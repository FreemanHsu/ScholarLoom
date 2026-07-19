CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  paper_id TEXT NOT NULL REFERENCES papers(id),
  active_context_snapshot_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE context_snapshots (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  paper_version_id TEXT NOT NULL REFERENCES paper_versions(id),
  summary_revision_id TEXT REFERENCES summary_revisions(id),
  extraction_run_id TEXT REFERENCES extraction_runs(id),
  repositories_json TEXT NOT NULL CHECK(json_valid(repositories_json)),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  context_snapshot_id TEXT NOT NULL REFERENCES context_snapshots(id),
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  citations_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(citations_json)),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE proposals (
  id TEXT PRIMARY KEY,
  proposal_type TEXT NOT NULL,
  paper_id TEXT REFERENCES papers(id),
  source_message_id TEXT REFERENCES messages(id),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  review_status TEXT NOT NULL,
  one_click_eligible INTEGER NOT NULL CHECK(one_click_eligible IN (0,1)),
  created_at TEXT NOT NULL,
  archived_at TEXT,
  decided_at TEXT
) STRICT;

CREATE TABLE review_decisions (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES proposals(id),
  action TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  result_json TEXT NOT NULL CHECK(json_valid(result_json)),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE takeaways (
  id TEXT PRIMARY KEY,
  paper_id TEXT NOT NULL REFERENCES papers(id),
  active_revision_id TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE takeaway_revisions (
  id TEXT PRIMARY KEY,
  takeaway_id TEXT NOT NULL REFERENCES takeaways(id),
  revision INTEGER NOT NULL,
  claim TEXT NOT NULL,
  review_status TEXT NOT NULL,
  provenance_json TEXT NOT NULL CHECK(json_valid(provenance_json)),
  markdown_path TEXT NOT NULL,
  markdown_hash TEXT NOT NULL,
  confirmed_at TEXT NOT NULL,
  UNIQUE(takeaway_id,revision)
) STRICT;
