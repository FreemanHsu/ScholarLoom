# ScholarLoom Application Agent Guide

## Mission

This repository contains the ScholarLoom application, schemas, product decisions,
templates, and versioned Agent skills. Production user knowledge and runtime state
must never be written into this repository.

The default production data root is `$HOME/ScholarLoomData`. It must be created
explicitly with `npm run data:init` and has its own `vault/AGENTS.md` for knowledge
operations.

## Repository map

```text
src/                    TypeScript application and browser UI
test/                   Vitest integration and Playwright browser tests
docs/                   PRD, data model, architecture, schema, and ADRs
templates/              Canonical Markdown artifact templates
skills/                 Versioned application-owned Agent skills
README.md               Setup, operation, snapshot, and restore entry point
CONTEXT.md              Canonical product/domain vocabulary
```

The former `HOME.md`, `inbox/`, `library/`, `knowledge/`, `syntheses/`, and
`assets/images/` paths belong in the external vault, not this code repository.

## Storage contract

- `vault/` is the Markdown/YAML knowledge authority.
- `originals/` stores immutable content-addressed source files such as PDFs.
- `state/scholarloom.sqlite3` is the operational authority.
- `derived/` and `cache/` are rebuildable.
- SQLite stores relative paths and hashes, not PDF or Markdown blobs.
- Production startup must fail closed when the external root is missing or invalid.
- Never restore over an existing root or silently create a second production store.
- Never delete legacy or rollback data without explicit user approval after verification.

## Implementation rules

- Keep ingestion, domain model, storage, retrieval, and presentation separable.
- Callers use `StorageLayout`; they do not construct production paths themselves.
- Markdown/SQLite coordination goes through recoverable KnowledgeWriteRequest intents.
- Search indexes and caches must remain reproducible from authoritative data.
- Add tests for layouts, migrations, parsers, link resolution, backup, restore, and recovery.
- Use real temporary SQLite and filesystem fixtures in tests.
- Preserve unrelated and uncommitted user changes.
- Update accepted architecture and ADRs when storage authority or lifecycle changes.

## Verification

For changes to code, dependencies, configuration, schemas, runtime prompts, or
application Skills, run:

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

For storage behavior changes, also exercise snapshot verification and restore into a
new temporary root. For browser behavior changes, complete a real Playwright journey.

For documentation-only changes that do not affect runtime behavior, verify content,
links, and `git diff --check`; the full runtime checks above are not required.
Application Skills and runtime prompts are not documentation-only changes merely
because they are written in Markdown.

If an environment issue blocks a required check, continue all other feasible work,
report the exact blocker and unverified scope, and do not claim that verification
passed or that the change is fully verified. A blocked check is not a waived check.

The repository's default working language is Chinese; retain English technical terms
when translation would reduce precision.
