# Implementation Slice 001 — One Paper to Retrievable Takeaway

- Status: Ready for implementation planning
- Architecture: [`architecture.md`](architecture.md)
- Data contract: [`data-model.md`](data-model.md)
- Schema: [`sqlite-schema.sql`](sqlite-schema.sql)

## 1. Outcome

This is a tracer-bullet slice through the complete v1 product path:

```text
arXiv link
→ unique Paper and current Paper Version
→ PDF download and page extraction
→ Paper Summary
→ explicit GitHub repository clone
→ Paper-scoped conversation with code context
→ Agent-proposed Takeaway
→ one-click confirmation
→ curated-only entry Agent retrieves the confirmed Takeaway
```

The slice is complete only when the whole path works through the browser and survives
a process restart. A collection of disconnected backend endpoints is not complete.

## 2. Fixed acceptance fixture

Use one redistributable AI/ML Paper fixture with:

- a stable arXiv ID and PDF fixture;
- multiple pages and at least one experiment table;
- an explicit GitHub URL in the Paper text;
- a small local bare Git repository representing that URL in automated tests;
- deterministic Codex fake outputs that conform to the production JSON Schemas.

The test fixture adapter replaces network access. One optional smoke test may use the
real arXiv, Git, and Codex adapters but is not part of the default test suite.

## 3. User journey

1. User opens ScholarLoom through the Mac mini's private Tailscale Serve HTTPS URL.
2. User pastes the fixture arXiv URL and submits.
3. The UI immediately shows one ImportRequest and live child-job progress.
4. The system resolves one Paper, downloads one PDF, and creates one accepted current
   Paper Version. Repeating the URL does not create duplicates.
5. PDF extraction creates page-addressable Document Elements and Evidence Anchors.
6. Summary and explicit-repository processing run independently.
7. The first schema-valid Paper Summary becomes active and enters the curated-only
   projection after its durable Markdown write has recovered or completed.
8. The explicit repository URL is cloned automatically, pinned to a commit, and its
   text files become Code Elements.
9. The Paper page opens on Summary. “Open original” adds the PDF pane; clicking a
   Summary claim opens the cited page.
10. User starts a Paper conversation and asks an implementation question.
11. The answer cites the Paper and, when used, fixed repository file/line sources.
12. The answer contains a proposed Takeaway. The UI shows verified source evidence;
   an unresolved or unverified quote requires opening the cited page before confirmation.
13. Confirmation creates ReviewDecision, Takeaway Revision, Markdown, provenance,
   and a `global-curated` FTS entry through KnowledgeWriter.
14. User asks the entry Agent a matching question. The answer retrieves and cites the
   confirmed Takeaway.
15. Restarting the process preserves the Paper workspace, conversation, confirmed
   Takeaway, and searchable result.

## 4. Implementation increments

Each increment ends with an executable behavioral test.

### Increment 1 — Runtime and durable import shell

- TypeScript project, Fastify server, React shell, migration runner, runtime config.
- Bind the application to loopback only, reject wildcard/non-loopback production
  binds, and expose it through a separately configured Tailscale Serve proxy.
- Define explicit arXiv-version semantics: `vN` is authoritative; a bare ID resolves
  once and is persisted as `(arxiv_id, version, resolved_at)`.
- Emit durable SSE event IDs, a 20-second heartbeat, and `Last-Event-ID` replay.
- Create SQLite and asset roots.
- Implement ImportRequest, JobRun, Paper, ExternalIdentity, and PaperVersion storage.
- `POST /api/imports`, status read endpoint, and SSE progress.
- Fixture PaperSource adapter resolves metadata and returns PDF bytes.

Behavioral test: submitting the same arXiv forms twice yields one Paper, one Paper
Version, two ImportRequests linked to it, and restart-safe status. An explicit `vN`
fixture stays `vN` even when the source advertises a newer version.

### Increment 2 — PDF Artifact and active Summary

- Content-addressed ArtifactStore.
- PDF.js page extraction into ExtractionRun and DocumentElement.
- Evidence Anchors with Paper Version, page, and optional text bounds.
- CodexRunner fake and production adapters.
- Paper Summary JSON Schema, renderer, Markdown validation, and first-summary activation.
- KnowledgeWriteRequest intent fields/phases and recovery for every Markdown write.
- Curated FTS projection and deterministic rebuild from active Summary revisions;
  the shared working-corpus FTS is not an Entry Agent dependency.

Behavioral test: a completed import exposes an active Summary whose Key Claims link
to valid pages in the exact PDF Artifact. Forced interruption at `staged`, `renamed`,
or `metadata-committed` either completes idempotently or preserves an external edit
as a non-activating reconciliation Proposal.

### Increment 3 — Paper workspace

- Paper list and Paper workspace read models.
- Summary-first view and optional PDF.js split pane.
- SSE status transitions and actionable retry states.
- Summary Evidence Anchor click-to-page.

Browser test: import fixture, wait for Summary Ready, open Paper, reveal PDF, click a
claim, and observe the expected page.

### Increment 4 — Explicit repository context

