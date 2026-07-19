CREATE TABLE source_open_events (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES proposals(id),
  source_handle TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  UNIQUE(proposal_id,source_handle)
) STRICT;
