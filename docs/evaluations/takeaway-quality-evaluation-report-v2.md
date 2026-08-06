# Takeaway Quality V2 — first blind grading checkpoint

- Fixture version: `takeaway-quality-fixtures.v1`
- Contract version: `takeaway-selection.v2`
- Cases: 36 synthetic/redistributable fixtures across 12 required categories
- Required runs: 3 per case (108 total)
- Blind grading status: pending
- Production release gate: closed

The implementation includes the versioned fixture corpus, repeated-run observation
format, deterministic lint checks, blind human rubric, and hard threshold evaluator.
This file intentionally does not claim model quality before the first 108 production
Selection outputs have been graded without showing graders the gold outcome.

Release requires all of:

- decision accuracy ≥ 85%;
- abstention-category accuracy ≥ 90%;
- referential fragments surviving lints = 0;
- candidate standalone quality ≥ 90%;
- evidence-entails-claim ≥ 90%;
- dangerous-direction epistemic miscalibration = 0;
- every candidate run blind graded.

No Critic pass or semantic prefilter may be added while this checkpoint is pending.
