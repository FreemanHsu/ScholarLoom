CREATE TABLE index_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  projection TEXT NOT NULL,
  source_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT
) STRICT;

CREATE TABLE projection_state (
  projection TEXT PRIMARY KEY,
  last_successful_at TEXT,
  rebuilt_at TEXT,
  updated_at TEXT NOT NULL
) STRICT;

INSERT INTO projection_state(projection,last_successful_at,rebuilt_at,updated_at)
VALUES ('global-curated',NULL,NULL,datetime('now'));
