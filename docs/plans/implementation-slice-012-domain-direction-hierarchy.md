# Implementation Slice 012: Optional Domain → Direction Hierarchy

- Status: Implemented
- Date: 2026-08-01
- Parent design: [`paper-organization-feature-design.md`](../paper-organization-feature-design.md)
- Depends on: Slice 007 Topic lifecycle and Slice 011 Topic knowledge revisions

## 1. Outcome

Complete Slice 4D with an optional, exactly two-level navigation hierarchy for a
large stable taxonomy. A Domain groups Research Directions in the Paper Library;
it is not assignable to a Paper, does not become a second knowledge taxonomy, and
does not alter Primary/Secondary semantics. Existing installations remain flat
until the owner explicitly enables hierarchy after at least 15 active confirmed
Directions exist.

## 2. Domain model and invariants

Domain is a navigation role played by an active confirmed classification Topic,
not a new Category entity. Topic revision frontmatter gains:

```yaml
navigation_role: domain # domain | direction
parent_domain_id: null  # only present on a direction when grouped
```

Missing `navigation_role` is parsed as `direction`, and missing
`parent_domain_id` as ungrouped. This makes all existing Topic files compatible.
The fixed invariants are:

- hierarchy is exactly `Domain → Direction`; Domains cannot have parents and
  Directions cannot have children;
- Paper `directions:` may reference only active confirmed Topics whose
  `navigation_role` is `direction`;
- each Direction has zero or one active Domain parent;
- Domain Topics remain `classification` in this slice and cannot be promoted to
  knowledge-ready or used as Topic knowledge sources;
- changing a Direction's parent does not change its identity, Scope, Paper
  assignments, Primary/Secondary roles, or Topic knowledge body;
- Domain title/Alias collisions use the same normalized-key rejection as Direction
  taxonomy identity; a Domain and Direction cannot occupy the same lookup name;
- grouping is presentation metadata. It never enters `global-curated`, provenance,
  Representative papers, or Paper manifests.

Conversion of an existing Direction into a Domain is out of scope because it could
invalidate Paper assignments. Domain creation always creates a new Topic identity.
Domain merge/delete and deeper nesting are also out of scope; an owner can first
ungroup/reassign children, while ordinary Topic lifecycle remains unchanged.
Every existing lifecycle command must reject a Domain with active children, and
must reject applying Direction-only rename/merge/promotion commands to a Domain.
This prevents an internal command from producing parents that the rebuild would
later reject. Domain rename is the only Domain lifecycle mutation in this slice.

A missing `parent_domain_id` and an explicit YAML `null` are equivalent. Any
non-null parent on a Domain is invalid. An external Domain edit that claims
`knowledge-ready`, sets `knowledge_attested: true`, or otherwise attempts promotion
creates reconciliation and is projected only from the last known good catalog;
the promotion API also rejects Domains directly. A Paper manifest that assigns a
Domain is invalid and enters the existing Paper reconciliation path.

## 3. Authority and projection

The child Direction Topic Markdown is authoritative for `parent_domain_id`; the
Domain file never stores an inverse child list. Domain identity and Scope are
authoritative in its own Topic Markdown. SQLite projects both roles in the existing
`direction_catalog` plus a rebuildable `topic_navigation` table:

- `topic_id`;
- `navigation_role = domain | direction`;
- nullable `parent_domain_id`;
- projection timestamp.

Migration 029 backfills every existing catalog Topic as an ungrouped Direction.
Clean rebuild parses every active Topic first, validates roles and parent targets,
then projects navigation rows. An unknown parent, parent that is not an active
Domain, self-parent, or Domain with a parent blocks the rebuild and creates the
existing reconciliation item; it is never silently flattened.

`hierarchy-enabled` and `hierarchy-ever-enabled` are local operational presentation
preferences stored in `paper_catalog_metadata`, not Paper Catalog projection rows
or epistemic knowledge. SQLite is operational authority for these keys: catalog
rebuild never deletes them, and the database is included in snapshot/restore. They
default false. Enabling is
allowed only when the current catalog contains at least 15 active confirmed
Directions. Once enabled, it remains enabled even if later merges reduce the count;
the owner may disable it without deleting any authoritative parent fields. If it
has been enabled once, the owner may re-enable below the threshold because the
authoritative taxonomy has already committed to hierarchy. Rebuild, snapshot, and
restore preserve both preferences and hierarchy data.
Enable and disable each rebuild Paper Catalog before returning so preference-gated
Domain search text cannot become stale. If projection work fails after the
preference transaction, a recoverable catalog outbox item remains pending;
`global-curated` is unaffected.

