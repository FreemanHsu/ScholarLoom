# Implementation Slice 006: Taxonomy Bootstrap and Existing-Library Backfill

- Status: Implemented
- Date: 2026-07-31
- Parent design: [`paper-organization-feature-design.md`](../paper-organization-feature-design.md)
- Depends on:
  [`implementation-slice-004-paper-organization-agent.md`](implementation-slice-004-paper-organization-agent.md),
  [`implementation-slice-005-organization-workspace.md`](implementation-slice-005-organization-workspace.md)

## 1. Outcome

Add the two-stage existing-library workflow without allowing an Agent to create
confirmed knowledge:

1. a dedicated Paper Taxonomy Agent reads a bounded, immutable cohort of active
   Paper summaries and proposes a small set of classification-only Research
   Directions;
2. the user independently edits, accepts, or rejects each Direction proposal;
3. after useful Directions are confirmed, a durable backfill campaign schedules the
   existing Paper Organization Agent once per eligible Paper.

This slice ends when old Papers have ordinary Alias/Primary/Secondary proposals in
the Slice 005 workspace. Batch Proposal decisions remain Slice 007.

## 2. Why a separate Agent

`Paper Organization Agent` answers a per-Paper question against an already confirmed
Direction catalog. Taxonomy bootstrap answers a cross-Paper question and proposes
the catalog itself. Combining the contracts would let per-Paper execution drift into
Topic creation and make retries depend on mutable library-wide inputs.

Add task kind `paper-taxonomy`, display name `Paper Taxonomy Agent`, a versioned
`skills/paper-taxonomy/SKILL.md`, prompt, strict JSON schema, settings contract, and
Codex structured one-shot adapter. It has no tools or network.

The Agent may propose only `operation=create`. It never writes Topic Markdown,
renames/merges existing Topics, or classifies Papers. Those are separate commands.

## 3. Bounded taxonomy input

### 3.1 Eligibility and cohort

The bootstrap command considers active Papers that have:

- a current immutable Paper Version;
- an active Summary revision for that version;
- a hash-verified Paper manifest;
- no confirmed Primary Direction by default.

The command snapshots at most 100 Papers. New bootstrap runs select Papers not yet
covered by a successful taxonomy run for the same active Summary revision, ordered
by stable Paper `created_at` ascending then Paper ID ascending. A user-facing
Regenerate command reuses the selected prior cohort but creates a new manifest; it
does not advance coverage. After all eligible Papers have coverage, an explicit
Refresh starts again from the stable ordering. The manifest stores the selection
mode and cohort hash. The preview and candidate UI report “N of M eligible Papers”
plus remaining uncovered count.

Every Paper contributes only:

- stable Paper ID, canonical title, authors, and external identities;
- Summary revision ID and Markdown hash;
- section title plus a deterministic excerpt, capped at 1,200 Unicode code points
  per Paper in total;
- confirmed Alias/Direction metadata already present on that Paper.

Raw PDFs, complete Summary bodies, Conversations, Agent rationale, and production
paths are excluded. The whole canonical manifest is capped at 180,000 code points;
overflow fails before scheduling rather than silently sampling.

### 3.2 Immutable manifest

`paper_taxonomy_manifests` stores:

- contract, prompt, schema, and skill hashes;
- ordered Paper facts with Summary revision/hash;
- the existing confirmed Direction catalog snapshot and semantic hashes;
- selection rule/version, selection mode, cohort hash,
  eligible/selected/remaining counts, and creation time;
- manifest JSON and content hash.

`paper_taxonomy_runs` links a monotonic sequence and a `paper-taxonomy` JobRun to one
manifest. Retry always reuses the original manifest. A new bootstrap is an explicit
new run.

No manifest is epistemic knowledge or indexed into `global-curated`.

## 4. Agent output and validation

The result contains 0–12 candidates. Zero is a valid `no-new-direction` outcome;
the runtime never clamps or fabricates candidates:

```ts
type TaxonomyCandidate = {
  suggestedTopicId: `topic:${string}`;
  title: string;
  aliases: string[];
  scope: string;
  exclusions: string[];
  representativePaperIds: string[];
  rationale: string;
};
```

