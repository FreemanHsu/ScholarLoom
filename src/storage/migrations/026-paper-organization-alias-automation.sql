CREATE TABLE paper_organization_calibration_labels (
  proposal_id TEXT PRIMARY KEY REFERENCES proposals(id) ON DELETE CASCADE,
  paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  normalized_alias TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN (
    'accepted-unchanged','accepted-edited','rejected','reversed','excluded'
  )),
  exclusion_reason TEXT,
  review_decision_id TEXT,
  proposal_hash TEXT NOT NULL,
  resulting_hash TEXT,
  policy_tuple_hash TEXT NOT NULL,
  terminal_at TEXT NOT NULL,
  matures_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK((outcome='excluded')=(exclusion_reason IS NOT NULL))
) STRICT;

CREATE INDEX paper_organization_calibration_maturity
  ON paper_organization_calibration_labels(policy_tuple_hash,matures_at,outcome);

CREATE TABLE paper_organization_policy_evaluations (
  id TEXT PRIMARY KEY,
  evaluation_hash TEXT NOT NULL UNIQUE,
  policy_tuple_hash TEXT NOT NULL,
  window_end TEXT NOT NULL,
  population_count INTEGER NOT NULL CHECK(population_count >= 0),
  label_count INTEGER NOT NULL CHECK(label_count >= 0),
  accepted_count INTEGER NOT NULL CHECK(accepted_count >= 0),
  excluded_count INTEGER NOT NULL CHECK(excluded_count >= 0),
  wilson_lower REAL NOT NULL CHECK(wilson_lower BETWEEN 0 AND 1),
  exclusion_rate REAL NOT NULL CHECK(exclusion_rate BETWEEN 0 AND 1),
  sample_hash TEXT NOT NULL,
  passed INTEGER NOT NULL CHECK(passed IN (0,1)),
  reasons_json TEXT NOT NULL CHECK(json_valid(reasons_json)),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE paper_organization_auto_policies (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL UNIQUE CHECK(version > 0),
  status TEXT NOT NULL CHECK(status IN ('eligible','enabled','suspended','retired')),
  evaluation_id TEXT NOT NULL REFERENCES paper_organization_policy_evaluations(id) ON DELETE RESTRICT,
  policy_tuple_hash TEXT NOT NULL,
  model_identity TEXT NOT NULL,
  prompt_hash TEXT NOT NULL,
  schema_hash TEXT NOT NULL,
  normalization_version TEXT NOT NULL,
  predicate_version TEXT NOT NULL,
  minimum_labels INTEGER NOT NULL CHECK(minimum_labels=75),
  maturity_days INTEGER NOT NULL CHECK(maturity_days=30),
  holdout_modulus INTEGER NOT NULL CHECK(holdout_modulus=10),
  daily_cap INTEGER NOT NULL CHECK(daily_cap=10),
  created_by TEXT NOT NULL,
  enabled_by TEXT,
  created_at TEXT NOT NULL,
  enabled_at TEXT,
  suspended_at TEXT,
  suspension_reason TEXT
) STRICT;

CREATE UNIQUE INDEX paper_organization_one_enabled_auto_policy
  ON paper_organization_auto_policies((1)) WHERE status='enabled';

CREATE TABLE paper_organization_auto_events (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES proposals(id) ON DELETE RESTRICT,
  paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  normalized_alias TEXT NOT NULL,
  policy_id TEXT REFERENCES paper_organization_auto_policies(id) ON DELETE RESTRICT,
  event_kind TEXT NOT NULL CHECK(event_kind IN ('shadow','holdout','automatic')),
  state TEXT NOT NULL CHECK(state IN (
    'reserved','applying','succeeded','failed','conflicted','skipped','would-accept','undone'
  )),
  proposal_hash TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  evaluation_hash TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  before_json TEXT NOT NULL CHECK(json_valid(before_json)),
  after_json TEXT NOT NULL CHECK(json_valid(after_json)),
  rationale TEXT NOT NULL,
  result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
  error_code TEXT,
  local_day TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(proposal_id,policy_id,event_kind)
) STRICT;

CREATE INDEX paper_organization_auto_events_status
  ON paper_organization_auto_events(state,local_day,created_at);

CREATE TABLE paper_organization_auto_ineligibility (
  paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  normalized_alias TEXT NOT NULL,
  reason TEXT NOT NULL,
  source_event_id TEXT REFERENCES paper_organization_auto_events(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(paper_id,normalized_alias)
) STRICT;
