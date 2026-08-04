import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import Database from "better-sqlite3";

import { createApp } from "../app.js";
import { fixtureSummary } from "../adapters/fixture.js";
import { initializeDataRoot } from "../storage/layout.js";
import { PdfPageRenderer } from "../storage/pdf-page-renderer.js";
import {
  LOSSLESS_LINEARIZATION_PARAMETERS,
  QpdfLinearizationTool,
  type PdfLinearizationTool,
} from "../storage/pdf-delivery-optimizer.js";

export type PdfDeliveryCorpusPaper = {
  arxivId: string;
  version: number;
  title: string;
  authors: string[];
  year: number;
  profile: string;
  pdfUrl: string;
  expectedSha256?: string;
};

export const PDF_DELIVERY_CORPUS = [
  {
    arxivId: "1706.03762", version: 7, title: "Attention Is All You Need",
    authors: ["Ashish Vaswani"], year: 2017, profile: "figures-and-two-column-text",
    pdfUrl: "https://arxiv.org/pdf/1706.03762v7",
    expectedSha256: "bdfaa68d8984f0dc02beaca527b76f207d99b666d31d1da728ee0728182df697",
  },
  {
    arxivId: "1810.04805", version: 2,
    title: "BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding",
    authors: ["Jacob Devlin"], year: 2018, profile: "small-text-heavy",
    pdfUrl: "https://arxiv.org/pdf/1810.04805v2",
    expectedSha256: "5692a5514787a8c6727b4ff3b726a3385798bc68e12138d1d4af83947e2acf6e",
  },
  {
    arxivId: "2005.14165", version: 4, title: "Language Models are Few-Shot Learners",
    authors: ["Tom Brown"], year: 2020, profile: "long-text-tables-and-appendices",
    pdfUrl: "https://arxiv.org/pdf/2005.14165v4",
    expectedSha256: "97fd272f1fdfc18677462d0292f5fbf26ca86b4d1b485c2dba03269b643a0e83",
  },
  {
    arxivId: "2302.13971", version: 1, title: "LLaMA: Open and Efficient Foundation Language Models",
    authors: ["Hugo Touvron"], year: 2023, profile: "small-tables-and-plots",
    pdfUrl: "https://arxiv.org/pdf/2302.13971v1",
    expectedSha256: "2e663675ae36ad12adb2f5a05281bac2747ecf8d23d92bedd9f937a89fee7136",
  },
  {
    arxivId: "2010.11929", version: 2,
    title: "An Image is Worth 16x16 Words: Transformers for Image Recognition at Scale",
    authors: ["Alexey Dosovitskiy"], year: 2020, profile: "image-and-plot-heavy",
    pdfUrl: "https://arxiv.org/pdf/2010.11929v2",
    expectedSha256: "8ce7b83971a14508ca711a27c875c9b6914c4f6767cf3150fb1ca6c07aa056d6",
  },
] as const satisfies readonly PdfDeliveryCorpusPaper[];

export type PdfDeliveryCorpusSample = PdfDeliveryCorpusPaper & {
  sourceHash: string;
  sourceBytes: number;
  pageCount: number;
  sourceLinearized: boolean | null;
  status: "selected" | "skipped" | "failed";
  reason: string;
  deliveryHash: string | null;
  deliveryBytes: number | null;
  sizeRatio: number | null;
  durationMs: number | null;
  renderedPages: Array<{
    page: number;
    sourceImageHash: string;
    deliveryImageHash: string;
    matches: boolean;
  }>;
};

export type PdfDeliveryCorpusReport = {
  schemaVersion: 1;
  generatedAt: string;
  tool: { name: string; version: string | null };
  parameters: typeof LOSSLESS_LINEARIZATION_PARAMETERS;
  summary: {
    papers: number;
    selected: number;
    skipped: number;
    failed: number;
    renderParityPassed: boolean;
  };
  samples: PdfDeliveryCorpusSample[];
};

