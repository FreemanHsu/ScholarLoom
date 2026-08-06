# Implementation Slice 002 — Takeaway Quality

- Status: Accepted for implementation
- Date: 2026-07-30
- Reviewed through: three-round external Claude Fable 5 design review
- Depends on: recoverable Paper Conversation, verified Evidence Receipts, Proposal review,
  recoverable KnowledgeWriter, curated-only Entry Agent
- Owner confirmation: recommended defaults accepted on 2026-07-30

## 1. Outcome

This slice changes Takeaway extraction from “up to three answer fragments” into a
selective, evidence-grounded knowledge decision:

```text
grounded Paper answer
→ answer and verified Evidence Receipts commit
→ asynchronous durable Takeaway Selection
→ no-proposal, or at most one context-complete candidate
→ deterministic quality and provenance validation
→ structured Proposal review
→ recoverable confirmed Takeaway Revision
→ standalone retrieval through the curated-only Entry Agent
```

The expected common result is `no-proposal`. A Proposal succeeds only when it captures
one durable conclusion that remains understandable outside the source Conversation.
Producing more Proposal volume is not a success criterion.

## 2. Evidence for the slice

The current Paper answer contract asks one Agent Run to answer the user and populate
`proposedTakeaways`. A candidate contains only:

```ts
{
  claim: string;
  receiptOrdinals: number[];
}
```

The prompt defines evidence retrieval in detail but does not define a Takeaway,
establish an abstention default, or state a quality rubric. Runtime validation checks
only that the claim is non-empty and every ordinal is in range. The receipt array may
be empty, and every surviving candidate is currently marked one-click eligible.

The review surface displays one claim string, editing uses one unstructured browser
prompt, and confirmed Markdown omits most of the canonical Takeaway template.

The current production baseline reinforces that this is a product-contract failure:

- 19 Papers;
- 11 Takeaway Proposals;
- 11 rejected;
- zero accepted or confirmed Takeaways;
- zero pending V1 Takeaway Proposals.

The observed pattern is one Proposal per answer bullet. A coherent correction is often
split into a framing sentence, a context-dependent supporting sentence, and an
experimental detail. The parts may be locally correct, but only their integrated
conclusion is durable knowledge.

## 3. Product definition

### 3.1 Takeaway

A **Takeaway** is a user-confirmed, evidence-grounded, Paper-scoped durable
conclusion. It expresses exactly one conclusion, but may contain the context,
reasoning, and limitation required to make that conclusion complete.

“Atomic” means one conclusion, not one sentence.

A Takeaway must:

1. be understandable without reading the source question or answer;
2. identify the Paper, method, experiment, or other subject it discusses;
3. preserve every condition needed to avoid a materially broader claim;
4. distinguish evidence-backed content from interpretation or hypothesis;
5. connect at least one verified Evidence Receipt to the conclusion;
6. add durable value beyond copying an answer bullet or Summary sentence.

### 3.2 Candidate kinds

The initial closed set is advisory metadata, not a semantic gate:

| Kind | Durable knowledge captured |
|---|---|
| `correction` | Corrects a material misunderstanding of the Paper |
| `mechanism` | Explains how or why a central method works |
| `finding` | Preserves a scoped empirical result |
| `limitation` | Preserves an applicability or evidence boundary |
| `comparison` | Preserves a consequential difference or trade-off |
| `reuse-implication` | Preserves a Paper-grounded implication for future research or implementation |

Procedural walkthrough steps, acronym definitions, transient lookup facts, and
context-dependent answer fragments are not Takeaways by default.

## 4. Minimal structured contract

The model contract contains only fields with distinct responsibilities:

```ts
type TakeawayCandidateV2 = {
  kind:
    | "correction"
    | "mechanism"
    | "finding"
    | "limitation"
    | "comparison"
    | "reuse-implication";
  claim: string;
  epistemicStatus: "evidence-backed" | "interpretation" | "hypothesis";
  evidenceRationale: string;
  caveat: string | null;
  receiptIds: string[];
  selectionRationale: string;
  duplicateHints: string[];
};

type DistillationSelection =
  | {
      decision: "no-proposal";
      reasonCode:
        | "not-durable"
        | "duplicate"
        | "insufficient-evidence"
        | "multiple-claims";
      rationale: string;
    }
  | { decision: "candidate"; candidate: TakeawayCandidateV2 };
```

