# Implementation Slice 015: Agentic Curated Knowledge Retrieval

- Status: implemented and verified
- Date: 2026-08-22
- Feature design: [`../knowledge-question-feature-design.md`](../knowledge-question-feature-design.md)
- ADR: [`../adr/0016-codex-native-curated-knowledge-questions.md`](../adr/0016-codex-native-curated-knowledge-questions.md)
- Blocked by: [`implementation-slice-014-knowledge-conversation-tracer.md`](implementation-slice-014-knowledge-conversation-tracer.md)

## Goal

Replace the one-shot host-preassembled Entry Agent path with one Codex-native curated
tool loop. Codex decides whether and how to retrieve, may issue iterative searches,
and returns structured claims backed by verified curated Evidence Receipts.

## What this slice includes

- invocation-local `search_curated_knowledge`, `open_curated_source`, and
  `verify_curated_citation` tools;
- explicit invocation-private MCP environment, absolute loader resolution, and a
  fail-closed local tool-list handshake before answer generation;
- production SQLite/vault and deterministic fixture `CuratedKnowledgeReader` adapters;
- mechanical eligibility for active Summary, confirmed Takeaway, and active confirmed
  knowledge-ready Topic revisions only;
- configurable search/candidate/open/Receipt budgets from the accepted design;
- Codex-authored query decomposition and iterative coverage checks;
- separate bilingual, acronym, and full-term searches when one combined FTS query
  would be too narrow;
- structured source-supported, source-consensus, Agent-inference, disagreement, and
  evidence-insufficient output;
- adapter-side citation preflight and atomic curated Receipt commit;
- source drawer, claim markers, and collapsed retrieval summary;
- no-result fallback to a clearly labeled model-knowledge answer;
- replacement of the fixed `slice(0, 8)` candidate contract;
- removal or compatibility redirection of the one-shot `/api/entry-agent/questions`
  browser path after the new route is accepted.

## Non-goals

- raw PDF, Paper working corpus, Message, Annotation, repository, or network search;
- vector retrieval or a host semantic reranker;
- user-authored mandatory scope builder;
- archive lifecycle, which remains Slice 016.

## Acceptance

- [x] A broad fixture question causes multiple Codex tool searches and can inspect
      more than eight candidates.
- [x] Codex may choose no search for a context-only turn.
- [x] Search cannot retrieve a `paper-working` sentinel or any ineligible revision.
- [x] Every visible source marker owns a verified source/revision/hash/locator/quote.
- [x] Model-knowledge fallback has no Receipt or source marker.
- [x] Budget exhaustion is disclosed as partial coverage and does not claim complete
      search.
- [x] Curated projection staleness shows the last successful projection time.
- [x] Full rebuild and outbox projection return equivalent eligible results.
- [x] Real Playwright covers grounded answer, source drawer, retrieval disclosure, and
      uncovered general answer.
- [x] Repository verification and storage snapshot/restore checks pass.
- [x] A temporary workspace can actually start the configured MCP and list all three
      curated tools without inheriting the private binding through the Codex environment.
- [x] A malformed MCP `initialize` response fails closed, and Settings reports the
      Agentic Curated capability independently from Structured and Agentic Evidence.
- [x] Invocation-local MCP startup failure retries three times with new run epochs,
      then reports a capability error without creating a Conversation.
- [x] Automatic retries use abortable `1s`, `3s`, and `10s` backoff.
- [x] Available Topic Knowledge Receipts navigate to the selected canonical Topic editor.
- [x] The retired one-shot question route is no longer exposed.
- [x] A bilingual dexterous-manipulation/RL fixture question retrieves ADEPT.

Verification on 2026-08-23 used a real fixture server and Playwright CLI journey for
both grounded and uncovered questions. Migration 036 was snapshotted, verified, and
restored into a new data root; the restored Receipt and foreign keys were checked.

A 2026-08-23 corrective pass replaced implicit MCP environment inheritance with an
explicit server-only `env`, resolved the `tsx` loader absolutely, added a pre-generation
tool handshake, separated the curated capability status, narrowed retry classification,
and verified the ADEPT bilingual retrieval regression.