- Extract explicit GitHub URL from Paper-derived text.
- Clone production URL or local test repository; pin commit.
- Create CodeRepository, RepositorySnapshot, PaperCodeLink, and Code Elements.
- Show repository state independently from Summary state.
- Build a minimal context manifest of README plus matched source files.

Behavioral test: explicit links clone without Proposal; an externally inferred URL
is represented only as a Proposal and is not cloned.

### Increment 5 — Conversation and Takeaway review

- Conversation, Context Snapshot, Message, and AgentRun persistence.
- Paper-chat structured response schema containing answer citations and optional
  Takeaway Proposals.
- Streaming conversation events.
- Proposal review UI and ReviewDecision command.
- KnowledgeWriter materializes Takeaway Markdown and provenance atomically.
- Verify displayed quotation text against its fixed PDF page before styling it as
  verbatim; require an opened source page for unverified evidence.

Behavioral test: a conversation pins Paper Version, Summary Revision, Extraction Run,
and Repository Snapshot; accepting its Proposal creates exactly one confirmed
Takeaway Revision even when the decision request is retried.

### Increment 6 — Curated-only Entry Agent retrieval

- Query only the separate curated FTS projection through `EntryAgentSearch`; it has no
  corpus-scope parameter and cannot call Paper-working search.
- Entry-answer structured schema with source references.
- Entry Agent UI with source cards linking to Summary or Takeaway.
- Show a staleness notice and last-successful projection timestamp while curated
  outbox work remains pending.

Behavioral test: the entry Agent retrieves the confirmed Takeaway and active Summary;
sentinel text present only in a raw Message, PDF Element, or Code Element never appears
in retrieved context.

### Increment 7 — Diagnostics and product-level acceptance

- Startup recovery for interrupted Job Runs and stale indexes not already covered by
  the owning increment.
- Archive unresolved Markdown reconciliation Proposals older than 30 days without
  deleting them; support reopening an archived Proposal.
- Diagnostics command and error surfaces.
- Full browser test through the fixed acceptance fixture.
- Optional real-adapter smoke test instructions.

Behavioral test: terminate the process after PDF storage and during Summary generation,
restart, retry safely, and complete the same single Paper without duplicate entities.

## 5. Codex structured results

The slice defines separate JSON Schemas for:

- `paper-summary`: structured sections, Key Claims, Evidence references;
- `paper-chat`: answer blocks, citations, proposed Takeaways/Insights;
- `entry-answer`: answer, curated source references, uncertainty.

Codex output never contains database IDs it invented. Context manifests provide
opaque allowed source handles; the application resolves and validates those handles
before persistence. The Paper Summary schema narrows `claims[].sourceHandle` to a
per-run enum of manifest handles. A Key Claim selects one representative Evidence
Anchor; multiple inline page markers remain valid in section Markdown, while an Agent
assessment without direct page evidence remains prose rather than a structured claim.

## 6. First-slice simplifications

- Only arXiv input is supported.
- Explicit arXiv `vN` imports and on-open update Proposals are required; a full update
  comparison UI beyond accept/reject is deferred.
- PDF Evidence Anchors are page-level with optional text bounds, not full layout
  fidelity for every formula/table.
- Only repositories explicitly linked by the Paper are cloned automatically.
- Code indexing covers text files under a size limit and honors ignore rules; no
  dependency installation or code execution.
- Code Analysis and Repository Digest may be minimal; code remains available to the
  Paper conversation through selected files.
- Summary regeneration/replacement UI is deferred after the first active Summary.
- Only Takeaway Proposal acceptance is required; Insight and other Knowledge Node
  types use the same future mechanism.
- FTS5 only; no embeddings, vector store, graph UI, or reranker.
- Entry Agent searches active Summary and confirmed Takeaway only.
- No automatic discovery, external-note migration, or annotation UI.

## 7. Definition of done

- The product-level acceptance journey passes through the browser with fixture adapters.
- A real Codex CLI run can produce schema-valid Summary output in a documented smoke test.
- Every material answer in the acceptance path carries a resolvable source reference.
- Duplicate requests, retried decisions, and interrupted jobs are idempotent.
- SQLite foreign-key check and integrity check pass.
- Deleting all search rows and rebuilding produces the same searchable sources.
- Curated projection rebuild equals outbox-maintained results; working-only sentinel
  strings never appear in Entry Agent context or final answers.
- Knowledge Markdown frontmatter parses and matches its SQLite revision metadata.
- Takeaway confirmation is blocked from one-click completion when a claimed quote or
  Evidence Anchor cannot be verified against the pinned PDF.
- The application listener is loopback-only; the UI is reachable through Tailscale
  Serve from an authorized tailnet device and not through wildcard/LAN binds.
- One-command setup, development, test, migration, and diagnostics are documented.

## 8. Explicitly not done

- production-grade extraction of every figure, formula, and table;
- inferred GitHub search and approval UX beyond a stored Proposal;
- multi-Paper synthesis or conflict detection;
- entry Agent downward retrieval;
- Paper update processing;
- vector retrieval;
- backup UI;
- multi-user access or public deployment.
