# Implementation Slice 007: Batch Decisions and Topic Lifecycle

- Status: Implemented and verified
- Date: 2026-07-31
- Parent design: [`paper-organization-feature-design.md`](../paper-organization-feature-design.md)
- Depends on:
  [`implementation-slice-005-organization-workspace.md`](implementation-slice-005-organization-workspace.md),
  [`implementation-slice-006-taxonomy-bootstrap-backfill.md`](implementation-slice-006-taxonomy-bootstrap-backfill.md)

## 1. Outcome

Complete Slice 2 with two related but separately recoverable capabilities:

1. apply an explicit selection of ordinary Alias/Primary/Secondary Proposals in
   bulk while preserving each Proposal's independent decision semantics;
2. rename or merge confirmed Research Directions without changing Topic identity,
   losing Paper membership, or making a partially migrated library unreadable.

Batch commands never infer selection from a changing query and never edit a
Proposal. Topic lifecycle commands are user-authored commands, not Agent actions.

## 2. Batch selection and preview

The workspace adds selection controls to each pending Alias, Primary, and Secondary
card. The user may select any combination; the three sections remain independently
confirmable. “Select safe visible” includes only proposals whose current light
state is `ready`, that are not ambiguous, and that carry no collision warning.
Changing a filter does not silently add hidden rows.

Before execution the browser sends the exact ordered Proposal IDs to a preview
endpoint. The server re-reads every Proposal and returns:

- selected Proposal and distinct Paper counts;
- counts by Alias/Primary/Secondary;
- eligible, stale, blocked, ambiguous, and collision-warning counts;
- up to five deterministic Paper samples;
- the exact excluded Proposal IDs and reason codes.

Accept preview excludes non-ready proposals. Reject preview permits ready or blocked
pending proposals but excludes stale/already-decided rows. The confirmation sheet
states that success is per Proposal and that one Paper may finish partially if,
for example, Alias succeeds but Primary conflicts. No confidence score is invented.

## 3. Durable batch command

Add `paper_organization_batches` and `paper_organization_batch_members`.

The command stores:

- one stable command ID and caller idempotency key;
- action `accept | reject`;
- the ordered frozen Proposal IDs and their Paper/section identities;
- preview counts and creation/completion timestamps;
- state `reserved | applying | complete | complete-with-issues | abandoned`.

Every member stores a derived idempotency key, state
`pending | applying | succeeded | failed | conflicted | skipped-stale |
skipped-external`, attempt count, result JSON, closed error code, and timestamps.
Only one batch may be active. A
Proposal can appear at most once in one command, and reservation rejects a Proposal
already owned by another active batch.

A coordinator processes one member at a time. It calls the existing
`decidePaperOrganizationProposal` command with the original proposed value:

- Accept uses the existing section-scoped validation, authority checks,
  ReviewDecision, and Paper KnowledgeWriteRequest.
- Reject uses the existing immutable reject decision and writes no Markdown.
- No member bypasses command-time Summary, manifest, Topic lifecycle, conditioned
  Secondary, alias-collision, or preferred-Alias checks.

This intentionally produces one recoverable KWR per accepted section. Successful
members are never rolled back because a later member fails. The per-Paper result
groups section outcomes so partial completion is visible rather than implied to be
atomic.

Every apply and retry begins with an effect check, not an idempotency-key check. If
the Proposal has the same effective decision and resulting manifest state, the
member reconciles to `succeeded`; an incompatible decision by another actor becomes
`skipped-external`; only a genuinely pending Proposal enters the decision command.
`decidePaperOrganizationProposal(proposalId, decision)` is effect-idempotent: an
identical already-effective decision returns its immutable prior result, while a
contradictory re-decision fails. Attempt keys journal executions but are not the
duplicate-effect guard.

Retry targets only failed/conflicted members still backed by a pending Proposal.
It increments attempt and re-enters the same existing decision command with a new
member-attempt idempotency key after the effect check. A conflicted external
Markdown edit still requires reconciliation; Retry never forces overwrite. Abandon
stops unscheduled members and does not undo decisions already made.

## 4. Batch APIs and interaction

Add:

- `POST /api/paper-organization/batches/preview`;
- `POST /api/paper-organization/batches`;
- `GET /api/paper-organization/batches/:id`;
- `POST /api/paper-organization/batches/:id/retry`;
- `POST /api/paper-organization/batches/:id/abandon`.

Each batch has exactly one verb; accept and reject members are never mixed.
Mutations require idempotency keys. Reads are bounded and omit full Proposal
rationales. `/papers/organize` shows a sticky selection tray, confirmation sheet,
live progress, grouped per-Paper outcomes, links to conflicts, and Retry. Mobile
uses a bottom sheet. Batch execution does not add items to the high-stakes Review
Center.

