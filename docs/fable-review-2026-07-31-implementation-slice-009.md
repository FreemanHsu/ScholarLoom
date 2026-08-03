# Fable Review: Implementation Slice 009

- Date: 2026-07-31
- Recovery Canvas: `b08b3014-bb9d-4ba3-bd16-824ad831193a`
- Prompt node: `47e51b6f-dfbd-4b8a-8f4e-38a02265f8a0`
- Response node: `262c7584-f9cc-4927-9c0f-458862073bed`
- Model: `claude-fable-5`
- Verdict: Conditionally approvable; do not implement as written

The original continuation Canvas produced two empty `running` child nodes after a
600-second timeout. The review was recovered in a fresh minimal-context Canvas
using the same fixed model. No fallback model was used.

## Major product conflict

Fable recommends that Slice 4A ship Alias-only. It treats Primary and Secondary
automation as separate later decisions because an auto-set Primary could satisfy
the current “confirmed Primary” precondition for an auto-accepted Secondary,
creating an automation cascade. The proposed design instead included first-Primary
and conditioned Secondary.

This materially changes the user-confirmed automation scope and is not adopted
without owner direction.

## Mandatory technical amendments independent of scope

1. The original `n >= 50` / Wilson-lower-bound gate is internally inconsistent.
   With 50/50 accepted labels the 95% Wilson lower bound is about 92.9%; a perfect
   record needs roughly 73 labels to clear 95%.
2. User acceptance measures predicted owner agreement, not correctness. UI and
   policy language must not claim correctness calibration.
3. Enabled policies need a continuing manual holdout; otherwise label production
   stops precisely for the automated population.
4. Gate labels must mature for 30 days. Any later reversal of an auto-accepted
   value suspends the policy regardless of age.
5. Evaluations must report exclusion taxonomy/rate and fail when excluded labels
   exceed 10%.
6. Reservation idempotency includes Proposal content hash, policy version, and
   revalidation snapshot hash. Orphaned reservations route to manual review and
   are never automatically retried.
7. Model identity/version joins prompt/schema/normalization/predicate hashes in the
   policy tuple.
8. Daily blast-radius caps queue overflow for manual review.
9. Undo/inverse Proposals are permanently automation-ineligible; reversal creates
   a bulk inverse-Proposal affordance and prevents the same automation loop.
10. Any suspension requires explicit owner re-enable.

## Fable's minimal recommended rollout

1. Alias-only shadow events; owner continues ordinary review.
2. Evaluate at least 75 mature labels with a 95% Wilson lower bound of at least
   95%, zero reversals/conflicts, bounded exclusions, and exact version tuple.
3. Enable Alias-only with one-in-ten holdout, a small daily cap, suspension, and
   audited inverse undo.
4. Treat Primary and Secondary as separate future automation slices.

## Owner decisions requested by Fable

- whether first-Primary automation remains in Slice 4A;
- whether permanent manual holdout is acceptable;
- whether any reversal, however late, should suspend;
- whether Primary/Secondary automation is proportionate for a single-user corpus.

## Owner resolution

The owner accepted Fable's minimal rollout in full:

- Slice 4A is Alias-only; Primary and Secondary remain separately confirmed;
- the permanent deterministic manual holdout is accepted;
- any later reversal immediately suspends the policy;
- the corrected minimum is 75 mature labels, with a daily cap of 10.

The reviewed implementation design incorporates every mandatory amendment above.
