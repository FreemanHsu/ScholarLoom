# Fable Review: Implementation Slice 008

- Date: 2026-07-31
- Canvas: `4baafd3f-0da1-4ad6-a003-4a32d3558e45`
- Prompt node: `b80d77ad-f9b3-441a-b047-223a0f4bfb4d`
- Response node: `6cdad76f-4706-42ae-8dc4-b08d4b9df2d9`
- Model: `claude-fable-5`
- Verdict: Accepted with amendments

## Findings adopted

1. Root fingerprints require a versioned, normative inclusion/exclusion algorithm.
2. A live inventory is provisional. Execution must stop the source runtime, rerun
   the complete inventory, and require equality with the plan input.
3. A restored destination with pending KWR, batch, merge, taxonomy, backfill, or
   other resumable command state is not a valid migration base.
4. KWR remains the correct destination writer, but every stored path must remain
   root-relative and the destination must recover/rebuild before applying new
   migration writes.
5. `directions:` presence makes legacy `topics:` inert and excludes it from future
   planning; the ledger retains source item fingerprints.
6. Value-bearing diagnostics, mapping files, plans, and path-bearing reports are
   local-only and non-committable.
7. Topic usability is validated at plan and apply time.
8. Migration is sequential and reuses effect-check-before-retry; no parallel batch
   coordinator is introduced.
9. Missing and explicitly empty `topics:` remain distinct byte states.
10. The cutover checklist is advisory and does not authorize cutover.

## Owner items resolved from accepted design

Fable separated two owner-confirmation items:

- an all-empty migration intentionally creates no organization assignments;
- legacy `topics:` persists until separately approved destructive cleanup.

Both were already normative in the accepted parent design and confirmed earlier in
this feature discussion. They do not reopen a product choice and are adopted
without pausing implementation.

## Local assessment

The review correctly kept the generic executor but trimmed it to a sequential
two-verb mapping loop. The strongest correction is destination operational-state
validation: replaying copied in-flight commands against a new root would be an
authority trap even when paths are relative. The implementation must abort before
new migration work unless the copied source is operationally quiescent.
