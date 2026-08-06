# ScholarLoom Backlog

This file records deferred product work that is intentionally outside the current
implementation slice. Accepted behavior remains authoritative in the PRD, data model,
architecture, and ADRs.

## Repository discovery and confirmation

Current behavior accepts an explicit complete `https://github.com/owner/repository`
URL from Paper-derived text or a manual association. Inferred repository discovery
remains outside the accepted product contract.

Deferred work:

- discover candidate repositories from arXiv metadata, Paper/project pages, and GitHub
  search instead of relying only on an extracted literal URL;
- show candidate URL, provenance, confidence, and relation type for user review;
- never clone an inferred candidate before explicit acceptance;
- after acceptance, shallow-clone without executing repository content, pin the exact
  commit SHA, index supported text files, and expose independent progress/error/retry;
- define refresh as a new immutable Repository Snapshot rather than `git pull` mutating
  an existing snapshot.

This item remains deferred until candidate provenance, review semantics, refresh
behavior, and safe acquisition have an accepted design and testable release gate.
