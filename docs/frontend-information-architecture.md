# ScholarLoom Frontend Information Architecture

- Status: Accepted baseline
- Date: 2026-07-20
- Scope: Browser information architecture and page logic after implementation slice 001
- Product contract: [`PRD.md`](PRD.md)
- Data contract: [`data-model.md`](data-model.md)
- System architecture: [`architecture.md`](architecture.md)

## 1. Purpose

This document defines the accepted browser page model before further UI work. It
separates currently implemented v1 capabilities from later product concepts and
fixes the navigation, URL, page-state, review, recovery, and responsive rules for
the next frontend slices.

It does not change storage authority, domain lifecycle, review boundaries, or Agent
retrieval scope. Canonical domain terms remain defined by [`CONTEXT.md`](../CONTEXT.md).

## 2. Product entry and top-level navigation

ScholarLoom opens on a **Research Home**, not directly in the Paper Library or a
full-screen chat. Global knowledge questions occupy the most prominent position.
The Home also helps the user resume work by surfacing recent reading, background
processing, and pending reviews.

The v1 top-level destinations are:

| Destination | Canonical URL | Responsibility |
|---|---|---|
| Research Home | `/` | Global question, continue reading, background work, and pending-review entry points |
| Paper Library | `/papers` | Search, filter, sort, and open all Papers |
| Review Center | `/reviews` | Review Proposals across Papers and Proposal types |

Settings and Diagnostics belong in secondary navigation. Knowledge/Wiki is not shown
as an empty top-level destination before its product flow exists. Import is a global
command available from any top-level destination; it is not a separate page.

Top-level navigation may show counts for processing work and pending reviews. These
counts are navigation aids, not substitutes for durable Job Run or Proposal state.

## 3. URL and browser-history model

URLs combine stable domain-object paths with recoverable view state:

| Purpose | URL shape |
|---|---|
| Paper Workspace | `/papers/:paperId` |
| Paper Conversation | `/papers/:paperId/conversations/:conversationId` |
| Proposal detail | `/reviews/:proposalId` |

Reading is the default Paper mode. View-only state such as the selected Paper mode,
whether PDF is open, selected page, and Evidence Anchor is represented with query
parameters. A representative evidence URL is:

```text
/papers/:paperId?pdf=open&page=7&anchor=:evidenceAnchorId
```

The exact parameter encoding may evolve, but these behaviors are required:

- direct links open the same Paper and meaningful view state;
- refresh restores the current Paper, mode, PDF state, page, and anchor;
- browser back and forward navigate between meaningful user-visible states;
- temporary request state, draft input, and transient animation state do not need to
  pollute the URL;
- a stale or invalid object reference produces an explicit not-found or unavailable
  state rather than silently returning Home.

## 4. Research Home

The Home is an action-oriented research overview. Its priority order is:

1. Global Entry Agent question input and latest result.
2. Continue reading recent Papers.
3. Background imports and processing that are running or need attention.
4. Pending review summary and entry to Review Center.

The Home does not duplicate the complete Paper Library or Review Center. Empty
sections should collapse or show one concise action rather than leave dashboard
chrome with no content.

### 4.1 Entry Agent behavior

The v1 Entry Agent performs a single research query at a time. It may preserve a
recent-query list, but it does not create an implicit global Conversation or carry
hidden context from one question to the next.

Its retrieval boundary remains `global-curated` only:

- active Summary Revisions;
- confirmed Takeaway Revisions;
- active confirmed Knowledge Revisions when those types are implemented.

Each answer distinguishes sources and Agent inference, displays source cards and
uncovered scope, and links back to the relevant Summary or Takeaway. A stale curated
projection may serve the last reliable result, but the UI must disclose staleness and
the last successful projection time. Saving a high-value answer always creates a
Proposal; the answer itself is not confirmed knowledge.

## 5. Paper Library

The Paper Library includes Ready, Processing, Failed, and Interrupted Papers. Failed
or incomplete work must remain discoverable and actionable.

The v1 library provides:

- default sort by recent activity;
- search by title, author, and arXiv ID;
- filters for processing state, needs-attention state, code association, and reading
  state;
- Paper cards showing Paper version, Summary state, code state, reading state, and
  pending-review count;
- no multi-select or bulk lifecycle operations in the initial frontend slices.

### 5.1 Personal reading state

Reading state is user-owned and independent of acquisition, processing, Summary,
repository, and archive state:

| Reading state | Rule |
|---|---|
| `unread` | Paper is in the Library but reading has not started |
| `reading` | Opening an available Summary for the first time may set this automatically |
| `read` | Set explicitly by the user; scrolling never marks completion |
| `paused` | User intends to stop temporarily while retaining the Paper in the normal Library |

