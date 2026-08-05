import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PDFDocument, PDFName, PDFString, StandardFonts } from "pdf-lib";
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

  it("detects a MediaBox change even when the effective CropBox stays identical", async () => {
    const sourceBytes = Buffer.from(await createFixturePdf());
    const changed = await PDFDocument.load(sourceBytes);
    const page = changed.getPage(0);
    const mediaBox = page.getMediaBox();
    page.setCropBox(mediaBox.x, mediaBox.y, mediaBox.width, mediaBox.height);
    page.setMediaBox(mediaBox.x, mediaBox.y, mediaBox.width + 10, mediaBox.height + 10);
    const outputBytes = Buffer.from(await changed.save());
    const imageBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAFAgIAC3+XGQAAAABJRU5ErkJggg==", "base64");

    const audit = await auditPdfCompression({
      sourceBytes,
      outputBytes,
      sourceHash: createHash("sha256").update(sourceBytes).digest("hex"),
      outputHash: createHash("sha256").update(outputBytes).digest("hex"),
      renderer: { async render() { return { imageBytes }; } },
    });

    expect(audit.geometryMatches).toBe(false);
    expect(audit.passes).toBe(false);
  }, 60_000);

  it("detects changed attachment bytes even when the attachment name is unchanged", async () => {
    const sourceBytes = await attachedPdf("source payload");
    const outputBytes = await attachedPdf("changed payload");
    const imageBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAFAgIAC3+XGQAAAABJRU5ErkJggg==", "base64");

    const audit = await auditPdfCompression({
      sourceBytes,
      outputBytes,
      sourceHash: createHash("sha256").update(sourceBytes).digest("hex"),
      outputHash: createHash("sha256").update(outputBytes).digest("hex"),
      renderer: { async render() { return { imageBytes }; } },
    });

    expect(audit.structuredContentMatches).toBe(false);
    expect(audit.passes).toBe(false);
  }, 60_000);

  it("detects changed annotation appearance semantics", async () => {
    const sourceBytes = await annotatedPdf([1, 0, 0]);
    const outputBytes = await annotatedPdf([0, 0, 1]);
    const imageBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAFAgIAC3+XGQAAAABJRU5ErkJggg==", "base64");

    const audit = await auditPdfCompression({
      sourceBytes,
      outputBytes,
      sourceHash: createHash("sha256").update(sourceBytes).digest("hex"),
      outputHash: createHash("sha256").update(outputBytes).digest("hex"),
      renderer: { async render() { return { imageBytes }; } },
    });

    expect(audit.annotationMatches).toBe(false);
    expect(audit.passes).toBe(false);
  }, 60_000);
});

async function attachedPdf(payload: string): Promise<Buffer> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  document.addPage([300, 300]).drawText("same visible page", { x: 40, y: 240, font });
  await document.attach(Buffer.from(payload), "supplement.bin", {
    mimeType: "application/octet-stream",
    description: "fixed supplement",
    creationDate: new Date("2026-08-05T00:00:00.000Z"),
    modificationDate: new Date("2026-08-05T00:00:00.000Z"),
  });
  return Buffer.from(await document.save());
}

async function annotatedPdf(color: [number, number, number]): Promise<Buffer> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const page = document.addPage([300, 300]);
  page.drawText("same linked text", { x: 40, y: 240, font });
  const link = document.context.register(document.context.obj({
    Type: "Annot",
    Subtype: "Link",
    Rect: [35, 235, 150, 255],
    Border: [0, 0, 1],
    C: color,
    A: { Type: "Action", S: "URI", URI: PDFString.of("https://example.test/paper") },
  }));
  page.node.set(PDFName.of("Annots"), document.context.obj([link]));
  return Buffer.from(await document.save());
}
