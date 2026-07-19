ALTER TABLE summary_revisions ADD COLUMN agent_run_id TEXT REFERENCES agent_runs(job_run_id);
ALTER TABLE artifacts ADD COLUMN created_by_id TEXT;
ALTER TABLE extraction_runs ADD COLUMN output_artifact_id TEXT REFERENCES artifacts(id);

CREATE TABLE artifact_parents (
  artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  parent_artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  relationship TEXT NOT NULL,
  ordinal INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(artifact_id,parent_artifact_id,relationship)
) STRICT;
