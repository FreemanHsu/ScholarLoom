CREATE TABLE paper_organization_catalog_snapshots (
  id TEXT PRIMARY KEY,
  catalog_hash TEXT NOT NULL UNIQUE,
  direction_count INTEGER NOT NULL CHECK(direction_count >= 0),
  catalog_json TEXT NOT NULL CHECK(json_valid(catalog_json)),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE paper_organization_triggers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  summary_revision_id TEXT NOT NULL REFERENCES summary_revisions(id) ON DELETE CASCADE,
  summary_hash TEXT NOT NULL,
  contract_version TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','scheduled','complete','failed')),
  created_at TEXT NOT NULL,
  consumed_at TEXT,
  UNIQUE(paper_id,summary_revision_id,contract_version)
) STRICT;

CREATE INDEX paper_organization_triggers_state
  ON paper_organization_triggers(state,id);

CREATE TABLE paper_organization_manifests (
  id TEXT PRIMARY KEY,
  manifest_hash TEXT NOT NULL UNIQUE,
  paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  paper_version_id TEXT NOT NULL REFERENCES paper_versions(id) ON DELETE CASCADE,
  summary_revision_id TEXT NOT NULL REFERENCES summary_revisions(id) ON DELETE CASCADE,
  catalog_snapshot_id TEXT NOT NULL REFERENCES paper_organization_catalog_snapshots(id) ON DELETE RESTRICT,
  contract_version TEXT NOT NULL,
  scope TEXT NOT NULL CHECK(scope IN ('all','alias','primary','secondary')),
  manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json)),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE paper_organization_runs (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  job_run_id TEXT NOT NULL UNIQUE REFERENCES job_runs(id) ON DELETE CASCADE,
  trigger_id INTEGER UNIQUE REFERENCES paper_organization_triggers(id) ON DELETE SET NULL,
  paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  manifest_id TEXT NOT NULL REFERENCES paper_organization_manifests(id) ON DELETE RESTRICT,
  contract_version TEXT NOT NULL,
  scope TEXT NOT NULL CHECK(scope IN ('all','alias','primary','secondary')),
  proposal_group_id TEXT,
  outcome_json TEXT CHECK(outcome_json IS NULL OR json_valid(outcome_json)),
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX paper_organization_runs_paper_sequence
  ON paper_organization_runs(paper_id,sequence);

CREATE INDEX paper_organization_agent_proposal_group
  ON proposals(
    json_extract(payload_json,'$.groupId'),
    json_extract(payload_json,'$.changeKind')
  )
  WHERE proposal_type='paper-organization'
    AND json_extract(payload_json,'$.sourceKind')='agent';

CREATE UNIQUE INDEX paper_organization_one_pending_agent_section
  ON proposals(paper_id,json_extract(payload_json,'$.changeKind'))
  WHERE proposal_type='paper-organization'
    AND review_status='pending'
    AND json_extract(payload_json,'$.sourceKind')='agent';
