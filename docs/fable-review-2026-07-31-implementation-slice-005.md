# Fable Review: Implementation Slice 005

- Date: 2026-07-31
- Reviewer: Claude Fable 5 through Flowith Canvas
- Target: [`implementation-slice-005-organization-workspace.md`](implementation-slice-005-organization-workspace.md)
- Result: approved after two rounds

## Review progression

Round 1 found one architectural fault line: the draft used live Markdown-derived
attention as part of a keyset cursor while `organizationProposalState` reads and
hashes the Paper manifest. That could both destabilize pagination and amplify
filesystem work. It also identified an unclassified/backfill scope leak for old
Papers with no organization run.

Local evidence established:

- applicability is computed and not stored as durable columns;
- `paper_organization_runs.sequence` is a global autoincrement;
- pre-Migration-022 Papers may have zero runs by design;
- Paper Catalog already supplies reusable search/filter membership;
- browser routes currently serialize filters but no pagination cursor.

Round 2 approved these resolutions:

1. remove pagination/cursors from this single-user slice rather than add a new
   applicability projection;
2. sort the full matching set, then cap at 500 and report truncation;
3. restrict all organize-workspace membership and counts to Papers with at least one
   organization run;
4. derive queue membership, counts, and light attention from SQLite only;
5. batch live verification once per visible Paper and preserve strict command-time
   verification;
6. poll a narrow SQLite-only status read and refresh full detail only on transitions;
7. load decided history per Paper on demand;
8. keep global counts unfiltered and label their scope explicitly.

## Applied judgment

The review did not require a new table, durable applicability projection, or second
state machine. Its two final refinements were adopted:

- truncation happens only after attention-first deterministic sorting;
- visibility verification updates badges without re-sorting cards mid-scroll and is
  memoized per Paper/manifest hash for the page session.

No production Vault content, Paper text, credentials, or environment data was sent.