Validation is per-candidate rather than all-or-nothing. Structurally invalid output
still fails the run, but an otherwise valid candidate with an exact catalog
collision is dropped and recorded in run outcome JSON while independent candidates
remain reviewable. Validation requires:

- stable Topic ID syntax and unique normalized IDs/titles/aliases in the result;
- non-empty Scope that states inclusion criteria;
- at least one exclusion boundary;
- 1–5 representative IDs, all from the frozen cohort;
- no exact normalized collision with an active Direction ID, title, or alias;
- no candidate whose Scope is merely a technique, model family, venue, or arXiv
  category without a core research-problem boundary;
- at most 12 candidates and bounded text fields.

Normalization reuses `normalizePaperLookup.v1`: Unicode NFKC (therefore width
folding), trim, internal whitespace collapse, and Unicode-aware Latin case folding.
It does not fold punctuation, hyphen variants, or simplified/traditional Chinese.

Semantic overlap is an Agent assertion against the frozen catalog, not a runtime
embedding or mutable algorithm. A candidate lists overlapping confirmed Direction
IDs and rationale; any non-empty overlap list yields `ambiguous=true`. Direction
`semanticHash` remains the versioned hash of Scope/lifecycle metadata used for
command-time authority checks, not the overlap detector. The manifest records the
normalization version and selection/excerpt algorithm versions. The UI requires
deliberate editing or rejection for ambiguous candidates.

## 5. Proposal and confirmation lifecycle

Every candidate becomes an immutable `direction-taxonomy` Proposal:

```ts
{
  contractVersion: "direction-taxonomy.v1",
  sourceKind: "agent",
  operation: "create",
  jobRunId,
  manifestId,
  suggested: { topicId, title, aliases, scope, exclusions },
  representativePaperIds,
  rationale,
  ambiguous,
  overlaps
}
```

Candidates are edited only in the decision command; the original Proposal remains
immutable. Each candidate has independent Accept, Reject, and Regenerate behavior.
Regenerate creates a new taxonomy run and supersedes only still-pending candidates
from the selected prior run after the replacement succeeds.

Accept performs command-time validation against the current confirmed catalog:

- Topic ID/path must remain unused;
- normalized title/aliases must not exactly collide;
- every referenced representative ID must belong to the frozen manifest cohort;
- unrelated catalog additions do not stale the Proposal;
- a new exact collision returns `direction-taxonomy-proposal-stale` and preserves
  the pending Proposal. Later Paper archival or Summary replacement does not stale
  taxonomy evidence already frozen in the manifest.

Accepted or accept-with-edit values use the existing Option E ordering and
`direction-taxonomy` KWR to create a `usage_level: classification` Topic revision.
Only after canonical rename succeeds are the Proposal, immutable ReviewDecision,
Topic projection, index outbox, and KWR metadata committed. Reject writes no
Markdown. Direct manual Direction creation remains supported and uses the same
write discipline.

The decision record schema is `direction-taxonomy-decision.v1` and records the
Agent proposal, accepted value, edited fields, and resulting Topic identity.

The existing Paper organization accept command remains the final authority guard:
`PaperOrganizationStore.decideAgentProposal` compares frozen semantic hashes and
calls `requireDirection` for every accepted assignment. `requireDirection` permits
only an active, confirmed Topic (both classification-only and knowledge-ready Topics
are classification-usable). A reconciled-away or otherwise unusable Direction
therefore returns a stale/not-usable 409 before a Paper KWR is reserved.

## 6. Backfill campaigns

### 6.1 Durable scheduling

`paper_organization_backfills` stores one command-level campaign, and
`paper_organization_backfill_members` stores every frozen Paper child:

- stable ID and idempotency key;
- selector (`zero-run` in this slice);
- confirmed Direction catalog hash as provenance only;
- ordered eligible Paper IDs and current Summary revision IDs;
- state and scheduled/skipped/failed counts;
- timestamps.

Each member stores Paper/Summary identity, scheduling state, child idempotency key,
skip reason, JobRun ID, and the actual child catalog hash after scheduling.

