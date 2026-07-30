ALTER TABLE job_runs ADD COLUMN parent_job_id TEXT REFERENCES job_runs(id);

CREATE TABLE takeaway_distillation_manifests (
  id TEXT PRIMARY KEY,
  manifest_hash TEXT NOT NULL UNIQUE,
  manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json)),
  created_at TEXT NOT NULL
) STRICT;

CREATE TRIGGER takeaway_distillation_manifests_no_update
BEFORE UPDATE ON takeaway_distillation_manifests
BEGIN
  SELECT RAISE(ABORT,'takeaway-distillation-manifest-immutable');
END;

CREATE TRIGGER takeaway_distillation_manifests_no_delete
BEFORE DELETE ON takeaway_distillation_manifests
BEGIN
  SELECT RAISE(ABORT,'takeaway-distillation-manifest-immutable');
END;

CREATE TABLE takeaway_distillation_runs (
  job_run_id TEXT PRIMARY KEY REFERENCES job_runs(id),
  assistant_message_id TEXT NOT NULL REFERENCES messages(id),
  manifest_id TEXT NOT NULL REFERENCES takeaway_distillation_manifests(id),
  contract_version TEXT NOT NULL,
  trigger TEXT NOT NULL CHECK(trigger IN ('automatic','explicit-save')),
  focus_hash TEXT NOT NULL,
  outcome_kind TEXT CHECK(outcome_kind IS NULL OR outcome_kind IN ('candidate','no-proposal')),
  reason_code TEXT CHECK(reason_code IS NULL OR reason_code IN
    ('not-durable','duplicate','insufficient-evidence','multiple-claims')),
  proposal_id TEXT REFERENCES proposals(id),
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX takeaway_distillation_message
  ON takeaway_distillation_runs(assistant_message_id,created_at,job_run_id);
CREATE UNIQUE INDEX takeaway_distillation_terminal_identity
  ON takeaway_distillation_runs(assistant_message_id,contract_version,trigger,focus_hash)
  WHERE outcome_kind IS NOT NULL;

ALTER TABLE takeaway_revisions ADD COLUMN title TEXT;
ALTER TABLE takeaway_revisions ADD COLUMN contract_version TEXT;
ALTER TABLE takeaway_revisions ADD COLUMN structured_json TEXT CHECK(structured_json IS NULL OR json_valid(structured_json));
ALTER TABLE takeaway_revisions ADD COLUMN source_message_id TEXT REFERENCES messages(id);
ALTER TABLE takeaway_revisions ADD COLUMN distillation_job_run_id TEXT REFERENCES job_runs(id);

CREATE TABLE takeaway_review_requirements (
  proposal_id TEXT PRIMARY KEY REFERENCES proposals(id),
  evidence_review_required INTEGER NOT NULL DEFAULT 0 CHECK(evidence_review_required IN (0,1)),
  duplicate_acknowledged INTEGER NOT NULL DEFAULT 0 CHECK(duplicate_acknowledged IN (0,1)),
  live_duplicate_warning INTEGER NOT NULL DEFAULT 0 CHECK(live_duplicate_warning IN (0,1)),
  live_duplicate_ids_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(live_duplicate_ids_json)),
  reviewed_receipt_ids_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(reviewed_receipt_ids_json)),
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE entry_source_open_events (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL CHECK(source_type IN ('summary','takeaway')),
  source_id TEXT NOT NULL,
  opened_at TEXT NOT NULL
) STRICT;

CREATE INDEX entry_source_open_source
  ON entry_source_open_events(source_type,source_id,opened_at);