Invariants:

- `claim` is a self-contained paragraph. It names the subject and includes all
  material scope and comparison conditions. It must be readable with every other
  field hidden.
- `evidenceRationale` explains how the verified Receipts support the claim. It is not
  a Receipt list.
- `caveat` records a material limit; it is null only when no supported caveat is
  needed.
- `selectionRationale` explains why this conclusion crossed the Proposal threshold.
  It is review metadata and never becomes confirmed knowledge.
- `duplicateHints` contains advisory IDs from the frozen Paper-scoped comparison
  corpus. It is review metadata and never changes another Takeaway.
- `receiptIds` has `minItems: 1`; every ID must resolve to a verified Receipt in the
  frozen source Attempt.
- Contract version belongs to the Distillation Run and Proposal, not the model
  candidate.

The model does not generate a separate scope or significance field. Splitting those
semantics out would let the claim become context-dependent again.

### 4.1 Title

Title is not part of the model contract and is never load-bearing:

- default to the claim's first sentence, using CJK-aware sentence boundaries and a
  bounded fallback;
- allow the user to edit it during review;
- do not use it as the only retrieval, duplicate, or quality input;
- title-only edits do not change epistemic review state.

## 5. Distillation lifecycle

### 5.1 Separate answering from knowledge selection

The Paper answer Agent returns only:

- answer;
- grounding status;
- citations;
- usage.

It does not produce Takeaway candidates.

After a grounded assistant Message and its Evidence Receipts commit successfully, the
same transaction creates one durable `takeaway-distillation` Job Run. The browser
shows the answer immediately; Selection completes independently.

Automatic Selection is the primary proactive path required by the PRD. It runs once
after every structurally eligible grounded answer. There is no semantic prefilter in
this slice: an uncalibrated lexical-overlap threshold could suppress a high-value
correction that quotes a Summary claim before overturning its interpretation.

The job is eligible only when:

- grounding status is `answered` or `partially_answered`;
- at least one verified Evidence Receipt exists;
- the source Conversation has frozen integrity;
- the idempotency identity has no completed terminal outcome.

An `insufficient_evidence` or `conflicting_evidence` answer does not trigger automatic
Selection.

### 5.2 Automatic and explicit-save identities

Every terminal Distillation outcome is unique by:

```text
(assistant_message_id, contract_version, trigger, focus_hash)
```

- Automatic Selection uses `trigger=automatic` and an empty focus hash.
- Explicit save is an auxiliary action available on any eligible grounded answer.
- When automatic Selection returns `multiple-claims`, the UI offers a non-blocking
  action: “This answer may contain more than one durable conclusion. Choose one focus
  to distill.”
- The optional focus string is frozen user steering input. It is not citable evidence
  and never becomes confirmed knowledge.
- There is no automatic multi-candidate output, re-run-with-exclusion loop, or
  unbounded refinement loop.

### 5.3 Frozen Distillation Context

Retries evaluate the same input. A content-addressed Distillation Context Manifest
freezes:

- Paper identity and Paper Version;
- source user and assistant Message IDs and content hashes;
- verified Evidence Receipt IDs and hashes;
- active Summary Revision from the Conversation Context Snapshot;
- confirmed Paper Takeaway Revision IDs and hashes visible at job creation;
- trigger and focus hash;
- contract and prompt hashes.

The frozen Takeaway corpus supports advisory duplicate hints. A separate live check at
review time handles knowledge confirmed after the manifest was created.

### 5.4 Selection and deterministic validation

Selection returns `no-proposal` or at most one candidate. Multiple answer facts must
support one conclusion or remain in the Conversation.

After schema validation, the application checks:

