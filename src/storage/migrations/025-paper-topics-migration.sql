CREATE TABLE paper_topics_migration_commands (
  id TEXT PRIMARY KEY,
  plan_hash TEXT NOT NULL UNIQUE,
  source_fingerprint TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('applying','complete','complete-with-issues')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
) STRICT;

CREATE TABLE paper_topics_migration_members (
  command_id TEXT NOT NULL REFERENCES paper_topics_migration_commands(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  paper_id TEXT NOT NULL REFERENCES papers(id),
  relative_path TEXT NOT NULL,
  source_markdown_hash TEXT NOT NULL,
  result_markdown_hash TEXT,
  source_item_fingerprints_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','applying','succeeded','failed','conflicted')),
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(command_id, ordinal),
  UNIQUE(command_id, relative_path)
) STRICT;
