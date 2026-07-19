---
status: accepted
---

# Use storage according to data authority

ScholarLoom stores human-maintained long-term knowledge in Markdown/YAML, immutable
source assets on the local filesystem, and operational identity, conversation,
review, and job state in SQLite. Search, vector, graph, and Wiki stores are disposable
projections. A Markdown-only design makes transactional conversation and job data
fragile, while a database-only design makes personal knowledge opaque and difficult
to migrate or edit outside the application.

Knowledge Markdown therefore outranks its SQLite cache. External edits are validated
and reconciled; the database must not silently overwrite them.
