ALTER TABLE source_open_events RENAME TO source_open_events_old;

CREATE TABLE source_open_events (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES proposals(id),
  source_handle TEXT NOT NULL,
  opened_at TEXT NOT NULL
) STRICT;

INSERT INTO source_open_events(id,proposal_id,source_handle,opened_at)
SELECT id,proposal_id,source_handle,opened_at FROM source_open_events_old;

DROP TABLE source_open_events_old;

CREATE INDEX source_open_events_proposal_source
  ON source_open_events(proposal_id,source_handle,opened_at);
