---
status: accepted
date: 2026-07-19
---

# Recover durable writes and isolate Entry Agent retrieval

ScholarLoom keeps Markdown/YAML as the content authority for durable knowledge and
SQLite as the operational authority. A single transaction cannot span both stores, so
every durable write is represented first by a persisted `KnowledgeWriteRequest` intent.
It records byte-exact expected/result hashes, target and staged paths, planned revision,
and monotonic recovery phase. Summary intents additionally retain their planned Markdown
bytes so an explicit retry can rebuild a missing staged Summary without rerunning the
Agent. Recovery rolls forward only when hashes prove it cannot overwrite a later
external edit. Other valid files become non-activating reconciliation Proposals;
missing files become scoped integrity incidents.

The MVP Entry Agent has no access to the shared Paper-working FTS corpus. It queries a
separate curated-only FTS projection in the same SQLite database, fed by the index
outbox and rebuildable from active Summary and confirmed knowledge revisions. This
keeps one SQLite write boundary while mechanically excluding PDF, messages, annotations,
and code from global answers. A stale projection may answer, but the UI must disclose
its last successful update time.

Immutable lineage is tombstoned or superseded rather than physically deleted. Git is
eventual local history/backup, not the identity of a revision.
