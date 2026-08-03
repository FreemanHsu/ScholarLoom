# Fable Review: Implementation Slice 004

- Date: 2026-07-31
- Reviewer: Claude Fable 5 through Flowith Canvas
- Target: [`implementation-slice-004-paper-organization-agent.md`](implementation-slice-004-paper-organization-agent.md)
- Result: approved after two rounds with small blocking specification changes

## Review progression

Round 1 challenged the decision payload, Secondary's dependency on Primary, the
activation watermark, same-Paper write serialization, scoped regeneration, manifest
duplication, and stale acceptance.

Local verification established that:

- `review_decisions.result_json` already stores arbitrary validated JSON;
- organization KWR metadata commit already inserts ReviewDecision and accepts the
  Proposal atomically after the Markdown rename;
- `KnowledgeWriter` already reserves one non-terminal organization write per target
  path;
- SQLite is located under the external data root;
- manual organization uses YAML Document serialization and shared domain validation.

Round 2 accepted those existing seams and approved the design after requiring:

1. a versioned `paper-organization-decision.v1` payload;
2. a recorded Primary conditioning baseline for Secondary;
3. no Secondary Proposal when an unlocked Primary is ambiguous;
4. a monotonic, conflict-tolerant Summary-activation trigger outbox instead of a
   wall-clock watermark;
5. content-addressed catalog snapshots;
6. one pending Agent Proposal per Paper/section;
7. hard refusal of stale acceptance;
8. separate generation and materialization retries.

## Applied judgment

The reviewer's suggestion to create generic Proposal rows for `no-fit` and
`not-needed` was not adopted. Those outcomes contain no proposed change and therefore
remain durable section outcomes on the organization run. The read model merges them
with actionable Proposal rows by monotonic run sequence.

Cross-Paper Alias collisions remain warnings rather than errors, preserving the
accepted product rule. Primary promotion may remove a duplicate Secondary only when
the complete diff and Decision payload make the effect visible.

No production Vault content, Paper text, credentials, or environment data was sent
for this review.
