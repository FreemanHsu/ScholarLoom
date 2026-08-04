import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createFixturePdf, createLargeFixturePdf } from "../src/adapters/fixture.js";
import { benchmarkPdfDeliveryCorpus } from "../src/benchmark/pdf-delivery-corpus.js";
import type { PdfLinearizationTool } from "../src/storage/pdf-delivery-optimizer.js";

describe("PDF delivery corpus benchmark", () => {
  it("reports a pinned small Paper Version fallback and removes its temporary data root", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "scholarloom-pdf-corpus-test-"));
    const bytes = await createFixturePdf();
    const tool: PdfLinearizationTool = {
      name: "fixture-qpdf",
      async version() { return "1.0.0"; },
      async isLinearized() { return false; },
      async linearize() { throw new Error("small PDF must not be linearized"); },
      async validate() { throw new Error("small PDF must not be validated"); },
    };

    const report = await benchmarkPdfDeliveryCorpus({
      runtimeRoot,
      corpus: [{
        arxivId: "1810.04805",
        version: 2,
        title: "BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding",
        authors: ["Jacob Devlin"],
        year: 2019,
        profile: "small-text-heavy",
        pdfUrl: "https://arxiv.org/pdf/1810.04805v2",
      }],
      fetchPdf: async () => bytes,
      tool,
      now: () => new Date("2026-08-05T00:00:00.000Z"),
    });

    expect(report).toMatchObject({
      schemaVersion: 1,
      generatedAt: "2026-08-05T00:00:00.000Z",
      tool: { name: "fixture-qpdf", version: "1.0.0" },
      summary: { papers: 1, selected: 0, skipped: 1, failed: 0, renderParityPassed: true },
      samples: [{
        arxivId: "1810.04805",
        version: 2,
        sourceHash: createHash("sha256").update(bytes).digest("hex"),
        sourceBytes: bytes.byteLength,
        pageCount: 2,
        sourceLinearized: false,
        status: "skipped",
        reason: "below-minimum-size",
        deliveryHash: null,
        deliveryBytes: null,
        sizeRatio: null,
        renderedPages: [],
      }],
    });
    expect(existsSync(join(runtimeRoot, "1810.04805v2"))).toBe(false);
    await rm(runtimeRoot, { recursive: true, force: true });
  }, 60_000);

  it("reports sampled-page render parity for a selected delivery Artifact", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "scholarloom-pdf-corpus-selected-test-"));
    const bytes = await createLargeFixturePdf();
    const tool: PdfLinearizationTool = {
      name: "fixture-qpdf",
      async version() { return "1.0.0"; },
      async isLinearized() { return false; },
      async linearize(inputPath, outputPath) {
        await writeFile(outputPath, Buffer.concat([await readFile(inputPath), Buffer.from("\n% linearized fixture\n")]));
      },
      async validate() { return true; },
    };

    const report = await benchmarkPdfDeliveryCorpus({
      runtimeRoot,
      corpus: [{
        arxivId: "2005.14165",
        version: 4,
        title: "Language Models are Few-Shot Learners",
        authors: ["Tom Brown"],
        year: 2020,
        profile: "long-text-and-tables",
        pdfUrl: "https://arxiv.org/pdf/2005.14165v4",
      }],
      fetchPdf: async () => bytes,
      tool,
      now: () => new Date("2026-08-05T00:00:00.000Z"),
    });

    expect(report.summary).toMatchObject({ papers: 1, selected: 1, skipped: 0, failed: 0, renderParityPassed: true });
    expect(report.samples[0]).toMatchObject({
      status: "selected",
      reason: "linearized",
      deliveryHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      deliveryBytes: bytes.byteLength + Buffer.byteLength("\n% linearized fixture\n"),
      renderedPages: [
        { page: 1, matches: true, sourceImageHash: expect.stringMatching(/^[0-9a-f]{64}$/),
          deliveryImageHash: expect.stringMatching(/^[0-9a-f]{64}$/) },
        { page: 2, matches: true, sourceImageHash: expect.stringMatching(/^[0-9a-f]{64}$/),
          deliveryImageHash: expect.stringMatching(/^[0-9a-f]{64}$/) },
      ],
    });
    await rm(runtimeRoot, { recursive: true, force: true });
  }, 60_000);
});
