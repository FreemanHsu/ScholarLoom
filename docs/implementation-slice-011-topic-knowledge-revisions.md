# Implementation Slice 011: Knowledge-ready Topic Knowledge Revisions

- Status: Implemented
- Date: 2026-08-01
- Parent design: [`paper-organization-feature-design.md`](paper-organization-feature-design.md)
- Depends on: Slice 007 Topic lifecycle and Slice 010 Entry Alias resolver

## 1. Outcome

Complete Slice 4C by making a confirmed, substantive Topic revision an eligible
`global-curated` source. A classification-only Research Direction remains useful
navigation metadata and never becomes epistemic evidence merely because it has a
title, aliases, Scope, or Paper assignments.

This slice does not add an Agent. The local owner edits Topic knowledge, explicitly
confirms a new revision, and separately attests that it is reusable knowledge. The
application validates and commits that revision through a recoverable
KnowledgeWriteRequest before updating either Paper Catalog or `global-curated`.

## 2. Domain and authority

Topic identity stays stable at `topic:<slug>`. Each accepted edit advances the
Topic's revision number and revision ID. The active Markdown file under
`vault/knowledge/topics/` remains the authority for the current Topic revision;
SQLite stores immutable revision metadata, paths, hashes, provenance links, and
the active projection. Before an active revision is replaced, its bytes are copied
and hash-verified into authoritative history Markdown at
`vault/knowledge/topics/.revisions/<encoded-topic-id>/<revision-id>.md`, keyed by
immutable Topic ID rather than mutable display slug. Active Topic
scans exclude `.revisions`; a separate deterministic history scan validates it.
The rebuild of the active knowledge corpus reads the current authoritative
Markdown only; historical revisions are audit-only and never retrieval inputs.

Add operational tables:

- `topic_knowledge_revisions`: immutable metadata for every Topic revision observed
  after migration, including usage level, review/epistemic status, active/history
  Markdown path and hash, knowledge-body hash, provenance JSON, and confirmation
  time;
- `topic_knowledge_provenance`: validated links from a knowledge-ready revision to
  an active Summary revision or confirmed active Takeaway revision;
- `topic_knowledge_paper_scope`: a derived Paper mapping from those provenance
  sources, used only by Paper-scoped Entry retrieval.

The migration backfills the current `direction_catalog` row as the initial observed
revision but unconditionally records it as classification, even if a legacy file
claims `knowledge-ready`; such a claim becomes reconciliation work. It does not
invent lost historical bodies or synthesize a new owner attestation. A
classification revision has no curated document. `usage_level` continues to belong
to the revision, not Topic identity.

## 3. Knowledge-ready eligibility

An accepted revision is `knowledge-ready` only when all conditions hold:

1. Topic identity is active and the revision is `confirmed`;
2. Scope is non-empty;
3. at least one substantive section is non-empty: **Map of concepts**, **Schools of
   thought and disagreements**, **Open questions**, **Syntheses**, or **Suggested
   reading path**;
4. at least one provenance source is selected and every source resolves to an active
   Summary or an active confirmed Takeaway;
5. every provenance source is still current when retrieval or rebuild occurs; and
6. the owner checks an explicit attestation that the revision is reusable Topic
   knowledge, not only classification metadata.

`Representative papers` is editorial navigation and is neither sufficient for
knowledge-ready status nor indexed as knowledge. Scope, aliases, tags, paper
membership, provenance labels, and Revision note are excluded from the curated
body. The five substantive sections are indexed with their headings so meaning is
not lost. A Topic title becomes the source title only after the revision passes the
knowledge-ready gate.

The same strict parser serves preview, commit, external reconciliation,
incremental indexing, and rebuild. Canonical sections are the eight English H2
headings in the current template, exactly once and in fixed order; the Chinese UI
maps labels to those keys. Unknown H2 sections are preserved but excluded and
terminate the preceding section. H3+ headings remain nested content. Missing,
duplicate, or out-of-order canonical headings fail knowledge-ready validation.
After whitespace and HTML comments are removed, exact placeholders `TODO`, `TBD`,
and `待补充` do not count as substantive content.

