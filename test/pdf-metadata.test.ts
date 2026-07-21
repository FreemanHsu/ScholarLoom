import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";

import { PdfMetadataExtractor } from "../src/adapters/pdf-metadata.js";

async function metadataPdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle("Locate Anything on Earth");
  pdf.setAuthor("Junyan Zhu; Ada Researcher");
  pdf.setCreationDate(new Date("2025-01-02T00:00:00.000Z"));
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage().drawText("Locate Anything on Earth", { x: 40, y: 700, font });
  return pdf.save();
}

describe("PdfMetadataExtractor", () => {
  it("extracts complete embedded metadata without guessing from the filename", async () => {
    await expect(new PdfMetadataExtractor().extract(await metadataPdf())).resolves.toEqual({
      title: "Locate Anything on Earth",
      authors: ["Junyan Zhu", "Ada Researcher"],
      year: 2025,
    });
  });

  it("uses structured first-page text as a fallback", async () => {
    const pdf = await PDFDocument.create();
    pdf.setCreationDate(new Date("2024-01-01T00:00:00.000Z"));
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const page = pdf.addPage();
    page.drawText("A Reliable Paper Title", { x: 40, y: 720, font, size: 18 });
    page.drawText("Ada Researcher and Junyan Zhu", { x: 40, y: 690, font, size: 11 });
    page.drawText("Proceedings of FixtureConf 2024", { x: 40, y: 660, font, size: 10 });
    await expect(new PdfMetadataExtractor().extract(await pdf.save())).resolves.toEqual({
      title: "A Reliable Paper Title", authors: ["Ada Researcher", "Junyan Zhu"], year: 2024,
    });
  });

  it("joins a multi-line title block and the following author lines", async () => {
    const pdf = await PDFDocument.create();
    pdf.setCreationDate(new Date("2026-05-27T00:00:00.000Z"));
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const page = pdf.addPage();
    page.drawText("LocateAnything: Fast and High-Quality Vision-Language", { x: 40, y: 740, font, size: 17 });
    page.drawText("Grounding with Parallel Box Decoding", { x: 40, y: 718, font, size: 17 });
    page.drawText("Shihao Wang, Shilong Liu, Yuanguo Kuang", { x: 40, y: 682, font, size: 9 });
    page.drawText("Andrew Tao, Guilin Liu, Jan Kautz", { x: 40, y: 668, font, size: 9 });
    page.drawText("Links: Project Page", { x: 40, y: 645, font, size: 10 });

    await expect(new PdfMetadataExtractor().extract(await pdf.save())).resolves.toEqual({
      title: "LocateAnything: Fast and High-Quality Vision-Language Grounding with Parallel Box Decoding",
      authors: ["Shihao Wang", "Shilong Liu", "Yuanguo Kuang", "Andrew Tao", "Guilin Liu", "Jan Kautz"],
      year: 2026,
    });
  });

  it("reports exact missing fields instead of inventing metadata", async () => {
    const pdf = await PDFDocument.create();
    pdf.setTitle("Title Only");
    pdf.addPage();
    await expect(new PdfMetadataExtractor().extract(await pdf.save())).rejects.toMatchObject({
      code: "paper-metadata-incomplete", message: expect.stringContaining("authors"),
    });
  });

  it("rejects damaged PDF bytes", async () => {
    await expect(new PdfMetadataExtractor().extract(new TextEncoder().encode("%PDF-damaged"))).rejects.toMatchObject({
      code: "paper-source-invalid-pdf",
    });
  });
});
