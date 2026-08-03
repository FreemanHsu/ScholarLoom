# Implementation Slice 005: Paper Organization Workspace

- Status: Implemented
- Date: 2026-07-31
- Parent design: [`paper-organization-feature-design.md`](paper-organization-feature-design.md)
- Depends on: [`implementation-slice-004-paper-organization-agent.md`](implementation-slice-004-paper-organization-agent.md)

## 1. Outcome

Add `/papers/organize` as the low-friction home for Paper Alias and Research Direction
curation. It consumes the same Proposal, ReviewDecision, JobRun, and
KnowledgeWriteRequest records introduced in Slice 004; it is a second read/interaction
surface, not a parallel review system.

The workspace lets the user:

- see every Paper with pending organization suggestions or an organization Job that
  needs attention;
- filter by section, Direction, unclassified state, and text;
- review Alias, Primary, and Secondary independently without opening each Paper;
- edit a suggested value before acceptance;
- reject or regenerate exactly one section;
- open the Paper Workspace for deeper reading;
- see applying, conflict, stale, blocked, failed, and retry states.

Batch decisions and taxonomy bootstrap remain Slice 2C/2D work. Slice 005 deliberately
keeps every command single-Paper and single-section.

## 2. Authority and lifecycle

- `/papers/organize` reads the shared `paper-organization` Proposal rows and
  `paper_organization_runs`; it never stores a separate queue.
- Accept/reject/regenerate calls the existing Slice 004 commands.
- Accepted values still materialize through a per-Paper recoverable KWR.
- A conflicted write leaves the Proposal pending and is shown inline with a link to
  the reconciliation item.
- No organization suggestion is added back to the high-stakes Review Center.
- Run outcomes such as `no-fit`, `not-needed`, and
  `blocked-on-primary-ambiguity` appear as contextual status, not fake Proposals.
- Agent rationale is escaped text.

## 3. Read model

Add a bounded operational query:

```ts
type OrganizationQueueQuery = {
  view: "pending" | "attention" | "all";
  section?: "alias" | "primary" | "secondary";
  direction?: string;
  unclassified?: boolean;
  q?: string;
};

type OrganizationQueueItem = {
  paper: PaperCatalogIdentity;
  latestRun: OrganizationRunSummary | null;
  sections: {
    alias: OrganizationSectionReadModel;
    primary: OrganizationSectionReadModel;
    secondary: OrganizationSectionReadModel;
  };
  pendingSectionCount: number;
  attention: boolean;
};
```

Rows are ordered deterministically by:

1. attention before ordinary pending;
2. latest monotonic `paper_organization_runs.sequence` descending;
3. Paper ID ascending.

There is no pagination or cursor in this slice. The endpoint sorts the complete
matching in-lifecycle set first, then returns at most 500 Papers and
`truncated=true` when more rows matched. Applying the cap after the full attention-
first sort prevents ordinary rows from hiding higher-priority work. UUID or
timestamp order is never used to choose the latest suggestion.

`view=pending` includes Papers with at least one pending Agent organization Proposal.
`view=attention` includes a failed/timed-out/interrupted latest Job, stale or
conflicted pending Proposal, or blocked Secondary. `view=all` includes all Papers
with any organization run history. A Paper can satisfy both pending and attention;
views are filters, not lifecycle buckets.

Every view and aggregate count has the same membership fence: a Paper must have at
least one `paper_organization_runs` row. Older zero-run Papers do not appear and have
no Generate affordance here. Slice 2C owns their bootstrap/backfill.

Direction filtering matches:

- Primary Proposal recommended/alternative Topic IDs;
- Secondary Proposal candidate Topic IDs;
- currently confirmed Primary/Secondary assignments.

Text filtering reuses the rebuildable Paper Catalog equality/FTS path for membership
only; it never changes organization ordering and does not search raw Agent rationale
or frozen manifests.

Queue membership, aggregate counts, and initial “light attention” derive only from
SQLite: latest terminal Job state, failed/conflicted KWR, and projected Primary
conditioning for Secondary. The queue endpoint performs no filesystem reads or
hashing. A shared store batch derivation serves both the coordinator and queue rather
than creating a second state machine.

Live applicability verification happens once per visible/expanded Paper, batching
all sections around one manifest read. It updates card badges but never re-sorts the
visible list mid-scroll; sorting changes on the next whole-list refresh. Verification
is memoized by Paper/manifest hash per page session and invalidated after a relevant
state transition. Command-time verification remains strict.

The read model contains bounded Proposal payloads and current Paper Catalog identity,
but never returns Summary bodies, catalog snapshots, prompts, or Agent manifests.

## 4. HTTP

Add:

- `GET /api/paper-organization/queue`;
- reuse `POST /api/paper-organization/proposals/:id/decision`;
- reuse `POST /api/papers/:id/organization-suggestions`;
- reuse `POST /api/paper-organization/jobs/:id/retry`.

Invalid Direction IDs, section, or view return a stable 400 code.
The response includes `items`, `truncated`, and aggregate counts for
`pendingPapers`, `attentionPapers`, and `unclassifiedPapers`.

