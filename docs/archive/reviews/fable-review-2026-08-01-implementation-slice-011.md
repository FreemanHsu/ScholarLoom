# Fable Review: Implementation Slice 011

- Date: 2026-08-01
- Review target: [`implementation-slice-011-topic-knowledge-revisions.md`](../../plans/implementation-slice-011-topic-knowledge-revisions.md)
- Model: `claude-fable-5`

## 1. Preliminary findings

Fable found three implementation blockers in the initial proposal:

1. preserving the replaced Topic body after the active-file rename could lose the
   only old bytes on a crash;
2. provenance validity was confirmation-time ambiguous and could leave stale
   Paper-scoped access;
3. external edits to an already knowledge-ready Topic had no explicit fail-closed
   reconciliation behavior.

It also requested deterministic section parsing, fail-closed migration of legacy
`knowledge-ready`, a fixed Entry source budget, merge/rename semantics, ordinary
Proposal/ReviewDecision audit, and stable curated document identity.

## 2. Local verification and response

Local inspection showed that the existing generic historical artifact writer stores
under `derived/`, which is rebuildable and cannot be the authority for Topic
history. The design was therefore changed to retain old revisions in authoritative
Vault Markdown before replacing the active file. Provenance now re-resolves current
Summary/Takeaway lifecycle, and unattested external knowledge edits remove the Topic
from curated retrieval and create reconciliation rather than being indexed.

The follow-up also froze:

- a shared strict eight-section parser;
- classification-only migration regardless of legacy usage level;
- at most one lowest-priority Topic source in Paper-scoped Entry;
- atomic rename-and-reconfirm and no knowledge carry on merge;
- client commit token plus parent revision/hash CAS;
- one ordinary `topic-knowledge-revision` Proposal and ReviewDecision;
- one curated document keyed by stable Topic ID.

## 3. Final review and owner resolution

Fable concluded that no architectural blocker remained after four mandatory
clarifications. It called one bounded owner choice: whether Paper Catalog should
freeze last-known-good classification metadata after an external edit or follow the
current authoritative file.

The owner-delegated resolution follows Fable's recommendation: Paper Catalog follows
the current file for title/aliases/Scope, while only unattested knowledge content is
removed from `global-curated`. This preserves deterministic full/incremental rebuild
and the Vault authority boundary without treating navigation metadata as knowledge.

The remaining mandatory amendments were adopted:

- history paths use immutable Topic identity, not mutable slug;
- an unrecognized active-file hash is a third CAS branch that aborts to
  reconciliation without overwrite;
- the canonical parser contract correctly lists all eight H2 sections;
- history mismatch is non-fatal and tamper-evident, retrieval order has stable
  tie-breaks, invalid provenance uses curated delete outbox, and rename equality is
  computed from parsed substantive sections plus provenance.

## 4. Conclusion

Fable rated Slice 011 ready to implement. No major conflict with an accepted owner
decision remains. Its review materially changed historical authority, provenance
invalidation, external-edit behavior, parser determinism, and recovery tests; those
changes are incorporated into the implementation design before coding.