Saving a revision as `classification` is always allowed and removes its formerly
active knowledge-ready revision from `global-curated` after the authoritative write
commits. Demotion requires explicit owner confirmation but does not delete revision
history. External Markdown that claims `knowledge-ready` without valid substantive
content and provenance is projected as classification plus reconciliation; it is
never silently indexed.

Provenance eligibility is current-state, not confirmation-time-only. If the last
source becomes inactive, the Markdown remains untouched but the revision gains
operational `invalid-provenance` eligibility, is removed from broad and scoped
curated retrieval, and creates reconciliation work. A new explicitly confirmed
Topic revision is required before it can return.

## 4. Editing and confirmation flow

Extend Research Direction management with a “Topic 知识” editor for the five
substantive sections and validated provenance sources. The editor displays current
revision ID, usage level, indexed/not-indexed state, and the exact sections that
will enter retrieval.

The owner may:

- save a new classification revision;
- promote a complete revision to knowledge-ready with the explicit attestation;
- edit an existing knowledge-ready Topic, producing a new confirmed revision;
- demote it to classification with a confirmation preview.

Every submission carries a client-generated idempotency key, expected parent
revision ID, and Markdown hash. A stale or
externally edited file fails closed and creates the existing reconciliation path.
The application records one ordinary Proposal with kind
`topic-knowledge-revision` and one ordinary ReviewDecision even though the owner
confirms inline; the lightweight UI does not create a second state machine.

API additions:

- `GET /api/directions/:id/knowledge`;
- `GET /api/directions/:id/knowledge/provenance-options`;
- `POST /api/directions/:id/knowledge/preview`;
- `POST /api/directions/:id/knowledge/revisions` with an idempotency key.

The preview returns eligibility failures, indexed section names, provenance source
labels, and whether the commit performs an upsert or removal in `global-curated`.

## 5. Recoverable write and projections

Use one logical `topic-knowledge-revision` KnowledgeWriteRequest with both active
and history paths/hashes in its payload. Its phases are:

`reserved -> staged -> history-retained -> renamed -> metadata-committed -> catalog-indexed -> curated-indexed -> complete`.

After the staged hash and compare-and-swap guard succeed:

1. stage and verify both the new active bytes and a copy of the hash-verified prior
   active bytes;
2. atomically retain the prior revision under `.revisions` before the active file
   can be replaced; an existing history target must hash-match;
3. compare-and-swap the staged Markdown over the active Topic file;
4. insert revision metadata, provenance, ReviewDecision, and both projection outbox
   intents;
5. rebuild/upsert Paper Catalog from the new active Topic revision;
6. upsert the active knowledge-ready revision into `global-curated`, or delete the
   former Topic source on demotion;
7. mark both outbox operations and the KWR complete.

Recovery is idempotent at every phase. A crash may leave an extra valid history
copy but can never destroy the only old revision bytes. Paper Catalog and
global-curated may report
stale independently during recovery. A crash after the authoritative rename never
causes an unvalidated Topic body to be indexed.

At commit or recovery, the active file has exactly three CAS branches: expected
parent hash permits rename; result hash means the rename already succeeded and
recovery continues; any other hash aborts into reconciliation and never overwrites
the unknown owner bytes. The already retained history copy remains harmless.

History is tamper-evident, not tamper-proof. Missing or mismatched `.revisions`
files create non-fatal audit/reconciliation findings and never block active-path
operations or become retrieval inputs.

`rebuildCuratedProjection()` reads all current Topic Markdown through
`direction_catalog`, verifies path/hash, re-runs the same eligibility parser, and
indexes only active confirmed knowledge-ready revisions. Rebuild must yield the
same logical Topic documents and derived Paper scope rows as incremental writes.
Classification edits must not change any other curated source.

## 6. Entry retrieval and source navigation

Register `topic-knowledge` as a third curated source kind beside Summary and
Takeaway. Broad Entry retrieval may return an active knowledge-ready Topic revision.
The source card identifies it as “Topic 知识” and links to that Research Direction.

Paper-scoped Alias retrieval includes a Topic revision only when its validated,
currently active
provenance resolves to one of the selected Papers. Merely assigning a Paper to a
Direction is not enough: assignment metadata must not broaden the evidence scope.
The existing eight-source budget first reserves one Summary per resolved Paper and
selects up to seven fair Summary/Takeaway sources. At most one best Topic source may
use the eighth slot only when fewer than eight Summary/Takeaway sources were
selected; it never displaces them. Source-open events accept the new kind without
storing question text or source bodies.

