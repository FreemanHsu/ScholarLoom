# Implementation Slice 004: Paper Organization Agent

- Status: Implemented
- Date: 2026-07-31
- Parent design: [`paper-organization-feature-design.md`](../paper-organization-feature-design.md)
- Scope: automatic per-Paper organization analysis, independently reviewable Alias/Primary/Secondary Proposals, and Workspace review

## 1. Outcome

When a new Paper Summary becomes active, ScholarLoom automatically runs a dedicated
Paper Organization Agent against a frozen Paper-and-Direction manifest. The Agent
may suggest Paper Aliases, one Primary Research Direction, and up to three Secondary
Research Directions. It never creates a Direction, changes Markdown, accepts a
Proposal, or enters the curated knowledge corpus.

The three suggestion sections are independently reviewable:

```text
Active Summary
→ durable paper-organization Job
→ one Agent Run and one proposal group
   ├── Alias Proposal
   ├── Primary Proposal
   └── Secondary Proposal
→ accept / accept-with-edit / reject per section
→ one recoverable Paper KWR per accepted section
→ authoritative Paper Markdown
→ rebuildable Paper Catalog projection
```

This slice is complete when the automatic journey works through the browser, survives
restart and retry, and preserves external Markdown edits as conflicts.

## 2. Fixed product rules

- Classification follows the Paper's core research problem/contribution.
- A Paper has at most one Primary and at most three Secondary Directions.
- Secondary requires a confirmed Primary and a material contribution; merely using a
  technique is insufficient.
- Alias candidates must refer to the whole Paper. The Agent may emit
  `model-name`, `method-name`, `acronym`, or `project-name`, but never `user-defined`.
- Existing confirmed Primary is locked. The automatic trigger emits
  `not-needed`; only an explicit `primary` regeneration request may evaluate a
  replacement.
- All automatic suggestions require user confirmation.
- A missing fitting Direction is a durable `no-fit` outcome, not a failed Job and not
  permission to create a Topic.
- Only Summary activations that append a post-Migration-022 durable trigger are
  automatically scheduled. The coordinator never scans historical active Summaries;
  existing-library backfill belongs to Slice 2C.

## 3. Agent contract

### 3.1 Configuration

Add `paper-organization` to the application-owned Agent Configuration Registry:

| Field | Value |
|---|---|
| display name | Paper Organization Agent |
| model | `gpt-5.6-sol` |
| reasoning effort | `medium` |
| timeout | 180 seconds |
| concurrency | 1 |
| execution mode | `structured-one-shot` |
| network | denied |
| tools | none |
| workspace | ephemeral read-only |
| Skill | `skills/paper-organization/SKILL.md` |

Settings and execution consume the same registry. Agent Run lineage records the
model, effort, Codex version, configuration version, Skill hash, Prompt hash, output
Schema hash, and exact manifest identity.

### 3.2 Frozen manifest

The enqueue transaction creates an immutable operational manifest containing:

- contract version and trigger scope;
- Paper ID, current Paper Version ID, canonical title, authors, and external identities;
- active Summary Revision ID, Summary Markdown hash, and the bounded structured
  Summary material actually sent to the Agent;
- authoritative Paper manifest path/hash and current confirmed aliases/directions;
- a reference to a content-addressed Direction Catalog snapshot containing every
  active, confirmed, direction-usable Topic's ID, title, aliases, Scope, revision
  ID/hash, and `direction_semantic_hash`;
- the referenced snapshot's full `direction_catalog_hash`;
- Prompt/Schema/Skill contract hashes.

The manifest may duplicate bounded projection text needed to replay an Agent Run, but
it is operational audit, not a Markdown authority or retrieval source. It must not
contain raw PDF text, Conversations, Entry Agent results, credentials, environment
data, or unrelated Vault content.

Initial flat taxonomies send the entire active Direction set. The hard limit is 64
active Directions. Crossing it produces a non-retryable
`direction-catalog-too-large` outcome and a user-facing request to organize the
taxonomy; the Agent never receives a silent sample. Candidate retrieval is deferred
until the hierarchy/scaling design exists.

SQLite is located under the external data root. Operational manifests and catalog
snapshots never enter the repository or retrieval corpus. A future hard-delete path
must cascade the Paper's operational manifests; current lifecycle deletion retains
the audit trail.

### 3.3 Output

An automatic `scope=all` result contains every in-scope independently materializable
section. Explicit regeneration uses a dynamic runtime Schema for
`scope=alias|primary|secondary`; out-of-scope sections are neither requested nor
emitted, and scoped regeneration supersedes only that section.

