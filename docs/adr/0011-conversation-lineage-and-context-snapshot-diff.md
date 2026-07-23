# ADR 0011: Conversation Lineage and Context Snapshot Diff

- Status: Accepted
- Date: 2026-07-23

## Context

Linked successor Conversations already preserve old frozen context, but the product
does not make their relationship or material changes inspectable. Re-freezing an
identical context can create meaningless branches. The solution must remain
Paper-scoped, deterministic, recoverable after restart, and compatible with archived
and legacy rows.

## Decision

Lineage is derived from `continued_from_conversation_id`; no migration, backfill,
graph table, or persisted diff is introduced. A read model returns the direct parent,
direct successors, and a stable root-to-parent breadcrumb. Traversal stops safely on
missing parents, cycles, cross-Paper links, or excessive depth.

One `ContextSnapshotDiffReader` compares saved snapshots and ephemeral freeze
candidates. It classifies Paper Version and Summary Revision; Extraction provenance
and output equivalence; repositories keyed by repository identity and commit; and
Knowledge Corpus entries using full Paper/revision/content identity. Technical hashes
and run IDs remain audit details.

Continuation preview builds the latest candidate without persistence. Authoritative
creation repeats the comparison, blocks a parent-identical candidate with
`conversation-context-unchanged`, and blocks an existing equivalent child with
`conversation-successor-already-exists`. Only a successful transaction persists the
Knowledge Corpus Manifest, Conversation, and Context Snapshot.

The header uses a compact popover, becoming a full-width overlay on narrow screens.
Archive lifecycle is independent of lineage. Legacy Conversations may create a new
frozen successor, while their historical comparison reports unavailable.

## Consequences

- Existing Conversation and Context Snapshot rows remain immutable.
- Restart recovery requires no reconstruction beyond normal SQLite reads.
- Preview is advisory; POST remains authoritative against concurrent material change.
- The first slice does not provide a tree sidebar, graph canvas, cross-Paper lineage,
  or stored diff history.