- nonempty verified Receipt ownership;
- allowed source identities and frozen hashes;
- bounded content;
- obvious referential fragments such as a claim beginning with an unresolved “it”,
  “its”, “this method”, “其”, “该方法”, or equivalent expression;
- idempotency and manifest integrity.

These lints are intentionally narrow. They reject near-certain invalid output and do
not attempt to determine scientific truth, durable significance, or entailment with
brittle heuristics.

Invalid output, timeout, runner failure, or lint failure becomes a durable abstention
or failed/retryable operational outcome. It never becomes a weaker Proposal.

### 5.5 Critic decision rule

There is no Critic model pass in the initial slice. A second call to the same model
family is not independent verification and is not justified before Selection is
measured.

Allow at most two prompt/schema/lint revisions against the fixed evaluation set. Add a
Critic only if Selection still misses a hard quality threshold. Any future Critic is
scoped to the measured failing gates and must improve results on the same held-out
fixtures. It remains internal to the `TakeawayDistillation` module.

## 6. Module design

`TakeawayDistillation` is a deep module at the seam between a successfully grounded
assistant Message and the Proposal Registry.

```ts
interface TakeawayDistillation {
  request(input: {
    assistantMessageId: string;
    idempotencyKey: string;
    trigger: "automatic" | "explicit-save";
    focus?: string;
  }): DistillationHandle;

  readForMessage(assistantMessageId: string): DistillationReadModel;
}
```

The module owns:

- eligibility and idempotency;
- frozen Context creation and validation;
- durable Job Run lifecycle and recovery;
- Selection model invocation;
- schema, provenance, and referential validation;
- duplicate hints and live warning preparation;
- Proposal creation or durable abstention;
- sanitized activity, elapsed time, available usage, and stable failure codes.

Callers do not construct prompts, apply quality rules, compare knowledge, or insert
Proposal rows.

The module reuses the existing mature `job_runs` substrate, including leases,
heartbeats, epochs, terminal states, interruption, and explicit retry. A small
ownership table relates a Distillation Run to its assistant Message, contract version,
trigger, and focus hash. It does not introduce a second operational state system.

The model seam has two real adapters: production Codex CLI and deterministic fixture.
`PaperConversation` commits the grounded answer and requests automatic Selection.
`KnowledgeReview` owns user decisions. `KnowledgeWriter` remains the only owner of
authoritative Markdown and revision activation.

## 7. Proposal and review behavior

### 7.1 Read model

The full review card displays:

- advisory kind and deterministic, editable title;
- standalone claim;
- epistemic status;
- evidence rationale and links to every Receipt;
- caveat;
- review-only selection rationale;
- duplicate hints and source Conversation;
- Distillation contract version and state.

The inline Conversation card may collapse rationale and evidence. Review Center shows
the complete candidate.

### 7.2 Acceptance eligibility

Verified evidence is necessary but not sufficient.

Direct acceptance requires:

- `epistemicStatus=evidence-backed`;
- every deterministic validation passed;
- all Receipts remain verified;
- any live duplicate warning has been acknowledged.

`interpretation` and `hypothesis` require full deliberate review or structured
edit-and-accept. `reuse-implication` will normally be interpretive.

The live Paper-scoped duplicate check is a soft warning, not a hard block. Current FTS
similarity is not precise enough to prevent a legitimate refinement.

### 7.3 Decisions and structured editing

The slice supports:

- `accept`;
- `edit-and-accept`;
- `reject`.

Reject records one optional reason:

- `useful-answer-not-knowledge`;
- `context-incomplete`;
- `incorrect-or-unsupported`;
- `duplicate`;
- `too-broad`;
- `too-trivial`;
- `other`.

The common “correct answer, not durable knowledge” case is not treated as evidence
that the answer was wrong.

Structured editing replaces the single-string browser prompt. Any edit to claim,
evidence rationale, Receipt selection, or epistemic status requires full review and
evidence reinspection before confirmation. Title-only edits do not. The owner must
confirm whether caveat-only edits do.

Merging into or revising an existing Takeaway is deferred. Rejected and duplicate
candidates are retained with reason codes and hints so a future merge/revision slice
has an audit trail.