```ts
type OrganizationOutcome = "proposal" | "ambiguous" | "no-fit" | "not-needed";

type PaperOrganizationAgentResult = {
  coreProblem: string;
  mainContribution: string;
  alias: {
    outcome: "proposal" | "not-needed";
    candidates: Array<{
      name: string;
      kind: "model-name" | "method-name" | "acronym" | "project-name";
      preferred: boolean;
      rationale: string;
    }>;
  };
  primary: {
    outcome: OrganizationOutcome;
    recommendedTopicId: string | null;
    rationale: string;
    alternatives: Array<{ topicId: string; rationale: string }>;
  };
  secondary: {
    outcome: "proposal" | "ambiguous" | "no-fit" | "not-needed";
    candidates: Array<{ topicId: string; rationale: string }>;
  };
  usage: AgentUsage;
};
```

The JSON Schema closes every object, bounds text and arrays, and restricts every
Topic ID to the runtime manifest allowlist. The host validator additionally enforces:

- one Preferred Alias at most;
- normalized Alias uniqueness and no canonical-title duplicate;
- Primary recommendation/alternative uniqueness;
- at most two Primary alternatives and three Secondary candidates;
- no Primary/Secondary duplicate;
- non-empty rationale for every Direction;
- status/value consistency;
- locked Primary cannot produce an automatic replacement.

No numeric confidence is emitted. `ambiguous` plus explicit alternatives is the
review signal.

When an unlocked Primary result is `ambiguous`, no Secondary Proposal is created.
The run records the Secondary section outcome as
`blocked-on-primary-ambiguity`. When a Secondary Proposal is created, it always
stores `conditionedOnPrimaryTopicId`, taken from the locked confirmed Primary or the
unambiguous recommended Primary.

When Primary is already confirmed, automatic scope excludes Primary entirely rather
than asking the model to return `not-needed`. Explicit Primary reevaluation lifts
that lock only for its scoped run.

## 4. Durable execution

### 4.1 Tables

Migration 022 adds:

- `paper_organization_manifests`: immutable manifest JSON/hash and frozen identities;
- `paper_organization_catalog_snapshots`: content-addressed bounded catalog JSON;
- `paper_organization_triggers`: monotonic durable activation outbox with unique
  `(paper_id, summary_revision_id, contract_version)`;
- `paper_organization_runs`: one row per Job attempt with trigger, scope, manifest,
  outcome, proposal group, monotonic sequence, and error/result metadata;
- indexes that make `(Paper, Summary, catalog, contract, scope)` idempotent;
- expression indexes over organization Proposal payloads, including a partial unique
  index enforcing at most one pending Agent Proposal per `(paper_id, change_kind)`.

Existing `job_runs`, `agent_runs`, `agent_run_usage`, `proposals`,
`review_decisions`, `knowledge_write_requests`, and `index_outbox` remain the shared
lifecycle records. No second generic proposal/review system is introduced.

### 4.2 Trigger and recovery

Summary activation records a durable automatic organization trigger only when:

- the Summary is active for the Paper's current Paper Version;
- no identical automatic run exists.

The trigger insert uses `ON CONFLICT DO NOTHING` in the same SQLite transaction that
makes the Paper Version/Summary current and completes the Summary KWR. Trigger
failure can never abort Summary activation. Existing completed Summaries have no
trigger rows and are never discovered by a startup scan. Contract-version bumps do
not retroactively insert triggers.

Trigger consumption and Job creation are one transaction and
`paper_organization_runs.trigger_id` is unique, so a crash cannot double-schedule a
trigger. Idempotency uses Paper ID, immutable Summary revision/hash, and contract
version rather than time.

A coordinator with concurrency one claims queued
`paper-organization` Jobs, maintains lease/heartbeat/run epoch, records usage, and
marks application-close work `interrupted`. Startup recovers queued work and exposes
failed/timed-out/interrupted attempts for explicit retry.

Before freezing a manifest, the coordinator verifies that the Paper manifest exists
and has no non-terminal Paper-manifest or organization KWR. A trigger waits rather
than snapshotting an intermediate manifest during Summary/Paper-manifest recovery.

A retry uses the same manifest. A manual section regeneration creates a new manifest
and Job with `scope = alias | primary | secondary`; it supersedes only still-pending
Proposals for that section after a schema-valid successor has been produced.

### 4.3 Proposal generation

A successful full run creates a stable proposal group ID and zero to three
`paper-organization` Proposals:

- `change_kind = alias`;
- `change_kind = primary-direction`;
- `change_kind = secondary-direction`.

Each Proposal payload stores `sourceKind=agent`, the group/run/manifest IDs, complete
before and proposed after values, rationale, alternatives where relevant, the
relevant semantic/base hashes, and for Secondary,
`conditionedOnPrimaryTopicId`. `no-fit`, `not-needed`, and
`blocked-on-primary-ambiguity` remain run outcomes rather than empty Proposals.
`ambiguous` remains actionable and creates a Proposal.