When hierarchy is enabled, Paper Catalog search text for a Paper includes the
title/aliases of every distinct parent Domain reached through all Primary and
Secondary assignments. When disabled, Domain text is excluded so the flat product
has exactly its prior search behavior. Exact Paper Alias/title ranking remains
unchanged; Domain matches are ordinary catalog matches. Domain rename and parent
assign/remove always trigger a catalog rebuild. The catalog remains independently
rebuildable, and `global-curated` is unchanged by every hierarchy operation.

Hierarchy validation happens before the catalog replacement transaction. An
invalid externally edited Topic creates one scoped reconciliation item and leaves
the complete last-known-good catalog readable; it does not partially delete rows
or make the current library unavailable. A clean rebuild with no last-good
projection fails closed rather than inventing or flattening parentage.

## 4. Commands and recoverable writes

Extend the existing `direction-taxonomy` Proposal/KWR discipline rather than
creating another workflow. Owner actions use operations:

- `create-domain`;
- `rename-domain`;
- `assign-domain`;
- `remove-domain`;
- `set-hierarchy-enabled` (ReviewDecision only; no Markdown write).

Domain creation and rename use the existing Topic renderer/parser, normalized-name
collision validation, client idempotency key, expected revision/hash CAS, Proposal,
ReviewDecision, and recoverable Topic write. A Domain file always has
`usage_level: classification`, `knowledge_attested: false`, and no parent.

Assign/remove Domain advances the child Direction revision and writes
`parent_domain_id` through one recoverable `direction-taxonomy`
KnowledgeWriteRequest. It freezes child revision/hash, target Domain revision/hash,
and the hierarchy-enabled state. Before the authoritative rename it revalidates
that the child is an active Direction, the parent is an active Domain, and neither
hash changed. The accepted transaction records ReviewDecision and rebuilds Paper
Catalog. Retry and recovery use the same idempotency key; an unknown external file
hash conflicts into reconciliation and is never overwritten.

All pre-existing Topic writers are part of the migration contract. Direction
rename/Scope edit, source/target merge rendering, classification promotion/demotion,
and Topic knowledge body edits preserve `navigation_role` and
`parent_domain_id` unless the command explicitly changes the parent. Tests cover
each writer. Direction merge uses the surviving target Topic's parent as
authoritative; a differing or source-only parent is discarded and surfaced in the
merge preview/Proposal. Domain Topics cannot be a merge source or target.
Direction reactivation and every lifecycle transition that re-projects a stored
parent edge must resolve the parent as an active Domain. If it cannot, the command
blocks and requires an explicit ungroup in the same recoverable write; it never
revives an invalid edge.

If the child is knowledge-ready, parent-only edits must use the Topic knowledge
revision writer so its old bytes remain in authoritative `.revisions` history.
The Topic knowledge API therefore accepts `parentDomainId` and applies it in the
same history-retaining revision. The lightweight hierarchy UI routes a
knowledge-ready Direction to that editor; it cannot bypass revision history.
Omitting `parentDomainId` preserves the current value, explicit `null` ungroups,
and a string assigns. Parent-only revisions are allowed, retain an unchanged
curated body/provenance, and record `operation_reason: navigation-parent-change`
for audit legibility. This explicitly broadens Topic revision history to include a
navigation-only revision because it is the only safe way to retain the old
authoritative bytes.
When `parentDomainId` is not omitted, the knowledge writer runs the identical
parent validation and CAS as the taxonomy writer: it freezes and rechecks the
active Direction child, active Domain target role/revision/hash, hierarchy state,
and external file hashes. Wrong-role, superseded, self, and drifted targets fail
before replacing the child; external-byte conflicts create reconciliation.

APIs:

- `GET /api/domains` returns domains, child counts, primary Paper counts, enable
  state, threshold, and ungrouped count;
- `POST /api/domains` creates a Domain;
- `POST /api/domains/:id/rename` creates a Domain revision;
- `POST /api/directions/:id/domain` assigns/removes the parent with CAS;
- `POST /api/taxonomy-hierarchy/enable` and `/disable` change the operational
  presentation preference with an idempotency key.

## 5. Library interaction and URL state

When hierarchy is disabled, the current flat library is unchanged. When enabled:

- the left rail lists Domains, their Primary Paper counts, nested child Directions,
  and an `Ungrouped` section;
- a Domain count is the distinct number of Papers whose Primary Direction is a
  child, so nested Primary counts sum predictably;
- selecting a Domain filters Papers that have any Primary or Secondary assignment
  to a child Direction, while `relation=primary` restricts to Primary;
