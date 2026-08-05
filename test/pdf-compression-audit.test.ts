import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";

import { createFixturePdf } from "../src/adapters/fixture.js";
import { auditPdfCompression } from "../src/benchmark/pdf-compression-audit.js";

describe("PDF compression quality audit", () => {
  it("accepts equivalent document semantics and sampled renders", async () => {
    const renderRoot = await mkdtemp(join(tmpdir(), "scholarloom-compression-audit-"));
    const sourceBytes = Buffer.from(await createFixturePdf());
    const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
    const imageBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAFAgIAC3+XGQAAAABJRU5ErkJggg==", "base64");

    try {
      const audit = await auditPdfCompression({
        sourceBytes,
        outputBytes: sourceBytes,
        sourceHash,
        outputHash: sourceHash,
        renderRoot,
        renderer: { async render() { return { imageBytes }; } },
      });

      expect(audit).toMatchObject({
        passes: true,
        pageCount: { source: 2, output: 2, matches: true },
        geometryMatches: true,
        normalizedTextMatches: true,
        outlineMatches: true,
        annotationMatches: true,
        structuredContentMatches: true,
        sampledPages: [
          { page: 1, ssim: 1, passes: true },
          { page: 2, ssim: 1, passes: true },
        ],
      });
      expect(existsSync(join(renderRoot, "page-001-source.png"))).toBe(true);
      expect(existsSync(join(renderRoot, "page-001-output.png"))).toBe(true);
    } finally {
      await rm(renderRoot, { recursive: true, force: true });
    }
  }, 60_000);

  it("fails closed when normalized document text changes even if sampled pixels match", async () => {
    const sourceBytes = Buffer.from(await createFixturePdf());
    const changed = await PDFDocument.load(sourceBytes);
    const font = await changed.embedFont(StandardFonts.Helvetica);
    changed.getPage(0).drawText("changed semantic content", { x: 40, y: 680, font, size: 12 });
    const outputBytes = Buffer.from(await changed.save());
    const imageBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAFAgIAC3+XGQAAAABJRU5ErkJggg==", "base64");

    const audit = await auditPdfCompression({
      sourceBytes,
      outputBytes,
      sourceHash: createHash("sha256").update(sourceBytes).digest("hex"),
      outputHash: createHash("sha256").update(outputBytes).digest("hex"),
      renderer: { async render() { return { imageBytes }; } },
    });

    expect(audit.normalizedTextMatches).toBe(false);
    expect(audit.sampledPages.every((sample) => sample.ssim === 1)).toBe(true);
    expect(audit.passes).toBe(false);
  }, 60_000);
});
