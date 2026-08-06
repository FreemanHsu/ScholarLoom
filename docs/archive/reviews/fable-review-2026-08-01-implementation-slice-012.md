# Fable Review: Implementation Slice 012

- Date: 2026-08-01
- Review target: [`implementation-slice-012-domain-direction-hierarchy.md`](../../plans/implementation-slice-012-domain-direction-hierarchy.md)
- Model: `claude-fable-5`

## 1. Initial findings

Fable accepted the core architecture: Domain is a navigation role on Topic,
parentage is child-authoritative, the hierarchy has exactly two levels, enabling is
manual after 15 stable Directions, and grouping remains outside `global-curated`.
It found four high implementation gaps: Domain lifecycle could orphan children,
the enable preference's operational durability was ambiguous, existing Topic
writers were not explicitly required to retain hierarchy fields, and Direction
merge parent semantics were undefined.

The review also requested complete external-drift validation, a closed URL matrix,
explicit count/search behavior, projection-only migration parity, and tests for all
writers and restore behavior.

## 2. Owner-delegated resolutions

These bounded choices did not conflict with accepted product semantics and were
resolved locally:

- navigation-only changes to a knowledge-ready Topic create a history-retaining
  Topic revision with an explicit audit reason;
- once hierarchy has been enabled, it may be re-enabled below 15 Directions;
- Domain title/Alias text participates in Paper search only while hierarchy is
  enabled;
- Direction merge keeps the surviving target's parent and surfaces any discarded
  source parent;
- `domain=ungrouped` mirrors Domain filters by matching either Primary or Secondary
  ungrouped assignments while displaying the Primary-only rail count.

## 3. Final amendments and conclusion

Round 2 identified four surgical omissions, all incorporated before coding:

1. enable/disable rebuilds Paper Catalog so gated Domain search cannot become stale;
2. the knowledge-ready parent edit path freezes and revalidates the target Domain
   with the same role/revision/hash CAS as the classification path;
3. Direction reactivation cannot revive a parent edge to an inactive Domain;
4. the reserved `ungrouped` URL token and symmetric membership semantics are fixed.

Fable stated that after these amendments the slice is ready without further
architectural review. No major conflict or owner escalation remains.