Counts are computed from current rows independently of filters and use the same
in-lifecycle membership fence. UI labels them “全部待确认 / 全部需处理 / 全部未分类”.
They are operational projections and do not enter Markdown. Light attention may
under-count an unobserved external edit; visible and command-time verification
preserve correctness without putting filesystem work on the queue hot path.

Add a bounded SQLite-only status read for the visible non-terminal JobRun/KWR IDs.
It is not a second lifecycle endpoint: it returns only identifier/state pairs.

## 5. Browser interaction

Add a top-level route `/papers/organize` and a “整理建议” entry from the Paper Library.
Route state is fully URL-owned:

```text
/papers/organize
  ?view=pending|attention|all
  &section=alias|primary|secondary
  &direction=:topicId
  &unclassified=true
  &q=:query
```

No cursor is accepted or serialized. Unknown query parameters are ignored.

Desktop:

- compact filter rail with Pending, Needs attention, and All;
- main column renders one Paper card at a time;
- each Paper card has Alias, Primary, Secondary sections;
- only pending sections expose editor/actions;
- succeeded/rejected/superseded history is loaded per Paper on demand under “历史”;
- “打开 Paper” preserves a return URL to the organize workspace.

Mobile:

- filters collapse into a drawer;
- one-column Paper cards;
- section actions remain sticky within the card, not viewport-global;
- no horizontally scrolling tables or raw JSON editors.

Independent confirmation remains visually explicit: every section has its own
Accept, Reject, and Regenerate controls. There is no Paper-level “accept all” in this
slice.

After a command, the client refreshes the affected Paper card and aggregate counts.
It does not optimistically claim that Markdown changed. Polling occurs only while a
visible Job/KWR is non-terminal through the narrow SQLite-only status read: 750 ms
initially, backing off to 2 seconds after 30 seconds, with no background-page
polling. A full Paper detail refresh occurs once on an observed transition.

## 6. State and failure behavior

- `ready`: Accept enabled.
- `blocked`: Accept disabled and Primary dependency explained.
- `stale`: Accept disabled; scoped Regenerate is primary.
- `applying`: all duplicate commands disabled while KWR is non-terminal.
- `conflicted`: Proposal stays pending; show reconciliation link and materialization
  retry only after reconciliation.
- failed/timed-out/interrupted generation: show exact section scope and
  `retryGeneration`; retry remains pinned to the original manifest.
- `direction-catalog-too-large`: non-retryable guidance, no retry button.

Client command idempotency keys are created once per visible user action and retained
until that action reaches a terminal response. React rerenders never create a second
key for an in-flight action.

If another surface decides the same immutable Proposal first, the losing surface's
409 response silently refreshes the card instead of showing a generic failure.

## 7. Implementation increments

1. Shared SQLite-only queue derivation, deterministic sort/cap, counts, and API tests.
2. Browser route/parser/serializer and Paper Library entry.
3. Queue cards reusing a shared organization-section editor extracted from the
   Workspace drawer.
4. Attention/retry/conflict states, foreground polling, responsive styling.
5. Real desktop/mobile Playwright journey.

## 8. Acceptance

- `/papers/organize` shows the same pending sections as the Paper Workspace drawer.
- Alias can be accepted while Primary remains pending.
- Secondary is visibly blocked until its conditioned Primary is confirmed.
- A stale suggestion cannot be accepted from either surface.
- Editing and accepting records the exact accepted value in
  `paper-organization-decision.v1`.
- Reject changes no Markdown.
- Scoped regeneration replaces only its section's pending Proposal.
- failed generation retry stays on the frozen manifest.
- attention/pending overlap is represented without double-rendering a Paper.
- URL filters survive refresh, back, and forward.
- the 500-row cap is applied after deterministic attention-first sorting and reports
  truncation without dropping higher-priority work first.
- narrow-screen cards and filter drawer are usable at 390 px.
- organization-only actions do not change `global-curated`.
- tests, typecheck, build, `git diff --check`, and a real Playwright journey pass.

## 9. Non-goals

- taxonomy proposal generation or Direction creation;
- existing-library backfill;
- batch accept/reject/regenerate;
- Topic rename, Scope revision, merge, or redirect migration;
- legacy `topics:` migration;
- auto-accept or calibrated policy;
- hierarchy.

## 10. Implementation record

Implemented on 2026-07-31:

- added the SQLite-only `/api/paper-organization/queue` read model, global counts,
  stable filters, attention-first ordering, 500-Paper post-sort cap, and bounded
  status reads;
- added `/papers/organize`, URL-owned filters, the Paper Library entry, deferred
  live verification on first card expansion, per-section decisions/regeneration,
  history, failure retry, and a safe organize-workspace return URL;
- kept zero-run Papers outside the workspace so Slice 2C remains the sole backfill
  owner;
- verified independent confirmation and queue refresh in a real desktop browser,
  plus the 390 px mobile filter drawer;
- passed 242 repository tests (the initial sandboxed run exposed only expected
  loopback/isolated-renderer permission failures; the approved native run passed),
  TypeScript typecheck, production build, and `git diff --check`;
- created, verified, and restored a real snapshot containing the new organization
  operational state with SQLite integrity `ok` and no foreign-key violations.