All reading states can be changed manually. Archive is a separate Paper lifecycle
operation and removes the Paper from the default Library view. A new Paper Version
does not silently reset `read`; it creates a separate update indication and Proposal.

## 6. Paper Workspace

The Paper Workspace has three product modes:

### 6.1 Reading

Reading is the default mode. The continuous Paper Summary is the primary document.
The PDF is optional and opens as a resizable second pane on wide screens. Summary
Evidence Anchors open and locate the exact PDF page or available source position.

### 6.2 Discussion

Discussion is separate from the bottom of the Summary. It owns the Conversation
list, current Conversation, Messages, citations, and Paper-scoped Proposal review.
Assistant Messages render safe Markdown with the same inert-link, no-raw-HTML policy
as Summary content. Pending Takeaway Proposals are grouped under their source Message
in a compact, collapsed review disclosure; Knowledge and Review Center retain the
expanded Paper-level and global review views.
Opening a saved Conversation uses its stable Conversation URL and preserves the
Context Snapshot boundary defined by the data model.

The Conversation header includes a lightweight “关系与上下文” panel. It shows the
parent, direct successors, root-to-parent breadcrumb, and readable Paper/Summary/
Code/Knowledge changes; Extraction IDs, hashes, and other provenance remain in
expandable technical details. On narrow screens the same panel becomes a full-width
overlay rather than introducing a tree sidebar.

Before linked-successor creation the client requests a read-only continuation
preview. No Context change blocks creation with an explanation and keeps independent
new Conversation available. A changed preview is confirmed with a readable list of
materials; the POST repeats the authoritative comparison. Archive status never hides
lineage and an active child remains in the active list even when its parent is
archived.

### 6.3 Knowledge

Knowledge shows confirmed Paper-scoped Takeaways and related pending Proposals. It is
not a graph or Wiki placeholder. Cross-Paper Knowledge Node exploration remains a
later product capability.

Paper metadata, Paper Version, processing state, and repository state apply to the
whole Workspace. They belong in the persistent header, status area, or a detail
drawer rather than becoming separate modes.

## 7. Code repository visibility

Every Paper Workspace exposes repository association status even though v1 has no
standalone Code mode. The UI must distinguish:

- no association;
- historical detected candidate awaiting confirmation;
- confirmed and materializing;
- confirmed and available to future Discussion;
- failed or interrupted with an explicit retry.

“No explicit link found” must not be presented as proof that no open-source code
exists. Ingestion-time detection and search-derived candidates are disabled.

The persistent Paper header shows `代码仓库 · N` plus `待确认`, `处理中`, or `需处理`
when relevant. Its URL-restorable drawer (`repositories=open`) contains the manual
GitHub root URL form and displays owner/repository, canonical URL, manual/detected
origin, association state, pinned commit SHA, failure detail, and independent
materialization progress. On narrow screens it becomes a full-width drawer.

Manual association is semantically confirmed before materialization. Each visible
association can be removed; candidate removal is direct, while confirmed or operational
states require browser confirmation. Removed links disappear from the current list,
retain historical identity and snapshot data, and may be restored only by manually
adding the canonical URL again. When available, the fixed Repository Snapshot is a
source only for Conversations created afterward; the drawer explicitly states that old
frozen Conversations do not change. Code never enters the v1 Entry Agent corpus.

## 8. Import and background processing

After an arXiv submission resolves to a Paper identity, the browser immediately
navigates to that Paper Workspace. The user is not required to remain there:

- processing continues in the background;
- global navigation can display processing counts;
- Research Home displays running and needs-attention work;
- completion, failure, or required action produces an in-product notification;
- refresh or SSE reconnect reconstructs state from durable Job Runs.

Job presentation preserves the domain distinctions:

- queued and running work display stage and progress when known;
- `succeeded`, `failed`, `cancelled`, and `interrupted` are terminal monitoring states;
- `failed` and `interrupted` may offer a new retry attempt;
- `cancelled` is terminal and non-retryable;
- Summary and repository processing remain independent, so code failure cannot block
  Summary reading.

An SSE disconnect is a connectivity condition, not evidence that a Job failed or a
Proposal was accepted.

## 9. Review Center and inline review

Takeaway review uses two entry points backed by the same Proposal:

- a non-blocking card appears next to the relevant Paper Conversation answer;
- the same Proposal appears in Review Center for later handling.

Verified evidence may allow inline one-click acceptance. If a quotation or Evidence
Anchor is not verified, the user must open the fixed source page before acceptance.
Proposal detail supports full source inspection, edit-and-accept, and reject.

Every action creates an immutable Review Decision, and repeated commands remain
idempotent. Later Paper Version updates, inferred repository links, Summary
replacements, semantic relations, and Markdown reconciliation reuse the Review
Center while remaining visibly distinct Proposal types.

## 10. Loading, empty, failure, and recovery rules

