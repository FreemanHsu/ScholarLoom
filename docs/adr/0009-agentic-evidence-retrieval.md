# ADR 0009: Codex-native Agentic Evidence Retrieval

- Status: Accepted
- Date: 2026-07-21

## Context

ADR 0008 made Discussion recoverable, but each turn still sent one preassembled
PDF/Summary/history/code payload to a one-shot `codex exec`. That limited evidence
exploration and made activity, usage, grounding, cancellation, and restart ownership
implicit.

## Decision

Each Message Attempt owns one long-lived, ephemeral `codex exec`. Codex uses its
native shell, `rg`, file reading, directory exploration, and context management over
a read-only Evidence Workspace. ScholarLoom does not implement a host-side ReAct
loop, query rewriting, session resume, or mandatory FTS/RRF retrieval.

`EvidenceWorkspaceBuilder` materializes a content-addressed derived tree from the
immutable Context Snapshot: fixed extraction pages, Summary Revision, tracked files
from fixed repository commits, bounded recent Conversation context, and the frozen
cross-paper Knowledge Corpus Manifest. Conversation context is never citable.
Markerless builds fail closed; completed trees are hash-checked, symlink/hardlink
checked, read-only, atomically published, registered, and eligible for LRU eviction.

`AgentRunCoordinator` is the sole lifecycle owner. It provides a durable FIFO queue,
two-run default concurrency, one active Attempt per Conversation, epoch-validated
activity/usage/final commits, leases and heartbeats, cancellation, hard timeout, and
explicit retry. Restart changes running/canceling work to `interrupted` and never
silently reruns it. Retry reuses the User Message and frozen Snapshot but creates a
new Attempt.

The Codex adapter uses strict config, JSONL, structured output, read-only inner
sandboxing, and a deny-default macOS filesystem profile. Launch-time capability
canaries verify the minimum tested CLI version (`0.144.6`), strict flags, JSONL and
visual-shim contracts, workspace access, protected-path denial, proxy scrubbing, and
shell-network denial. Failure is infrastructure failure; there is no one-shot
fallback.

Final citations include a bounded verbatim quote. `AnswerGroundingGate` maps each
citation through `MANIFEST.json`, checks citable scope, source ownership, hash, path,
line range, and NFC/whitespace-normalized exact substring. It permits one
deterministic line-location repair from already returned content, then fails closed.
Only final verified citations create Evidence Receipts. Activity is audit/progress,
not evidence. Assistant Message, zero to three Proposals, Receipts, usage, and success
transition commit atomically.

Knowledge Corpus refresh creates a linked successor Conversation. Proposal review
remains the only route to a confirmed Takeaway; Entry Agent retrieval remains active
Summary plus confirmed knowledge only.

## Consequences

- Conversation URLs remain stable; `?evidence=:receiptId` restores the inspector.
- Legacy answers are labeled `legacy_one_shot`; no fabricated activity, usage, or
  Receipt records are created.
- Submodules are not expanded, LFS pointers remain pointers, and excluded binary,
  model, build, and oversized files are not copied into Evidence Workspaces.
- Codex sessions remain disposable. Durable recovery depends only on authoritative
  SQLite/Markdown and rebuildable workspace material.
