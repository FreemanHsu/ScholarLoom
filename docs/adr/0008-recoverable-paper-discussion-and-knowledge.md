# ADR 0008: Recoverable Paper Discussion and Knowledge Workspace

- Status: Accepted
- Date: 2026-07-21

## Context

The first Paper chat path invoked Codex before persisting the user Message and kept
the current Conversation only in browser memory. Refresh, interruption, or Codex
failure could lose the visible turn. Citations were embedded JSON and code handles
were path-only, so two frozen repositories could produce ambiguous handles.

## Decision

Paper Workspace has Reading, Discussion, and Knowledge modes. A Conversation belongs
to one Paper and has one immutable Context Snapshot. Creation fails unless the
accepted Paper Version, active Summary Revision, its Extraction Run, and ready
Repository Snapshots can be frozen without guessing.

A send uses two SQLite transactions. Tx1 persists the user Message, running
`job_runs` row, `conversation_turn_attempts`, exact handle manifest in
`job_runs.input_json`, and a durable started event. After output validation, Tx2
atomically persists the successful `agent_runs` row, assistant Message, normalized
citations, Proposals, succeeded state, and completion event.

`job_runs` is the sole operational state authority. `agent_runs` records validated
successful output. Terminal transitions compare-and-set from `running`. Retry creates
a new attempt for the original user Message and frozen Snapshot. One Conversation
may have only one non-terminal attempt.

Migration 015 stamps Conversations `frozen` or `legacy` and records a diagnostic
reason. Incomplete legacy Conversations are readable but cannot send or retry. Their
Takeaway Proposals may be viewed or rejected, but not accepted. “Continue with
latest” creates a new Conversation linked by `continued_from_conversation_id`.

New citations use `message_citations`; `messages.citations_json` is frozen legacy
display data. PDF citations resolve to a Paper Version and Evidence Anchor. Code
citations resolve to a Repository Snapshot, commit, path, and line range. Only
handles persisted in the attempt manifest are accepted.

Proposal review remains the only path to confirmed Takeaways. Raw Messages, PDF
elements, and code elements remain outside curated-only Entry Agent retrieval.

## URL and recovery rules

- Reading: `/papers/:paperId`
- Discussion list: `/papers/:paperId?mode=discussion`
- Conversation: `/papers/:paperId/conversations/:conversationId`
- Knowledge: `/papers/:paperId?mode=knowledge`
- source state: `pdf=open&page=:page&anchor=:anchorId`

Identity is encoded in the path and view state in the query. Citation opening pushes
history; continuous PDF page changes replace it. Desktop and narrow layouts use the
same URL.

## Consequences

- User input and attempt state survive refresh and restart.
- No durable worker is introduced. Tx1 is followed by an immediately tracked
  in-process task; startup marks dead attempts interrupted and never reruns them.
- The composer is disabled while one attempt runs; different Conversations may run
  concurrently.
- Conversation Digest, cross-Conversation memory, reading-state persistence,
  Summary regeneration, and Paper Version comparison remain later work.