All pages follow one recovery principle: **preserve the last reliable content and
localize errors**.

- Initial load with no usable data uses a page-level loading state or Skeleton.
- Background refresh preserves visible content and marks it as updating.
- A component request failure affects that component rather than replacing the whole
  Paper Workspace with an error page.
- Summary failure preserves Paper metadata, PDF access, and completed artifacts.
- Import and Summary failures display the durable stage, code, and message in the
  immediate notification and recovery surfaces; cards include the latest reason instead
  of showing only a generic failed label.
- Repository failure preserves Summary reading and discussion that does not require
  code.
- SSE loss shows reconnecting state while durable reads remain available.
- Curated-index staleness preserves last-good Entry Agent results with disclosure.
- A blocking error page is reserved for first load without usable content, missing
  objects, authorization/access failure, or a scoped integrity incident.

Empty states identify why the collection is empty and provide one relevant action:

- no Papers: invoke Import;
- no pending reviews: return to reading or Discussion;
- no recent queries: ask the first global question;
- no confirmed Takeaways: start or continue a Paper Conversation;
- no explicit repository link: explain the limitation without claiming code does not
  exist.

## 11. Responsive and private-deployment scope

The complete experience is laptop-first, targeting approximately 1280 px and wider.
Narrower windows retain Home, Library, Review, and single-column Summary behavior.
PDF verification switches between Summary and PDF rather than forcing an unreadable
split view.

Mobile browser support is limited to checking task state, reading a single-column
Summary, simple questions, and simple review actions. Precise PDF comparison and the
complete Workspace are not mobile commitments. Native mobile applications, offline
reading, public access, and multi-user behavior remain out of scope. Tailscale Serve
latency and reconnects must not erase local drafts or misrepresent durable state.

## 12. Next frontend vertical slice

The next accepted slice is **Recoverable Research Navigation**.

### Included

- real routes and global navigation for `/`, `/papers`, `/papers/:paperId`, and
  `/reviews`;
- a Research Home with prominent Entry Agent access and concise continue-reading,
  processing, and pending-review entry points;
- a global Import command that navigates to the resolved Paper while work continues
  in the background;
- migration of the existing Paper reading experience to a stable object URL;
- URL persistence for PDF visibility, selected page, and Evidence Anchor;
- correct direct-link, refresh, browser-back, and browser-forward behavior.

### Implemented by the recoverable Discussion/Knowledge slice

- Reading, Discussion, and Knowledge workspace modes;
- stable Conversation identity URLs and URL-restored source state;
- multiple active/archived Conversations with frozen context;
- persistent Message/attempt states, explicit retry, and local per-Conversation draft;
- pending Proposal and confirmed Takeaway Paper Knowledge views;
- single-column narrow-screen mode switching and full-screen source view.
- Agentic Evidence activity timeline, queue/cancel/retry/failure states, reported or
  unavailable usage, and verified PDF/Summary/Code/Library citation types;
- citation inspector state at `?evidence=:receiptId`, restored by refresh/back/forward;
- frozen Knowledge Corpus information and linked successor Conversation creation.

### Not included

- persisted personal reading state;
- a notification center;
- a standalone Code mode;
- inferred repository discovery;
- Conversation Digest and cross-Conversation automatic memory;
- Summary regeneration and Paper Version comparison.

### Browser acceptance journey

1. Open Research Home.
2. Submit an arXiv reference and enter the processing Paper Workspace.
3. Navigate to Paper Library while the durable import continues.
4. Reopen the same Paper without creating another Paper or losing job state.
5. Open a Summary Evidence Anchor and reveal the expected PDF page.
6. Refresh and retain the same Paper, PDF visibility, page, and anchor.
7. Use browser back and forward and observe the expected meaningful states.

Later slices can add reading-state persistence, notification history, Conversation
Digest, and richer knowledge-node types without changing this route and recovery
foundation.

## 13. Visual Evidence Retrieval extension

Visual Evidence is an incremental extension of the existing Discussion receipt flow,
not a new workspace mode. While an Attempt is running, sanitized Activity may report
that a PDF page is being inspected; Activity remains progress/audit and never becomes
evidence by itself.

A grounded visual citation is rendered inline as `Visual · p. N`. Selecting it uses
the existing `?evidence=:receiptId` URL contract. The Evidence Inspector shows the
frozen rendered page, bounded visual observation, page number, renderer/settings,
and image-hash verification state. On narrow screens the same URL opens a full-screen
Evidence View, and refresh/back/forward restore it like text evidence.

Missing derived images are rebuilt from the frozen PDF. A renderer/settings mismatch
is shown as `renderer-unavailable`; a rebuilt hash mismatch is shown as `render-drift`.
Both states fail closed and must not display the image as verified. Visual Activity
and verified Visual Evidence use distinct labels and styling.