An Agent Run never updates an existing pending Proposal in place. Regeneration
creates new immutable Proposal rows and supersedes replaced pending rows.

## 5. Three independent decisions

### 5.1 Review, applicability, and materialization

The read model deliberately separates:

- review: `pending | accepted | rejected | superseded`;
- applicability: `ready | blocked | stale`;
- materialization: derived from KWR as
  `not-started | applying | succeeded | failed | conflicted`.

`review_status` remains `pending` while an accept attempt is applying or conflicted.
The immutable accepting ReviewDecision is recorded only in the same metadata
transaction that completes the authoritative write. This preserves the existing
rule that an external Markdown conflict leaves the Proposal pending.

Every organization ReviewDecision `result_json` validates against
`paper-organization-decision.v1` before the write is reserved:

```ts
type PaperOrganizationDecisionV1 = {
  schemaVersion: "paper-organization-decision.v1";
  sectionKind: "alias" | "primary-direction" | "secondary-direction";
  action: "accept" | "accept-with-edit" | "reject";
  agentProposed: unknown;
  userAccepted: unknown | null;
  edited: boolean;
  editedFields: string[];
  resultingOrganization: PaperOrganizationInput | null;
};
```

For accepted decisions, `userAccepted` is the exact chosen subset/value and
`resultingOrganization` is the complete organization written to Markdown. Accepting
an alternative Primary uses this same path without special casing.

### 5.2 Field-local application

Accepting one section re-reads the latest authoritative Paper Markdown and modifies
only that section:

- Alias Proposal replaces the confirmed Alias set and preserves all Directions.
- Primary Proposal replaces only Primary and preserves valid Secondary values.
- Secondary Proposal replaces only the Secondary set and preserves Primary.

The writer validates the resulting complete organization before staging Markdown.
Accept-with-edit stores both the Agent suggestion and final accepted value in the
ReviewDecision result.

Secondary is `blocked` until a confirmed Primary exists. Accepting Primary
immediately re-evaluates the Secondary Proposal. If the chosen Primary equals a
Secondary candidate, the UI removes that candidate before submission; the host
still rejects duplicates.

Promoting an already-confirmed Secondary to Primary is the one visible cross-section
normalization: the duplicate Secondary is removed. The pre-commit diff and versioned
Decision payload must show this change; it is never silently filtered.

### 5.3 Staleness

Applicability is field-local:

- Alias checks its before value, Paper identity, and normalization/collision rules.
- Primary checks current Primary, Summary identity, target Direction activity, and
  target semantic hash.
- Secondary checks current Secondary, confirmed Primary, Summary identity, each
  target Direction, semantic hashes, and requires confirmed Primary to equal
  `conditionedOnPrimaryTopicId`.

Title/Alias-only Direction changes do not make proposals stale. Scope, exclusion,
lifecycle, usage-level, or supersession changes do.

`stale` hard-refuses acceptance. The application performs no semantic rebase and
offers scoped regeneration instead.

Manual organization saves supersede only pending Agent Proposals whose owned section
changed. This supersession is committed in the same KWR metadata transaction as the
manual edit; unrelated section Proposals remain pending.

Reject records a ReviewDecision and changes no Markdown. The same frozen input does
not automatically propose the rejected section again.

## 6. Interfaces

The main seam is a `PaperOrganizationCoordinator`:

```ts
enqueueAutomatic(paperId, summaryRevisionId): { jobRunId; replayed }
request(paperId, scope, idempotencyKey): { jobRunId; replayed }
retryGeneration(jobRunId, idempotencyKey): { jobRunId; replayed }
retryMaterialization(proposalId, idempotencyKey): DecisionResult
readForPaper(paperId): OrganizationReadModel
decide(proposalId, action, editedValue, idempotencyKey): DecisionResult
close(): Promise<void>
```

The coordinator owns manifests, Jobs, Agent Runs, Proposal generation, eligibility,
retry, and decisions. It delegates canonical Markdown mutation to the existing
Paper organization store/KnowledgeWriter. React and Fastify never construct YAML or
resolve redirect/semantic validity themselves.

The Agent adapter satisfies a narrow `PaperOrganizationRunner` interface and cannot
receive storage or decision capabilities.

## 7. HTTP and browser interaction

Add:

- `GET /api/papers/:id/organization-suggestions`;
- `POST /api/papers/:id/organization-suggestions` for explicit scoped regeneration;
- `POST /api/paper-organization/jobs/:id/retry`;
- `POST /api/paper-organization/proposals/:id/decision`.

Every command requires an Idempotency-Key. The existing direct-edit
`PUT /api/papers/:id/organization` remains authoritative manual editing.