## 8. Confirmed Takeaway Revision

Accepted V2 Takeaways materialize the canonical template:

```markdown
# <deterministic or user-edited title>

## Claim

<standalone claim>

## Evidence

| Source | Evidence Receipt | Relationship |
|---|---|---|
| ... | ... | supports |

<evidence rationale>

## Interpretation

<present only when the confirmed epistemic status requires it>

## Challenges or conflicts

<caveat or explicit none known>

## Revision note

Confirmed from Proposal <id>.
```

Frontmatter records:

- contract version and advisory kind;
- Paper and revision identity;
- epistemic and review status;
- Receipt-based provenance;
- source Message, Proposal, Distillation Run, and trigger;
- confirmation and revision timestamps.

`selectionRationale`, `duplicateHints`, and focus never enter confirmed Markdown.
Curated search indexes labeled claim, evidence rationale, interpretation when present,
and caveat. Retrieved context must remain understandable without Conversation text or
the title.

## 9. Duplicate scope

The production corpus currently contains zero confirmed Takeaways, so duplicate
behavior remains deliberately small:

- freeze the complete confirmed Paper-scoped corpus in the manifest;
- allow Selection to return advisory `duplicateHints`;
- perform a live deterministic check at review time;
- show a soft warning that the user may acknowledge;
- retain rejected or suppressed candidates and related IDs;
- defer merge, revision, cross-Paper deduplication, embedding similarity, and automatic
  supersession.

Synthetic fixtures exercise duplicate outcomes before the real corpus grows.

## 10. Legacy behavior

- Existing confirmed V1 Takeaways remain authoritative and retrievable.
- Missing contract version reads as V1.
- Existing knowledge is never silently regenerated, rewritten, or deleted.
- Pending V1 Proposals would require structured V2 upgrade before acceptance.
- Current production has zero pending V1 Takeaway Proposals, so no elaborate upgrade
  workflow is built until the state exists.

## 11. Evaluation and release gate

Maintain a versioned, synthetic or redistributable quality set covering:

- factual lookup abstention;
- procedural walkthrough abstention;
- integrated multi-step mechanism;
- corrected user misconception;
- scoped empirical finding with a missing baseline;
- dangling reference;
- unsupported generalization;
- conflicting evidence;
- Summary duplicate;
- existing Takeaway duplicate;
- strong Paper limitation;
- high-value explicit-save request.

Each case freezes question, answer, Receipts, Summary, comparison corpus, and a
human-authored gold outcome. Candidate cases include a binary rubric:

- standalone;
- single conclusion;
- evidence entails claim;
- epistemically calibrated;
- duplicate handling is correct.

Run the production Selection multiple times per case and grade blind. Exact wording is
not the oracle. Approximately 36–40 cases and three runs per case are targets; category
coverage and blind human grading are the requirements.

Proposed release thresholds:

- decision accuracy at least 85% overall;
- abstention-category accuracy at least 90%;
- referential-fragment claims surviving lints: zero;
- candidate standalone quality at least 90%;
- evidence-entails-claim at least 90%;
- dangerous-direction miscalibration—interpretation or hypothesis labeled
  `evidence-backed`: zero tolerance.

The owner signs off thresholds after the first blind grading pass. The release gate,
not a model self-score, decides whether the Selection contract is ready.

Post-release, reconsider a Critic if `incorrect-or-unsupported` plus
`context-incomplete` exceeds roughly 20% over a rolling 20-Proposal window.

## 12. Product metrics

- eligible grounded assistant turns;
- candidate and abstention rate by reason;
- Proposal accept-without-edit, edit-and-accept, and reject rate;
- rejected fields and reason codes;
- duplicate warnings and rejection rate;
- accepted Receipt coverage;
- Distillation elapsed time, available token usage, failure, interruption, and retry;
- later Entry Agent source opens as a longer-term usefulness signal.

