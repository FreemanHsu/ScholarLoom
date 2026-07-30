import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { PDFDocument, StandardFonts } from "pdf-lib";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import type { AgenticEvidenceRunner } from "../src/agent/agentic-evidence-runner.js";
import { initializeDataRoot } from "../src/storage/layout.js";
import { PdfPageRenderer } from "../src/storage/pdf-page-renderer.js";
import { VisualEvidenceShim } from "../src/storage/visual-evidence-shim.js";
import { VisualEvidenceStore } from "../src/storage/visual-evidence-store.js";

async function waitFor(app: FastifyInstance, url: string, predicate: (body: any) => boolean): Promise<any> {
  for (let index = 0; index < 200; index += 1) {
    const response = await app.inject({ method: "GET", url });
    const body = response.json();
    if (predicate(body)) return body;
    const failed = body.messages?.flatMap((message: any) => message.attempts ?? []).find((attempt: any) => attempt.state === "failed");
    if (failed) throw new Error(JSON.stringify(failed));
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("agentic fixture did not settle");
}

describe("Agentic Evidence conversation", () => {
  it("atomically commits a grounded visual citation as a Visual Receipt", async () => {
    const root = await mkdtemp(join(tmpdir(), "scholarloom-visual-conversation-"));
    const layout = initializeDataRoot(join(root, "data"));
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const page = pdf.addPage();
    page.drawRectangle({ x: 40, y: 80, width: 80, height: 300 });
    page.drawText("Figure 1", { x: 40, y: 50, font });
    const bytes = await pdf.save({ useObjectStreams: false });
    const runner: AgenticEvidenceRunner = { async run(input) {
      const manifest = JSON.parse(await readFile(join(input.workspaceRoot, "MANIFEST.json"), "utf8")) as {
        sources: Array<{ kind: string; sourceId: string }>;
      };
      const sourceId = manifest.sources.find((source) => source.kind === "pdf")!.sourceId;
      const database = new Database(layout.databasePath);
      database.pragma("foreign_keys = ON");
      try {
        const shim = new VisualEvidenceShim({ attemptId: input.attemptId, runEpoch: input.runEpoch, layout, database,
          store: new VisualEvidenceStore(layout, database, new PdfPageRenderer()) });
        const inspected = await shim.inspectPdfPage({ sourceId, page: 1 });
        return { answer: "图 1 包含一根明显的竖直柱。", groundingStatus: "answered",
          citations: [{ kind: "visual" as const, sourceId, page: 1, imageHash: inspected.imageHash,
            observation: "Figure 1 shows one prominent vertical bar." }],
          usage: { status: "unavailable" } };
      } finally { database.close(); }
    } };
    const app = await createApp({ storageLayout: layout,
      paperSource: { async resolve(arxivId) { return { arxivId, latestVersion: 1, title: "Visual Conversation",
        authors: ["Ada Fixture"], year: 2026 }; }, async fetchPdf() { return bytes; } },
      codexRunner: { async runSummary() { return { sections: [{ key: "overview", title: "概述", body: "Figure 1" }],
        claims: [{ voice: "paper-evidence", claim: "Figure 1", sourceHandle: "pdf-page:1" }], readStatus: "read" }; } },
      agenticEvidenceRunner: runner });
    const imported = await app.inject({ method: "POST", url: "/api/imports", payload: { arxivUrl: "https://arxiv.org/abs/2601.00008v1" } });
    await waitFor(app, `/api/imports/${imported.json().importRequest.id}`, (body) => body.jobs.at(-1)?.state === "succeeded");
    const created = await app.inject({ method: "POST", url: `/api/papers/${encodeURIComponent(imported.json().paper.id)}/conversations` });
    const conversationId = created.json().conversation.id;
    await app.inject({ method: "POST", url: `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
      payload: { content: "图 1 里有什么？", idempotencyKey: "visual-grounding" } });

    const restored = await waitFor(app, `/api/conversations/${encodeURIComponent(conversationId)}`,
      (body) => body.messages.some((message: any) => message.role === "assistant"));

    expect(restored.messages[1]).toMatchObject({ role: "assistant", groundingStatus: "answered",
      citations: [expect.objectContaining({ evidenceKind: "visual", page: 1,
        visualObservation: "Figure 1 shows one prominent vertical bar." })] });
    const database = new Database(layout.databasePath);
    expect(database.prepare("SELECT count(*) FROM visual_evidence_receipts").pluck().get()).toBe(1);
    expect(database.prepare("SELECT count(*) FROM proposals WHERE source_message_id=?").pluck()
      .get(restored.messages[1].id)).toBe(0);
    const receiptId = restored.messages[1].citations[0].id;
    const receipt = await app.inject({ method: "GET", url: `/api/evidence/${encodeURIComponent(receiptId)}` });
    expect(receipt.json()).toMatchObject({ evidenceKind: "visual", page: 1,
      visualObservation: "Figure 1 shows one prominent vertical bar.", verificationStatus: "verified" });
    const renderRef = database.prepare(`SELECT artifact.storage_ref FROM visual_evidence_receipts receipt
      JOIN visual_render_artifacts artifact ON artifact.id=receipt.render_artifact_id WHERE receipt.id=?`).pluck()
      .get(receiptId) as string;
    await rm(dirname(join(layout.root, renderRef)), { recursive: true, force: true });
    const rebuiltImage = await app.inject({ method: "GET", url: `/api/evidence/${encodeURIComponent(receiptId)}/image` });
    expect(rebuiltImage.statusCode).toBe(200);
    expect(rebuiltImage.rawPayload.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(new VisualEvidenceStore(layout, database, new PdfPageRenderer()).collectGarbage({ retainUnreferenced: 0 })
      .removedArtifactIds).toEqual([]);
    database.close();
    await app.close();
  });

  it("runs one workspace-scoped attempt and atomically exposes grounded receipts and activity", async () => {
    const root = await mkdtemp(join(tmpdir(), "scholarloom-agentic-conversation-"));
    const layout = initializeDataRoot(join(root, "data"));
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    pdf.addPage().drawText("Grounded agentic answer.", { x: 40, y: 700, font });
    const bytes = await pdf.save();
    const runner: AgenticEvidenceRunner = { async run(input) {
      expect(input.workspaceRoot).toContain("derived/evidence-workspaces/");
      const pagePath = join(input.workspaceRoot, "paper", "pages", "page-0001.md");
      const page = await readFile(pagePath, "utf8");
      const line = page.split("\n").findIndex((value) => value.includes("Grounded agentic answer.")) + 1;
      input.onActivity({ type: "evidence-read", text: "已检查 PDF 第 1 页", metadata: { path: "paper/pages/page-0001.md" } });
      return {
        answer: "证据支持这个回答。",
        groundingStatus: "answered",
        citations: [{ kind: "text" as const, path: "paper/pages/page-0001.md", lineStart: line, lineEnd: line, quote: "Grounded agentic answer." }],
        usage: { status: "reported", inputTokens: 1200, cachedInputTokens: 200, outputTokens: 80, totalTokens: 1280 },
      };
    } };
    const app = await createApp({
      storageLayout: layout,
      paperSource: {
        async resolve(arxivId) { return { arxivId, latestVersion: 1, title: "Agentic Fixture", authors: ["Ada Fixture"], year: 2026 }; },
        async fetchPdf() { return bytes; },
      },
      codexRunner: { async runSummary() { return {
        sections: [{ key: "overview", title: "概述", body: "Grounded agentic answer." }],
        claims: [{ voice: "paper-evidence", claim: "Grounded agentic answer.", sourceHandle: "pdf-page:1" }],
        readStatus: "read",
      }; } },
      agenticEvidenceRunner: runner,
    });
    const imported = await app.inject({ method: "POST", url: "/api/imports", payload: { arxivUrl: "https://arxiv.org/abs/2601.00003v1" } });
    await waitFor(app, `/api/imports/${imported.json().importRequest.id}`, (body) => body.jobs.at(-1)?.state === "succeeded");
    const created = await app.inject({ method: "POST", url: `/api/papers/${encodeURIComponent(imported.json().paper.id)}/conversations` });
    const conversationId = created.json().conversation.id;
    const accepted = await app.inject({ method: "POST", url: `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
      payload: { content: "证据是什么？", idempotencyKey: "agentic-send-1" } });
    expect(accepted.statusCode, accepted.body).toBe(202);
    const restored = await waitFor(app, `/api/conversations/${encodeURIComponent(conversationId)}`,
      (body) => body.messages.some((message: any) => message.role === "assistant"));
    expect(restored.messages).toEqual([
      expect.objectContaining({ role: "user", attempts: [expect.objectContaining({ state: "succeeded", runnerKind: "agentic_evidence",
        activities: [expect.objectContaining({ type: "evidence-read", text: "已检查 PDF 第 1 页" })],
        usage: expect.objectContaining({ status: "reported", inputTokens: 1200, cachedInputTokens: 200, totalTokens: 1280 }) })] }),
      expect.objectContaining({ role: "assistant", content: "证据支持这个回答。", groundingStatus: "answered",
        citations: [expect.objectContaining({ evidenceKind: "pdf", quote: "Grounded agentic answer." })] }),
    ]);
    const receiptId = restored.messages[1].citations[0].id;
    const inspector = await app.inject({ method: "GET", url: `/api/evidence/${encodeURIComponent(receiptId)}` });
    expect(inspector.statusCode).toBe(200);
    expect(inspector.json()).toMatchObject({ id: receiptId, evidenceKind: "pdf", quote: "Grounded agentic answer.",
      locator: { page: 1 } });
    await app.close();
  });

  it("classifies an unresolved visual inspection failure as failed_infra", async () => {
    const root = await mkdtemp(join(tmpdir(), "scholarloom-visual-infra-"));
    const layout = initializeDataRoot(join(root, "data"));
    const pdf = await PDFDocument.create();
    pdf.addPage();
    const bytes = await pdf.save();
    const runner: AgenticEvidenceRunner = { async run(input) {
      const database = new Database(layout.databasePath);
      const source = database.prepare(`SELECT artifact.id artifact_id,artifact.content_hash FROM job_runs job
        JOIN papers paper ON paper.id=job.paper_id
        JOIN paper_versions version ON version.id=paper.current_version_id
        JOIN artifacts artifact ON artifact.id=version.pdf_artifact_id WHERE job.id=?`).get(input.attemptId) as
        { artifact_id: string; content_hash: string };
      const now = new Date().toISOString();
      database.prepare(`INSERT INTO visual_page_inspections
        (id,job_run_id,run_epoch,source_artifact_id,source_content_hash,page_number,inspection_status,failure_count,
         first_inspected_at,last_inspected_at) VALUES (?,?,?,?,?,1,'failed_infra',1,?,?)`)
        .run(`inspection:${input.attemptId}`, input.attemptId, input.runEpoch, source.artifact_id, source.content_hash, now, now);
      database.close();
      return { answer: "无法检查图像。", groundingStatus: "insufficient_evidence", citations: [],
        usage: { status: "unavailable" } };
    } };
    const app = await createApp({ storageLayout: layout,
      paperSource: { async resolve(arxivId) { return { arxivId, latestVersion: 1, title: "Infra Fixture",
        authors: ["Ada Fixture"], year: 2026 }; }, async fetchPdf() { return bytes; } },
      codexRunner: { async runSummary() { return { sections: [{ key: "overview", title: "概述", body: "fixture" }],
        claims: [{ voice: "paper-evidence", claim: "fixture", sourceHandle: "pdf-page:1" }], readStatus: "read" }; } },
      agenticEvidenceRunner: runner });
    const imported = await app.inject({ method: "POST", url: "/api/imports",
      payload: { arxivUrl: "https://arxiv.org/abs/2601.00009v1" } });
    await waitFor(app, `/api/imports/${imported.json().importRequest.id}`, (body) => body.jobs.at(-1)?.state === "succeeded");
    const created = await app.inject({ method: "POST",
      url: `/api/papers/${encodeURIComponent(imported.json().paper.id)}/conversations` });
    const conversationId = created.json().conversation.id;
    await app.inject({ method: "POST", url: `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
      payload: { content: "inspect visual", idempotencyKey: "visual-infra" } });
    let attempt: any;
    for (let index = 0; index < 200; index += 1) {
      const response = await app.inject({ method: "GET", url: `/api/conversations/${encodeURIComponent(conversationId)}` });
      attempt = response.json().messages[0]?.attempts[0];
      if (attempt?.state === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(attempt).toMatchObject({ state: "failed", failureKind: "failed_infra" });
    await app.close();
  });

  it("invalidates a running epoch on cancel and retries the same user Message", async () => {
    const root = await mkdtemp(join(tmpdir(), "scholarloom-agentic-cancel-"));
    const layout = initializeDataRoot(join(root, "data"));
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    pdf.addPage().drawText("Retry uses frozen evidence.", { x: 40, y: 700, font });
    const bytes = await pdf.save();
    let calls = 0;
    const runner: AgenticEvidenceRunner = { async run(input) {
      calls += 1;
      if (calls === 1) await new Promise<void>((_resolve, reject) => input.signal.addEventListener("abort", () => reject(input.signal.reason), { once: true }));
      const page = await readFile(join(input.workspaceRoot, "paper", "pages", "page-0001.md"), "utf8");
      const line = page.split("\n").findIndex((value) => value.includes("Retry uses frozen evidence.")) + 1;
      return { answer: "retry complete", groundingStatus: "answered",
        citations: [{ kind: "text" as const, path: "paper/pages/page-0001.md", lineStart: line, lineEnd: line, quote: "Retry uses frozen evidence." }],
        usage: { status: "unavailable" } };
    } };
    const app = await createApp({ storageLayout: layout,
      paperSource: { async resolve(arxivId) { return { arxivId, latestVersion: 1, title: "Cancel Fixture", authors: ["Ada Fixture"], year: 2026 }; },
        async fetchPdf() { return bytes; } },
      codexRunner: { async runSummary() { return { sections: [{ key: "overview", title: "概述", body: "Retry uses frozen evidence." }],
        claims: [{ voice: "paper-evidence", claim: "Retry uses frozen evidence.", sourceHandle: "pdf-page:1" }], readStatus: "read" }; } },
      agenticEvidenceRunner: runner });
    const imported = await app.inject({ method: "POST", url: "/api/imports", payload: { arxivUrl: "https://arxiv.org/abs/2601.00004v1" } });
    await waitFor(app, `/api/imports/${imported.json().importRequest.id}`, (body) => body.jobs.at(-1)?.state === "succeeded");
    const created = await app.inject({ method: "POST", url: `/api/papers/${encodeURIComponent(imported.json().paper.id)}/conversations` });
    const conversationId = created.json().conversation.id;
    await app.inject({ method: "POST", url: `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
      payload: { content: "cancel then retry", idempotencyKey: "cancel-send" } });
    const running = await waitFor(app, `/api/conversations/${encodeURIComponent(conversationId)}`,
      (body) => body.messages[0]?.attempts[0]?.state === "running");
    const attemptId = running.messages[0].attempts[0].id;
    const canceled = await app.inject({ method: "POST", url: `/api/agent-runs/${encodeURIComponent(attemptId)}/cancel` });
    expect(canceled.statusCode).toBe(202);
    const afterCancel = await waitFor(app, `/api/conversations/${encodeURIComponent(conversationId)}`,
      (body) => body.messages[0]?.attempts[0]?.state === "canceled");
    expect(afterCancel.messages).toHaveLength(1);
    const retry = await app.inject({ method: "POST", url: `/api/messages/${encodeURIComponent(afterCancel.messages[0].id)}/retry`,
      headers: { "idempotency-key": "cancel-retry" } });
    expect(retry.statusCode, retry.body).toBe(202);
    const complete = await waitFor(app, `/api/conversations/${encodeURIComponent(conversationId)}`,
      (body) => body.messages.some((message: any) => message.role === "assistant"));
    expect(complete.messages.filter((message: any) => message.role === "user")).toHaveLength(1);
    expect(complete.messages[0].attempts).toMatchObject([{ attemptNo: 1, state: "canceled" }, { attemptNo: 2, state: "succeeded" }]);
    expect(complete.messages[1]).toMatchObject({ role: "assistant", content: "retry complete" });
    await app.close();
  });
});
