# ADR 0015: arXiv Version Review and Frozen Conversations

## Status

Accepted — 2026-08-14

## Decision

Paper open and an explicit manual check resolve arXiv metadata and persist a fixed
candidate only when its numeric version is newer than `papers.current_version_id`.
There is no scheduled polling in this slice. A higher observation supersedes older
pending arXiv candidates; rejected or accepted versions do not reappear.

Candidate preparation is isolated from active knowledge. It downloads the fixed PDF,
runs extraction and Summary generation, persists a bounded page-level material diff,
and optionally records a structured Agent semantic digest. Digest failure is visible
but non-blocking. Preparation and retry Job input includes the Proposal and candidate
version IDs so a retry cannot accidentally activate the candidate.

Acceptance is the only activation boundary. Candidate preparation stores an immutable
Summary Artifact; acceptance preflight may additionally materialize that Summary at
its canonical vault path and register it as `superseded`, but it remains excluded from
active retrieval. The Paper manifest is only staged and validated at this point. A
single SQLite transaction then records the Review Decision and candidate state; only
after that durable boundary may recovery advance the manifest and activate the new
Paper Version and Summary. A manifest conflict or stale current-version guard records
no accept decision. An in-flight semantic-diff retry temporarily blocks acceptance so
a linked successor cannot freeze an incomplete Version Diff. Activation supersedes the
former active Summary, updates current metadata, and retains the prior title as an Alias. Historical PDFs, extractions,
Summaries, Version Diff Artifacts, Proposals, and Review Decisions remain addressable
and are included by the default snapshot through `originals/artifacts/`.
Reproducible extraction and active-Summary copies remain `rebuildable` under
`derived/`; their authoritative PDF and vault Markdown are already snapshotted.

Conversation Context Snapshots remain immutable. An old Conversation stays writable
against its old Paper Version. A linked successor freezes the new current material and
adds the accepted Version Diff as a source; no Message or snapshot is silently rebased.

## Consequences

- Reviewing a candidate can consume compute without changing active knowledge.
- The latest-only pending rule reduces review noise while preserving superseded audit.
- Version-scoped metadata is required; Paper-level metadata follows the accepted current
  version rather than rewriting historical records.
- Automatic polling, redline-quality document layout diff, automatic Takeaway
  revalidation, and synthesized conversation handoff remain later work.
