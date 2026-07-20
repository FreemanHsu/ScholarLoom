---
status: accepted
date: 2026-07-19
---

# Separate application code from user data

ScholarLoom production data lives under one explicit local root, defaulting to
`$HOME/ScholarLoomData`, and never falls back to a directory inside the
application repository. The root must be created with `data:init`; normal startup
fails closed when its version manifest or required directories are missing.

The layout separates four retention classes:

- `vault/` is the Markdown/YAML knowledge authority and an independent local Git
  repository. Git is optional history, not a write prerequisite or backup.
- `originals/` stores immutable, content-addressed source bytes such as ingested
  PDFs. Original files are read-only, while their parent directories remain writable
  so new content hashes can be added. These bytes are retained even when the remote
  source remains available.
- `state/` stores SQLite operational authority, including conversations, review
  decisions, lineage, job state, and projections.
- `derived/`, `cache/`, `logs/`, and `tmp/` contain rebuildable or operational
  material and are excluded from default snapshots.

SQLite stores identities, lifecycle, hashes, relative paths, relationships, and
operational content; it does not store PDF or Markdown blobs. A default snapshot
contains `vault/`, `originals/`, a SQLite Online Backup, the data-root manifest,
and a SHA-256 snapshot manifest. The application runtime holds a per-root write
lock, so snapshot creation refuses to run while ScholarLoom is writing.

Restore never overwrites an existing data root. It materializes and verifies a new
root before operators switch the application to it. Snapshot media may itself be
read-only; restore normalizes the new root to writable owner-only directories,
writable vault/state files, and read-only original files. Production startup and
diagnostics fail closed when authoritative directories are not writable. Encryption, off-device
transport, retention scheduling, and pruning remain responsibilities of external
backup tooling; no automatic backup is enabled until a second storage target exists.
