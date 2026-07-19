CREATE TABLE papers (
  id TEXT PRIMARY KEY,
  title TEXT,
  acquisition_status TEXT NOT NULL CHECK (acquisition_status IN ('metadata-only','queued','ingested','unavailable','deleted')),
  origin TEXT NOT NULL CHECK (origin IN ('manual-import','reference-discovery')),
  lifecycle_status TEXT NOT NULL DEFAULT 'active',
  current_version_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE paper_external_identities (
  id TEXT PRIMARY KEY,
  paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE RESTRICT,
  identity_type TEXT NOT NULL,
  normalized_value TEXT NOT NULL,
  canonical_url TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at TEXT NOT NULL,
  UNIQUE(identity_type, normalized_value)
) STRICT;

CREATE TABLE paper_versions (
  id TEXT PRIMARY KEY,
  paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE RESTRICT,
  source_type TEXT NOT NULL,
  source_version TEXT NOT NULL,
  source_url TEXT NOT NULL,
  resolved_at TEXT NOT NULL,
  processing_status TEXT NOT NULL,
  accepted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(paper_id, source_type, source_version)
) STRICT;

CREATE TABLE import_requests (
  id TEXT PRIMARY KEY,
  original_input TEXT NOT NULL,
  normalized_input TEXT,
  submitted_at TEXT NOT NULL,
  resolution_status TEXT NOT NULL,
  resolved_paper_id TEXT REFERENCES papers(id) ON DELETE SET NULL,
  error_code TEXT,
  error_detail TEXT,
  completed_at TEXT
) STRICT;

CREATE TABLE job_runs (
  id TEXT PRIMARY KEY,
  job_type TEXT NOT NULL,
  import_request_id TEXT REFERENCES import_requests(id) ON DELETE SET NULL,
  paper_id TEXT REFERENCES papers(id) ON DELETE SET NULL,
  state TEXT NOT NULL,
  progress REAL NOT NULL CHECK(progress >= 0 AND progress <= 1),
  attempt INTEGER NOT NULL DEFAULT 1,
  idempotency_key TEXT NOT NULL UNIQUE,
  input_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(input_json)),
  output_json TEXT CHECK(output_json IS NULL OR json_valid(output_json)),
  error_json TEXT CHECK(error_json IS NULL OR json_valid(error_json)),
  queued_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  heartbeat_at TEXT
) STRICT;

CREATE TABLE durable_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  event_type TEXT NOT NULL,
  data_json TEXT NOT NULL CHECK(json_valid(data_json)),
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX durable_events_scope_id ON durable_events(scope, id);
