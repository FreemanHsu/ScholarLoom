import type Database from "better-sqlite3";
import { ContextSnapshotDiffReader } from "./context-snapshot-diff.js";

type ConversationRow = {
  id: string;
  paper_id: string;
  title: string;
  status: string;
  snapshot_integrity: string;
  active_context_snapshot_id: string | null;
  continued_from_conversation_id: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
};

const conversationSelect = `SELECT id,paper_id,title,status,snapshot_integrity,active_context_snapshot_id,
  continued_from_conversation_id,created_at,updated_at,archived_at FROM conversations`;

function toRef(row: ConversationRow) {
  return {
    id: row.id,
    paperId: row.paper_id,
    title: row.title,
    status: row.status,
    snapshotIntegrity: row.snapshot_integrity,
    continuedFromConversationId: row.continued_from_conversation_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

export class ConversationLineageReader {
  readonly #diff: ContextSnapshotDiffReader;

  constructor(private readonly database: Database.Database) {
    this.#diff = new ContextSnapshotDiffReader(database);
  }

  read(conversationId: string): unknown | null {
    const current = this.database.prepare(`${conversationSelect} WHERE id=?`).get(conversationId) as ConversationRow | undefined;
    if (!current) return null;
    const successors = (this.database.prepare(`${conversationSelect}
      WHERE paper_id=? AND continued_from_conversation_id=? ORDER BY created_at,id`)
      .all(current.paper_id, current.id) as ConversationRow[]).map(toRef);
    if (!current.continued_from_conversation_id) {
      return { conversation: toRef(current), parent: null, ancestors: [], successors,
        contextComparison: { status: "independent" } };
    }
    const ancestors: ConversationRow[] = [];
    const visited = new Set([current.id]);
    let cursorId: string | null = current.continued_from_conversation_id;
    let integrityWarning: string | null = null;
    while (cursorId && ancestors.length < 100) {
      if (visited.has(cursorId)) {
        integrityWarning = "conversation-lineage-cycle";
        break;
      }
      visited.add(cursorId);
      const ancestor = this.database.prepare(`${conversationSelect} WHERE id=?`).get(cursorId) as ConversationRow | undefined;
      if (!ancestor) {
        integrityWarning = "conversation-lineage-parent-missing";
        break;
      }
      if (ancestor.paper_id !== current.paper_id) {
        integrityWarning = "conversation-lineage-paper-mismatch";
        break;
      }
      ancestors.push(ancestor);
      cursorId = ancestor.continued_from_conversation_id;
    }
    if (cursorId && ancestors.length >= 100) integrityWarning = "conversation-lineage-depth-exceeded";
    const parent = ancestors[0] ?? null;
    return {
      conversation: toRef(current),
      parent: parent ? toRef(parent) : null,
      ancestors: ancestors.toReversed().map(toRef),
      successors,
      contextComparison: this.#compare(current, parent),
      ...(integrityWarning ? { integrityWarning } : {}),
    };
  }

  #compare(current: ConversationRow, parent: ConversationRow | null): unknown {
    if (!parent) return { status: "unavailable", reason: "conversation-lineage-parent-unavailable" };
    if (current.snapshot_integrity !== "frozen" || parent.snapshot_integrity !== "frozen") {
      return { status: "unavailable", reason: "conversation-context-legacy" };
    }
    return this.#diff.compare(parent.active_context_snapshot_id, current.active_context_snapshot_id);
  }
}
