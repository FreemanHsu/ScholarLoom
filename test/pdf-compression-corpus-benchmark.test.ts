import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createFixturePdf } from "../src/adapters/fixture.js";
import { benchmarkPdfCompressionCorpus, PDF_COMPRESSION_CORPUS } from "../src/benchmark/pdf-compression-corpus.js";
import type { PdfCompressionTool } from "../src/benchmark/ghostscript-ebook-tool.js";

describe("PDF compression corpus benchmark", () => {
  it("pins the six reviewed Paper Versions including Hunyuan3D v5", () => {
    expect(PDF_COMPRESSION_CORPUS).toHaveLength(6);
    expect(PDF_COMPRESSION_CORPUS.at(-1)).toMatchObject({
      arxivId: "2411.02293",
      version: 5,
      profile: "image-heavy-3d-generation",
      expectedSha256: "6467c327e68f48acf9d1d2bc11a7636c017359d0b0a140589262bf1c40c68def",
    });
  });

  it("rejects an equivalent candidate when it does not save at least 30 percent", async () => {
    const root = await mkdtemp(join(tmpdir(), "scholarloom-compression-corpus-"));
    const runtimeRoot = join(root, "runtime");
    const outputRoot = join(root, "output");
    const bytes = Buffer.from(await createFixturePdf());
    const imageBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAFAgIAC3+XGQAAAABJRU5ErkJggg==", "base64");
    const tool: PdfCompressionTool = {
      name: "fixture-pdfwrite",
      async version() { return "1.0.0"; },
      async compress(inputPath, outputPath) { await writeFile(outputPath, await readFile(inputPath)); },
    };

    try {
      const report = await benchmarkPdfCompressionCorpus({
        runtimeRoot,
        outputRoot,
        corpus: [{
          arxivId: "1706.03762",
          version: 7,
          title: "Attention Is All You Need",
          authors: ["Ashish Vaswani"],
          year: 2017,
          profile: "figures-and-two-column-text",
          pdfUrl: "https://arxiv.org/pdf/1706.03762v7",
          expectedSha256: createHash("sha256").update(bytes).digest("hex"),
        }],
        fetchPdf: async () => bytes,
        tool,
        validator: { name: "fixture-validator", async version() { return "1.0.0"; },
          async validate() { return true; } },
        renderer: { async render() { return { imageBytes }; } },
        now: () => new Date("2026-08-05T00:00:00.000Z"),
      });

      expect(report).toMatchObject({
        schemaVersion: 1,
        generatedAt: "2026-08-05T00:00:00.000Z",
        strategy: "ebook-compression",
        tool: { name: "fixture-pdfwrite", version: "1.0.0" },
        validator: { name: "fixture-validator", version: "1.0.0" },
        summary: { papers: 1, go: 0, noGo: 1, recommendation: "no-go" },
        samples: [{
          sourceBytes: bytes.length,
          outputBytes: bytes.length,
          sizeRatio: 1,
          savingsRatio: 0,
          deterministic: true,
          structureValid: true,
          qualityPassed: true,
          passesSizeGate: false,
          decision: "no-go",
          reasons: ["insufficient-size-reduction"],
        }],
      });
      expect(existsSync(join(outputRoot, "1706.03762v7", "compressed.pdf"))).toBe(true);
      expect(existsSync(join(runtimeRoot, "1706.03762v7"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