export async function benchmarkPdfDeliveryCorpus(options: {
  runtimeRoot: string;
  corpus: readonly PdfDeliveryCorpusPaper[];
  fetchPdf(paper: PdfDeliveryCorpusPaper): Promise<Uint8Array>;
  tool?: PdfLinearizationTool;
  now?: () => Date;
}): Promise<PdfDeliveryCorpusReport> {
  const tool = options.tool ?? new QpdfLinearizationTool();
  const now = options.now ?? (() => new Date());
  let toolVersion: string | null = null;
  try { toolVersion = await tool.version(); } catch { /* Each sample records the production fallback. */ }
  const samples: PdfDeliveryCorpusSample[] = [];

  for (const paper of options.corpus) {
    const bytes = Buffer.from(await options.fetchPdf(paper));
    if (!bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error(`corpus-source-not-pdf:${paper.arxivId}v${paper.version}`);
    const sourceHash = createHash("sha256").update(bytes).digest("hex");
    if (paper.expectedSha256 && paper.expectedSha256 !== sourceHash) {
      throw new Error(`corpus-source-hash-mismatch:${paper.arxivId}v${paper.version}`);
    }
    const sampleRoot = join(options.runtimeRoot, `${paper.arxivId}v${paper.version}`);
    let app: Awaited<ReturnType<typeof createApp>> | null = null;

    try {
      const layout = initializeDataRoot(sampleRoot, now());
      app = await createApp({
        storageLayout: layout,
        paperSource: {
          async resolve() { return { arxivId: paper.arxivId, latestVersion: paper.version,
            title: paper.title, authors: paper.authors, year: paper.year }; },
          async fetchPdf() { return bytes; },
        },
        codexRunner: { async runSummary() { return fixtureSummary; } },
        pdfOptimization: { strategy: "lossless-linearization", tool },
      });
      const submitted = await app.inject({ method: "POST", url: "/api/imports",
        payload: { reference: `https://arxiv.org/abs/${paper.arxivId}v${paper.version}` } });
      if (submitted.statusCode !== 202) throw new Error(`corpus-import-rejected:${paper.arxivId}v${paper.version}`);
      const body = submitted.json() as { importRequest: { id: string }; paper: { id: string } };
      await waitForImport(app, body.importRequest.id, paper);
      const workspace = await app.inject({ method: "GET", url: `/api/papers/${encodeURIComponent(body.paper.id)}` });
      if (workspace.statusCode !== 200) throw new Error(`corpus-workspace-unavailable:${paper.arxivId}v${paper.version}`);

      const database = new Database(layout.databasePath, { readonly: true });
      let optimization: { status: "selected" | "skipped" | "failed"; reason: string;
        output_byte_size: number | null; metrics_json: string; delivery_hash: string | null;
        delivery_storage_ref: string | null };
      let sourcePath: string;
      try {
        optimization = database.prepare(`SELECT o.status,o.reason,o.output_byte_size,o.metrics_json,
            delivery.content_hash delivery_hash,delivery.storage_ref delivery_storage_ref
          FROM pdf_delivery_optimizations o
          LEFT JOIN artifacts delivery ON delivery.id=o.output_artifact_id
          WHERE o.source_artifact_id=?`).get(`artifact:pdf:${sourceHash}`) as typeof optimization;
        const source = database.prepare(`SELECT storage_ref FROM artifacts
          WHERE artifact_type='paper-pdf' AND content_hash=?`).get(sourceHash) as { storage_ref: string };
        sourcePath = join(layout.root, source.storage_ref);
      } finally { database.close(); }

      let sourceLinearized: boolean | null = null;
      try { sourceLinearized = await tool.isLinearized(sourcePath); } catch { /* Tool-unavailable is a measured result. */ }
      const metrics = JSON.parse(optimization.metrics_json) as { durationMs?: number; sizeRatio?: number };
      const pageCount = (workspace.json() as { pdf: { pageCount: number } }).pdf.pageCount;
      const renderedPages = optimization.delivery_hash && optimization.delivery_storage_ref
        ? await renderParitySamples(bytes, sourceHash,
          await readFile(join(layout.root, optimization.delivery_storage_ref)), optimization.delivery_hash, pageCount)
        : [];
      samples.push({ ...paper, sourceHash, sourceBytes: bytes.byteLength,
        pageCount,
        sourceLinearized, status: optimization.status, reason: optimization.reason,
        deliveryHash: optimization.delivery_hash, deliveryBytes: optimization.output_byte_size,
        sizeRatio: typeof metrics.sizeRatio === "number" ? metrics.sizeRatio : null,
        durationMs: typeof metrics.durationMs === "number" ? metrics.durationMs : null,
        renderedPages,
      });
    } finally {
      await app?.close();
      await rm(sampleRoot, { recursive: true, force: true });
    }
  }

  return {
    schemaVersion: 1,
    generatedAt: now().toISOString(),
    tool: { name: tool.name, version: toolVersion },
    parameters: LOSSLESS_LINEARIZATION_PARAMETERS,
    summary: {
      papers: samples.length,
      selected: samples.filter((sample) => sample.status === "selected").length,
      skipped: samples.filter((sample) => sample.status === "skipped").length,
      failed: samples.filter((sample) => sample.status === "failed").length,
      renderParityPassed: samples.every((sample) => sample.status !== "selected" ||
        (sample.renderedPages.length > 0 && sample.renderedPages.every((page) => page.matches))),
    },
    samples,
  };
}

async function renderParitySamples(sourceBytes: Uint8Array, sourceHash: string, deliveryBytes: Uint8Array,
  deliveryHash: string, pageCount: number): Promise<PdfDeliveryCorpusSample["renderedPages"]> {
  const pages = [...new Set([1, Math.ceil(pageCount / 2), pageCount])].sort((left, right) => left - right);
  const renderer = new PdfPageRenderer();
  const results: PdfDeliveryCorpusSample["renderedPages"] = [];
  for (const page of pages) {
    const source = await renderer.render({ artifactId: `benchmark:source:${sourceHash}`,
      contentHash: sourceHash, bytes: Buffer.from(sourceBytes) }, page);
    const delivery = await renderer.render({ artifactId: `benchmark:delivery:${deliveryHash}`,
      contentHash: deliveryHash, bytes: Buffer.from(deliveryBytes) }, page);
    results.push({ page, sourceImageHash: source.imageHash, deliveryImageHash: delivery.imageHash,
      matches: source.imageHash === delivery.imageHash });
  }
  return results;
}

async function waitForImport(app: Awaited<ReturnType<typeof createApp>>, importRequestId: string,
  paper: PdfDeliveryCorpusPaper): Promise<void> {
  for (let attempt = 0; attempt < 12_000; attempt += 1) {
    const status = await app.inject({ method: "GET", url: `/api/imports/${encodeURIComponent(importRequestId)}` });
    const job = (status.json() as { jobs: Array<{ state: string; error?: unknown }> }).jobs.at(-1);
    if (job?.state === "succeeded") return;
    if (job?.state === "failed") throw new Error(`corpus-import-failed:${paper.arxivId}v${paper.version}:${JSON.stringify(job.error)}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`corpus-import-timeout:${paper.arxivId}v${paper.version}`);
}
