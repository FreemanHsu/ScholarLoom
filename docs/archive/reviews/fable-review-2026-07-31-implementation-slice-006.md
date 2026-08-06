# Fable Review: Implementation Slice 006

- Date: 2026-07-31
- Reviewer: Claude Fable 5 through Flowith Canvas
- Target:
  [`implementation-slice-006-taxonomy-bootstrap-backfill.md`](../../plans/implementation-slice-006-taxonomy-bootstrap-backfill.md)
- Result: accepted after two rounds, with four small pre-implementation conditions

## Review progression

The review completed in two rounds.

Fable confirmed that a separate Paper Taxonomy Agent is justified, but found three
high-risk ambiguities in the first draft:

1. catalog growth could have been misread as campaign drift and skipped all
   remaining Papers;
2. `updated_at DESC` repeatedly selected the same recent cohort and starved older
   Papers;
3. per-child catalog snapshots made campaign results heterogeneous without exposing
   which Papers saw an older catalog.

The design now makes the campaign catalog hash provenance-only, stores each child
catalog hash, reports older-catalog children for follow-up, and never treats catalog
growth as a skip reason. Taxonomy selection advances through stable
`created_at, Paper ID` cohorts with persisted coverage and a cohort hash;
Regenerate reuses its cohort and explicit Refresh restarts coverage.

## Other adopted findings

- exact catalog collisions drop one candidate rather than fail the whole Agent run;
- `normalizePaperLookup.v1`, selection, and excerpt algorithms are versioned;
- semantic overlap is a reviewable Agent assertion, not an unversioned runtime
  embedding heuristic;
- one campaign may be active, with durable member rows and selectable size;
- campaign progress separates Job completion from remaining user decisions;
- the ordinary queue's absolute run membership and backfill's current-Summary
  zero-run selector intentionally overlap for stale old-Summary context;
- zero candidates is a successful covered-cohort outcome;
- an explicit terminal `abandoned` state prevents a wedged campaign from blocking
  future work;
- existing accept-time `requireDirection` and semantic-hash validation protects
  Paper writes after external Topic reconciliation;
- old-Summary proposals are visibly stale before a replacement child commits.

## Final verdict

Fable reported no blocker or major conflict and accepted the revised design for
implementation. Confidence was high for Agent isolation, cohort selection,
drift/skip semantics, and the test plan; medium-high for normalization, campaign
recovery, and the deliberate queue/backfill overlap.

No production Vault content, Summary body, credentials, or environment data was
sent.
