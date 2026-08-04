import { createHash } from "node:crypto";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { createFixturePdf, createLargeFixturePdf, fixtureSummary } from "../src/adapters/fixture.js";
import type { PdfLinearizationTool } from "../src/storage/pdf-delivery-optimizer.js";
import { createSnapshot, restoreSnapshot, verifySnapshot } from "../src/storage/data-operations.js";
import { initializeDataRoot } from "../src/storage/layout.js";
import type { StorageLayout } from "../src/storage/layout.js";

async function waitForImport(app: Awaited<ReturnType<typeof createApp>>, id: string): Promise<void> {
  for (let attempt = 0; attempt < 4_500; attempt += 1) {
    const status = await app.inject({ method: "GET", url: `/api/imports/${encodeURIComponent(id)}` });
    const job = status.json().jobs.at(-1);
    if (job?.state === "succeeded") return;
    if (job?.state === "failed") throw new Error(`import failed: ${JSON.stringify(job.error)}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("import did not succeed");
}

function fixtureLinearizer(): PdfLinearizationTool {
  return {
    name: "fixture-linearizer",
    async version() { return "1.0.0"; },
    async isLinearized() { return false; },
    async linearize(inputPath, outputPath) {
      const original = await readFile(inputPath);
      await writeFile(outputPath, Buffer.concat([original, Buffer.from("\n% fixture-linearized\n")]));
    },
    async validate() { return true; },
  };
}

async function fixtureApp(layout: StorageLayout, sourceBytes: Uint8Array, tool: PdfLinearizationTool) {
  return createApp({
    storageLayout: layout,
    paperSource: {
      async resolve() { return { arxivId: "2401.12345", latestVersion: 2, title: "Fixture Paper", authors: ["Ada Fixture"], year: 2024 }; },
      async fetchPdf() { return sourceBytes; },
    },
    codexRunner: { async runSummary() { return fixtureSummary; } },
    pdfOptimization: { strategy: "lossless-linearization", tool },
  });
}

async function importFixture(app: Awaited<ReturnType<typeof createApp>>) {
  const imported = await app.inject({ method: "POST", url: "/api/imports",
    payload: { reference: "https://arxiv.org/abs/2401.12345v2" } });
  await waitForImport(app, imported.json().importRequest.id);
  return imported.json().paper as { id: string; versionId: string };
}

describe("derived PDF delivery optimization", () => {
  it("selects a validated lossless derived PDF without mutating the immutable original", async () => {
    const parent = await mkdtemp(join(tmpdir(), "scholarloom-pdf-optimization-"));
    const layout = initializeDataRoot(join(parent, "data"));
    const sourceBytes = await createLargeFixturePdf();
    const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
    const app = await fixtureApp(layout, sourceBytes, fixtureLinearizer());
    const paper = await importFixture(app);
    const workspace = await app.inject({ method: "GET", url: `/api/papers/${paper.id}` });
    const deliveryUrl = workspace.json().pdf.url as string;
    expect(deliveryUrl).not.toContain(sourceHash);

    const delivered = await app.inject({ method: "GET", url: deliveryUrl });
    expect(delivered.statusCode).toBe(200);
    expect(createHash("sha256").update(delivered.rawPayload).digest("hex"))
      .toBe(String(delivered.headers.etag).slice(1, -1));
    const originalPath = join(layout.originalsRoot, "papers", sourceHash.slice(0, 2), `${sourceHash}.pdf`);
    expect(await readFile(originalPath)).toEqual(Buffer.from(sourceBytes));
    expect((await stat(originalPath)).mode & 0o777).toBe(0o400);

    const database = new Database(layout.databasePath, { readonly: true });
    expect(database.prepare(`SELECT a.storage_ref,a.retention_class,o.status,o.reason,o.parameters_json,o.metrics_json
      FROM pdf_delivery_optimizations o JOIN artifacts a ON a.id=o.output_artifact_id
      WHERE o.source_artifact_id=?`).get(`artifact:pdf:${sourceHash}`)).toMatchObject({
      storage_ref: expect.stringMatching(/^derived\/pdf-delivery\/[0-9a-f]{2}\/[0-9a-f]{64}\.pdf$/),
      retention_class: "rebuildable",
      status: "selected",
      reason: "linearized",
      parameters_json: JSON.stringify({ maximumSizeRatio: 1.02, minimumSourceBytes: 1_048_576 }),
    });
    database.close();
    await app.close();
  }, 60_000);

  it("records an unavailable tool and keeps serving the original PDF", async () => {
    const parent = await mkdtemp(join(tmpdir(), "scholarloom-pdf-optimization-unavailable-"));
    const layout = initializeDataRoot(join(parent, "data"));
    const sourceBytes = await createLargeFixturePdf();
    const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
    const unavailable: PdfLinearizationTool = {
      name: "missing-qpdf",
      async version() { throw Object.assign(new Error("not found"), { code: "ENOENT" }); },
      async isLinearized() { throw new Error("must not inspect"); },
      async linearize() { throw new Error("must not run"); },
      async validate() { throw new Error("must not validate"); },
    };
    const app = await fixtureApp(layout, sourceBytes, unavailable);

    const paper = await importFixture(app);
    const workspace = await app.inject({ method: "GET", url: `/api/papers/${paper.id}` });

    expect(workspace.json().pdf.url).toBe(`/api/artifacts/${sourceHash}/pdf`);
    const database = new Database(layout.databasePath, { readonly: true });
    expect(database.prepare(`SELECT status,reason,output_artifact_id FROM pdf_delivery_optimizations
      WHERE source_artifact_id=?`).get(`artifact:pdf:${sourceHash}`)).toEqual({
      status: "skipped", reason: "tool-unavailable", output_artifact_id: null,
    });
    expect(database.prepare("SELECT count(*) FROM artifacts WHERE artifact_type='paper-pdf-delivery'").pluck().get()).toBe(0);
    database.close();
    await app.close();
  }, 60_000);

  it("rejects an unvalidated derived PDF and keeps serving the original", async () => {
    const parent = await mkdtemp(join(tmpdir(), "scholarloom-pdf-optimization-invalid-"));
    const layout = initializeDataRoot(join(parent, "data"));
    const sourceBytes = await createLargeFixturePdf();
    const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
    const invalid = fixtureLinearizer();
    invalid.validate = async () => false;
    const app = await fixtureApp(layout, sourceBytes, invalid);

    const paper = await importFixture(app);
    const workspace = await app.inject({ method: "GET", url: `/api/papers/${paper.id}` });

    expect(workspace.json().pdf.url).toBe(`/api/artifacts/${sourceHash}/pdf`);
    const database = new Database(layout.databasePath, { readonly: true });
    expect(database.prepare(`SELECT status,reason,output_artifact_id FROM pdf_delivery_optimizations
      WHERE source_artifact_id=?`).get(`artifact:pdf:${sourceHash}`)).toEqual({
      status: "failed", reason: "output-validation-failed", output_artifact_id: null,
    });
    expect(database.prepare("SELECT count(*) FROM artifacts WHERE artifact_type='paper-pdf-delivery'").pluck().get()).toBe(0);
    database.close();
    await app.close();
  }, 60_000);

  it("skips small PDFs before invoking the external tool", async () => {
    const parent = await mkdtemp(join(tmpdir(), "scholarloom-pdf-optimization-small-"));
    const layout = initializeDataRoot(join(parent, "data"));
    const sourceBytes = await createFixturePdf();
    const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
    let toolCalls = 0;
    const tool = fixtureLinearizer();
    tool.version = async () => { toolCalls += 1; return "1.0.0"; };
    const app = await fixtureApp(layout, sourceBytes, tool);

    const paper = await importFixture(app);
    const workspace = await app.inject({ method: "GET", url: `/api/papers/${paper.id}` });

    expect(toolCalls).toBe(0);
    expect(workspace.json().pdf.url).toBe(`/api/artifacts/${sourceHash}/pdf`);
    const database = new Database(layout.databasePath, { readonly: true });
    expect(database.prepare("SELECT status,reason FROM pdf_delivery_optimizations").get()).toEqual({
      status: "skipped", reason: "below-minimum-size",
    });
    database.close();
    await app.close();
  }, 60_000);

  it("rejects a linearized candidate whose size grows by more than two percent", async () => {
    const parent = await mkdtemp(join(tmpdir(), "scholarloom-pdf-optimization-inflation-"));
    const layout = initializeDataRoot(join(parent, "data"));
    const sourceBytes = await createLargeFixturePdf();
    const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
    const inflated = fixtureLinearizer();
    inflated.linearize = async (inputPath, outputPath) => {
      await writeFile(outputPath, Buffer.concat([await readFile(inputPath), Buffer.alloc(300 * 1024)]));
    };
    const app = await fixtureApp(layout, sourceBytes, inflated);

    const paper = await importFixture(app);
    const workspace = await app.inject({ method: "GET", url: `/api/papers/${paper.id}` });

    expect(workspace.json().pdf.url).toBe(`/api/artifacts/${sourceHash}/pdf`);
    const database = new Database(layout.databasePath, { readonly: true });
    expect(database.prepare("SELECT status,reason FROM pdf_delivery_optimizations").get()).toEqual({
      status: "skipped", reason: "size-inflation",
    });
    database.close();
    await app.close();
  }, 60_000);

  it("rejects a structurally valid candidate when its page count changes", async () => {
    const parent = await mkdtemp(join(tmpdir(), "scholarloom-pdf-optimization-page-count-"));
    const layout = initializeDataRoot(join(parent, "data"));
    const sourceBytes = await createLargeFixturePdf();
    const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
    const changed = fixtureLinearizer();
    changed.linearize = async (_inputPath, outputPath) => {
      const document = await PDFDocument.create();
      document.addPage([595.28, 841.89]);
      await writeFile(outputPath, await document.save());
    };
    const app = await fixtureApp(layout, sourceBytes, changed);

    const paper = await importFixture(app);
    const workspace = await app.inject({ method: "GET", url: `/api/papers/${paper.id}` });

    expect(workspace.json().pdf.url).toBe(`/api/artifacts/${sourceHash}/pdf`);
    const database = new Database(layout.databasePath, { readonly: true });
    expect(database.prepare("SELECT status,reason FROM pdf_delivery_optimizations").get()).toEqual({
      status: "failed", reason: "page-count-mismatch",
    });
    expect(database.prepare("SELECT count(*) FROM artifacts WHERE artifact_type='paper-pdf-delivery'").pluck().get()).toBe(0);
    database.close();
    await app.close();
  }, 60_000);

  it("reuses an already-linearized original instead of creating a derived copy", async () => {
    const parent = await mkdtemp(join(tmpdir(), "scholarloom-pdf-optimization-already-linearized-"));
    const layout = initializeDataRoot(join(parent, "data"));
    const sourceBytes = await createLargeFixturePdf();
    const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
    let linearizations = 0;
    const tool = fixtureLinearizer();
    tool.isLinearized = async () => true;
    tool.linearize = async () => { linearizations += 1; };
    const app = await fixtureApp(layout, sourceBytes, tool);

    const paper = await importFixture(app);
    const workspace = await app.inject({ method: "GET", url: `/api/papers/${paper.id}` });

    expect(linearizations).toBe(0);
    expect(workspace.json().pdf.url).toBe(`/api/artifacts/${sourceHash}/pdf`);
    const database = new Database(layout.databasePath, { readonly: true });
    expect(database.prepare("SELECT status,reason FROM pdf_delivery_optimizations").get()).toEqual({
      status: "skipped", reason: "already-linearized",
    });
    database.close();
    await app.close();
  }, 60_000);

  it("rebuilds a selected delivery PDF after a default snapshot restores only the immutable original", async () => {
    const parent = await mkdtemp(join(tmpdir(), "scholarloom-pdf-optimization-rebuild-"));
    const layout = initializeDataRoot(join(parent, "data"));
    const sourceBytes = await createLargeFixturePdf();
    const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
    let linearizations = 0;
    const tool = fixtureLinearizer();
    const linearize = tool.linearize.bind(tool);
    tool.linearize = async (...args) => { linearizations += 1; await linearize(...args); };
    const firstApp = await fixtureApp(layout, sourceBytes, tool);
    const paper = await importFixture(firstApp);
    const database = new Database(layout.databasePath, { readonly: true });
    const selected = database.prepare(`SELECT a.storage_ref,a.content_hash FROM pdf_delivery_optimizations o
      JOIN artifacts a ON a.id=o.output_artifact_id WHERE o.status='selected'`).get() as
      { storage_ref: string; content_hash: string };
    database.close();
    await firstApp.close();

    const healthyReopen = await fixtureApp(layout, sourceBytes, tool);
    await healthyReopen.close();
    expect(linearizations).toBe(1);
    const snapshotRoot = join(parent, "snapshot");
    await createSnapshot(layout, snapshotRoot);
    expect(verifySnapshot(snapshotRoot)).toMatchObject({ healthy: true, errors: [] });
    const restored = restoreSnapshot(snapshotRoot, join(parent, "restored"));

    const reopened = await fixtureApp(restored, sourceBytes, tool);
    await expect.poll(async () => {
      const workspace = await reopened.inject({ method: "GET", url: `/api/papers/${paper.id}` });
      return workspace.json().pdf.url;
    }, { timeout: 10_000 }).toBe(`/api/artifacts/${selected.content_hash}/pdf`);

    expect(linearizations).toBe(2);
    expect(await readFile(join(restored.originalsRoot, "papers", sourceHash.slice(0, 2), `${sourceHash}.pdf`)))
      .toEqual(Buffer.from(sourceBytes));
    await reopened.close();
  }, 60_000);
});
