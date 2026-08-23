CREATE TABLE knowledge_conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
) STRICT;

CREATE INDEX idx_knowledge_conversations_activity
  ON knowledge_conversations(status, updated_at DESC, id);

CREATE TABLE knowledge_messages (
  id TEXT PRIMARY KEY,
  knowledge_conversation_id TEXT NOT NULL REFERENCES knowledge_conversations(id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK(role IN ('user','assistant')),
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  reply_to_message_id TEXT REFERENCES knowledge_messages(id) ON DELETE RESTRICT,
  content TEXT NOT NULL,
  answer_basis TEXT CHECK(answer_basis IS NULL OR answer_basis IN ('curated-evidence','conversation-context','model-knowledge')),
  coverage TEXT CHECK(coverage IS NULL OR coverage IN ('supported','partial','none','conflicting')),
  structured_answer_json TEXT CHECK(structured_answer_json IS NULL OR json_valid(structured_answer_json)),
  created_at TEXT NOT NULL,
  UNIQUE(knowledge_conversation_id, ordinal),
  CHECK((role='user' AND reply_to_message_id IS NULL AND answer_basis IS NULL AND coverage IS NULL AND structured_answer_json IS NULL)
    OR (role='assistant' AND reply_to_message_id IS NOT NULL AND answer_basis IS NOT NULL AND coverage IS NOT NULL AND structured_answer_json IS NOT NULL))
) STRICT;

CREATE TRIGGER knowledge_messages_reply_owner
BEFORE INSERT ON knowledge_messages
WHEN NEW.role='assistant' AND NOT EXISTS (
  SELECT 1 FROM knowledge_messages parent
  WHERE parent.id=NEW.reply_to_message_id
    AND parent.knowledge_conversation_id=NEW.knowledge_conversation_id
    AND parent.role='user'
)
BEGIN
  SELECT RAISE(ABORT, 'knowledge-message-reply-invalid');
END;

CREATE TRIGGER knowledge_messages_no_update
BEFORE UPDATE ON knowledge_messages
BEGIN
  SELECT RAISE(ABORT, 'knowledge-message-immutable');
END;

CREATE TRIGGER knowledge_messages_no_delete
BEFORE DELETE ON knowledge_messages
BEGIN
  SELECT RAISE(ABORT, 'knowledge-message-immutable');
END;

CREATE TABLE knowledge_turn_attempts (
  id TEXT PRIMARY KEY,
  job_run_id TEXT NOT NULL UNIQUE REFERENCES job_runs(id) ON DELETE RESTRICT,
  knowledge_conversation_id TEXT REFERENCES knowledge_conversations(id) ON DELETE RESTRICT,
  submission_id TEXT NOT NULL UNIQUE,
  cancel_idempotency_key TEXT UNIQUE,
  question_hash TEXT NOT NULL,
  run_epoch INTEGER NOT NULL DEFAULT 0 CHECK(run_epoch >= 0),
  state TEXT NOT NULL CHECK(state IN ('running','succeeded','failed','canceled','interrupted')),
  user_message_id TEXT REFERENCES knowledge_messages(id) ON DELETE RESTRICT,
  assistant_message_id TEXT REFERENCES knowledge_messages(id) ON DELETE RESTRICT,
  error_code TEXT,
  error_detail TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  CHECK((state='succeeded' AND knowledge_conversation_id IS NOT NULL AND user_message_id IS NOT NULL AND assistant_message_id IS NOT NULL)
    OR (state<>'succeeded' AND user_message_id IS NULL AND assistant_message_id IS NULL))
) STRICT;

CREATE INDEX idx_knowledge_turn_attempts_conversation
  ON knowledge_turn_attempts(knowledge_conversation_id, created_at DESC);
