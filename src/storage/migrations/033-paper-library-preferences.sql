CREATE TABLE paper_library_preferences (
  paper_id TEXT PRIMARY KEY REFERENCES papers(id) ON DELETE CASCADE,
  starred INTEGER NOT NULL DEFAULT 0 CHECK(starred IN (0, 1)),
  starred_at TEXT,
  updated_at TEXT NOT NULL,
  CHECK((starred = 1 AND starred_at IS NOT NULL) OR (starred = 0 AND starred_at IS NULL))
) STRICT;

CREATE INDEX paper_library_preferences_starred_at
  ON paper_library_preferences(starred, starred_at DESC)
  WHERE starred = 1;
