# Implementation Slice 009: Calibrated Alias Auto-Accept

- Status: Implemented
- Date: 2026-07-31
- Parent design: [`paper-organization-feature-design.md`](../paper-organization-feature-design.md)
- Review: [`fable-review-2026-07-31-implementation-slice-009.md`](../archive/reviews/fable-review-2026-07-31-implementation-slice-009.md)
- Depends on:
  [`implementation-slice-006-taxonomy-bootstrap-backfill.md`](implementation-slice-006-taxonomy-bootstrap-backfill.md),
  [`implementation-slice-007-batch-decisions-topic-lifecycle.md`](implementation-slice-007-batch-decisions-topic-lifecycle.md)

## 1. Outcome and owner decision

Complete Slice 4A with a deterministic policy layer around the existing Paper
Organization Agent. No new Agent is introduced. The Agent continues to emit three
independently reviewable section Proposals, but automation may accept **Alias only**.
Primary and Secondary Research Directions always require explicit section-level
owner confirmation.

This Alias-only restriction resolves the Fable review's major conflict: existing
decisions measure predicted owner agreement, not semantic correctness, and an
automatic Primary could create a misleading eligibility cascade for Secondary.

The feature ships disabled. Insufficient evidence is a complete useful state and
never a reason to weaken the gate.

## 2. Non-negotiable safety rules

Auto-accept:

- accepts only an unedited Alias Proposal produced by the Agent after the first
  active Summary revision;
- never accepts Primary or Secondary, and never creates or changes a Direction;
- never accepts ambiguous, stale, blocked, collision-warning, inverse, undo,
  edited, backfill, regenerate, migration, taxonomy, merge, or batch work;
- uses the ordinary ReviewDecision and recoverable Paper KWR path;
- records actor `agent-auto`, Proposal ID and content hash, policy ID/version,
  evaluation hash, predicate version, and revalidation snapshot hash;
- never automatically retries an orphaned reservation: reconciliation closes it
  as manual/no-op and leaves the Proposal for the owner;
- is reversible only through a new owner-authored counter-change; history is never
  erased.

## 3. Frozen policy and calibration gate

Add `paper_organization_auto_policies`. One immutable policy version records:

- status `eligible | enabled | suspended | retired`;
- exact model identity/version, prompt version, output schema, normalization
  version, and eligibility-predicate version;
- calibration window and frozen evaluation-set hash;
- gate constants, evaluation hash, enable actor/time, suspension reason/time;
- daily cap `10` and deterministic holdout rate `10%`.

No confidence score or user-tunable threshold is introduced. Initial gates are:

- at least **75** distinct mature labels;
- every label is at least **30 days** after its terminal materialization;
- the accepted-unchanged proportion has a 95% Wilson lower bound of at least 95%;
- zero rejected, edited, later-reversed, collision-conflicted, or materially
  conflicted included examples;
- excluded examples are at most 10% of the total matching population.

The owner cannot cherry-pick samples. Evaluation selects the complete matching
population in a closed time window and freezes ordered label hashes. Production
can enable only a policy backed by a passing evaluation and an explicit owner
action.

## 4. Calibration labels and holdout

Add:

- `paper_organization_calibration_labels`;
- `paper_organization_policy_evaluations`;
- `paper_organization_auto_events`;
- `paper_organization_auto_ineligibility`.

Labels are operational audit data and never enter either search corpus. A label is
derived only from a terminal, materialized, Agent-origin Alias Proposal:

- `accepted-unchanged`;
- `accepted-edited`;
- `rejected`;
- `reversed`;
- `excluded` with a closed reason.

After enablement, a deterministic one-in-ten eligible Proposal is retained as a
manual holdout. Holdouts continue producing labels so enabled automation does not
starve itself of independent evidence. Runtime auto-accepted examples do not count
as positive calibration labels.

Any later reversal or confirmed collision:

1. permanently marks that Paper/Alias pair ineligible for automation;
2. immediately suspends the active policy, regardless of aggregate rate;
3. requires a new passing evaluation and explicit owner re-enable action.

## 5. Runtime eligibility and execution

After independent Proposals have been persisted, `AutoAcceptCoordinator` evaluates
the Alias Proposal. Its frozen predicate requires:

1. Agent source, first-active-summary trigger, latest pending Alias Proposal;
2. non-empty whole-Paper rationale and a normalized non-empty proposed Alias;
3. applicability `ready`, materialization `not-started`, no ambiguity, collision,
   reconciliation, KWR, batch, merge, or other active organization mutation;
4. proposal content, Paper manifest, Summary, catalog, model, prompt, schema,
   normalization, and predicate snapshots still match;
