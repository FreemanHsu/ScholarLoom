---
status: accepted
date: 2026-08-22
---

# ADR 0016: Codex-native curated Knowledge Questions

## Context

The existing Entry Agent performs host-side FTS recall, caps the preassembled context
at eight sources, and executes a one-shot structured Codex call. It cannot maintain a
Knowledge Conversation or let Codex decide whether to search, decompose a broad
question, inspect more sources, or stop without retrieval.

Moving the decision tree into application code would duplicate Agent reasoning in
query parsing, routing, coverage checks, source diversity, and follow-up handling.
Giving Codex unrestricted SQLite, filesystem, or shell access would violate the
curated-only boundary and make source authority difficult to verify.

## Decision

Each Knowledge Question execution epoch owns one long-lived ephemeral `codex exec`.
Codex receives bounded recent successful Knowledge Conversation context and three
invocation-local stdio tools: search curated knowledge, open one returned source, and
verify a candidate citation. The tools mechanically expose only `global-curated`:
active Summary Revisions, confirmed Takeaway Revisions, and active confirmed
knowledge-ready Topic Revisions.

Codex decides whether to retrieve, authors search queries and optional constraints,
iterates when coverage is incomplete, selects final evidence, and distinguishes
source support, agreement, inference, disagreement, and unknowns. ScholarLoom does not
implement a host-side ReAct loop, fixed eight-source recall, mandatory search, query
decomposition tree, or semantic reranker.

Tool budgets are configuration safety ceilings: 30 results per search, 60 unique
candidates, 20 opened documents, 8 search calls, and 20 final Receipts per execution
epoch. They are not user-facing source-count requirements.

The same tool authority preflights every final citation and returns canonical source
identity, revision, hash, locator, and bounded quote. The Codex adapter repeats
preflight before commit. Only verified final citations create curated Evidence
Receipts; search results and Agent Activity are not evidence.

Codex may answer from model knowledge when curated coverage is absent. Such output is
explicitly labeled `model-knowledge`, carries no source marker, does not imply network
access, and is never presented as a ScholarLoom-supported conclusion.

Knowledge Conversation is a separate aggregate from Paper-scoped Conversation.
Paper Conversation continues to freeze one Context Snapshot. Knowledge Conversation
consults the current curated projection per turn and freezes only the exact Receipts
used by successful answers. Old Messages are never reinterpreted or marked stale.

A pending question body is transient. Job state records identity, question hash,
progress, usage, retries, and bounded errors. User/assistant Messages and source
Receipts commit only after successful validation. Cancellation, final failure, and
restart interruption create no Knowledge Message. One submission permits an initial
execution and three automatic retry epochs.

## Consequences

- Codex has maximal decision latitude inside a mechanically narrow corpus.
- Prompt wording guides reasoning, while tools and validation enforce authority; the
  feature does not pretend Prompt alone can query or secure SQLite.
- Retrieval can scale beyond eight candidates without making the browser or host own
  complex ranking policy.
- General answers remain useful when the personal corpus is incomplete, but their
  lack of curated evidence is unambiguous.
- The application adds Knowledge Conversation persistence and curated Receipt storage
  instead of weakening Paper Conversation invariants with nullable scope fields.
- Restart cannot automatically resume an unfinished question because the question
  body was intentionally not persisted; the user must submit again.
- PDF, full Messages, Annotation, code, network search, and entry-Agent downward
  retrieval remain deferred.
