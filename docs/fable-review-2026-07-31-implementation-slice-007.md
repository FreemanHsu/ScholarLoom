# Fable Review: Implementation Slice 007

- Date: 2026-07-31
- Reviewer: Claude Fable 5 through `fable-review`
- Canvas: `4baafd3f-0da1-4ad6-a003-4a32d3558e45`
- Prompt node: `c171a3b6-6b0c-411b-a7ef-312108067e1b`
- Response node: `cb55da99-248b-440b-a856-91ca7eaa5961`
- Verdict: Accepted with amendments; no user-confirmation-level conflict

## Findings adopted

1. Batch retry now requires an effect check before any re-apply. Attempt keys are
   journal identities, not duplicate-effect guards.
2. The source Topic KWR is merge authority. Redirect rows are rebuildable cache,
   and Paper migration waits for a verified post-commit rebuild.
3. Startup order is KWR recovery, redirect rebuild, member reconciliation, then
   coordinator resume.
4. Redirect chains remain historical, resolve transitively with depth/cycle checks,
   and fail closed when unavailable.
5. The design includes a complete Primary/Secondary role matrix and explicit stale
   handling for conditioned pending proposals.
6. Merge is forward-only after Topic supersession and retains a durable exception
   report when Paper conflicts remain.
7. Batch and Topic lifecycle operations have explicit mutation guards.
8. Pure rename requires a `scopeMeaningUnchanged` attestation; otherwise it is a
   semantic Scope edit.
9. Batches are single-verb, apply-time authority is reloaded, and skip reasons
   distinguish stale from externally decided.
10. User-authored rename/merge audit envelopes record actor and frozen hashes and
    remain excluded from Paper batch selection.

## Resolution

All findings refine recovery, audit, and concurrency behavior without changing the
user-confirmed product semantics. Implementation may proceed without another user
decision.