Paper order, source kind, current revision recency, then stable source ID provide
the deterministic round-robin tie-break. `invalid-provenance` removes the broad FTS
document through the global-curated delete outbox; scoped SQL also revalidates the
current source lifecycle so a stale cache cannot grant access.

There is one curated document per active Topic:
`id = curated-topic:<topic_id>`, `source_type = topic-knowledge`, and
`source_id = <topic_id>`. Its active revision ID and hashes are joined from
`topic_knowledge_revisions`; old revisions never enter retrieval.

## 7. Rename, merge, and external edits

- Rename or Scope edit remains a new Topic revision. If the prior revision was
  knowledge-ready, an atomic rename-and-reconfirm option preserves curated presence
  only when the owner confirms unchanged substantive content and provenance in the
  same KWR. “Unchanged” compares the five parsed substantive sections plus the
  sorted provenance source-revision set, not the whole-file hash. Otherwise the
  result is classification and removes the curated source.
- Merge remains forward-only and never combines Topic knowledge bodies. The source
  file is retained and marked superseded; source knowledge/provenance freezes and a
  global-curated delete is enqueued in the same merge KWR. Target knowledge is
  unchanged, and no Alias or redirect carries knowledge-ready state. Historical
  revision metadata remains queryable.
- Rebuild follows Topic redirects for navigation but never retargets provenance or
  merges knowledge bodies.
- A knowledge-ready active-file hash mismatch creates/reuses reconciliation and
  enqueues curated deletion, but Paper Catalog still follows the current file's
  classification title/aliases/Scope and shows a drift warning. This makes
  incremental and full rebuilds identical while only epistemic content fails
  closed. External knowledge edits are accepted into curated retrieval only through
  explicit reconciliation and the same eligibility validation.

Direction creation continues to reject any occupied active path, including a slug
whose superseded Topic file is still retained. History directories are never moved
on rename or merge and cannot interleave two Topic identities.

## 8. Rollout and verification

Implementation order:

1. migration, Topic parser/projection contract, and immutable revision metadata;
2. recoverable writer and rebuild parity;
3. APIs and owner editor/preview;
4. Entry source registry, scoped retrieval, and source navigation;
5. recovery, rebuild, snapshot/restore, and Playwright acceptance.

Acceptance requires:

- classification-only Topic metadata never appears in `global-curated`;
- knowledge-ready requires substantive content, validated provenance, and explicit
  owner attestation;
- promotion, edit, demotion, crash recovery, rename, merge, and external drift have
  deterministic tests;
- incremental indexing equals a clean rebuild from authoritative active Markdown;
- Paper-scoped Entry retrieval includes Topic knowledge only through Paper-backed
  provenance, never through assignment alone;

## 9. Implemented result and verification

Migration 028, the strict Topic parser, immutable Vault revision history,
recoverable writer, Paper Catalog/curated projections, current-state provenance
invalidation, Entry source integration, APIs, and the responsive owner editor are
implemented. A knowledge-ready Topic's title, aliases, Scope, and substantive body
are confirmed atomically in the same revision; the ordinary rename path rejects
attempts that would bypass history retention.

Automated coverage verifies promotion, owner attestation, atomic rename, retained
history bytes, deterministic rebuild, scoped Entry provenance, immediate
invalidation, no automatic re-eligibility, and external drift. Typecheck and the
production build pass. A real Playwright journey verified the knowledge-ready
editor and Curated state at desktop and mobile widths; the dialog uses a body
portal so the mobile navigation drawer cannot move it off-screen. A stopped-server
snapshot was created, verified with SQLite integrity and foreign keys, and restored
into a new empty temporary data root.
- source cards resolve to the correct active Topic revision;
- tests, typecheck, build, `git diff --check`, real desktop/mobile Playwright, and
  snapshot verification/restore pass.

## 9. Non-goals

- Agent-authored Topic synthesis or automatic promotion;
- a general-purpose Knowledge Node editor for Concept, Question, or Synthesis;
- indexing classification Scope, aliases, tags, assignments, or representative
  paper lists;
- automatically merging Topic bodies or provenance during Direction merge;
- restoring Topic revisions that predate the first observed migration snapshot.
