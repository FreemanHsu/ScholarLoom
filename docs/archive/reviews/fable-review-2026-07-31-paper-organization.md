# External Paper Organization design review record — 2026-07-31

This record captures a five-turn Claude Fable 5 review of the Research Direction and
Paper Alias design. A compact repository brief, accepted product decisions, schema
excerpts, and implementation evidence were shared. No production vault content,
credentials, secrets, or personal Paper knowledge was sent.

The resulting feature contract is
[`paper-organization-feature-design.md`](../../paper-organization-feature-design.md).

## Review conversation

The five review rounds covered initial architecture and interaction critique,
repository-backed clarification, state-machine and migration corrections,
implementation gates, and the final ReviewDecision/KWR ordering amendment.

## Adopted findings

1. Research Direction remains a role of Topic, but a classification-only direction
   must not be mistaken for a Topic approved for global knowledge answers.
2. Topic `usage_level = classification | knowledge-ready` belongs to Topic revision.
   Confirmation and Entry retrieval eligibility remain independent.
3. Organization suggestions use the same Proposal, ReviewDecision and KnowledgeWriteRequest
   discipline as other proposals. Only their primary UI surface and counts differ:
   “UI 分流，纪律不分流”.
4. Two Proposal types provide a clearer contract than one overloaded type:
   `paper-organization` for per-Paper changes and `direction-taxonomy` for Topic-wide changes.
5. Paper frontmatter uses a new structured `directions:` field. Unknown legacy `topics:`
   content is preserved until the external production vault is inspected.
6. Direction rationale uses a shared three-question rubric. Alias rationale remains optional.
7. Exact Alias lookup requires deterministic normalization and an equality layer rather than
   relying on FTS rank. Fuzzy Catalog search starts from the repository's trigram convention.
8. Topic redirects must be reconstructable from canonical Markdown, support transitive closure,
   detect loops, and keep old Paper references readable during partial migration.
9. Pending Organization and Unclassified are overlapping derived states, not exclusive buckets.
10. The accepted implementation sequence is manual foundation, organization/backfill,
    separately gated legacy migration, then future automation/knowledge integration.

## Owner terminology clarification

After the external review, the owner found `catalog | developed` unclear. The final
design uses `classification | knowledge-ready` and Chinese UI labels “仅用于分类” /
“可用于知识问答”. This is a terminology clarification, not a lifecycle change:
both levels remain confirmed Topic revisions, and the distinction is their permitted use.

The owner also explicitly confirmed:

- confirmed Secondary directions cannot exist without a confirmed Primary;
- direct manual Alias/Direction edits save immediately without a second confirmation,
  while retaining the common audit and recoverable-write discipline;
- a direction view separates Primary membership from Secondary-only matches, and its
  navigation count reflects Primary membership.

## Fable proposals corrected or rejected

### A second generic Proposal discriminator

The runtime and forward schema already have `proposal_type` and `payload_json`.
The final design adds two explicit proposal types and keeps local `change_kind`/`operation`
inside their payloads.

### Proposal becoming `conflicted`

`conflicted` is a KnowledgeWriteRequest state, not a Proposal state. Before metadata
commit, a conflict leaves the Proposal pending and creates no accept ReviewDecision.

### Intent-first ReviewDecision

Fable initially recommended inserting an accepted ReviewDecision together with KWR
reservation. Local verification showed that the existing writer gives `accept` a
different meaning: canonical rename succeeds first, then Proposal acceptance,
ReviewDecision, metadata and outbox are committed together.

The final Fable amendment selected the existing Option E. The feature retains that
ordering instead of introducing an “accepted but unapplied” semantic state.

### Bigram as a Catalog default

The repository's current FTS convention is trigram. Fable withdrew the unsupported
bigram recommendation. Catalog tokenization changes require evidence from Chinese,
Latin and mixed Alias fixtures.

### Merge overflow and silent truncation

A many-to-one Topic merge deduplicates direction assignments and cannot increase the
number of Secondary directions. Primary wins when roles collide; no silent truncation
is allowed.

### Destructive legacy `topics:` migration

The production vault was not inspected. Fable withdrew any recommendation to clear
legacy `topics:` automatically. Migration remains a separate, read-only-inventory-first
slice.

## Stable conclusion

Fable concluded that the reviewed model is coherent enough for a formal feature design
with no core blocker. The only external unknown is the production vault's legacy
`topics:` shape. That unknown gates migration planning but not the manual organization
foundation, Paper Catalog, UI, or Proposal/KWR lifecycle.
