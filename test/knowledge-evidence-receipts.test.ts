import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import type { KnowledgeAnswerRunner } from "../src/agent/knowledge-answer.js";
import { KnowledgeConversationCoordinator } from "../src/storage/knowledge-conversation.js";
import { initializeDataRoot } from "../src/storage/layout.js";
import { createSnapshot, restoreSnapshot, verifySnapshot } from "../src/storage/data-operations.js";

describe("Knowledge Evidence Receipts", () => {
  it("atomically commits immutable verified receipts with the successful assistant message", async () => {
    const root = await mkdtemp(join(tmpdir(), "scholarloom-knowledge-receipt-"));
    const layout = initializeDataRoot(join(root, "data"));
    const runner: KnowledgeAnswerRunner = { async answer() { return groundedAnswer(); } };
    const conversations = KnowledgeConversationCoordinator.open(layout, runner);
    const submitted = conversations.submit({ question: "Diffusion 如何生成？", idempotencyKey: "receipt-turn" });
    const completed = await eventually(() => conversations.readAttempt(submitted.id), (value) => value.state !== "running");

    expect(completed.state).toBe("succeeded");
    const message = conversations.read(completed.conversationId!).messages[1]!;
    expect(message.evidenceReceipts).toEqual([expect.objectContaining({ ordinal: 1, sourceType: "summary",
      sourceId: "summary-1", quote: "反向过程逐步去噪。", whySelected: "直接支持生成过程。" })]);
    const database = new Database(layout.databasePath);
    const row = database.prepare(`SELECT r.run_epoch,j.run_epoch job_epoch,a.run_epoch attempt_epoch
      FROM knowledge_evidence_receipts r JOIN job_runs j ON j.id=r.job_run_id
      JOIN knowledge_turn_attempts a ON a.job_run_id=j.id`).get() as Record<string, number>;
    expect(row).toEqual({ run_epoch: 1, job_epoch: 1, attempt_epoch: 1 });
    expect(() => database.prepare("UPDATE knowledge_evidence_receipts SET quote_text='mutated'").run())
      .toThrow("knowledge-evidence-receipt-immutable");
    const receipt = database.prepare("SELECT * FROM knowledge_evidence_receipts").get() as Record<string, unknown>;
    expect(() => database.prepare(`INSERT INTO knowledge_evidence_receipts
      (id,assistant_message_id,job_run_id,run_epoch,ordinal,source_type,source_id,source_revision_id,
       content_hash,source_title,trust_label,locator_json,quote_text,why_selected,created_at)
      VALUES ('wrong-lineage',?,?,2,2,'summary','summary-1','summary-1',?,'Diffusion',
        'generated-from-primary-source','{"lineStart":3,"lineEnd":3}','quote','why',?)`)
      .run(receipt.assistant_message_id, receipt.job_run_id, "a".repeat(64), new Date().toISOString()))
      .toThrow("knowledge-evidence-receipt-owner-invalid");
    database.close();
    await conversations.close();
    const snapshotRoot = join(root, "snapshot");
    await createSnapshot(layout, snapshotRoot);
    expect(verifySnapshot(snapshotRoot)).toMatchObject({ healthy: true, errors: [] });
    const restored = restoreSnapshot(snapshotRoot, join(root, "restored"));
    const restoredDatabase = new Database(restored.databasePath, { readonly: true });
    expect(restoredDatabase.prepare("SELECT count(*) FROM knowledge_evidence_receipts").pluck().get()).toBe(1);
    expect(restoredDatabase.pragma("foreign_key_check")).toEqual([]);
    restoredDatabase.close();
  });

  it("links an available Topic Knowledge receipt to its canonical editor", async () => {
    const root = await mkdtemp(join(tmpdir(), "scholarloom-topic-knowledge-receipt-"));
    const layout = initializeDataRoot(join(root, "data"));
    const topicId = "topic:dexterous-manipulation";
    const revisionId = `${topicId}:r1`;
    const conversations = KnowledgeConversationCoordinator.open(layout, {
      async answer() { return groundedTopicAnswer(topicId, revisionId, markdownHash); },
    });
    const database = new Database(layout.databasePath);
    const markdownPath = `knowledge/directions/${encodeURIComponent(topicId)}.md`;
    const markdown = "# Dexterous Manipulation\n\n强化学习可用于灵巧手操作。\n";
    const markdownHash = createHash("sha256").update(markdown).digest("hex");
    const absolutePath = join(layout.vaultRoot, markdownPath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, markdown, "utf8");
    const now = new Date().toISOString();
    database.prepare(`INSERT INTO direction_catalog
      (topic_id,title,aliases_json,scope,usage_level,lifecycle_status,superseded_by,revision_id,revision_number,
       review_status,markdown_path,markdown_hash,created_at,updated_at)
      VALUES (?,?,'[]','scope','knowledge-ready','active',NULL,?,1,'confirmed',?,?,?,?)`)
      .run(topicId, "Dexterous Manipulation", revisionId, markdownPath, markdownHash, now, now);
    database.prepare(`INSERT INTO topic_knowledge_revisions
      (id,topic_id,revision_number,usage_level,review_status,epistemic_status,markdown_path,markdown_hash,
       history_path,knowledge_body_hash,provenance_json,owner_attested,eligibility_status,active,confirmed_at,created_at)
      VALUES (?,?,1,'knowledge-ready','confirmed','evidence-backed',?,?,NULL,?,'[]',1,'eligible',1,?,?)`)
      .run(revisionId, topicId, markdownPath, markdownHash, markdownHash, now, now);
    database.prepare(`INSERT INTO curated_search_documents(id,source_type,source_id,title,body,updated_at)
      VALUES (?,'topic-knowledge',?,?,?,?)`).run(`curated:${topicId}`, topicId,
        "Dexterous Manipulation", "强化学习可用于灵巧手操作。", now);

    const submitted = conversations.submit({ question: "灵巧手操作中的 RL？", idempotencyKey: "topic-receipt" });
    const completed = await eventually(() => conversations.readAttempt(submitted.id), (value) => value.state !== "running");
    const receipt = conversations.read(completed.conversationId!).messages[1]!.evidenceReceipts[0]!;

    expect(receipt).toMatchObject({ available: true,
      href: "/papers/organize?view=all&direction=topic%3Adexterous-manipulation#topic-knowledge" });
    database.close();
    await conversations.close();
  });
});