The preview and command use the same eligibility function. `zero-run` means no
Paper Organization run exists for the current active Summary revision. Prior runs
for an older Summary do not exclude the Paper.

Starting a campaign reserves the campaign transactionally, then schedules one
ordinary `scope=all` Paper Organization Job per eligible Paper with child
idempotency key:

```text
paper-organization-backfill:{campaignId}:{paperId}:{summaryRevisionId}
```

Scheduling is resumable after restart. The closed skip-reason set is: Paper no
longer active, active Summary revision replaced, Paper manifest/hash drift, or a
non-terminal organization/KWR operation. Direction catalog growth is never a drift
or skip reason. A skipped member can be retried through a new preview. Completed
Papers are never rolled back because another Paper fails.

The campaign freezes only the Paper membership and Summary identities. Each child
Job freezes the confirmed Direction catalog when it is actually scheduled. This
allows the user to finish Direction confirmation before starting backfill while
retaining ordinary per-Paper retry semantics. A campaign may therefore contain
monotonically growing catalog snapshots. Its summary reports how many children ran
against a catalog hash older than the newest child and links those Papers for
follow-up; catalog growth never invalidates already completed work.

### 6.2 Safety boundaries

- Backfill never accepts a Paper proposal.
- It never changes a confirmed Primary.
- It does not schedule a duplicate child for the same campaign/Paper/Summary.
- Only one backfill campaign may be non-terminal. This plus the revision-relative
  zero-run selector prevents cross-campaign duplicate children.
- The user chooses 25, 50, 100, 250, or 500 Papers after seeing the preview; larger
  libraries run multiple campaigns with an explicit remaining count.
- Organization Agent concurrency remains one.
- Stopping/restarting the app resumes unscheduled campaign members and existing
  queued/running JobRuns through normal recovery.
- A user may explicitly abandon a `reserved`, `scheduling`, or `monitoring`
  campaign. `abandoned` is terminal, stops scheduling unscheduled members, and does
  not cancel or roll back already queued/running/completed child JobRuns. This
  prevents one wedged campaign from permanently blocking the single-active-campaign
  entry path.

## 7. HTTP and read models

Add:

- `GET /api/paper-taxonomy/bootstrap/preview`;
- `POST /api/paper-taxonomy/bootstrap`;
- `GET /api/paper-taxonomy/bootstrap`;
- `POST /api/paper-taxonomy/jobs/:id/retry`;
- `POST /api/direction-taxonomy/proposals/:id/decision`;
- `GET /api/paper-organization/backfill/preview`;
- `POST /api/paper-organization/backfill`;
- `GET /api/paper-organization/backfills/:id`.

All mutating commands require idempotency keys. Status reads are bounded and omit
full Summary excerpts and manifests. Invalid bodies and limits use stable 400
codes; stale/conflicting decisions use stable 409 codes.

## 8. Browser interaction

Add a `Taxonomy` step above the existing organize queue:

1. a compact onboarding card shows confirmed Direction count and bootstrap preview;
2. “生成候选方向” starts one immutable run and shows progress; a successful
   zero-candidate run marks its cohort covered and displays “已检查此批 Paper，未发现需
   新增的方向” rather than a failure;
3. the result renders one editable candidate card at a time with title, stable ID,
   aliases, Scope, exclusions, representative Paper links, rationale, and overlap
   warnings;
4. every card has independent Confirm, Reject, and Regenerate controls;
5. after at least one Direction is confirmed, the next-step card previews zero-run
   Papers and starts backfill;
6. campaign progress reports scheduled, skipped, failed, completed Jobs and links
   to `/papers/organize?view=pending`.

Taxonomy candidates do not enter the high-stakes Review Center by default. The same
Proposal/ReviewDecision rows remain auditable. On mobile, candidate fields are one
column and representative Papers collapse under a disclosure.

The preview estimates the number of Alias/Primary/Secondary decisions that could be
created (as a range, not a promise). Campaign progress separately reports Job
completion and still-pending user decisions. The UI never promises that all Papers
fit the first taxonomy. Remaining and later unclassified counts stay explicit.