Batch regenerate is not included: regeneration creates new immutable Agent runs and
has per-Paper scope choices, so it remains an explicit Paper action.

## 5. Direction rename

Rename preserves `topic_id` and Markdown path. The command accepts title, aliases,
Scope, exclusions, and the expected current Topic revision/hash. It creates a direct
`direction-taxonomy` audit Proposal and immutable ReviewDecision, then writes a new
Topic revision through the existing Option E `direction-taxonomy` KWR.

Command-time validation requires an active, confirmed Direction and rejects exact
normalized title/alias collisions. Paper manifests do not change. Catalog rebuild
shows the new title everywhere while old names may be deliberately retained as
aliases. Scope edits are part of Rename/Edit and change the Direction semantic hash,
therefore still-pending Paper Organization Proposals referencing the old semantic
hash become stale.

A pure display rename keeps the semantic hash stable only when the user explicitly
attests `scopeMeaningUnchanged=true`. The Proposal restates the frozen Scope and
records that attestation. Without it, the command is a Scope edit and intentionally
changes the semantic hash. Rename/merge audit Proposals keep
`proposal_type=direction-taxonomy` with distinct payload operations `rename` and
`merge`; they are never batch-eligible, record actor `local-owner` on Proposal and
ReviewDecision, and embed every frozen preview hash.

## 6. Direction merge and redirect authority

Merge is a source → target command. Source and target must be distinct, active,
confirmed Directions. The preview freezes:

- source and target semantic hashes;
- every Paper manifest currently assigning source, ordered by Paper ID;
- the deterministic post-merge organization for each Paper;
- conflict-risk and assignment-shape counts.

Add `topic_redirects`, `direction_merge_commands`, and
`direction_merge_members`. Redirects are a rebuildable projection from authoritative
Topic Markdown: a superseded source revision records `superseded_by: targetTopicId`.
Projection rebuild resolves A→B→C closure, rejects cycles, and fails closed on a
missing/deleted target. Chains remain historical in Markdown and are never
compressed. Reads resolve transitively to the final active target with a maximum
depth of 32. Cycle, depth overflow, missing target, or an unverified rebuild returns
`topic-redirect-unavailable`. Canonical URLs include the complete merged-from
lineage and merge dates.

The authoritative merge commit is the Topic KWR that writes `superseded_by`;
`topic_redirects` is only a derived cache. Paper migration cannot begin until a full
Markdown scan has rebuilt and verified the just-committed source redirect. During
that interval the merge command is `superseding` and source reads fail closed rather
than serving stale active catalog data.

Execution order:

1. reserve the command and frozen members;
2. revalidate both semantic hashes and the absence of a redirect cycle;
3. use a recoverable Topic KWR to write the source as superseded by target;
4. rebuild redirect projection, making old IDs readable as target immediately;
5. migrate Paper members one at a time through ordinary recoverable Paper KWRs;
6. finish `complete` or `complete-with-issues`; successful members are never rolled
   back because another Paper conflicts.

Paper rewrite rules are deterministic:

- source Primary becomes target Primary;
- source Secondary becomes target Secondary;
- if target is already Primary, any source/target Secondary duplicate is removed;
- if source is Primary and target is Secondary, target becomes Primary and the
  duplicate Secondary is removed;
- if both are Secondary, retain one target Secondary at the earlier ordinal;
- no new Secondary is introduced, so the maximum-three rule cannot require silent
  truncation.

The complete role matrix is:

| Source role | Existing target role | Result |
|---|---|---|
| Primary | none | target Primary |
| Primary | Secondary | target Primary; remove duplicate Secondary |
| Primary | Primary | target Primary; remove source duplicate |
| Secondary | none | target Secondary at source ordinal |
| Secondary | Secondary | one target Secondary at the earlier ordinal |
| Secondary | Primary | target Primary; remove source Secondary |

Confirmed Paper manifests do not persist Proposal-time conditioning. Every pending
conditioned-Secondary Proposal mentioning source or target becomes stale and is
never retargeted. If a post-merge organization fails Primary uniqueness, Secondary
limit, or another current invariant, the member becomes `conflicted`; roles are
never silently demoted or dropped outside this matrix.

The Topic command does not merge Scope, aliases, representative Papers,
disagreements, reading paths, or knowledge prose. Source remains on disk with its
history and redirect. A member revalidates the Paper manifest hash immediately
before its KWR; an external edit becomes `conflicted` and old source ID remains
readable through redirect until explicitly retried.

