CREATE TABLE source_open_tokens (
  token TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES proposals(id),
  paper_version_id TEXT NOT NULL REFERENCES paper_versions(id),
  source_handle TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  consumed_at TEXT
) STRICT;
