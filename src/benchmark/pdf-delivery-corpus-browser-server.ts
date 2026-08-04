import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApp } from "../app.js";
import { fixtureSummary } from "../adapters/fixture.js";
import { parsePort } from "../runtime-config.js";
import { initializeDataRoot } from "../storage/layout.js";
import { MINIMUM_CODEX_VERSION } from "../agent/agent-configuration.js";
import { PDF_DELIVERY_CORPUS } from "./pdf-delivery-corpus.js";
import { downloadPinnedArxivPdf } from "./pinned-arxiv-pdf.js";

const arxivId = process.env.SCHOLARLOOM_BENCHMARK_ARXIV_ID;
const paper = PDF_DELIVERY_CORPUS.find((candidate) => candidate.arxivId === arxivId);
if (!paper) throw new Error("benchmark-corpus-paper-required");
const port = parsePort(process.env.SCHOLARLOOM_PORT ?? "3018");
const host = "127.0.0.1";
const optimizationEnabled = process.env.SCHOLARLOOM_BENCHMARK_PDF_OPTIMIZATION !== "off";
const startedAt = new Date().toISOString();
const runtimeRoot = await mkdtemp(join(tmpdir(), `scholarloom-pdf-corpus-browser-${paper.arxivId}-`));
let app: Awaited<ReturnType<typeof createApp>> | null = null;

let closed = false;
async function cleanup(): Promise<void> {
  if (closed) return;
  closed = true;
  await app?.close();
  await rm(runtimeRoot, { recursive: true, force: true });
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => { void cleanup().finally(() => process.exit(0)); });
}

try {
  const bytes = await downloadPinnedArxivPdf(paper);
  const sourceHash = createHash("sha256").update(bytes).digest("hex");
  if (sourceHash !== paper.expectedSha256) throw new Error(`corpus-source-hash-mismatch:${paper.arxivId}v${paper.version}`);
  const layout = initializeDataRoot(join(runtimeRoot, "data"));
  app = await createApp({
    storageLayout: layout,
    paperSource: {
      async resolve() { return { arxivId: paper.arxivId, latestVersion: paper.version,
        title: paper.title, authors: [...paper.authors], year: paper.year }; },
      async fetchPdf() { return bytes; },
    },
    codexRunner: { async runSummary() { return fixtureSummary; } },
    ...(optimizationEnabled ? { pdfOptimization: { strategy: "lossless-linearization" as const } } : {}),
    settingsRuntime: {
      host, port, startedAt, fixture: true, takeawayQualityReleased: false,
      pdfViewerEngine: "pdfjs", pdfOptimization: optimizationEnabled ? "lossless-linearization" : "off",
      codexRuntimeStatus: () => ({
        installedVersion: null, minimumVersion: MINIMUM_CODEX_VERSION, versionStatus: "unavailable",
        capabilityStatus: "not-run", capabilityChecks: {
          structured: { status: "not-run", checkedAt: null },
          agenticEvidence: { status: "not-run", checkedAt: null },
        }, checkedAt: startedAt,
      }),
    },
  });
  const submitted = await app.inject({ method: "POST", url: "/api/imports",
    payload: { reference: `https://arxiv.org/abs/${paper.arxivId}v${paper.version}` } });
  const imported = submitted.json() as { importRequest: { id: string }; paper: { id: string } };
  await waitForImport(app, imported.importRequest.id);
  const workspace = await app.inject({ method: "GET", url: `/api/papers/${encodeURIComponent(imported.paper.id)}` });
  const pdfUrl = (workspace.json() as { pdf: { url: string } }).pdf.url;
  const servingOriginal = pdfUrl.includes(sourceHash);
  if (!optimizationEnabled && !servingOriginal) {
    throw new Error(`benchmark-delivery-selection-mismatch:${paper.arxivId}`);
  }
  await app.listen({ host, port });
  process.stdout.write(`${JSON.stringify({
    paperUrl: `http://${host}:${port}/papers/${encodeURIComponent(imported.paper.id)}`,
    pdfUrl: `http://${host}:${port}${pdfUrl}`,
    sourceHash,
    sourceBytes: bytes.byteLength,
    arxivId: paper.arxivId,
    deliveryMode: servingOriginal ? "original" : "lossless-linearization",
  })}\n`);
} catch (error) {
  await cleanup();
  throw error;
}

async function waitForImport(runningApp: Awaited<ReturnType<typeof createApp>>,
  importRequestId: string): Promise<void> {
  for (let attempt = 0; attempt < 12_000; attempt += 1) {
    const status = await runningApp.inject({ method: "GET", url: `/api/imports/${encodeURIComponent(importRequestId)}` });
    const job = (status.json() as { jobs: Array<{ state: string; error?: unknown }> }).jobs.at(-1);
    if (job?.state === "succeeded") return;
    if (job?.state === "failed") throw new Error(`benchmark-import-failed:${JSON.stringify(job.error)}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("benchmark-import-timeout");
}
