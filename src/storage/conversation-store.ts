import type Database from "better-sqlite3";

export class ConversationStore {
  constructor(private readonly database: Database.Database, private readonly now: () => Date) {}

  listForPaper(paperId: string): unknown[] {
    return (this.database.prepare(`SELECT id,paper_id,title,status,snapshot_integrity,active_context_snapshot_id,
      continued_from_conversation_id,created_at,updated_at,archived_at
      FROM conversations WHERE paper_id=?
      ORDER BY updated_at DESC,created_at DESC,rowid DESC`).all(paperId) as Array<{
        id: string; paper_id: string; title: string; status: string; snapshot_integrity: string;
        active_context_snapshot_id: string | null; continued_from_conversation_id: string | null;
        created_at: string; updated_at: string; archived_at: string | null;
      }>).map((row) => ({
        id: row.id, paperId: row.paper_id, title: row.title, status: row.status,
        snapshotIntegrity: row.snapshot_integrity, contextSnapshotId: row.active_context_snapshot_id,
        continuedFromConversationId: row.continued_from_conversation_id, createdAt: row.created_at,
        updatedAt: row.updated_at, archivedAt: row.archived_at,
      }));
  }

  rename(conversationId: string, title: string): boolean {
    const normalized = title.trim().slice(0, 120);
    if (!normalized) return false;
    return this.database.prepare("UPDATE conversations SET title=?,updated_at=? WHERE id=?")
      .run(normalized, this.now().toISOString(), conversationId).changes === 1;
  }

  setArchived(conversationId: string, archived: boolean): boolean {
    const now = this.now().toISOString();
    return this.database.prepare(`UPDATE conversations SET status=?,archived_at=?,updated_at=? WHERE id=?`)
      .run(archived ? "archived" : "active", archived ? now : null, now, conversationId).changes === 1;
  }

  read(conversationId: string): unknown | null {
    const row = this.database.prepare(`SELECT c.id,c.paper_id,c.title,c.status,c.snapshot_integrity,
      c.active_context_snapshot_id,c.continued_from_conversation_id,c.created_at,c.updated_at,c.archived_at,
      cs.paper_version_id,cs.summary_revision_id,cs.extraction_run_id,cs.repositories_json,er.page_count
      FROM conversations c LEFT JOIN context_snapshots cs ON cs.id=c.active_context_snapshot_id
      LEFT JOIN extraction_runs er ON er.id=cs.extraction_run_id
      WHERE c.id=?`).get(conversationId) as {
        id: string; paper_id: string; title: string; status: string; snapshot_integrity: string;
        active_context_snapshot_id: string | null; continued_from_conversation_id: string | null;
        created_at: string; updated_at: string; archived_at: string | null; paper_version_id: string | null;
        summary_revision_id: string | null; extraction_run_id: string | null; repositories_json: string | null;
        page_count: number | null;
      } | undefined;
    if (!row) return null;
    const messages = (this.database.prepare(`SELECT id,role,content,created_at,ordinal,in_reply_to_message_id,citations_json
      FROM messages WHERE conversation_id=? ORDER BY ordinal,created_at,id`).all(conversationId) as Array<{
        id: string; role: string; content: string; created_at: string; ordinal: number | null;
        in_reply_to_message_id: string | null; citations_json: string;
      }>).map((message) => {
        const attempts = message.role === "user" ? (this.database.prepare(`SELECT a.job_run_id,a.attempt_no,j.state,j.error_json,j.started_at,j.completed_at
          FROM conversation_turn_attempts a JOIN job_runs j ON j.id=a.job_run_id
          WHERE a.user_message_id=? ORDER BY a.attempt_no`).all(message.id) as Array<{
            job_run_id: string; attempt_no: number; state: string; error_json: string | null;
            started_at: string | null; completed_at: string | null;
          }>).map((attempt) => ({ id: attempt.job_run_id, attemptNo: attempt.attempt_no, state: attempt.state,
            error: attempt.error_json ? JSON.parse(attempt.error_json) as unknown : null,
            startedAt: attempt.started_at, completedAt: attempt.completed_at })) : [];
        const normalized = this.database.prepare(`SELECT kind,source_handle,locator_json,verification_status
          FROM message_citations WHERE message_id=? ORDER BY ordinal`).all(message.id) as Array<{
            kind: string; source_handle: string; locator_json: string; verification_status: string;
          }>;
        const citations = normalized.length > 0
          ? normalized.map((citation) => ({ kind: citation.kind, sourceHandle: citation.source_handle,
            locator: JSON.parse(citation.locator_json) as unknown, verificationStatus: citation.verification_status }))
          : JSON.parse(message.citations_json) as unknown[];
        return { id: message.id, role: message.role, content: message.content, ordinal: message.ordinal,
          inReplyToMessageId: message.in_reply_to_message_id, createdAt: message.created_at, citations, attempts };
      });
    return {
      conversation: { id: row.id, paperId: row.paper_id, title: row.title, status: row.status,
        snapshotIntegrity: row.snapshot_integrity, contextSnapshotId: row.active_context_snapshot_id,
        continuedFromConversationId: row.continued_from_conversation_id, createdAt: row.created_at,
        updatedAt: row.updated_at, archivedAt: row.archived_at },
      contextSnapshot: row.active_context_snapshot_id ? { id: row.active_context_snapshot_id,
        paperVersionId: row.paper_version_id, summaryRevisionId: row.summary_revision_id,
        extractionRunId: row.extraction_run_id, pageCount: row.page_count,
        repositorySnapshots: JSON.parse(row.repositories_json ?? "[]") as unknown[] } : null,
      messages,
    };
  }

