CREATE TABLE agent_runs (
  job_run_id TEXT PRIMARY KEY REFERENCES job_runs(id),
  task_kind TEXT NOT NULL,
  model TEXT,
  codex_version TEXT NOT NULL,
  skill_path TEXT,
  skill_content_hash TEXT,
  context_snapshot_id TEXT REFERENCES context_snapshots(id),
  output_schema_hash TEXT NOT NULL,
  prompt_hash TEXT NOT NULL,
  output_json TEXT NOT NULL CHECK(json_valid(output_json))
) STRICT;