The usage recorder already faithfully stores `unavailable`; improving upstream Codex
usage extraction is an observability improvement, not a Takeaway correctness gate.
Initial automatic-trigger cost is explicitly accepted under unknown token usage and
revisited with measured Selection latency and usage.

## 13. Acceptance journey

1. A narrow factual question produces a grounded answer and a durable
   `no-proposal:not-durable`.
2. A Figure walkthrough produces zero candidates or one integrated `mechanism`, never
   one Proposal per pipeline step.
3. A material misconception correction produces exactly one `correction` Proposal
   with a standalone claim, evidence rationale, epistemic status, caveat, and verified
   Receipts.
4. `multiple-claims` shows the optional-focus explicit-save action without producing
   several automatic candidates.
5. Refresh or restart preserves answer and Distillation states. Interrupted work is
   visible and explicitly retryable without duplicate outcomes.
6. Review Center restores the complete candidate and opens every Receipt.
7. Acceptance creates one recoverable V2 Takeaway Markdown revision and one curated
   search document.
8. Entry Agent retrieves it with text that makes sense without loading the original
   Conversation.
9. Repeating the discussion produces a duplicate abstention or soft review warning,
   not an unreviewed duplicate write.

## 14. Implementation increments

1. **Contracts:** remove `proposedTakeaways` from Paper answer; add V2 Selection schemas,
   prompt rubric, default abstention, bounded fields, and nonempty Receipts.
2. **Job substrate:** add the Distillation job type and ownership record; implement
   eligibility, manifest hashing, trigger identities, recovery, and explicit retry on
   the existing `job_runs` substrate.
3. **Selection execution:** add production Codex and deterministic fixture adapters,
   deterministic validation, durable outcomes, activity, elapsed time, and available
   usage.
4. **Evaluation gate:** author fixtures, run repeated Selection, blind-grade outcomes,
   iterate prompt/schema/lints at most twice, and obtain owner threshold sign-off.
5. **Writer:** materialize the full V2 canonical template and curated FTS document
   through recoverable KnowledgeWriteRequest intents.
6. **Review UI:** structured display, Receipt inspection, direct-accept rules, reject
   reasons, title editing, and edit-and-accept.
7. **Duplicate behavior:** frozen hints, live soft warning, acknowledgement, and
   retained rejected/suppressed candidates.
8. **Explicit save:** auxiliary action on eligible answers and optional focus for
   `multiple-claims`.
9. **Production metrics:** expose outcome, review, latency, usage, and retry measures
   needed to revisit Critic and trigger policy.

The evaluation gate blocks user-facing release. A collection of schemas and endpoints
without the quality fixture results is not a completed slice.

## 15. Explicitly not done

- mandatory Critic pass;
- semantic prefilter before Selection;
- Insight, Concept, Topic, Question, or Synthesis generation;
- direct Insight generation from raw Conversations;
- automatic merge, revision, or supersession of confirmed Takeaways;
- feedback-trained ranking or a hidden user profile;
- bulk rewriting of V1 knowledge;
- replacing FTS with vector retrieval;
- using unverified Conversation text as Takeaway evidence.

Future Insight work must consume confirmed Takeaway Revisions rather than bypass this
quality layer and generalize directly from raw Conversation output.

## 16. Confirmed owner decisions

1. Normal `no-proposal` outcomes use a subtle per-message state; detailed reasons are
   available in an expanded view and diagnostics.
2. Explicit save is available on every eligible grounded answer and remains an
   auxiliary path.
3. Duplicate warnings are shown and acknowledged within the Proposal card; a dedicated
   comparison page is not required in this slice.
4. User-facing candidate kinds, epistemic statuses, and abstention/reject reasons use
   concise Chinese labels while retaining canonical English values in stored data.
5. Editing claim, evidence rationale, Receipt selection, or epistemic status forces
   full evidence review. Title-only and caveat-only edits do not.
6. The initial release targets are 85% overall decision accuracy, 90% abstention
   accuracy, 90% standalone and evidence-entailment quality, and zero dangerous-
   direction epistemic miscalibration. The first blind grading report remains an
   explicit implementation checkpoint.
