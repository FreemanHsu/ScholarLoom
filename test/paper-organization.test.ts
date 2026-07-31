import { mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import Database from "better-sqlite3";
import { parse } from "yaml";

import { createApp } from "../src/app.js";
import { normalizePaperLookup } from "../src/domain/paper-organization.js";
import { createSnapshot, restoreSnapshot, verifySnapshot } from "../src/storage/data-operations.js";
import { initializeDataRoot } from "../src/storage/layout.js";

async function fixturePdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage().drawText("Video generation models learn transferable visual representations.", {
    x: 40,
    y: 700,
    font,
  });
  return pdf.save();
}

async function waitForImport(app: FastifyInstance, id: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await app.inject({ method: "GET", url: `/api/imports/${encodeURIComponent(id)}` });
    if (response.json().jobs.at(-1)?.state === "succeeded") return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("import did not finish");
}

describe("Paper organization", () => {
  it("uses deterministic Unicode case folding for lookup keys", () => {
    expect(normalizePaperLookup("  Straẞe  ")).toBe(normalizePaperLookup("STRASSE"));
    expect(normalizePaperLookup("ᾀ")).toBe(normalizePaperLookup("ἀι"));
  });

  it("recovers direction writes from every durable KWR phase", async () => {
    for (const phase of ["reserved", "staged", "renamed", "metadata-committed", "indexed"] as const) {
      const root = await mkdtemp(join(tmpdir(), `scholarloom-direction-recovery-${phase}-`));
      const storageLayout = initializeDataRoot(join(root, "data"));
      const options = {
        storageLayout,
        paperSource: { async resolve() { throw new Error("unused"); } },
      };
      const interrupted = await createApp({ ...options, knowledgeWriteFailurePoint: phase });
      const response = await interrupted.inject({
        method: "POST",
        url: "/api/directions",
        headers: { "idempotency-key": `recover-${phase}` },
        payload: {
          id: `topic:recover-${phase}`,
          title: `Recover ${phase}`,
          scope: "验证可恢复方向写入。",
        },
      });
      expect(response.statusCode).toBe(500);
      await interrupted.close();

      const resumed = await createApp(options);
      const directions = await resumed.inject({ method: "GET", url: "/api/directions" });
      expect(directions.json().directions).toEqual([
        expect.objectContaining({ id: `topic:recover-${phase}`, title: `Recover ${phase}` }),
      ]);
      const database = new Database(storageLayout.databasePath, { readonly: true });
      expect(database.prepare(`SELECT phase FROM knowledge_write_requests
        WHERE request_type='direction-taxonomy'`).pluck().get()).toBe("complete");
      database.close();
      await resumed.close();
    }
  });

  it("rejects legacy non-Catalog reconciliation Proposals without misrouting them to Takeaway review", async () => {
    const root = await mkdtemp(join(tmpdir(), "scholarloom-legacy-reconciliation-"));
    const storageLayout = initializeDataRoot(join(root, "data"));
    const options = {
      storageLayout,
      paperSource: { async resolve() { throw new Error("unused"); } },
    };
    const initial = await createApp(options);
    await initial.close();
    const database = new Database(storageLayout.databasePath);
    database.prepare(`INSERT INTO proposals
      (id,proposal_type,paper_id,payload_json,review_status,one_click_eligible,created_at)
      VALUES ('proposal:legacy-reconciliation','reconciliation',NULL,?,'pending',0,?)`)
      .run(JSON.stringify({
        writeId: "knowledge-write:legacy-summary",
        targetPath: "library/papers/legacy/summary.md",
        expectedHash: "expected",
        actualHash: "actual",
      }), new Date().toISOString());
    database.close();

    const app = await createApp(options);
    const rejected = await app.inject({
      method: "POST",
      url: "/api/proposals/proposal%3Alegacy-reconciliation/decisions",
      headers: { "idempotency-key": "reject-legacy-reconciliation" },
      payload: { action: "reject" },
    });
    expect(rejected.statusCode, rejected.body).toBe(201);
    expect(rejected.json()).toMatchObject({
      proposal: { id: "proposal:legacy-reconciliation", reviewStatus: "rejected" },
      requiresFileRestore: true,
    });
    await app.close();
  });

  it("never overwrites an externally edited Direction during same-key retry", async () => {
    const root = await mkdtemp(join(tmpdir(), "scholarloom-direction-conflict-retry-"));
    const storageLayout = initializeDataRoot(join(root, "data"));
    const options = {
      storageLayout,
      paperSource: { async resolve() { throw new Error("unused"); } },
    };
    const interrupted = await createApp({ ...options, knowledgeWriteFailurePoint: "staged" });
    const first = await interrupted.inject({
      method: "POST",
      url: "/api/directions",
      headers: { "idempotency-key": "direction-conflict-retry" },
      payload: {
        id: "topic:direction-conflict-retry",
        title: "Direction Conflict Retry",
        scope: "原始 Scope。",
      },
    });
    expect(first.statusCode).toBe(500);
    await interrupted.close();

    const database = new Database(storageLayout.databasePath, { readonly: true });
    const stagedPath = database.prepare(`SELECT staged_path FROM knowledge_write_requests
      WHERE request_type='direction-taxonomy'`).pluck().get() as string;
    database.close();
    const staged = await readFile(join(storageLayout.vaultRoot, stagedPath), "utf8");
    const target = join(storageLayout.vaultRoot, "knowledge", "topics", "direction-conflict-retry.md");
    await writeFile(target, staged.replace("原始 Scope。", "外部修改后的 Scope。"), "utf8");

    const resumed = await createApp(options);
    const retried = await resumed.inject({
      method: "POST",
      url: "/api/directions",
      headers: { "idempotency-key": "direction-conflict-retry" },
      payload: {
        id: "topic:direction-conflict-retry",
        title: "Direction Conflict Retry",
        scope: "原始 Scope。",
      },
    });
    expect(retried.statusCode).toBe(409);
    expect(retried.json()).toEqual({ code: "direction-retry-review-required" });
    expect(await readFile(target, "utf8")).toContain("外部修改后的 Scope。");
    await resumed.close();
  });

  it("keeps offline Topic additions and deletions non-activating until reconciliation", async () => {
    const root = await mkdtemp(join(tmpdir(), "scholarloom-direction-membership-reconciliation-"));
    const storageLayout = initializeDataRoot(join(root, "data"));
    const options = {
      storageLayout,
      paperSource: { async resolve() { throw new Error("unused"); } },
    };
    const app = await createApp(options);
    const created = await app.inject({
      method: "POST",
      url: "/api/directions",
      headers: { "idempotency-key": "create-membership-base" },
      payload: {
        id: "topic:membership-base",
        title: "Membership Base",
        scope: "用于验证目录成员变化。",
      },
    });
    expect(created.statusCode).toBe(201);
    await app.close();

    const topicRoot = join(storageLayout.vaultRoot, "knowledge", "topics");
    const basePath = join(topicRoot, "membership-base.md");
    const addedPath = join(topicRoot, "membership-added.md");
    const base = await readFile(basePath, "utf8");
    await writeFile(addedPath, base
      .replaceAll("topic:membership-base", "topic:membership-added")
      .replaceAll("Membership Base", "Membership Added"), "utf8");

    const afterAddition = await createApp(options);
    const additionDirections = await afterAddition.inject({ method: "GET", url: "/api/directions" });
    expect(additionDirections.json().directions.map((direction: { id: string }) => direction.id))
      .toEqual(["topic:membership-base"]);
    const additionDatabase = new Database(storageLayout.databasePath, { readonly: true });
    const additionPayloads = (additionDatabase.prepare(`SELECT payload_json FROM proposals
      WHERE proposal_type='reconciliation' AND review_status='pending'`).all() as
      Array<{ payload_json: string }>).map((row) => JSON.parse(row.payload_json) as Record<string, unknown>);
    expect(additionPayloads).toContainEqual(expect.objectContaining({
      targetPath: "knowledge/topics/membership-added.md",
      expectedHash: null,
      source: "external-markdown-rebuild",
    }));
    additionDatabase.close();
    await afterAddition.close();

    await unlink(basePath);
    const afterDeletion = await createApp(options);
    const deletionDirections = await afterDeletion.inject({ method: "GET", url: "/api/directions" });
    expect(deletionDirections.json().directions.map((direction: { id: string }) => direction.id))
      .toEqual(["topic:membership-base"]);
    const deletionDatabase = new Database(storageLayout.databasePath, { readonly: true });
    const deletionPayloads = (deletionDatabase.prepare(`SELECT payload_json FROM proposals
      WHERE proposal_type='reconciliation' AND review_status='pending'`).all() as
      Array<{ payload_json: string }>).map((row) => JSON.parse(row.payload_json) as Record<string, unknown>);
    expect(deletionPayloads).toContainEqual(expect.objectContaining({
      targetId: "topic:membership-base",
      actualHash: null,
      source: "external-markdown-rebuild",
    }));
    deletionDatabase.close();
    await afterDeletion.close();
  });

  it("keeps an offline Topic edit non-activating until reconciliation", async () => {
    const root = await mkdtemp(join(tmpdir(), "scholarloom-direction-reconciliation-"));
    const storageLayout = initializeDataRoot(join(root, "data"));
    const options = {
      storageLayout,
      paperSource: { async resolve() { throw new Error("unused"); } },
    };
    const app = await createApp(options);
    const created = await app.inject({
      method: "POST",
      url: "/api/directions",
      headers: { "idempotency-key": "create-offline-edit-direction" },
      payload: {
        id: "topic:offline-edit",
        title: "Original Direction",
        scope: "原始分类范围。",
      },
    });
    expect(created.statusCode).toBe(201);
    await app.close();

    const topicPath = join(storageLayout.vaultRoot, "knowledge", "topics", "offline-edit.md");
    const original = await readFile(topicPath, "utf8");
    await writeFile(topicPath, original.replaceAll("Original Direction", "Externally Edited Direction"), "utf8");

    const reopened = await createApp(options);
    const directions = await reopened.inject({ method: "GET", url: "/api/directions" });
    expect(directions.json().directions).toEqual([
      expect.objectContaining({ id: "topic:offline-edit", title: "Original Direction" }),
    ]);
    const database = new Database(storageLayout.databasePath, { readonly: true });
    const reconciliation = database.prepare(`SELECT payload_json FROM proposals
      WHERE proposal_type='reconciliation' AND review_status='pending'`).get() as { payload_json: string };
    expect(JSON.parse(reconciliation.payload_json)).toMatchObject({
      targetKind: "topic",
      targetId: "topic:offline-edit",
      source: "external-markdown-rebuild",
    });
    const proposalId = database.prepare(`SELECT id FROM proposals
      WHERE proposal_type='reconciliation' AND review_status='pending'`).pluck().get() as string;
    database.close();
    const accepted = await reopened.inject({
      method: "POST",
      url: `/api/proposals/${encodeURIComponent(proposalId)}/decisions`,
      headers: { "idempotency-key": "accept-offline-topic-edit" },
      payload: { action: "accept" },
    });
    expect(accepted.statusCode, accepted.body).toBe(201);
    const activatedDirections = await reopened.inject({ method: "GET", url: "/api/directions" });
    expect(activatedDirections.json().directions).toEqual([
      expect.objectContaining({ id: "topic:offline-edit", title: "Externally Edited Direction" }),
    ]);
    await reopened.close();
  });

  it("persists aliases and directions in Markdown and resolves an exact alias after restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "scholarloom-paper-organization-"));
    const storageLayout = initializeDataRoot(join(root, "data"));
    const options = {
      storageLayout,
      paperSource: {
        async resolve() {
          return {
            arxivId: "2501.01234",
            latestVersion: 1,
            title: "Video Generation Models are General-Purpose Vision Learners",
            authors: ["Ada Fixture"],
            year: 2025,
          };
        },
        async fetchPdf() { return fixturePdf(); },
      },
      codexRunner: {
        async runSummary() {
          return {
            sections: [{ key: "overview", title: "概述", body: "视频生成模型可学习通用视觉表征。" }],
            claims: [{
              voice: "authors-claim" as const,
              claim: "Video generation models learn transferable visual representations.",
              sourceHandle: "pdf-page:1",
            }],
            readStatus: "read" as const,
          };
        },
      },
    };
    const app = await createApp(options);
    const imported = await app.inject({
      method: "POST",
      url: "/api/imports",
      payload: { arxivUrl: "https://arxiv.org/abs/2501.01234" },
    });
    expect(imported.statusCode).toBe(202);
    await waitForImport(app, imported.json().importRequest.id);
    const paperId = imported.json().paper.id as string;

    for (const direction of [
      {
        id: "topic:vision-representation-learning",
        title: "Vision Representation Learning",
        scope: "学习可迁移的视觉表征。",
      },
      {
        id: "topic:video-generation",
        title: "Video Generation",
        aliases: ["生成式视频"],
        scope: "生成、建模和理解视频。",
      },
    ]) {
      const created = await app.inject({
        method: "POST",
        url: "/api/directions",
        headers: { "idempotency-key": `create-${direction.id}` },
        payload: direction,
      });
      expect(created.statusCode, created.body).toBe(201);
    }

    const secondaryWithoutPrimary = await app.inject({
      method: "PUT",
      url: `/api/papers/${encodeURIComponent(paperId)}/organization`,
      headers: { "idempotency-key": "invalid-secondary-only" },
      payload: {
        aliases: [],
        directions: [{ topicId: "topic:video-generation", role: "secondary" }],
      },
    });
    expect(secondaryWithoutPrimary.statusCode).toBe(400);
    expect(secondaryWithoutPrimary.json()).toEqual({ code: "paper-secondary-requires-primary" });

    const saved = await app.inject({
      method: "PUT",
      url: `/api/papers/${encodeURIComponent(paperId)}/organization`,
      headers: { "idempotency-key": "organize-genception" },
      payload: {
        aliases: [{ name: "GenCeption", kind: "model-name", preferred: true }],
        directions: [
          { topicId: "topic:vision-representation-learning", role: "primary" },
          { topicId: "topic:video-generation", role: "secondary" },
        ],
      },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const rebuilt = await app.inject({ method: "POST", url: "/api/diagnostics/rebuild-paper-catalog" });
    expect(rebuilt.statusCode).toBe(200);
    expect(rebuilt.json()).toMatchObject({ count: 1 });
    await app.close();

    const manifestPath = join(storageLayout.vaultRoot, "library", "papers",
      "video-generation-models-are-general-purpose-vision-learners", "paper.md");
    const manifest = await readFile(manifestPath, "utf8");
    expect(parse(manifest.split("---")[1]!)).toMatchObject({
      aliases: [{ name: "GenCeption", kind: "model-name", preferred: true }],
      directions: [
        { topic_id: "topic:vision-representation-learning", role: "primary" },
        { topic_id: "topic:video-generation", role: "secondary" },
      ],
      topics: [],
    });
    const database = new Database(storageLayout.databasePath, { readonly: true });
    expect(database.prepare(`SELECT count(*) count FROM review_decisions d JOIN proposals p ON p.id=d.proposal_id
      WHERE p.proposal_type IN ('direction-taxonomy','paper-organization')`).pluck().get()).toBe(5);
    expect(database.prepare(`SELECT count(*) count FROM knowledge_write_requests
      WHERE request_type IN ('direction-taxonomy','paper-organization') AND phase='complete'`).pluck().get()).toBe(3);
    expect(database.prepare("SELECT count(*) count FROM curated_search_documents").pluck().get()).toBe(1);
    database.close();

    const snapshotRoot = join(root, "snapshot");
    await createSnapshot(storageLayout, snapshotRoot);
    expect(verifySnapshot(snapshotRoot)).toMatchObject({ healthy: true });
    const restoredLayout = restoreSnapshot(snapshotRoot, join(root, "restored"));
    const restored = await createApp({ ...options, storageLayout: restoredLayout });
    const restoredCatalog = await restored.inject({ method: "GET", url: "/api/papers?q=genception" });
    expect(restoredCatalog.json().papers[0]).toMatchObject({
      id: paperId,
      preferredAlias: "GenCeption",
      matchedBy: { kind: "preferred-alias", exact: true },
    });
    await restored.close();

    const restarted = await createApp(options);
    const catalog = await restarted.inject({ method: "GET", url: "/api/papers?q=genception" });
    expect(catalog.statusCode).toBe(200);
    expect(catalog.json().papers).toEqual([
      expect.objectContaining({
        id: paperId,
        title: "Video Generation Models are General-Purpose Vision Learners",
        preferredAlias: "GenCeption",
        matchedBy: { kind: "preferred-alias", value: "GenCeption", exact: true },
        aliases: [{ name: "GenCeption", kind: "model-name", preferred: true }],
        directions: [
          expect.objectContaining({
            topicId: "topic:vision-representation-learning",
            title: "Vision Representation Learning",
            role: "primary",
          }),
          expect.objectContaining({
            topicId: "topic:video-generation",
            title: "Video Generation",
            role: "secondary",
          }),
        ],
      }),
    ]);
    const externalIdentity = await restarted.inject({ method: "GET", url: "/api/papers?q=2501.01234" });
    expect(externalIdentity.json().papers[0]).toMatchObject({
      id: paperId,
      matchedBy: { kind: "external-identity", value: "2501.01234", exact: true },
    });
    const directionAlias = await restarted.inject({
      method: "GET",
      url: `/api/papers?q=${encodeURIComponent("生成式视频")}`,
    });
    expect(directionAlias.json().papers[0]).toMatchObject({ id: paperId });
    await writeFile(manifestPath, `${manifest}\n<!-- external edit -->\n`, "utf8");
    const conflicted = await restarted.inject({
      method: "PUT",
      url: `/api/papers/${encodeURIComponent(paperId)}/organization`,
      headers: { "idempotency-key": "organize-after-external-edit" },
      payload: {
        aliases: [
          { name: "GenCeption", kind: "model-name", preferred: true },
          { name: "GenCeption Paper", kind: "user-defined", preferred: false },
        ],
        directions: [
          { topicId: "topic:vision-representation-learning", role: "primary" },
          { topicId: "topic:video-generation", role: "secondary" },
        ],
      },
    });
    expect(conflicted.statusCode).toBe(409);
    expect(conflicted.json()).toEqual({ code: "paper-organization-conflicted" });
    expect(await readFile(manifestPath, "utf8")).toContain("external edit");
    const conflictedDatabase = new Database(storageLayout.databasePath, { readonly: true });
    expect(conflictedDatabase.prepare(`SELECT count(*) FROM knowledge_write_requests
      WHERE request_type='paper-organization' AND phase='conflicted'`).pluck().get()).toBe(1);
    expect(conflictedDatabase.prepare(`SELECT count(*) FROM proposals
      WHERE proposal_type='paper-organization' AND review_status='pending'`).pluck().get()).toBe(1);
    conflictedDatabase.close();

    const changedRetry = await restarted.inject({
      method: "PUT",
      url: `/api/papers/${encodeURIComponent(paperId)}/organization`,
      headers: { "idempotency-key": "organize-after-external-edit" },
      payload: {
        aliases: [
          { name: "GenCeption", kind: "model-name", preferred: true },
          { name: "Different Retry", kind: "user-defined", preferred: false },
        ],
        directions: [
          { topicId: "topic:vision-representation-learning", role: "primary" },
          { topicId: "topic:video-generation", role: "secondary" },
        ],
      },
    });
    expect(changedRetry.statusCode).toBe(409);
    expect(changedRetry.json()).toEqual({ code: "idempotency-key-conflict" });

    const retried = await restarted.inject({
      method: "PUT",
      url: `/api/papers/${encodeURIComponent(paperId)}/organization`,
      headers: { "idempotency-key": "organize-after-external-edit" },
      payload: {
        aliases: [
          { name: "GenCeption", kind: "model-name", preferred: true },
          { name: "GenCeption Paper", kind: "user-defined", preferred: false },
        ],
        directions: [
          { topicId: "topic:vision-representation-learning", role: "primary" },
          { topicId: "topic:video-generation", role: "secondary" },
        ],
      },
    });
    expect(retried.statusCode, retried.body).toBe(200);
    expect(await readFile(manifestPath, "utf8")).toContain("external edit");
    const retriedDatabase = new Database(storageLayout.databasePath, { readonly: true });
    expect(retriedDatabase.prepare(`SELECT phase FROM knowledge_write_requests
      WHERE request_type='paper-organization'
        AND json_extract(payload_json,'$.idempotencyKey')='organize-after-external-edit'`).pluck().get())
      .toBe("complete");
    expect(retriedDatabase.prepare(`SELECT count(*) FROM proposals
      WHERE proposal_type='reconciliation' AND review_status='pending'
        AND json_extract(payload_json,'$.writeId') IS NOT NULL`).pluck().get()).toBe(0);
    retriedDatabase.close();

    const organizedManifest = await readFile(manifestPath, "utf8");
    await writeFile(manifestPath, organizedManifest.replace("name: GenCeption Paper", "name: External Alias"), "utf8");
    const fieldConflictPayload = {
      aliases: [
        { name: "GenCeption", kind: "model-name", preferred: true },
        { name: "GenCeption Paper", kind: "user-defined", preferred: false },
        { name: "Fresh Alias", kind: "user-defined", preferred: false },
      ],
      directions: [
        { topicId: "topic:vision-representation-learning", role: "primary" },
        { topicId: "topic:video-generation", role: "secondary" },
      ],
    };
    const fieldConflict = await restarted.inject({
      method: "PUT",
      url: `/api/papers/${encodeURIComponent(paperId)}/organization`,
      headers: { "idempotency-key": "organization-field-conflict" },
      payload: fieldConflictPayload,
    });
    expect(fieldConflict.statusCode).toBe(409);
    const blockedRetry = await restarted.inject({
      method: "PUT",
      url: `/api/papers/${encodeURIComponent(paperId)}/organization`,
      headers: { "idempotency-key": "organization-field-conflict" },
      payload: fieldConflictPayload,
    });
    expect(blockedRetry.statusCode).toBe(409);
    expect(blockedRetry.json()).toEqual({ code: "paper-organization-retry-review-required" });
    expect(await readFile(manifestPath, "utf8")).toContain("name: External Alias");
    await restarted.close();
  });
});
