CREATE TABLE entry_paper_resolution_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_hash TEXT NOT NULL,
  resolver_version TEXT NOT NULL,
  normalization_version TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('off','shadow','enabled')),
  outcome TEXT NOT NULL CHECK(outcome IN (
    'none','resolved','ambiguous','too-many','bypassed','normalization-mismatch'
  )),
  matches_json TEXT NOT NULL CHECK(json_valid(matches_json)),
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX entry_paper_resolution_events_created
  ON entry_paper_resolution_events(created_at,id);