Old-Summary pending suggestions are marked stale by the existing SQLite light-state
comparison against the current active Summary as soon as that Summary changes. The
campaign preview/card repeats this warning at membership time, before a replacement
child is scheduled or commits; users are not asked to infer staleness from later
supersession.

## 9. Recovery and rebuild

- Startup marks interrupted taxonomy Jobs consistently with other JobRuns.
- Taxonomy retry reuses the immutable manifest.
- Pending taxonomy Proposals survive restart.
- Topic KWR recovery uses the existing direction write recovery path.
- Backfill campaign scheduling resumes from durable member state.
- Startup JobRun recovery makes queued/running child work terminal or resumable;
  explicit campaign abandonment is the final escape hatch if monitoring cannot
  converge.
- Taxonomy manifests, runs, Proposals, ReviewDecisions, and campaigns are
  operational authority; confirmed Topic/Paper Markdown remains knowledge
  authority.
- Paper Catalog and `global-curated` remain deterministically rebuildable.

## 10. Implementation increments

1. Taxonomy Agent contract, configuration, skill, adapter, migrations, and tests.
2. Immutable bootstrap manifest, coordinator, Proposal generation, retry, and APIs.
3. Taxonomy Proposal decision through existing recoverable Topic writes.
4. Backfill preview, durable campaign scheduling/recovery, and progress.
5. Taxonomy/backfill UI, desktop/mobile Playwright journey, snapshot/restore.

## 11. Acceptance

- no taxonomy Agent path can directly create or mutate a Topic;
- a frozen cohort produces independently reviewable Direction candidates;
- exact catalog collisions are rejected deterministically;
- accept-with-edit records the exact confirmed Direction;
- failed/conflicted Topic writes leave the Proposal pending;
- zero-run membership is defined against the current active Summary revision;
- the ordinary organize queue continues to use absolute run-history membership.
  A Paper with only an old-Summary run may temporarily appear in the queue and a
  backfill preview: the old suggestions are stale/attention context, while the
  backfill child supersedes pending sections only after its new run succeeds.
  Single-active-campaign and non-terminal Paper guards prevent duplicate execution;
- a restarted campaign never duplicates child Jobs;
- one failed Paper does not roll back successful scheduling for others;
- backfill produces ordinary independent Alias/Primary/Secondary Proposals;
- zero-run Papers enter `/papers/organize` only after their first run exists;
- taxonomy-only actions do not change `global-curated`;
- full tests, typecheck, build, `git diff --check`, real Playwright, and
  snapshot/verify/restore pass.

Required tests include stable cohort advancement despite `updated_at` changes,
Regenerate cohort reuse, byte-equivalent retry manifests, mixed CJK/Latin/width
normalization, per-candidate collision drops, unrelated catalog additions versus
exact-collision staleness, single-active-campaign enforcement, restart during
partial scheduling, every closed skip reason, per-child catalog hashes, and the
campaign invariant `scheduled + skipped + remaining = frozen membership`.
Run outcomes expose emitted/dropped/ambiguous candidate counts and skip-reason
histograms.

## 12. Non-goals

- batch accept/reject of Paper proposals;
- taxonomy rename, merge, redirect migration, or Scope revision;
- production legacy `topics:` migration;
- calibrated auto-accept;
- Entry Agent Alias resolution;
- knowledge-ready Topic indexing;
- Domain hierarchy.

## 13. Verification record

Implemented on 2026-07-31 with:

- one dedicated, tool-free Paper Taxonomy Agent and immutable frozen manifests;
- independently editable Direction Proposals confirmed through recoverable
  `direction-taxonomy` KnowledgeWriteRequests;
- durable, restart-safe zero-run backfill campaigns that schedule ordinary Paper
  Organization Jobs without accepting any Proposal;
- a responsive Taxonomy/Backfill step in `/papers/organize`.

Verification passed: 244 repository tests plus the taxonomy contract tests,
TypeScript typecheck, production build, `git diff --check`, desktop and 390 px
Playwright journeys, and snapshot verification/restore into a new data root.
