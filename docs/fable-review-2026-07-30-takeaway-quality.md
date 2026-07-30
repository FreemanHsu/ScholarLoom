# External Takeaway Quality design review record — 2026-07-30

This record captures a three-round external Claude Fable 5 review of
[`implementation-slice-002-takeaway-quality.md`](implementation-slice-002-takeaway-quality.md).
A sanitized design brief, repository contracts, and aggregate runtime counts were
shared. No production Paper content, Proposal text, credentials, or personal knowledge
was sent.

## Context supplied during review

- Current Takeaway prompt, JSON Schema, runtime validation, review UI, writer, and
  canonical Markdown template.
- Existing durable `job_runs`, Evidence Receipt, recovery, and KnowledgeWriteRequest
  contracts.
- Aggregate baseline: 19 Papers, 11 Takeaway Proposals, all 11 rejected, zero
  confirmed Takeaways, and zero pending V1 Takeaway Proposals.
- Aggregate successful Agentic Evidence answer latency: three recorded runs averaging
  about 60 seconds; token usage was reported as unavailable.
- Accepted PRD requirement that proactive non-interruptive Proposal discovery remains
  the primary path and explicit save remains auxiliary.

## Adopted findings

1. The original seven prose fields recreated fragmentation inside one candidate.
   `claim` now owns subject, scope, comparison conditions, and the complete conclusion.
2. Answer generation and Takeaway Selection remain separate, but the mandatory Critic
   pass is removed until evaluation demonstrates a measured need.
3. Automatic asynchronous Selection runs once for every structurally eligible grounded
   answer. Durable abstention is the normal outcome and at most one candidate is allowed.
4. No semantic prefilter is introduced before Selection. An uncalibrated overlap check
   could suppress high-value corrections that quote Summary text before challenging it.
5. The existing mature `job_runs` substrate is reused with a small Message/contract/
   trigger ownership record; no second operational state system is introduced.
6. Candidate kinds remain advisory. Title is derived deterministically from the first
   claim sentence, is user-editable, and is never retrieval- or quality-load-bearing.
7. Duplicate handling is split between frozen advisory hints and a live soft warning
   at review time. Merge, revision, and supersession remain deferred.
8. Interpretation and hypothesis cannot use direct acceptance even when Receipts are
   verified.
9. A versioned human-labeled evaluation set and hard release thresholds decide whether
   the Selection contract ships and whether a future Critic is warranted.
10. `multiple-claims` abstention exposes an auxiliary explicit-save action with optional
    user focus rather than producing several automatic candidates.

## Fable proposals deliberately not adopted

### Explicit save as the primary path

Fable initially recommended explicit save for the first release. This was rejected
because it contradicts the accepted PRD interaction: the Agent proactively suggests
durable knowledge, while explicit save is auxiliary.

### Mandatory Critic

The original draft proposed a separate Critic for every candidate. Fable challenged
this as correlated LLM judgment rather than independent verification. The Critic is
now evidence-gated: it may be introduced only when Selection still misses a hard
quality threshold after bounded prompt/schema/lint revisions.

### Semantic overlap prefilter

Fable proposed a high-threshold Summary/Takeaway overlap prefilter in round two. Local
verification showed that the existing trigram FTS is not a calibrated duplicate
classifier and that lexical overlap can be highest for valuable corrections. Fable
accepted this counterexample and withdrew the recommendation in the final round.

### Token recorder as broken prerequisite

Fable described unavailable token data as broken recording. Local code verification
showed that elapsed time and upstream `unavailable` status are faithfully stored.
Improved token extraction remains observability work, not a Takeaway correctness gate.

## Stable conclusion

The review concluded with high confidence in:

- the “atomic means one conclusion, not one sentence” definition;
- answer/Selection separation;
- abstention-first, single-candidate behavior;
- the collapsed candidate contract;
- reuse of durable Job Runs and recoverable KnowledgeWriter;
- deterministic lints after generation rather than semantic suppression before it;
- epistemic acceptance rules and full canonical Markdown materialization.

The main remaining uncertainties are real Selection latency/token cost, whether one
Selection pass meets the fixture thresholds without a Critic, and future duplicate
behavior after confirmed Takeaways exist.

## Owner confirmation

On 2026-07-30 the owner accepted the reviewed recommended defaults:

- subtle per-message abstention state with expandable detail;
- explicit save on every eligible grounded answer;
- duplicate acknowledgement inside the Proposal card;
- concise Chinese UI labels with canonical English stored values;
- full evidence review after claim/evidence/Receipt/epistemic edits, but not after
  title-only or caveat-only edits;
- the proposed 85%/90%/zero-tolerance release thresholds, with the first blind grading
  report retained as an explicit implementation checkpoint.
