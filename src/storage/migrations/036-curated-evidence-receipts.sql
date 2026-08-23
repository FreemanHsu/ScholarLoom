CREATE TABLE knowledge_evidence_receipts (
  id TEXT PRIMARY KEY,
  assistant_message_id TEXT NOT NULL REFERENCES knowledge_messages(id) ON DELETE RESTRICT,
  job_run_id TEXT NOT NULL REFERENCES job_runs(id) ON DELETE RESTRICT,
  run_epoch INTEGER NOT NULL CHECK(run_epoch >= 1),
  ordinal INTEGER NOT NULL CHECK(ordinal >= 1 AND ordinal <= 20),
  source_type TEXT NOT NULL CHECK(source_type IN ('summary','takeaway','topic-knowledge')),
  source_id TEXT NOT NULL,
  source_revision_id TEXT NOT NULL,
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64),
  source_title TEXT NOT NULL,
  trust_label TEXT NOT NULL CHECK(trust_label IN ('generated-from-primary-source','user-confirmed')),
  locator_json TEXT NOT NULL CHECK(json_valid(locator_json)),
  quote_text TEXT NOT NULL,
  why_selected TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(assistant_message_id, ordinal),
  UNIQUE(job_run_id, run_epoch, ordinal)
) STRICT;

CREATE INDEX idx_knowledge_evidence_receipts_source
  ON knowledge_evidence_receipts(source_type, source_id, source_revision_id);

CREATE TRIGGER knowledge_evidence_receipts_assistant_owner
BEFORE INSERT ON knowledge_evidence_receipts
WHEN NOT EXISTS (
  SELECT 1 FROM knowledge_turn_attempts attempt
  JOIN knowledge_messages message ON message.id=attempt.assistant_message_id
  WHERE attempt.job_run_id=NEW.job_run_id AND attempt.assistant_message_id=NEW.assistant_message_id
    AND attempt.run_epoch=NEW.run_epoch AND attempt.state='succeeded' AND message.role='assistant'
)
BEGIN
  SELECT RAISE(ABORT, 'knowledge-evidence-receipt-owner-invalid');
END;

CREATE TRIGGER knowledge_evidence_receipts_no_update
BEFORE UPDATE ON knowledge_evidence_receipts
BEGIN
  SELECT RAISE(ABORT, 'knowledge-evidence-receipt-immutable');
END;

CREATE TRIGGER knowledge_evidence_receipts_no_delete
BEFORE DELETE ON knowledge_evidence_receipts
BEGIN
  SELECT RAISE(ABORT, 'knowledge-evidence-receipt-immutable');
END;
