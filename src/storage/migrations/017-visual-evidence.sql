CREATE TABLE visual_render_artifacts (
  id TEXT PRIMARY KEY,
  source_artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  source_content_hash TEXT NOT NULL CHECK(length(source_content_hash) = 64),
  page_number INTEGER NOT NULL CHECK(page_number >= 1),
  page_count INTEGER NOT NULL CHECK(page_count >= page_number),
  renderer_name TEXT NOT NULL,
  renderer_version TEXT NOT NULL,
  renderer_fingerprint TEXT NOT NULL CHECK(length(renderer_fingerprint) = 64),
  render_settings_json TEXT NOT NULL CHECK(json_valid(render_settings_json)),
  image_content_hash TEXT NOT NULL CHECK(length(image_content_hash) = 64),
  storage_ref TEXT NOT NULL UNIQUE,
  media_type TEXT NOT NULL CHECK(media_type = 'image/png'),
  byte_size INTEGER NOT NULL CHECK(byte_size > 0),
  pixel_width INTEGER NOT NULL CHECK(pixel_width > 0),
  pixel_height INTEGER NOT NULL CHECK(pixel_height > 0),
  cache_state TEXT NOT NULL CHECK(cache_state IN ('complete','missing','render-drift')),
  created_at TEXT NOT NULL,
  last_accessed_at TEXT NOT NULL,
  UNIQUE(source_content_hash,page_number,renderer_fingerprint,render_settings_json)
) STRICT;

CREATE TABLE visual_page_inspections (
  id TEXT PRIMARY KEY,
  job_run_id TEXT NOT NULL REFERENCES job_runs(id),
  run_epoch INTEGER NOT NULL CHECK(run_epoch >= 1),
  source_artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  source_content_hash TEXT NOT NULL CHECK(length(source_content_hash) = 64),
  page_number INTEGER NOT NULL CHECK(page_number >= 1),
  render_artifact_id TEXT REFERENCES visual_render_artifacts(id) ON DELETE SET NULL,
  inspection_status TEXT NOT NULL CHECK(inspection_status IN ('ready','failed_infra')),
  failure_count INTEGER NOT NULL DEFAULT 0 CHECK(failure_count >= 0),
  first_inspected_at TEXT NOT NULL,
  last_inspected_at TEXT NOT NULL,
  UNIQUE(job_run_id,run_epoch,source_artifact_id,page_number)
) STRICT;

CREATE INDEX visual_page_inspections_budget
  ON visual_page_inspections(job_run_id,run_epoch,inspection_status);

CREATE TABLE visual_evidence_receipts (
  id TEXT PRIMARY KEY,
  job_run_id TEXT NOT NULL REFERENCES job_runs(id),
  run_epoch INTEGER NOT NULL CHECK(run_epoch >= 1),
  message_id TEXT NOT NULL REFERENCES messages(id),
  ordinal INTEGER NOT NULL CHECK(ordinal >= 1),
  source_id TEXT NOT NULL,
  source_revision TEXT,
  source_artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  source_content_hash TEXT NOT NULL CHECK(length(source_content_hash) = 64),
  page_number INTEGER NOT NULL CHECK(page_number >= 1),
  renderer_name TEXT NOT NULL,
  renderer_version TEXT NOT NULL,
  renderer_fingerprint TEXT NOT NULL CHECK(length(renderer_fingerprint) = 64),
  render_settings_json TEXT NOT NULL CHECK(json_valid(render_settings_json)),
  render_artifact_id TEXT NOT NULL REFERENCES visual_render_artifacts(id),
  image_content_hash TEXT NOT NULL CHECK(length(image_content_hash) = 64),
  visual_observation TEXT NOT NULL CHECK(length(visual_observation) BETWEEN 1 AND 1000),
  verification_status TEXT NOT NULL CHECK(verification_status = 'verified'),
  created_at TEXT NOT NULL,
  UNIQUE(job_run_id,run_epoch,ordinal)
) STRICT;

CREATE INDEX visual_evidence_receipts_message
  ON visual_evidence_receipts(message_id,ordinal);

CREATE TRIGGER evidence_receipts_text_only
BEFORE INSERT ON evidence_receipts
WHEN NEW.evidence_kind = 'visual'
BEGIN
  SELECT RAISE(ABORT, 'visual-receipt-requires-visual-table');
END;

CREATE TRIGGER evidence_receipts_visual_ordinal_guard
BEFORE INSERT ON evidence_receipts
WHEN EXISTS (
  SELECT 1 FROM visual_evidence_receipts visual
  WHERE visual.job_run_id=NEW.job_run_id AND visual.run_epoch=NEW.run_epoch AND visual.ordinal=NEW.ordinal
)
BEGIN
  SELECT RAISE(ABORT, 'evidence-receipt-ordinal-conflict');
END;

CREATE TRIGGER visual_evidence_receipts_text_ordinal_guard
BEFORE INSERT ON visual_evidence_receipts
WHEN EXISTS (
  SELECT 1 FROM evidence_receipts text_receipt
  WHERE text_receipt.job_run_id=NEW.job_run_id AND text_receipt.run_epoch=NEW.run_epoch
    AND text_receipt.ordinal=NEW.ordinal
)
BEGIN
  SELECT RAISE(ABORT, 'evidence-receipt-ordinal-conflict');
END;

CREATE VIEW all_evidence_receipts AS
SELECT id,job_run_id,run_epoch,message_id,ordinal,'text' citation_kind,evidence_kind,source_id,source_revision,
  workspace_path,locator_json,content_hash,quote_text,NULL visual_observation,NULL source_artifact_id,
  NULL source_content_hash,NULL page_number,NULL renderer_name,NULL renderer_version,NULL renderer_fingerprint,
  NULL render_settings_json,NULL render_artifact_id,NULL image_content_hash,verification_status,created_at
FROM evidence_receipts
UNION ALL
SELECT id,job_run_id,run_epoch,message_id,ordinal,'visual' citation_kind,'visual' evidence_kind,source_id,source_revision,
  NULL workspace_path,json_object('page',page_number) locator_json,source_content_hash,NULL quote_text,visual_observation,
  source_artifact_id,source_content_hash,page_number,renderer_name,renderer_version,renderer_fingerprint,
  render_settings_json,render_artifact_id,image_content_hash,verification_status,created_at
FROM visual_evidence_receipts;
