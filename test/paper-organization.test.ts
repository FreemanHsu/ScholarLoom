import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import Database from "better-sqlite3";
import { parse } from "yaml";

import { createApp } from "../src/app.js";
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
    await writeFile(manifestPath, `${manifest}\n<!-- external edit -->\n`, "utf8");
    const conflicted = await restarted.inject({
      method: "PUT",
      url: `/api/papers/${encodeURIComponent(paperId)}/organization`,
      headers: { "idempotency-key": "organize-after-external-edit" },
      payload: {
        aliases: [{ name: "GenCeption", kind: "model-name", preferred: true }],
        directions: [
          { topicId: "topic:vision-representation-learning", role: "primary" },
          { topicId: "topic:video-generation", role: "secondary" },
        ],
      },
    });
    expect(conflicted.statusCode).toBe(409);
    expect(conflicted.json()).toEqual({ code: "paper-organization-conflicted" });
    expect(await readFile(manifestPath, "utf8")).toContain("external edit");
    await restarted.close();
  });
});
