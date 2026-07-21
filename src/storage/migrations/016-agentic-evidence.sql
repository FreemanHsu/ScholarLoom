CREATE TABLE knowledge_corpus_manifests (
  id TEXT PRIMARY KEY,
  manifest_hash TEXT NOT NULL UNIQUE,
  manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json)),
  created_at TEXT NOT NULL
) STRICT;

CREATE TRIGGER knowledge_corpus_manifests_no_update
BEFORE UPDATE ON knowledge_corpus_manifests
BEGIN
  SELECT RAISE(ABORT,'knowledge-corpus-manifest-immutable');
END;

CREATE TRIGGER knowledge_corpus_manifests_no_delete
BEFORE DELETE ON knowledge_corpus_manifests
BEGIN
  SELECT RAISE(ABORT,'knowledge-corpus-manifest-immutable');
END;

ALTER TABLE context_snapshots ADD COLUMN knowledge_corpus_manifest_id TEXT
  REFERENCES knowledge_corpus_manifests(id);

CREATE TABLE evidence_workspaces (
  id TEXT PRIMARY KEY,
  context_snapshot_id TEXT NOT NULL REFERENCES context_snapshots(id),
  knowledge_corpus_manifest_id TEXT NOT NULL REFERENCES knowledge_corpus_manifests(id),
  workspace_hash TEXT NOT NULL UNIQUE,
  root_ref TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK(status IN ('building','built','failed','evicted')),
  builder_version TEXT NOT NULL,
  byte_size INTEGER NOT NULL DEFAULT 0 CHECK(byte_size >= 0),
  last_accessed_at TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  failed_at TEXT,
  evicted_at TEXT,
  error_json TEXT CHECK(error_json IS NULL OR json_valid(error_json)),
  UNIQUE(context_snapshot_id,workspace_hash)
) STRICT;

ALTER TABLE job_runs ADD COLUMN run_epoch INTEGER NOT NULL DEFAULT 0 CHECK(run_epoch >= 0);
ALTER TABLE job_runs ADD COLUMN lease_owner TEXT;
ALTER TABLE job_runs ADD COLUMN lease_expires_at TEXT;
ALTER TABLE job_runs ADD COLUMN cancel_requested_at TEXT;
ALTER TABLE job_runs ADD COLUMN runner_kind TEXT;
ALTER TABLE job_runs ADD COLUMN failure_kind TEXT;
ALTER TABLE job_runs ADD COLUMN evidence_workspace_id TEXT REFERENCES evidence_workspaces(id);

UPDATE job_runs
SET runner_kind = 'legacy_one_shot'
WHERE job_type = 'paper-chat' AND runner_kind IS NULL;

CREATE TABLE agent_run_activities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_run_id TEXT NOT NULL REFERENCES job_runs(id),
  run_epoch INTEGER NOT NULL CHECK(run_epoch >= 1),
  event_type TEXT NOT NULL,
  display_text TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX agent_run_activities_timeline
  ON agent_run_activities(job_run_id,run_epoch,id);

CREATE TABLE agent_run_usage (
  job_run_id TEXT NOT NULL REFERENCES job_runs(id),
  run_epoch INTEGER NOT NULL CHECK(run_epoch >= 1),
  status TEXT NOT NULL CHECK(status IN ('reported','estimated','unavailable')),
  input_tokens INTEGER CHECK(input_tokens IS NULL OR input_tokens >= 0),
  cached_input_tokens INTEGER CHECK(cached_input_tokens IS NULL OR cached_input_tokens >= 0),
  output_tokens INTEGER CHECK(output_tokens IS NULL OR output_tokens >= 0),
  total_tokens INTEGER CHECK(total_tokens IS NULL OR total_tokens >= 0),
  elapsed_ms INTEGER CHECK(elapsed_ms IS NULL OR elapsed_ms >= 0),
  recorded_at TEXT NOT NULL,
  PRIMARY KEY(job_run_id,run_epoch)
) STRICT;

CREATE TABLE evidence_receipts (
  id TEXT PRIMARY KEY,
  job_run_id TEXT NOT NULL REFERENCES job_runs(id),
  run_epoch INTEGER NOT NULL CHECK(run_epoch >= 1),
  message_id TEXT REFERENCES messages(id),
  ordinal INTEGER NOT NULL CHECK(ordinal >= 1),
  evidence_kind TEXT NOT NULL CHECK(evidence_kind IN ('pdf','summary','code','library','visual')),
  source_id TEXT NOT NULL,
  source_revision TEXT,
  workspace_path TEXT NOT NULL,
  locator_json TEXT NOT NULL CHECK(json_valid(locator_json)),
  content_hash TEXT NOT NULL,
  quote_text TEXT NOT NULL CHECK(length(quote_text) <= 500),
  verification_status TEXT NOT NULL CHECK(verification_status IN ('verified','render-drift')),
  visual_observation TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(job_run_id,run_epoch,ordinal)
) STRICT;

CREATE INDEX evidence_receipts_message ON evidence_receipts(message_id,ordinal);

ALTER TABLE summary_revisions ADD COLUMN canonical_sections_hash TEXT;
ALTER TABLE messages ADD COLUMN grounding_status TEXT;

CREATE TRIGGER summary_revisions_frozen_source_fields
BEFORE UPDATE OF paper_id,paper_version_id,extraction_run_id,revision,markdown_path,markdown_hash,
  structured_json,skill_path,skill_content_hash,agent_run_id,canonical_sections_hash ON summary_revisions
WHEN NEW.paper_id IS NOT OLD.paper_id
  OR NEW.paper_version_id IS NOT OLD.paper_version_id
  OR NEW.extraction_run_id IS NOT OLD.extraction_run_id
  OR NEW.revision IS NOT OLD.revision
  OR NEW.markdown_path IS NOT OLD.markdown_path
  OR NEW.markdown_hash IS NOT OLD.markdown_hash
  OR NEW.structured_json IS NOT OLD.structured_json
  OR NEW.skill_path IS NOT OLD.skill_path
  OR NEW.skill_content_hash IS NOT OLD.skill_content_hash
  OR NEW.agent_run_id IS NOT OLD.agent_run_id
  OR (OLD.canonical_sections_hash IS NOT NULL AND NEW.canonical_sections_hash IS NOT OLD.canonical_sections_hash)
BEGIN
  SELECT RAISE(ABORT,'summary-revision-source-immutable');
END;
