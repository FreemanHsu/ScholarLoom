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

Manual add immediately creates or reuses a confirmed association. A root URL detected
in Paper material creates only a candidate and requires explicit confirmation.
Confirmation starts a durable repository-materialization Job. The association remains
readable while that independent Job is running or failed, and retry creates a new
auditable attempt. Existing fixed snapshots are reused across Papers; missing restored
cache fails closed and can only be recovered at the recorded commit.

The existing `code_repositories`, `paper_code_links`, `repository_snapshots`, and
`job_runs` tables express this lifecycle, so no migration is added. v1 does not support
removing or deactivating an association and does not add GitHub search, ranking,
multi-host support, branch selection, or code execution.

Repository attempts use the application's existing background-task dispatch seam while
`job_runs` remains their durable authority. This slice does not create a generic task
system or add cancellation; restart reconciliation and explicit retry are required.

Conversation creation freezes only confirmed, ready Repository Snapshots. Paper
association changes affect future Conversations only. Existing Context Snapshots and
their Repository Snapshots are immutable, including archived and legacy Conversations.
Archived Papers expose their association read model but reject association commands.

## Consequences

- Repository identity and trust become explicit user-inspectable state.
- A detected URL cannot silently enter reliable Agent context.
- Materialization failure does not damage Paper reading or existing associations.
- Snapshot restore remains truthful even though repository cache is excluded: missing
  materialization is visible and exact-commit recovery is explicit.
- Removing associations and retaining a lifecycle tombstone require a future design.
