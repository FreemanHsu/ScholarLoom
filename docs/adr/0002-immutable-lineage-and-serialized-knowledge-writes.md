---
status: accepted
---

# Preserve immutable lineage and serialize knowledge writes

ScholarLoom never mutates a Paper Version, source asset, accepted Summary, Takeaway,
or Knowledge Revision in place. New understanding creates a revision connected to
its exact inputs through Artifact and Provenance records. Read and generation jobs
may run concurrently, but accepted long-term knowledge changes pass through one
serialized writer. This costs storage and write throughput, but prevents historical
answers from changing meaning and avoids conflicts between Codex tasks, Web edits,
external Markdown edits, SQLite metadata, and derived indexes.
