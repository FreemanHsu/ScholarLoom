CREATE TABLE paper_taxonomy_manifests (
  id TEXT PRIMARY KEY,
  manifest_hash TEXT NOT NULL UNIQUE,
  cohort_hash TEXT NOT NULL,
  selection_mode TEXT NOT NULL CHECK(selection_mode IN ('next','regenerate','refresh')),
  selection_version TEXT NOT NULL,
  excerpt_version TEXT NOT NULL,
  normalization_version TEXT NOT NULL,
  prior_manifest_id TEXT REFERENCES paper_taxonomy_manifests(id) ON DELETE RESTRICT,
  manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json)),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE paper_taxonomy_runs (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  job_run_id TEXT NOT NULL UNIQUE REFERENCES job_runs(id) ON DELETE CASCADE,
  manifest_id TEXT NOT NULL REFERENCES paper_taxonomy_manifests(id) ON DELETE RESTRICT,
  proposal_group_id TEXT,
  outcome_json TEXT CHECK(outcome_json IS NULL OR json_valid(outcome_json)),
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX paper_taxonomy_runs_manifest ON paper_taxonomy_runs(manifest_id,sequence);

CREATE TABLE paper_organization_backfills (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  selector TEXT NOT NULL CHECK(selector='zero-run'),
  catalog_hash TEXT NOT NULL,
  requested_limit INTEGER NOT NULL CHECK(requested_limit IN (25,50,100,250,500)),
  state TEXT NOT NULL CHECK(state IN (
    'reserved','scheduling','monitoring','complete','complete-with-issues','abandoned'
  )),
  eligible_count INTEGER NOT NULL CHECK(eligible_count >= 0),
  remaining_count INTEGER NOT NULL CHECK(remaining_count >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
) STRICT;

CREATE UNIQUE INDEX one_active_paper_organization_backfill
  ON paper_organization_backfills((1))
  WHERE state IN ('reserved','scheduling','monitoring');

CREATE TABLE paper_organization_backfill_members (
  campaign_id TEXT NOT NULL REFERENCES paper_organization_backfills(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  summary_revision_id TEXT NOT NULL REFERENCES summary_revisions(id) ON DELETE RESTRICT,
  member_state TEXT NOT NULL CHECK(member_state IN ('pending','scheduled','skipped')),
  child_idempotency_key TEXT NOT NULL UNIQUE,
  skip_reason TEXT CHECK(skip_reason IS NULL OR skip_reason IN (
    'paper-inactive','summary-replaced','manifest-drift','work-in-progress'
  )),
  job_run_id TEXT UNIQUE REFERENCES job_runs(id) ON DELETE SET NULL,
  catalog_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(campaign_id,ordinal),
  UNIQUE(campaign_id,paper_id,summary_revision_id)
) STRICT;

CREATE INDEX paper_organization_backfill_member_state
  ON paper_organization_backfill_members(campaign_id,member_state,ordinal);
