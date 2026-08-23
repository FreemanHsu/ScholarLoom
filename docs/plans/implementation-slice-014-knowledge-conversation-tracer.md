# Implementation Slice 014: Knowledge Conversation Tracer

- Status: implemented and verified
- Date: 2026-08-23
- Feature design: [`../knowledge-question-feature-design.md`](../knowledge-question-feature-design.md)
- Depends on: current `main`

## Goal

Deliver the first complete standalone Knowledge Question path without curated tool
retrieval. A user can submit from Research Home or `/questions`, receive a validated
Codex answer labeled `model-knowledge` or `conversation-context`, and see successful
turns persist in a separate Knowledge Conversation.

## What this slice includes

- top-level `知识问答` navigation and `/questions` plus `/questions/:id` routes;
- active Conversation sidebar and new-Conversation state;
- Knowledge Conversation/Message/Attempt SQLite migration and read/write module;
- first-turn creation only after a successful answer;
- follow-up submission with bounded recent successful Message context;
- deterministic title from the first successful question;
- structured `answerBasis`, `coverage`, direct answer, claims, unknowns, and empty
  citation contract;
- production Codex CLI adapter and deterministic fixture adapter;
- canceling or failing a turn creates no Knowledge Message;
- Home submission enters the same route and module rather than rendering another
  one-shot result;
- direct-link, refresh, back, and forward behavior;
- Settings exposure for the new task kind and runtime contract.

## Non-goals

- curated search/open/verify tools;
- source drawer or grounded source markers;
- automatic retries beyond one execution;
- archive/restore and unavailable-source presentation;
- Paper/Topic/Summary entry points;
- hard delete.

## Deep module seam

Web handlers and browser code use the `KnowledgeConversation` interface from the
feature design. Codex execution is injected through production and fixture
`KnowledgeAnswerRunner` adapters. Tests do not call storage internals or construct
Codex prompts.

## Acceptance

- [x] Research Home and `/questions` submit through the same application module.
- [x] The first successful turn creates exactly one Knowledge Conversation and two
      immutable Knowledge Messages.
- [x] Cancel or forced failure leaves no Conversation or Message for a new draft.
- [x] A follow-up sees prior successful Messages and persists at the next ordinals.
- [x] `model-knowledge` visibly says `通用回答 · 无知识库证据` and has no source marker.
- [x] Existing Paper Conversation tests and frozen Context Snapshot invariants remain
      unchanged.
- [x] Real temporary SQLite/filesystem integration tests cover migration, idempotency,
      success transaction, failure, cancellation, and restart interruption.
- [x] A real Playwright journey covers Home → question → saved route → refresh →
      follow-up.
- [x] `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check` pass.
- [x] Snapshot verification and restore into a new temporary root pass.

## Implementation record

- Migration `035-knowledge-conversations.sql` adds the independent Conversation,
  immutable Message, and transient Attempt audit tables. A v34-compatible temporary
  root is snapshot-verified before migration in the integration suite.
- `KnowledgeConversationCoordinator` owns admission, bounded history, concurrency,
  hard timeout even for an uncooperative runner, cancellation with durable idempotent
  replay, submission idempotency conflict detection, successful-turn-only commit,
  restart interruption, and read models.
- `KnowledgeAnswerRunner` has production Codex CLI and deterministic fixture adapters;
  the direct-answer schema mechanically forbids retrieval and citations in this slice.
- Browser verification on 2026-08-23 exercised Home submission, the stable saved URL,
  refresh, a follow-up, and back/forward restoration in a real Chromium session. A
  delayed-Attempt journey also verified that navigating to the Paper Library is not
  overwritten by a late answer and that returning leaves no stale running state.
- A fresh schema-35 acceptance root was snapshot-verified across 22 files and restored
  into a new root. Diagnostics against the final restored root reported healthy
  SQLite integrity, no foreign-key violations, and no interrupted work.
