ALTER TABLE conversations ADD COLUMN title TEXT NOT NULL DEFAULT '新对话';
ALTER TABLE conversations ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
  CHECK(status IN ('active','archived'));
ALTER TABLE conversations ADD COLUMN archived_at TEXT;
ALTER TABLE conversations ADD COLUMN continued_from_conversation_id TEXT REFERENCES conversations(id);
ALTER TABLE conversations ADD COLUMN snapshot_integrity TEXT NOT NULL DEFAULT 'legacy'
  CHECK(snapshot_integrity IN ('frozen','legacy'));

UPDATE conversations
SET snapshot_integrity = 'frozen'
WHERE active_context_snapshot_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM context_snapshots cs
    JOIN paper_versions pv ON pv.id=cs.paper_version_id
      AND pv.paper_id=conversations.paper_id
    JOIN summary_revisions sr ON sr.id=cs.summary_revision_id
      AND sr.paper_version_id=cs.paper_version_id
      AND sr.extraction_run_id=cs.extraction_run_id
    JOIN extraction_runs er ON er.id=cs.extraction_run_id
      AND er.paper_version_id=cs.paper_version_id
      AND er.status='succeeded'
    WHERE cs.id = conversations.active_context_snapshot_id
      AND cs.conversation_id = conversations.id
      AND cs.paper_version_id IS NOT NULL
      AND cs.summary_revision_id IS NOT NULL
      AND cs.extraction_run_id IS NOT NULL
  )
  AND NOT EXISTS (
    SELECT 1
    FROM messages m
    WHERE m.conversation_id = conversations.id
      AND m.context_snapshot_id <> conversations.active_context_snapshot_id
  )
  AND (SELECT count(*) FROM context_snapshots all_snapshots
    WHERE all_snapshots.conversation_id=conversations.id)=1
  AND NOT EXISTS (
    SELECT 1 FROM context_snapshots cs, json_each(cs.repositories_json) repository
    LEFT JOIN repository_snapshots rs ON rs.id=json_extract(repository.value,'$.id')
      AND rs.commit_sha=json_extract(repository.value,'$.commitSha')
    WHERE cs.id=conversations.active_context_snapshot_id AND rs.id IS NULL
  );

CREATE TABLE conversation_integrity_diagnostics (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id),
  integrity TEXT NOT NULL CHECK(integrity IN ('frozen','legacy')),
  reason TEXT NOT NULL,
  diagnosed_at TEXT NOT NULL
) STRICT;

INSERT INTO conversation_integrity_diagnostics(conversation_id,integrity,reason,diagnosed_at)
SELECT id,snapshot_integrity,
  CASE snapshot_integrity
    WHEN 'frozen' THEN 'complete-frozen-context'
    ELSE 'incomplete-or-inconsistent-context'
  END,
  strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM conversations;

CREATE INDEX conversations_paper_order
  ON conversations(paper_id,status,updated_at DESC,created_at DESC,id DESC);

CREATE TRIGGER context_snapshots_one_per_new_conversation
BEFORE INSERT ON context_snapshots
WHEN EXISTS (SELECT 1 FROM context_snapshots WHERE conversation_id=NEW.conversation_id)
BEGIN
  SELECT RAISE(ABORT,'conversation-context-snapshot-immutable');
END;

CREATE TRIGGER conversations_context_snapshot_set_once
BEFORE UPDATE OF active_context_snapshot_id ON conversations
WHEN OLD.active_context_snapshot_id IS NOT NULL AND NEW.active_context_snapshot_id IS NOT OLD.active_context_snapshot_id
BEGIN
  SELECT RAISE(ABORT,'conversation-context-snapshot-immutable');
END;

CREATE TRIGGER context_snapshots_no_update
BEFORE UPDATE ON context_snapshots
BEGIN
  SELECT RAISE(ABORT,'conversation-context-snapshot-immutable');
END;

CREATE TRIGGER context_snapshots_no_delete
BEFORE DELETE ON context_snapshots
BEGIN
  SELECT RAISE(ABORT,'conversation-context-snapshot-immutable');
END;

ALTER TABLE messages ADD COLUMN ordinal INTEGER;
ALTER TABLE messages ADD COLUMN in_reply_to_message_id TEXT REFERENCES messages(id);

UPDATE messages AS target
SET ordinal = (
  SELECT count(*)
  FROM messages AS prior
  WHERE prior.conversation_id = target.conversation_id
    AND (prior.created_at < target.created_at OR (prior.created_at = target.created_at AND prior.rowid <= target.rowid))
);

CREATE UNIQUE INDEX messages_conversation_ordinal
  ON messages(conversation_id,ordinal);
CREATE UNIQUE INDEX messages_one_assistant_reply
  ON messages(in_reply_to_message_id)
  WHERE role = 'assistant' AND in_reply_to_message_id IS NOT NULL;

CREATE TABLE conversation_turn_attempts (
  job_run_id TEXT PRIMARY KEY REFERENCES job_runs(id),
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  user_message_id TEXT NOT NULL REFERENCES messages(id),
  attempt_no INTEGER NOT NULL CHECK(attempt_no > 0),
  created_at TEXT NOT NULL,
  UNIQUE(user_message_id,attempt_no)
) STRICT;

CREATE INDEX conversation_turn_attempts_conversation
  ON conversation_turn_attempts(conversation_id,created_at,job_run_id);

CREATE TABLE message_citations (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id),
  ordinal INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('pdf_anchor','summary_locator','repo_lines','message')),
  source_handle TEXT NOT NULL,
  locator_json TEXT NOT NULL CHECK(json_valid(locator_json)),
  verification_status TEXT NOT NULL CHECK(verification_status IN ('verified','unverified')),
  UNIQUE(message_id,ordinal)
) STRICT;
