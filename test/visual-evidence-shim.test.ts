import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rename, symlink, unlink } from "node:fs/promises";
import { chmod, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

import Database from "better-sqlite3";
import { PDFDocument, StandardFonts } from "pdf-lib";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import type { AgenticEvidenceRunner } from "../src/agent/agentic-evidence-runner.js";
import { initializeDataRoot } from "../src/storage/layout.js";
import { PdfPageRenderer } from "../src/storage/pdf-page-renderer.js";
import { preflightTextCitations } from "../src/storage/text-citation-preflight.js";
import { VisualEvidenceShim } from "../src/storage/visual-evidence-shim.js";
import { VisualEvidenceStore } from "../src/storage/visual-evidence-store.js";

describe("VisualEvidenceShim", () => {
  it("host-preflights exact final text citations when the Agent skips the tool", async () => {
    const fixture = await runningAttemptFixture(2);
    const database = new Database(fixture.layout.databasePath);
    database.pragma("foreign_keys = ON");

    expect(preflightTextCitations({ attemptId: fixture.attemptId, runEpoch: fixture.runEpoch,
      layout: fixture.layout, database, citations: [{ kind: "text", path: "paper/pages/page-0002.md",
        lineStart: 1, lineEnd: 1, quote: "visual page 2" }] })).toEqual([
      { kind: "text", path: "paper/pages/page-0002.md", lineStart: 10, lineEnd: 10, quote: "visual page 2" },
    ]);
    expect(() => preflightTextCitations({ attemptId: fixture.attemptId, runEpoch: fixture.runEpoch,
      layout: fixture.layout, database, citations: [{ kind: "text", path: "paper/pages/page-0002.md",
        lineStart: 10, lineEnd: 10, quote: "visual page two" }] })).toThrow("citation-quote-mismatch");
    expect(database.prepare(`SELECT event_type,count(*) count FROM agent_run_activities
      WHERE job_run_id=? AND run_epoch=? AND event_type LIKE 'text-citation-preflight%'
      GROUP BY event_type ORDER BY event_type`).all(fixture.attemptId, fixture.runEpoch)).toEqual([
      { event_type: "text-citation-preflight", count: 1 },
      { event_type: "text-citation-preflight-failed", count: 1 },
    ]);

    await fixture.app.inject({ method: "POST", url: `/api/agent-runs/${encodeURIComponent(fixture.attemptId)}/cancel` });
    database.close();
    await fixture.app.close();
  });

  it("counts four unique pages per Attempt while repeated pages are free", async () => {
    const fixture = await runningAttemptFixture(5);
    const database = new Database(fixture.layout.databasePath);
    database.pragma("foreign_keys = ON");
    const shim = new VisualEvidenceShim({ attemptId: fixture.attemptId, runEpoch: fixture.runEpoch,
      layout: fixture.layout, database, store: new VisualEvidenceStore(fixture.layout, database, new PdfPageRenderer()) });

    await expect(shim.inspectPdfPage({ sourceId: "paper-version:foreign", page: 1 })).rejects.toThrow("visual-source-foreign");
    await expect(shim.inspectPdfPage({ sourceId: fixture.paperVersionId, page: 6 })).rejects.toThrow("visual-page-out-of-bounds");
    const artifact = database.prepare(`SELECT artifact.id,artifact.storage_ref FROM paper_versions version
      JOIN artifacts artifact ON artifact.id=version.pdf_artifact_id WHERE version.id=?`)
      .get(fixture.paperVersionId) as { id: string; storage_ref: string };
    database.prepare("UPDATE artifacts SET storage_ref='../foreign.pdf' WHERE id=?").run(artifact.id);
    await expect(shim.inspectPdfPage({ sourceId: fixture.paperVersionId, page: 1 })).rejects.toThrow("visual-source-path-unsafe");
    database.prepare("UPDATE artifacts SET storage_ref=? WHERE id=?").run(artifact.storage_ref, artifact.id);
    const sourceShard = dirname(join(fixture.layout.root, artifact.storage_ref));
    const outsideShard = `${sourceShard}-outside`;
    await rename(sourceShard, outsideShard);
    await symlink(outsideShard, sourceShard, "dir");
    await expect(shim.inspectPdfPage({ sourceId: fixture.paperVersionId, page: 1 }))
      .rejects.toThrow("visual-source-path-unsafe");
    await unlink(sourceShard);
    await rename(outsideShard, sourceShard);

    for (const page of [1, 2, 3, 4]) await shim.inspectPdfPage({ sourceId: fixture.paperVersionId, page });
    await shim.inspectPdfPage({ sourceId: fixture.paperVersionId, page: 1 });

    expect(shim.budgetStatus()).toEqual({ used: 4, remaining: 0, limit: 4 });
    await expect(shim.inspectPdfPage({ sourceId: fixture.paperVersionId, page: 5 }))
      .rejects.toThrow("visual-page-budget-exhausted");
    expect(database.prepare("SELECT count(*) FROM visual_page_inspections WHERE inspection_status='ready'").pluck().get()).toBe(4);
    expect(database.prepare("SELECT count(*) FROM agent_run_activities WHERE event_type='visual-page-inspected'").pluck().get()).toBe(5);
    await fixture.app.inject({ method: "POST", url: `/api/agent-runs/${encodeURIComponent(fixture.attemptId)}/cancel` });
    expect(() => shim.budgetStatus()).toThrow("visual-attempt-inactive-or-stale");
    await fixture.app.inject({ method: "POST", url: `/api/messages/${encodeURIComponent(fixture.userMessageId)}/retry`,
      headers: { "idempotency-key": "visual-budget-retry" } });
    const retried = await waitFor(fixture.app, `/api/conversations/${encodeURIComponent(fixture.conversationId)}`,
      (body) => body.messages[0]?.attempts[1]?.state === "running");
    const retryAttemptId = retried.messages[0].attempts[1].id as string;
    const retryEpoch = database.prepare("SELECT run_epoch FROM job_runs WHERE id=?").pluck().get(retryAttemptId) as number;
    const retryShim = new VisualEvidenceShim({ attemptId: retryAttemptId, runEpoch: retryEpoch, layout: fixture.layout,
      database, store: new VisualEvidenceStore(fixture.layout, database, new PdfPageRenderer()) });
    expect(retryShim.budgetStatus()).toEqual({ used: 0, remaining: 4, limit: 4 });
    await fixture.app.inject({ method: "POST", url: `/api/agent-runs/${encodeURIComponent(retryAttemptId)}/cancel` });
    database.close();
    await fixture.app.close();
  });

  it("counts a failed first request toward the four unique-page budget", async () => {
    const fixture = await runningAttemptFixture(5);
    const database = new Database(fixture.layout.databasePath);
    database.pragma("foreign_keys = ON");
    const renderer = new PdfPageRenderer();
    const failFirst = { async render(source: Parameters<PdfPageRenderer["render"]>[0], page: number) {
      if (page === 1) throw new Error("renderer-fixture-failure");
      return renderer.render(source, page);
    } };
    const shim = new VisualEvidenceShim({ attemptId: fixture.attemptId, runEpoch: fixture.runEpoch,
      layout: fixture.layout, database, store: new VisualEvidenceStore(fixture.layout, database, failFirst) });

    await expect(shim.inspectPdfPage({ sourceId: fixture.paperVersionId, page: 1 }))
      .rejects.toThrow("visual-render-failed");
    for (const page of [2, 3, 4]) await shim.inspectPdfPage({ sourceId: fixture.paperVersionId, page });

    expect(shim.budgetStatus()).toEqual({ used: 4, remaining: 0, limit: 4 });
    await expect(shim.inspectPdfPage({ sourceId: fixture.paperVersionId, page: 5 }))
      .rejects.toThrow("visual-page-budget-exhausted");
    await fixture.app.inject({ method: "POST", url: `/api/agent-runs/${encodeURIComponent(fixture.attemptId)}/cancel` });
    database.close();
    await fixture.app.close();
  });

  it("serves text preflight and the visual tools over the same stdio MCP contract", async () => {
    const fixture = await runningAttemptFixture(5);
    const binding = join(fixture.layout.tmpRoot, "visual-mcp-test-binding.json");
    await writeFile(binding, JSON.stringify({ dataRoot: fixture.layout.root, attemptId: fixture.attemptId,
      runEpoch: fixture.runEpoch }), { mode: 0o600 });
    await chmod(binding, 0o600);
    const child = spawn(process.execPath, ["--import", "tsx", join(process.cwd(), "src/agent/visual-evidence-mcp-server.ts")], {
      cwd: process.cwd(), env: { ...process.env, SCHOLARLOOM_VISUAL_BINDING_FILE: binding }, stdio: ["pipe", "pipe", "pipe"],
    });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const iterator = lines[Symbol.asyncIterator]();
    const request = async (value: object) => {
      child.stdin.write(`${JSON.stringify(value)}\n`);
      const next = await iterator.next();
      if (next.done) throw new Error("visual-mcp-closed");
      return JSON.parse(next.value) as any;
    };

    const initialized = await request({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
    expect(initialized.result.serverInfo.name).toBe("scholarloom-visual");
    const listed = await request({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    expect(listed.result.tools.map((tool: any) => tool.name))
      .toEqual(["verify_text_citation", "inspect_pdf_page", "budget_status"]);
    const paraphrased = await request({ jsonrpc: "2.0", id: 3, method: "tools/call", params: {
      name: "verify_text_citation", arguments: { path: "paper/pages/page-0002.md", lineStart: 1, lineEnd: 1,
        quote: "visual page two" } } });
    expect(paraphrased.result).toMatchObject({ isError: true,
      content: [{ type: "text", text: "citation-quote-mismatch" }] });
    const preflight = await request({ jsonrpc: "2.0", id: 4, method: "tools/call", params: {
      name: "verify_text_citation", arguments: { path: "paper/pages/page-0002.md", lineStart: 1, lineEnd: 1,
        quote: "visual page 2" } } });
    expect(JSON.parse(preflight.result.content[0].text)).toEqual({ kind: "text", path: "paper/pages/page-0002.md",
      lineStart: 10, lineEnd: 10, quote: "visual page 2" });
    const inspected = await request({ jsonrpc: "2.0", id: 5, method: "tools/call", params: {
      name: "inspect_pdf_page", arguments: { sourceId: fixture.paperVersionId, page: 2 } } });
    const descriptor = JSON.parse(inspected.result.content[0].text);
    const image = Buffer.from(inspected.result.content[1].data, "base64");
    expect(inspected.result.content[1].mimeType).toBe("image/png");
    expect(image.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(descriptor).toMatchObject({ sourceId: fixture.paperVersionId, page: 2,
      imageHash: createHash("sha256").update(image).digest("hex"), budget: { used: 1, remaining: 3, limit: 4 } });
    const budget = await request({ jsonrpc: "2.0", id: 6, method: "tools/call",
      params: { name: "budget_status", arguments: {} } });
    expect(JSON.parse(budget.result.content[0].text)).toEqual({ used: 1, remaining: 3, limit: 4 });
    const database = new Database(fixture.layout.databasePath);
    expect(database.prepare(`SELECT count(*) FROM agent_run_activities
      WHERE job_run_id=? AND run_epoch=? AND event_type='text-citation-preflight'`).pluck()
      .get(fixture.attemptId, fixture.runEpoch)).toBe(1);
    database.close();
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => child.once("close", () => resolve()));
    await fixture.app.inject({ method: "POST", url: `/api/agent-runs/${encodeURIComponent(fixture.attemptId)}/cancel` });
    await fixture.app.close();
  });
});

async function runningAttemptFixture(pageCount: number) {
  const root = await mkdtemp(join(tmpdir(), "scholarloom-visual-shim-"));
  const layout = initializeDataRoot(join(root, "data"));
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let page = 1; page <= pageCount; page += 1) pdf.addPage().drawText(`visual page ${page}`, { x: 40, y: 700, font });
  const bytes = await pdf.save({ useObjectStreams: false });
  const runner: AgenticEvidenceRunner = { async run(input) {
    await new Promise<void>((_resolve, reject) => input.signal.addEventListener("abort", () => reject(input.signal.reason), { once: true }));
    throw new Error("unreachable");
  } };
  const app = await createApp({ storageLayout: layout,
    paperSource: { async resolve(arxivId) { return { arxivId, latestVersion: 1, title: "Visual Fixture",
      authors: ["Ada Fixture"], year: 2026 }; }, async fetchPdf() { return bytes; } },
    codexRunner: { async runSummary() { return { sections: [{ key: "overview", title: "概述", body: "visual fixture" }],
      claims: [{ voice: "paper-evidence", claim: "visual fixture", sourceHandle: "pdf-page:1" }], readStatus: "read" }; } },
    agenticEvidenceRunner: runner });
  const imported = await app.inject({ method: "POST", url: "/api/imports", payload: { arxivUrl: "https://arxiv.org/abs/2601.00009v1" } });
  await waitFor(app, `/api/imports/${imported.json().importRequest.id}`, (body) => body.jobs.at(-1)?.state === "succeeded");
  const created = await app.inject({ method: "POST", url: `/api/papers/${encodeURIComponent(imported.json().paper.id)}/conversations` });
  const conversationId = created.json().conversation.id;
  await app.inject({ method: "POST", url: `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
    payload: { content: "inspect the chart", idempotencyKey: `visual-${pageCount}` } });
  const running = await waitFor(app, `/api/conversations/${encodeURIComponent(conversationId)}`,
    (body) => body.messages[0]?.attempts[0]?.state === "running");
  const database = new Database(layout.databasePath);
  const runEpoch = database.prepare("SELECT run_epoch FROM job_runs WHERE id=?").pluck()
    .get(running.messages[0].attempts[0].id) as number;
  database.close();
  return { app, layout, conversationId, paperVersionId: created.json().contextSnapshot.paperVersionId,
    userMessageId: running.messages[0].id, attemptId: running.messages[0].attempts[0].id, runEpoch };
}

async function waitFor(app: FastifyInstance, url: string, predicate: (body: any) => boolean): Promise<any> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await app.inject({ method: "GET", url });
    const body = response.json();
    if (predicate(body)) return body;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("fixture-timeout");
}