5. matching policy is enabled and not drifted;
6. Paper/Alias is not permanently ineligible;
7. deterministic holdout does not select it and the local-day cap has not reached
   10.

The event state is `reserved | applying | succeeded | failed | conflicted |
skipped | would-accept`. The idempotency identity is the tuple of Proposal ID,
Proposal content hash, policy version, and revalidation snapshot hash. A successful
event calls the existing single-Proposal accept method and therefore produces the
same ReviewDecision and recoverable KWR as manual confirmation.

Reservations that lose their process before applying are never retried
automatically. Startup reconciliation marks them skipped/manual after checking
whether the ordinary decision already took effect.

## 6. Shadow mode, enablement, drift, and daily cap

Before any policy is enabled, eligible Alias Proposals may record bounded
`would-accept` events. Shadow events never create ReviewDecisions/KWRs and are
excluded from labels.

An enabled policy suspends before another acceptance when any frozen semantic
version changes, its evidence cannot be reproduced, an Alias is later reversed or
collides, or an execution violates an invariant. Daily overflow stays pending for
manual review. Suspension does not undo prior accepted Aliases.

Only an explicit owner request can enable or re-enable a version. Re-enable always
requires a fresh passing evaluation.

## 7. Undo and correction

Every succeeded event exposes “撤销自动整理”. Preview compares the current Alias
section with the frozen after-value. If it still matches, undo:

1. creates an owner-authored inverse Alias Proposal;
2. accepts it through the ordinary KWR path;
3. links the correction to the original event and label;
4. permanently excludes the Paper/Alias pair and immediately suspends the policy.

If the Alias section changed, undo refuses and leaves resolution to ordinary
manual editing. Inverse and undo Proposals are never automation-eligible.

## 8. APIs and interaction

Add:

- `GET /api/paper-organization/automation`;
- `POST /api/paper-organization/automation/evaluate`;
- `POST /api/paper-organization/automation/policies`;
- `POST /api/paper-organization/automation/policies/:id/enable`;
- `POST /api/paper-organization/automation/policies/:id/suspend`;
- `GET /api/paper-organization/automation/events`;
- `POST /api/paper-organization/automation/events/:id/undo/preview`;
- `POST /api/paper-organization/automation/events/:id/undo`.

The Organization workspace adds an Automation panel with Disabled / Insufficient
evidence / Eligible / Enabled / Suspended. It shows sample counts, Wilson lower
bound, exclusions, policy version, holdout and daily-cap behavior, but never a
model-confidence percentage. Auto-confirmed Alias cards show the policy version,
time, reason, and safe undo action. Mobile policy management remains text-labeled
and non-destructive actions are not icon-only.

## 9. Recovery, retention, and authority

- KWR recovery runs before auto-event reconciliation and new organization Jobs;
- one Proposal has at most one effective accepted ReviewDecision and one succeeded
  auto-event;
- enable, suspend, reserve, and undo use idempotency keys;
- policies, evaluations, labels, events, and ineligibility rows survive
  snapshot/restore;
- bounded payloads contain identifiers, hashes, values, and rationales only—never
  Summary/PDF bodies, prompt bodies, or catalog snapshots;
- Settings exposes policy versions, gate constants, status counts, and last
  evaluation time without Paper content.

## 10. Rollout and acceptance

1. schema, label backfill, deterministic evaluator, disabled UI;
2. shadow `would-accept` events;
3. explicit enable/suspend, drift, holdout, and cap;
4. fixture canary proving real ReviewDecision + KWR execution;
5. undo, permanent ineligibility, and immediate suspension;
6. production remains disabled until its local evidence passes.

Acceptance requires deterministic threshold math and evaluation hashes, no
Direction auto-accept path, exactly-once effective acceptance under crash/replay,
orphan reservations falling back to manual, one-in-ten ongoing holdout, cap
overflow remaining manual, audited undo/suspension, snapshot/restore coverage,
tests, typecheck, build, `git diff --check`, and a real Playwright journey.

## 11. Non-goals

- a new organization Agent;
- automatic Primary or Secondary confirmation;
- confidence-score UX or learned online policy optimization;
- automatic taxonomy lifecycle;
- production enablement without passing evidence and an explicit owner action.

## 12. Verification

- `npm test`: 47 files, 253 tests passed.
- `npm run typecheck` and `npm run build`: passed.
- Target test proves the corrected Wilson gate, disabled state, explicit policy
  enablement, real Alias ReviewDecision/KWR execution, safe undo, permanent
  ineligibility, and immediate suspension.
- A real Playwright desktop/mobile journey verified the Alias-only Automation panel;
  its local screenshots are intentionally not versioned.
- Fixture snapshot verification passed SQLite integrity and foreign-key checks and
  restored successfully into a new empty `/tmp` data root.
