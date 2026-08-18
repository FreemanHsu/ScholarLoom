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

The Codex adapter uses strict config, JSONL, structured output, and one native custom
permission profile for model-generated commands. The profile denies filesystem reads
by default, grants only Codex's minimal runtime plus the Evidence Workspace, grants
writes only to the current Attempt run directory, and disables shell network. It does
not combine legacy `--sandbox` settings with an outer `sandbox-exec`: Codex's
legacy read-only profile allowed broad host reads, while applying it inside an outer
Seatbelt profile failed at runtime.

Attempt run directories live under the current user's `0700` private
`StorageLayout.tmpRoot`, outside system `/tmp` and `$TMPDIR` paths included by the
native minimal runtime policy.
Launch-time capability canaries use the same permission profile and verify the
minimum tested CLI version (`0.144.6`), strict/JSONL flags and the deterministic
JSONL normalizer contract, workspace access, current-run writes, sibling/parent
denial, proxy and secret-variable scrubbing, and external plus loopback shell-network
denial. Minor or patch CLI upgrades are accepted only when those canaries pass; a
major upgrade requires a source-level baseline update and manual recertification.
Failure is infrastructure failure; there is no one-shot fallback.

Final citations include a bounded verbatim quote. `AnswerGroundingGate` maps each
citation through `MANIFEST.json`, checks citable scope, source ownership, hash, path,
line range, and NFC/whitespace-normalized exact substring. It permits one
deterministic line-location repair from already returned content, then fails closed.
Before final output, every text citation must pass the Attempt-scoped
`verify_text_citation` tool. The tool runs the same authority and grounding checks,
returns a canonical citation for the Agent to copy, and records only a citation hash
as preflight audit metadata. The Codex adapter also preflights every returned text
citation itself and replaces it with the canonical result, so correctness does not
depend on the Agent choosing to call the tool. Failed preflights record only a bounded
error code. This does not make Activity evidence or weaken the final gate.
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
