# ADR 0012: Manual Repository Association and Visibility

- Status: Accepted
- Date: 2026-07-23

## Context

Repository association previously treated a GitHub URL detected in Paper content as
reliable enough to clone automatically. A wrong association can contaminate Paper
context, later Conversations, Evidence Workspaces, and code citations. Users also
lacked a direct, inspectable way to associate a known repository or see its pinned
version and recovery state.

## Decision

Paper Workspace provides a URL-restorable repository drawer and a manual GitHub
repository root URL command. URLs are accepted only for exact
`https://github.com/owner/repository` roots; allowed trailing `/` and `.git` forms
normalize to a lowercase canonical identity. Nested routes, alternate hosts,
credentials, ports, query strings, and fragments are rejected.

Manual add immediately creates or reuses a confirmed association. Automatic repository
detection is disabled: importing Paper text does not create a candidate, association,
or materialization Job. Historical candidates remain readable and may still be
confirmed or removed, but no new ingestion path creates them. Confirmation or manual
add starts a durable repository-materialization Job. The association remains readable
while that independent Job is running or failed, and retry creates a new auditable
attempt. Existing fixed snapshots are reused across Papers; missing restored cache
fails closed and can only be recovered at the recorded commit.

The existing `code_repositories`, `paper_code_links`, `repository_snapshots`, and
`job_runs` tables express this lifecycle, so no migration is added. Remove changes the
PaperCodeLink status to `rejected`, preserves its Repository Snapshot pointer, and
writes a synchronous succeeded `repository-association-remove` ledger entry in the
same transaction. Replaying that idempotency key never re-evaluates current state, so
a delayed replay cannot remove a later manual re-add. Only manual add can reactivate a
rejected link, changing its origin to `manual`; no removed-items UI is provided.
Ready-snapshot add, re-add, and confirm commands also write synchronous succeeded
ledgers, so their delayed replays cannot revive an association removed afterward.
GitHub search, ranking, multi-host support, branch selection, and code execution remain
out of scope.

Repository attempts use the application's existing background-task dispatch seam while
`job_runs` remains their durable authority. This slice does not create a generic task
system or add cancellation; restart reconciliation and explicit retry are required.

Conversation creation freezes only confirmed, ready Repository Snapshots. Paper
association changes affect future Conversations only. Existing Context Snapshots and
their Repository Snapshots are immutable, including archived and legacy Conversations.
Archived Papers expose their association read model but reject association commands.

## Consequences

- Repository identity and trust become explicit user-inspectable state.
- Paper content cannot silently create repository state or enter reliable Agent context.
- Materialization failure does not damage Paper reading or existing associations.
- Snapshot restore remains truthful even though repository cache is excluded: missing
  materialization is visible and exact-commit recovery is explicit.
- Removal is recoverable through the same canonical manual add without mutating frozen
  Conversation snapshots.
