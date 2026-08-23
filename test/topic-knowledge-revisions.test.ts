import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { initializeDataRoot } from "../src/storage/layout.js";

async function pdf(text: string): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  document.addPage().drawText(text, { x: 40, y: 700, font });
  return document.save();
}

async function waitForImport(app: FastifyInstance, id: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const result = await app.inject({ method: "GET", url: `/api/imports/${encodeURIComponent(id)}` });
    if (result.json().jobs.at(-1)?.state === "succeeded") return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("import-timeout");
}

describe("Topic KnowledgeRevision", () => {
  it("promotes only attested substantive knowledge with current provenance and rebuilds deterministically", async () => {
    const layout = initializeDataRoot(join(await mkdtemp(join(tmpdir(), "scholarloom-topic-knowledge-")), "data"));
    const app = await createApp({
      storageLayout: layout,
      paperSource: {
        async resolve(arxivId) { return { arxivId, latestVersion: 1,
          title: "Video Generation Models are General-Purpose Vision Learners",
          authors: ["Ada Topic"], year: 2026 }; },
        async fetchPdf() { return pdf("Video generation provides reusable visual representations."); },
      },
      codexRunner: {
        async runSummary() { return {
          sections: [{ key: "overview", title: "概述", body: "视频生成模型能够学习可迁移的视觉表征。" }],
          claims: [{ voice: "authors-claim" as const, claim: "Generation transfers to perception.",
            sourceHandle: "pdf-page:1" }], readStatus: "read" as const,
        }; },
      },
    });
    const imported = await app.inject({ method: "POST", url: "/api/imports",
      payload: { arxivUrl: "https://arxiv.org/abs/2608.03001" } });
    expect(imported.statusCode, imported.body).toBe(202);
    await waitForImport(app, imported.json().importRequest.id);
    const paperId = imported.json().paper.id as string;

    expect((await app.inject({ method: "POST", url: "/api/directions",
      headers: { "idempotency-key": "create-vision-direction" }, payload: {
        id: "topic:vision-representation-learning", title: "Vision Representation Learning",
        scope: "研究如何学习可迁移的视觉表征。",
      } })).statusCode).toBe(201);
    expect((await app.inject({ method: "PUT", url: `/api/papers/${encodeURIComponent(paperId)}/organization`,
      headers: { "idempotency-key": "assign-vision-direction" }, payload: {
        aliases: [{ name: "GenCeption", kind: "model-name", preferred: true }],
        directions: [{ topicId: "topic:vision-representation-learning", role: "primary" }],
      } })).statusCode).toBe(200);

    const current = (await app.inject({ method: "GET",
      url: "/api/directions/topic%3Avision-representation-learning/knowledge" })).json();
    const options = (await app.inject({ method: "GET",
      url: "/api/directions/topic%3Avision-representation-learning/knowledge/provenance-options" })).json();
    expect(current).toMatchObject({ usageLevel: "classification", indexed: false });
    expect(options.sources).toEqual([expect.objectContaining({ sourceType: "summary", paperId })]);
    const summary = options.sources[0];
    const input = {
      usageLevel: "knowledge-ready",
      sections: { Syntheses: "生成式预测目标不仅用于生成，也能形成可迁移的视觉表征。" },
      provenance: [{ sourceType: "summary", sourceId: summary.sourceId }],
      ownerAttested: true,
      expectedRevisionId: current.revisionId,
      expectedMarkdownHash: current.markdownHash,
    };
    const preview = await app.inject({ method: "POST",
      url: "/api/directions/topic%3Avision-representation-learning/knowledge/preview", payload: input });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json()).toMatchObject({ eligible: true, projectionOperation: "upsert",
      indexedSections: ["Syntheses"] });
    const promoted = await app.inject({ method: "POST",
      url: "/api/directions/topic%3Avision-representation-learning/knowledge/revisions",
      headers: { "idempotency-key": "promote-vision-topic" }, payload: input });
    expect(promoted.statusCode, promoted.body).toBe(201);
    expect(promoted.json()).toMatchObject({ topicKnowledge: { usageLevel: "knowledge-ready", indexed: true } });

    const promotedCurrent = (await app.inject({ method: "GET",
      url: "/api/directions/topic%3Avision-representation-learning/knowledge" })).json();
    const blockedRename = await app.inject({ method: "POST",
      url: "/api/directions/topic%3Avision-representation-learning/rename",
      headers: { "idempotency-key": "unsafe-topic-rename" }, payload: {
        title: "Visual Representation Learning", aliases: [], scope: promotedCurrent.scope,
        scopeMeaningUnchanged: true, expectedRevisionId: promotedCurrent.revisionId,
        expectedMarkdownHash: promotedCurrent.markdownHash,
      } });
    expect(blockedRename.statusCode, blockedRename.body).toBe(409);
    expect(blockedRename.json()).toMatchObject({ code: "topic-knowledge-rename-required" });
    const renamed = await app.inject({ method: "POST",
      url: "/api/directions/topic%3Avision-representation-learning/knowledge/revisions",
      headers: { "idempotency-key": "atomic-topic-rename" }, payload: {
        title: "Visual Representation Learning", aliases: ["Vision Rep Learning"],
        scope: promotedCurrent.scope, usageLevel: "knowledge-ready", sections: promotedCurrent.sections,
        provenance: promotedCurrent.provenance, ownerAttested: true,
        expectedRevisionId: promotedCurrent.revisionId, expectedMarkdownHash: promotedCurrent.markdownHash,
      } });
    expect(renamed.statusCode, renamed.body).toBe(201);

    let database = new Database(layout.databasePath, { readonly: true });
    const curated = database.prepare(`SELECT title,body FROM curated_search_documents
      WHERE source_type='topic-knowledge' AND source_id='topic:vision-representation-learning'`).get() as
      { title: string; body: string };
    expect(curated.title).toBe("Visual Representation Learning");
    expect(curated.body).toContain("生成式预测目标");
    expect(curated.body).not.toContain("研究如何学习");
    const old = database.prepare(`SELECT history_path FROM topic_knowledge_revisions
      WHERE topic_id='topic:vision-representation-learning' AND active=0`).get() as { history_path: string };
    database.close();
    expect(old.history_path).toContain("topic%3Avision-representation-learning");
    await access(join(layout.vaultRoot, old.history_path));

    expect((await app.inject({ method: "POST", url: "/api/diagnostics/rebuild-curated" })).json())
      .toMatchObject({ count: 2 });
    database = new Database(layout.databasePath, { readonly: true });
    expect(database.prepare(`SELECT count(*) FROM curated_search_documents
      WHERE source_type='topic-knowledge'`).pluck().get()).toBe(1);
    database.close();

    database = new Database(layout.databasePath);
    database.prepare("UPDATE summary_revisions SET status='superseded' WHERE id=?").run(summary.sourceId);
    database.close();
    expect((await app.inject({ method: "POST", url: "/api/diagnostics/rebuild-curated" })).json())
      .toMatchObject({ count: 0 });
    database = new Database(layout.databasePath);
    expect(database.prepare(`SELECT count(*) FROM curated_search_documents
      WHERE source_type='topic-knowledge'`).pluck().get()).toBe(0);
    expect(database.prepare(`SELECT eligibility_status FROM topic_knowledge_revisions
      WHERE topic_id='topic:vision-representation-learning' AND active=1`).pluck().get()).toBe("invalid-provenance");
    database.prepare("UPDATE summary_revisions SET status='active' WHERE id=?").run(summary.sourceId);
    database.close();
    expect((await app.inject({ method: "POST", url: "/api/diagnostics/rebuild-curated" })).json())
      .toMatchObject({ count: 1 });
    await app.close();
  });

  it("fails closed for missing attestation and external knowledge drift", async () => {
    const layout = initializeDataRoot(join(await mkdtemp(join(tmpdir(), "scholarloom-topic-drift-")), "data"));
    const app = await createApp({ storageLayout: layout,
      paperSource: { async resolve() { throw new Error("unused"); } } });
    expect((await app.inject({ method: "POST", url: "/api/directions",
      headers: { "idempotency-key": "create-drift-topic" }, payload: {
        id: "topic:drift", title: "Drift", scope: "用于验证外部编辑。",
      } })).statusCode).toBe(201);
    const current = (await app.inject({ method: "GET", url: "/api/directions/topic%3Adrift/knowledge" })).json();
    const invalid = await app.inject({ method: "POST", url: "/api/directions/topic%3Adrift/knowledge/preview",
      payload: { usageLevel: "knowledge-ready", sections: { Syntheses: "TODO" }, provenance: [],
        ownerAttested: false, expectedRevisionId: current.revisionId,
        expectedMarkdownHash: current.markdownHash } });
    expect(invalid.statusCode, invalid.body).toBe(200);
    expect(invalid.json().eligible).toBe(false);
    expect(invalid.json().errors).toEqual(expect.arrayContaining([
      "substantive-content-empty", "provenance-empty", "owner-attestation-required",
    ]));

    const path = join(layout.vaultRoot, "knowledge", "topics", "drift.md");
    const markdown = await readFile(path, "utf8");
    await writeFile(path, markdown.replace("用于验证外部编辑。", "外部修改后的分类 Scope。"), "utf8");
    const rebuilt = await app.inject({ method: "POST", url: "/api/diagnostics/rebuild-paper-catalog" });
    expect(rebuilt.statusCode, rebuilt.body).toBe(200);
    const database = new Database(layout.databasePath, { readonly: true });
    expect(database.prepare(`SELECT scope FROM direction_catalog WHERE topic_id='topic:drift'`).pluck().get())
      .toBe("外部修改后的分类 Scope。");
    expect(database.prepare(`SELECT count(*) FROM curated_search_documents
      WHERE source_type='topic-knowledge' AND source_id='topic:drift'`).pluck().get()).toBe(0);
    database.close();
    await app.close();
  });
});
