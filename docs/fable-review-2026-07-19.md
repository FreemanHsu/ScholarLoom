# External architecture review record — 2026-07-19

This record captures the decisions made after a three-round external Claude Fable 5
architecture review. Only a sanitized architecture summary was shared; no repository
files, paths, credentials, paper assets, or personal knowledge content were sent.

## Adopted findings

1. Durable Markdown/SQLite writes require a persisted intent and deterministic
   recovery state machine.
2. Immutable lineage must be tombstoned/superseded, not physically deleted.
3. The v1 Entry Agent needs a curated-only FTS projection, separate from the shared
   Paper-working corpus, plus negative retrieval fixtures.
4. Evidence shown as verbatim must be verified against the pinned source page; an
   unresolved quote cannot take the one-click confirmation path.
5. Explicit arXiv versions are authoritative; bare IDs resolve once and freeze.
6. Explicit repository links resolve and persist a commit SHA before use.
7. Tailscale Serve requires an operational SSE contract: heartbeat, event replay, and
   no state inference from a disconnected stream.

## Owner decisions confirmed

- When the curated index is stale, Entry Agent may answer from the last successful
  projection only while showing a staleness notice and timestamp.
- Unresolved Markdown reconciliation Proposals are retained forever and archived from
  the active queue after 30 days.

## Deliberately not adopted

A second physical SQLite database for Entry Agent retrieval was rejected for v1. It
would complicate the single-write recovery boundary. The curated-only shadow FTS table
provides the required mechanical corpus separation within one database.

See [`adr/0005-recoverable-writes-and-curated-entry-retrieval.md`](adr/0005-recoverable-writes-and-curated-entry-retrieval.md)
for the binding architectural decision.