Any pending Paper Organization Proposal that references source becomes stale.
Accept never silently retargets it. Taxonomy Proposal collision checks resolve
canonical redirects before deciding availability.

Merge is forward-only after the authoritative source Topic KWR. It may be abandoned
only before that commit. Afterwards it ends as `complete` or
`complete-with-exceptions`; the latter keeps a durable list of unmigrated Papers,
all readable through redirect and individually retryable.

## 7. Topic lifecycle APIs and interaction

Add:

- `POST /api/directions/:id/rename/preview`;
- `POST /api/directions/:id/rename`;
- `POST /api/directions/:id/merge/preview`;
- `POST /api/directions/:id/merge`;
- `GET /api/direction-merges/:id`;
- `POST /api/direction-merges/:id/retry`.

Direction management in the Paper Library gains Rename/Edit and Merge actions.
Merge requires choosing a target and shows affected Paper counts and a sample before
confirmation. Progress lists succeeded/conflicted Papers and links to reconciliation.
There is no “force” action. Superseded Directions disappear from creation/filter
pickers but old URLs redirect to the canonical target while retaining a visible
“merged from” notice.

## 8. Recovery and rebuild

- startup order is fixed: replay and verify KWR journals; rebuild and verify Topic
  redirects from Markdown; reconcile every `applying` member through effect checks;
  only then resume coordinators;
- startup resumes reserved/applying batches and merge members;
- batch and merge member idempotency prevents duplicate ReviewDecisions/KWRs;
- Topic KWR recovery completes the redirect before Paper migration resumes;
- redirect projection is deterministically rebuilt from Topic Markdown alone;
- a failed redirect rebuild blocks merge execution and direction-filter reads
  rather than returning an unfiltered library;
- `global-curated` remains unchanged for classification-only Topic rename/merge;
- snapshot/restore preserves commands, member outcomes, Topic/Paper Markdown, and
  rebuildable redirects.

An active rename/merge places a topic-level mutation guard. A batch member touching
that Topic becomes `conflicted` or `skipped-stale` at apply time. Starting a merge
or rename reports frozen active-batch members referencing the Topic and requires
them to finish or be abandoned; Topic meaning changes never interleave with those
member applications.

## 9. Implementation increments

1. batch schema, preview/reservation, coordinator, APIs, and failure tests;
2. selection tray, confirmation sheet, progress/retry UI, desktop/mobile journey;
3. Topic revision renderer/parser extensions and redirect projection;
4. rename command and stale-Proposal tests;
5. durable merge preview/command, partial Paper migration, recovery, and UI;
6. full rebuild, snapshot/restore, and browser regression.

## 10. Acceptance

- Alias, Primary, and Secondary remain independently selectable and decidable;
- batch membership is an exact frozen set, not a live query;
- every accepted member uses the existing section decision and KWR path;
- per-Paper partial success and conflict remain visible and retryable;
- Rename keeps Topic ID/path stable and makes old semantic-hash proposals stale;
- Merge establishes a readable redirect before migrating any Paper;
- redirect chains rebuild deterministically and loops fail closed;
- duplicate Primary/Secondary assignments collapse by explicit deterministic rules;
- pending proposals are never silently retargeted across a merge;
- a Paper conflict does not roll back Topic supersession or other Paper migrations;
- deleting `topic_redirects` and rebuilding from Markdown produces identical rows;
- after every prefix of a batch or merge, every touched Paper manifest independently
  passes all organization invariants;
- crash injection around ReviewDecision, KWR completion, and member-state update
  never produces more than one effective decision or accepted-section KWR;
- full tests, typecheck, build, `git diff --check`, Playwright, and
  snapshot/restore pass.

## 11. Non-goals

- confidence scoring or batch auto-accept;
- batch editing Proposal values;
- Agent-proposed rename/merge/scope-edit;
- knowledge-prose merge;
- destructive cleanup of superseded Topic files;
- production legacy `topics:` migration.

## 12. Verification

Implemented on 2026-07-31. Verification completed with:

- all 247 repository tests passing;
- TypeScript typecheck, production build, and `git diff --check`;
- a real Playwright desktop journey covering safe visible selection, batch preview
  and acceptance, Topic rename, forward-only merge, Paper membership migration, and
  old-direction URL resolution;
- a 390 × 844 mobile check of the canonical redirected library view;
- snapshot creation and verification, restore into a new data root, and SQLite
  integrity/foreign-key diagnostics with no authoritative artifacts missing.

The screenshots from these journeys were local verification outputs and are not
versioned documentation.
