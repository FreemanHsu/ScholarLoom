# ADR 0013: Durable abstention-first Takeaway Selection

- Status: Accepted
- Date: 2026-07-30

## Context

Paper answers previously generated zero to three claim fragments inside the same
Codex output. The answer prompt therefore owned an underspecified knowledge decision,
and accepted Markdown omitted most of the canonical Takeaway contract.

## Decision

Paper answering returns only answer, grounding status, citations, and usage. After an
eligible grounded assistant Message and its verified Evidence Receipts commit, the
same SQLite transaction creates one `takeaway-distillation` Job Run. The run freezes
a content-addressed Distillation Context Manifest and independently returns durable
abstention or at most one V2 candidate.

The lifecycle reuses `job_runs`, run epochs, Activity, Usage, interruption, timeout,
and explicit retry. A small ownership record binds Message, contract version, trigger,
focus hash, manifest, terminal outcome, and Proposal. Automatic and explicit-save
identities are separate. Retries reuse the exact manifest.

Selection is abstention-first. Deterministic validation enforces bounded fields,
verified Receipt ownership, manifest hashes, and narrow dangling-reference lints.
There is no mandatory Critic and no semantic prefilter in this slice.

Accepted candidates use structured review. Evidence-backed output may be accepted
directly only while Receipts remain verified and live duplicate warnings are
acknowledged. Interpretation and hypothesis, plus evidence-sensitive edits, require
explicit full evidence review. Duplicate checks are advisory and Paper-scoped.

KnowledgeWriter materializes the full canonical V2 Markdown through the existing
recoverable intent protocol. Curated retrieval indexes claim, evidence rationale,
interpretation when present, and caveat; selection rationale, focus, and duplicate
hints remain operational review metadata.

The production feature remains closed until the versioned 36-case fixture corpus has
three Selection runs per case, blind human grading is complete, and every accepted
hard threshold passes.

## Consequences

- A grounded answer is visible independently of Selection latency or failure.
- Normal no-proposal outcomes and retries survive refresh and restart.
- Conversation text never becomes citable evidence merely because Selection saw it.
- Confirmed Takeaways remain Paper-scoped, standalone, recoverable, and curated-only.
- A future Critic must be justified by measured failures on the same held-out set.
