# Implementation Slice 016: Knowledge Conversation Lifecycle

- Status: planned — remaining lifecycle
- Date: 2026-08-22
- Feature design: [`../knowledge-question-feature-design.md`](../knowledge-question-feature-design.md)
- Blocked by: [`implementation-slice-015-agentic-curated-knowledge-retrieval.md`](implementation-slice-015-agentic-curated-knowledge-retrieval.md)

## Goal

Complete the remaining Knowledge Question lifecycle: archive/restore, richer runtime
presentation, and historically honest unavailable-source presentation.

## Already delivered

- Slice 014 delivered continuous follow-up, cancel-without-Message persistence, and
  restart interruption.
- Slice 015 delivered one initial execution plus at most three automatic retry epochs,
  explicit retryability classification, and curated-tool capability failures.

## What this slice includes

- sanitized activity, usage, cancel, failure, timeout, and interrupted presentation;
- no silent restart resume when the transient question body is unavailable;
- active/archived lists, rename, archive, and restore;
- hard delete absent from browser and mutation routes;
- per-turn current curated retrieval with immutable prior Messages/Receipts;
- source availability resolution at read time;
- gray, non-navigable missing/purged/integrity-withheld sources;
- superseded but retained source revisions remain openable historically;
- no knowledge-update banner or automatic old-answer rewrite;
- desktop and narrow-screen browser completion for the confirmed visual design.

## Acceptance

- [ ] Rename, archive, archived list, and restore survive refresh and backup/restore.
- [ ] Hard delete is not exposed.
- [ ] An unavailable cited source is gray, keyboard-disabled, and non-navigable.
- [ ] Activating a replacement Summary does not modify or annotate an old answer.
- [ ] Existing Paper Conversation archive/lineage behavior is unaffected.
- [ ] A real Playwright journey covers new Conversation, iterative retrieval, source
      drawer, follow-up, cancel, retry exhaustion, archive, and restore.
- [ ] Repository verification and storage snapshot/restore checks pass.