  turnBlock(conversationId: string, idempotencyKey: string): string | null {
    const replay = this.database.prepare(`SELECT 1 FROM job_runs j JOIN conversation_turn_attempts a ON a.job_run_id=j.id
      WHERE j.idempotency_key=? AND a.conversation_id=?`).get(idempotencyKey, conversationId);
    if (replay) return null;
    const conversation = this.database.prepare("SELECT status,snapshot_integrity FROM conversations WHERE id=?").get(conversationId) as
      { status: string; snapshot_integrity: string } | undefined;
    if (!conversation) return "conversation-not-found";
    if (conversation.status !== "active") return "conversation-archived";
    if (conversation.snapshot_integrity !== "frozen") return "conversation-legacy-read-only";
    const active = this.database.prepare(`SELECT 1 FROM conversation_turn_attempts a JOIN job_runs j ON j.id=a.job_run_id
      WHERE a.conversation_id=? AND j.state IN ('queued','running') LIMIT 1`).get(conversationId);
    return active ? "conversation-turn-active" : null;
  }

  retryBlock(messageId: string, idempotencyKey: string): string | null {
    const replay = this.database.prepare(`SELECT 1 FROM job_runs j JOIN conversation_turn_attempts a ON a.job_run_id=j.id
      WHERE j.idempotency_key=? AND a.user_message_id=?`).get(idempotencyKey, messageId);
    if (replay) return null;
    const row = this.database.prepare("SELECT conversation_id FROM messages WHERE id=? AND role='user'").get(messageId) as
      { conversation_id: string } | undefined;
    if (!row) return "message-not-found";
    const conversationBlock = this.turnBlock(row.conversation_id, idempotencyKey);
    if (conversationBlock) return conversationBlock;
    const retryable = this.database.prepare(`SELECT 1 FROM messages m WHERE m.id=?
      AND NOT EXISTS (SELECT 1 FROM messages reply WHERE reply.in_reply_to_message_id=m.id)
      AND EXISTS (SELECT 1 FROM conversation_turn_attempts a JOIN job_runs j ON j.id=a.job_run_id
        WHERE a.user_message_id=m.id AND j.state IN ('failed','interrupted'))`).get(messageId);
    return retryable ? null : "message-not-retryable";
  }

  paperExists(paperId: string): boolean {
    return Boolean(this.database.prepare("SELECT 1 FROM papers WHERE id=?").get(paperId));
  }

  messageConversationId(messageId: string): string | null {
    return (this.database.prepare("SELECT conversation_id FROM messages WHERE id=? AND role='user'").get(messageId) as
      { conversation_id: string } | undefined)?.conversation_id ?? null;
  }
}
