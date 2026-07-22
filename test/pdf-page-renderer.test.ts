import { createHash } from "node:crypto";

import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { describe, expect, it } from "vitest";

import { PdfPageRenderer } from "../src/storage/pdf-page-renderer.js";

describe("PdfPageRenderer", () => {
  it("renders one requested page deterministically in an isolated child", async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    pdf.addPage([320, 240]).drawText("page one", { x: 24, y: 180, font });
    const page = pdf.addPage([320, 240]);
    page.drawRectangle({ x: 40, y: 40, width: 80, height: 140, color: rgb(1, 0.5, 0) });
    page.drawText("B", { x: 70, y: 20, font });
    const bytes = Buffer.from(await pdf.save({ useObjectStreams: false }));
    const sourceHash = createHash("sha256").update(bytes).digest("hex");
    const renderer = new PdfPageRenderer();

    const first = await renderer.render({ artifactId: "artifact:pdf:fixture", contentHash: sourceHash, bytes }, 2);
    const second = await renderer.render({ artifactId: "artifact:pdf:fixture", contentHash: sourceHash, bytes }, 2);

    expect(first.imageBytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(first.imageHash).toBe(createHash("sha256").update(first.imageBytes).digest("hex"));
    expect(second.imageHash).toBe(first.imageHash);
    expect(second.imageBytes).toEqual(first.imageBytes);
    expect(first.descriptor).toMatchObject({ page: 2, pageCount: 2, pixelWidth: 640, pixelHeight: 480,
      rendererName: "pdfjs-napi-canvas", rendererVersion: "6.1.200+1.0.2", isolation: "macos-seatbelt" });
  });
});