- the main list always groups uniquely by each Paper's Primary Direction. A Paper
  matched through a Secondary child can therefore appear under its actual Primary
  group, preserving the existing no-duplication rule;
- `domain=<topic-id>` is canonical URL state and is mutually exclusive with
  `direction=<topic-id>`; invalid/superseded IDs show the existing invalid-filter
  recovery UI;
- on mobile the Domain/Direction tree remains inside the existing navigation
  drawer, with native disclosure controls and at least 48px touch targets.

The Direction manager gains a hierarchy section showing threshold/readiness,
explicit enable/disable, Domain create/rename, and one parent selector per
Direction. It does not generate Domain suggestions or automatically group existing
Directions. Domain ordering is title plus stable Topic ID; children use the same
ordering. Expanded/collapsed state is local UI state and does not enter URLs or
authority.

URL validation is fail-closed: supplying both `domain=` and `direction=`, using a
Domain filter while hierarchy is disabled, or pointing `domain=` at a
Direction-role Topic all show the invalid-filter recovery UI. `domain=ungrouped`
is the reserved canonical filter for Papers with any Primary or Secondary
assignment to an ungrouped Direction; it is available only while hierarchy is
enabled. Topic IDs must begin with `topic:`, so the token cannot collide. Like the
accepted flat Direction
rail, Domain navigation displays a Primary-only count while the default filter may
return additional Secondary matches; the result heading states the total match
count. A Secondary-only match may render under a Primary group outside the selected
Domain by design, preserving unique Primary grouping.

## 6. Rollout and verification

Implementation order:

1. migration, parser defaults, projection invariants, and deterministic rebuild;
2. hierarchy commands, CAS/recovery, and knowledge-ready parent integration;
3. API and URL state;
4. desktop/mobile Library tree and management UI;
5. snapshot/restore and real-browser acceptance.

Acceptance requires:

- all existing Topics backfill and rebuild as ungrouped Directions with no Paper
  behavior change while hierarchy is disabled;
- Migration 029 is projection-only, rewrites zero Markdown files, and a migrated
  database is logically identical to a clean projection rebuild;
- fewer than 15 active Directions cannot enable hierarchy, and no automatic enable
  occurs at the threshold;
- a Paper cannot be assigned to a Domain and a Direction cannot receive a
  Direction parent;
- hierarchy writes preserve unrelated Topic fields and confirmed Paper
  assignments; external hash drift conflicts without overwrite;
- knowledge-ready parent changes retain old authoritative bytes and do not change
  curated body/provenance;
- Domain lifecycle guards, Domain promotion rejection, Paper-to-Domain assignment
  drift, every existing Topic writer, and surviving-target merge parent semantics
  have deterministic tests;
- domain filtering, Primary-only filtering, counts, URL back/forward, exact Paper
  search ranking, rebuild parity, and mobile navigation are deterministic;
- hierarchy-only operations leave `global-curated` byte-equivalent;
- hierarchy enable/ever-enabled state and all parent fields survive catalog rebuild,
  snapshot verification, and restore into a new root;
- disable immediately removes Domain-title search matches and re-enable restores
  them without any intervening Topic or Paper write;
- the knowledge-ready parent path rejects wrong-role, superseded, self, and
  externally drifted targets with the same CAS semantics as the classification
  path, and Direction reactivation cannot revive an inactive parent edge;
- `domain=ungrouped` matches both Primary and Secondary ungrouped assignments while
  retaining the documented Primary-only rail count;
- full tests, typecheck, production build, `git diff --check`, snapshot verify,
  restore to a new root, and a Playwright desktop/mobile journey pass.

## 7. Implemented result and verification

Migration 029, strict Topic navigation parsing, rebuildable `topic_navigation`,
threshold-gated hierarchy preferences, Domain and parent commands, recoverable
writes, knowledge-ready parent revisions, Domain-aware Paper Catalog search and
filters, canonical URL state, and the responsive Library tree/manager are
implemented. Existing missing navigation fields remain compatible as ungrouped
Directions, while wrong-role Paper assignments and malformed external hierarchy
edits fail closed into reconciliation.

Automated coverage verifies threshold and explicit enablement, parent preservation,
Paper-to-Domain rejection, Domain rename/search rebuild, disable/re-enable search
gating, Domain and Ungrouped filters, and history-retaining parent changes on a
knowledge-ready Topic without curated body drift. A real Playwright journey
verified hierarchy enablement, Domain creation, parent assignment, canonical
`domain=` navigation, the desktop tree, and the mobile drawer with a clean browser
console. The stopped data root is snapshot-verified and restored to a new empty
root; full repository verification is recorded with this slice.
