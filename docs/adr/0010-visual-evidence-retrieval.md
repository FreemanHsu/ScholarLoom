# ADR 0010: Recoverable Visual Evidence Retrieval

- Status: Accepted
- Date: 2026-07-22

## Context

ADR 0009 lets one long-lived Evidence Agent explore a frozen text workspace, but PDF
text extraction cannot verify charts, diagrams, spatial layout, or other visual-only
claims. A visual extension must preserve the existing Attempt lifecycle, native shell
permission profile, curated-only Entry Agent, atomic grounding commit, and recoverable
storage model.

## Decision

The visual branch gives the same `codex exec` two tools over the invocation-local
stdio MCP: `inspect_pdf_page` and `budget_status`. The shared MCP also exposes the
text-citation preflight required by ADR 0009; it does not expand visual authority.
Visual tool input contains only a
manifest-owned Paper Version source ID and 1-based page. Attempt ID and run epoch are
bound to the per-Attempt shim process and revalidated against SQLite on every call;
there is no model-visible bearer, path, data root, or generic filesystem MCP surface.

Visual MCP requires `approval_policy="never"` because noninteractive Codex otherwise
cancels annotated read-only tool calls. This setting is accepted only together with
the existing native filesystem/network profile and an exact certified CLI allowlist
(initially `0.144.6`). Direct and model-driven canaries prove external network,
loopback, sibling reads, and parent writes remain denied. An uncertified version fails
closed without a legacy fallback.

The host resolves source identity through Attempt → User Message → frozen Context
Snapshot → Paper Version → content-addressed PDF artifact. It opens the artifact with
no-follow semantics, verifies regular-file/link invariants and hashes the opened bytes.
The Agent never supplies a path. A short-lived renderer child receives only verified
PDF bytes on stdin. On macOS it runs under a Seatbelt profile denying network and
writes and allowing reads only from the Node runtime, installed renderer modules, and
the renderer entry file. PDF parsing, page/viewport checks, canvas allocation, and PNG
encoding remain inside the child with time, memory, dimension, input, and output caps.

Each Attempt may request four unique `(source,page)` pairs. Repeated inspection of the
same pair is free but audited. A failed infrastructure render still consumes its unique
page slot; three failed renders also exhaust a separate failure budget. Cancellation invalidates the
epoch before terminating the Codex/shim/renderer process group. A retry creates a new
Attempt, epoch, process, and budget.

Rendered PNGs live in `derived/visual-evidence` as content-addressed, atomically
published, read-only derived artifacts. Receipt reachability pins an artifact; only
unreferenced artifacts enter LRU GC. Missing artifacts may be rebuilt with the frozen
PDF, exact renderer fingerprint, and canonical settings. A hash mismatch records
`render-drift` and never displays the new image. An unavailable fingerprint reports
`renderer-unavailable`. Historical Message and Receipt metadata remain readable.

Text and visual proposed citations form a strict discriminated union. Text requires a
bounded verbatim quote. Visual requires source, page, image hash, and a bounded visual
observation and rejects quote/path/line fields. Only the final grounding gate creates
a Visual Receipt. Activity and inspection cache rows are not evidence.

Migration 017 is forward-only: legacy text receipts remain in `evidence_receipts`;
visual receipts use `visual_evidence_receipts`. Symmetric triggers prevent cross-table
ordinal collisions, and `all_evidence_receipts` is the sole read projection. Message,
zero to three Proposals, text/visual Receipts, usage, and Attempt success still commit
in one SQLite transaction.

## Consequences

- Entry Agent still has no path to PDF or visual cache.
- Visual Receipt images are available at a receipt-scoped endpoint and restored by
  `?evidence=:receiptId`; narrow screens use a full-screen Evidence View.
- Renderer native-code compromise remains a documented residual risk, reduced by the
  parse-free shim, bytes-only child interface, Seatbelt, and resource limits.
- Cross-host PNG reproducibility is not claimed; the platform/runtime is part of the
  renderer fingerprint.