The existing organization drawer gains two modes:

1. Current organization: existing manual editor.
2. Suggestions: one Paper card with separate Alias, Primary, and Secondary sections.

Each section supports accept, edit-and-accept, reject, and regenerate. The UI shows
queued/running/failed Job state, ready/blocked/stale applicability, applying/conflict
state, and actionable retry. Pending counts remain Paper counts in navigation while
the Paper card may show the number of pending sections.

The read model merges Proposal rows with non-Proposal section outcomes by the
monotonic `paper_organization_runs.sequence`, never by timestamp or UUID ordering.
Agent-authored rationale is rendered as escaped text, not raw HTML.

## 8. Implementation increments

### Increment 1 — Contract and configuration

- application-owned Skill, Prompt, schema, runtime allowlists, and host validator;
- 1–120-character Alias candidate bounds, rejection of C0/C1 controls and line
  breaks, and reuse of manual-entry normalization/deduplication;
- Agent Configuration Registry and read-only Settings exposure;
- Codex CLI and fixture runner support.

### Increment 2 — Manifest and Job lifecycle

- migration 022;
- frozen manifest builder;
- coordinator queue, automatic trigger, retry, interruption, usage, and Agent Run
  lineage;
- schema-valid output creates grouped independent Proposals.

### Increment 3 — Decision and recoverable writes

- field-local applicability;
- accept/edit/reject commands;
- field-local KWR rendering;
- manual edit supersession;
- external conflict and restart recovery.

### Increment 4 — Workspace

- suggestions read model and commands;
- drawer modes and independent section controls;
- pending Paper count and Job/error states;
- narrow-screen behavior.

## 9. Acceptance

- A newly active fixture Summary schedules exactly one automatic organization Job.
- Existing Summaries without a durable trigger are not backfilled.
- Duplicate trigger insertion cannot abort Summary activation, and one trigger owns
  at most one first Job attempt.
- One Agent Run produces independently reviewable Alias, Primary, and Secondary
  Proposals with a shared group ID.
- Existing confirmed Primary blocks automatic replacement.
- Alias can be accepted while Primary remains pending.
- Secondary cannot materialize before Primary; it becomes ready after Primary
  confirmation only when that Primary equals its recorded conditioning baseline.
- An ambiguous unlocked Primary creates no Secondary Proposal.
- Reject changes no Markdown. Manual Alias edit supersedes only the Alias suggestion.
- Accept-with-edit records proposed and final values.
- Every Decision validates as `paper-organization-decision.v1`.
- Topic IDs outside the frozen allowlist, duplicate aliases/directions, missing
  rationales, and invalid outcome combinations fail closed without Proposals.
- External Paper Markdown change leaves the Proposal pending and the KWR conflicted.
- Retry is idempotent and fixed to the original manifest.
- Process restart preserves queued/running/interrupted Jobs and pending Proposals.
- No Organization content enters `global-curated`.
- Settings uses the same task configuration as execution and exposes no materialized
  Paper/manifest content.
- Snapshot/restore into a new temporary root preserves Jobs, Proposals, Markdown, and
  catalog rebuild results.
- `npm test`, `npm run typecheck`, `npm run build`, `git diff --check`, SQLite
  integrity/foreign-key checks, and a real Playwright journey pass.

## 10. Non-goals

- `/papers/organize` batch workspace or batch decisions;
- taxonomy bootstrap, Direction creation by Agent, or existing-library backfill;
- Direction rename, Scope edit, merge, or redirect migration;
- legacy `topics:` migration;
- confidence-based or policy-based auto-accept;
- Entry Agent Alias resolution;
- knowledge-ready Topic indexing;
- Domain hierarchy.

## 11. Implementation record

Implemented on 2026-07-31 with:

- Migration 022 durable trigger, catalog snapshot, manifest, and run tables;
- a dedicated, configuration-registry-backed Paper Organization Agent;
- automatic post-Summary scheduling without historical startup scans;
- frozen, content-addressed manifests and runtime Topic-ID allowlists;
- grouped Alias, Primary, and Secondary Proposals with one pending Agent Proposal
  per Paper/section;
- field-local accept, accept-with-edit, reject, staleness, Primary conditioning, and
  recoverable KWR materialization;
- manual-edit supersession limited to changed sections;
- Workspace Agent-suggestion/current-organization modes and responsive drawer;
- fixture and production runner wiring.

Verification:

- 240 Vitest tests passed, including the new automatic-trigger and independent
  decision integration journey;
- TypeScript typecheck and production Vite build passed;
- `git diff --check` passed;
- a real headed Playwright journey created a Direction, imported a Paper, observed
  the automatic Primary Proposal, confirmed it independently, verified the
  authoritative current organization, and inspected the 390×844 drawer.