function groundedAnswer() {
  return { answerBasis: "curated-evidence" as const, coverage: "supported" as const,
    directAnswer: "反向过程逐步去噪。",
    claims: [{ text: "反向过程逐步去噪。", status: "source-supported" as const, citationOrdinals: [1] }],
    disagreements: [], unknowns: [], citations: [{ handle: "curated-source-01", sourceType: "summary" as const,
      sourceId: "summary-1", revisionId: "summary-1", contentHash: "a".repeat(64), title: "Diffusion",
      trustLabel: "generated-from-primary-source" as const, locator: { lineStart: 3, lineEnd: 3 },
      quote: "反向过程逐步去噪。", whySelected: "直接支持生成过程。" }],
    retrievalSummary: { searched: true, queryCount: 1, candidateCount: 3, openedSourceCount: 1,
      usedSourceCount: 1, budgetExhausted: false, projectionStale: false, lastSuccessfulAt: null } };
}

function groundedTopicAnswer(topicId: string, revisionId: string, contentHash: string) {
  return { answerBasis: "curated-evidence" as const, coverage: "supported" as const,
    directAnswer: "强化学习可用于灵巧手操作。",
    claims: [{ text: "强化学习可用于灵巧手操作。", status: "source-supported" as const, citationOrdinals: [1] }],
    disagreements: [], unknowns: [], citations: [{ handle: "curated-source-01", sourceType: "topic-knowledge" as const,
      sourceId: topicId, revisionId, contentHash, title: "Dexterous Manipulation",
      trustLabel: "user-confirmed" as const, locator: { lineStart: 3, lineEnd: 3 },
      quote: "强化学习可用于灵巧手操作。", whySelected: "直接支持问题。" }],
    retrievalSummary: { searched: true, queryCount: 1, candidateCount: 1, openedSourceCount: 1,
      usedSourceCount: 1, budgetExhausted: false, projectionStale: false, lastSuccessfulAt: null } };
}

async function eventually<T>(read: () => T, done: (value: T) => boolean): Promise<T> {
  for (let count = 0; count < 100; count += 1) {
    const value = read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("attempt-timeout");
}
