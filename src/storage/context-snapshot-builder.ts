import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

export class ContextSnapshotBuilder {
  constructor(private readonly database: Database.Database, private readonly now: () => Date) {}

  create(paperId: string, continuedFromConversationId: string | null = null): unknown | null {
    const timestamp = this.now().toISOString();
    const row = this.database.prepare(`SELECT p.current_version_id,s.id summary_id,s.extraction_run_id,e.page_count
      FROM papers p JOIN summary_revisions s ON s.paper_id=p.id AND s.paper_version_id=p.current_version_id AND s.status='active'
      JOIN extraction_runs e ON e.id=s.extraction_run_id AND e.paper_version_id=p.current_version_id AND e.status='succeeded'
      WHERE p.id=?`).get(paperId) as
      { current_version_id: string; summary_id: string; extraction_run_id: string; page_count: number } | undefined;
    if (!row) return null;
    if (continuedFromConversationId && !this.database.prepare("SELECT 1 FROM conversations WHERE id=? AND paper_id=?")
      .get(continuedFromConversationId, paperId)) return null;
    const repositories = this.database.prepare(`SELECT rs.id,rs.commit_sha FROM paper_code_links pcl
      JOIN repository_snapshots rs ON rs.id=pcl.repository_snapshot_id
      WHERE pcl.paper_id=? AND pcl.status='confirmed' ORDER BY rs.id`).all(paperId) as Array<{ id: string; commit_sha: string }>;
    const conversationId = `conversation:${randomUUID()}`;
    const snapshotId = `context-snapshot:${randomUUID()}`;
    this.database.transaction(() => {
      const pageElements = this.database.prepare(`SELECT id,page_number FROM document_elements
        WHERE extraction_run_id=? AND element_type='page' ORDER BY page_number`).all(row.extraction_run_id) as
        Array<{ id: string; page_number: number }>;
      if (pageElements.length === 0) throw new Error("conversation-context-unavailable");
      for (const page of pageElements) {
        const anchorId = `evidence:${row.current_version_id}:page:${page.page_number}:source`;
        this.database.prepare(`INSERT OR IGNORE INTO evidence_anchors
          (id,anchor_type,paper_version_id,extraction_run_id,document_element_id,page_number,quote_text,verification_status,locator_json,created_at)
          VALUES (?,'pdf-page',?,?,?,?,NULL,'located',?,?)`)
          .run(anchorId, row.current_version_id, row.extraction_run_id, page.id, page.page_number,
            JSON.stringify({ page: page.page_number }), timestamp);
      }
      this.database.prepare(`INSERT INTO conversations
        (id,paper_id,active_context_snapshot_id,title,status,snapshot_integrity,continued_from_conversation_id,created_at,updated_at)
        VALUES (?,?,?,'新对话','active','frozen',?,?,?)`)
        .run(conversationId, paperId, snapshotId, continuedFromConversationId, timestamp, timestamp);
      this.database.prepare(`INSERT INTO context_snapshots
        (id,conversation_id,paper_version_id,summary_revision_id,extraction_run_id,repositories_json,created_at)
        VALUES (?,?,?,?,?,?,?)`).run(snapshotId, conversationId, row.current_version_id, row.summary_id, row.extraction_run_id,
          JSON.stringify(repositories.map((repository) => ({ id: repository.id, commitSha: repository.commit_sha }))), timestamp);
    })();
    return { conversation: { id: conversationId, paperId, title: "新对话", status: "active",
      snapshotIntegrity: "frozen", continuedFromConversationId }, contextSnapshot: { id: snapshotId,
      paperVersionId: row.current_version_id, summaryRevisionId: row.summary_id, extractionRunId: row.extraction_run_id,
      pageCount: row.page_count,
      repositorySnapshots: repositories.map((repository) => ({ id: repository.id, commitSha: repository.commit_sha })) } };
  }
}
