import { dirname, join } from "node:path";
import { createRequire } from "node:module";

import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

import { PaperSourceError } from "./safe-pdf-downloader.js";

const standardFontDataUrl = `${join(dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json")), "standard_fonts")}/`;

export type PaperMetadata = { title: string; authors: string[]; year: number };

export class PdfMetadataExtractor {
  async extract(input: Uint8Array): Promise<PaperMetadata> {
    try {
      const document = await getDocument({ data: new Uint8Array(input), standardFontDataUrl }).promise;
      const raw = (await document.getMetadata()).info as Record<string, unknown>;
      const firstPage = await document.getPage(1);
      const content = await firstPage.getTextContent();
      const structuredLines = content.items.filter((item): item is typeof item & { str: string; transform: number[] } => "str" in item)
        .map((item) => ({ text: item.str.trim(), y: Math.round(item.transform[5] ?? 0), size: Math.abs(item.transform[0] ?? 0) })).filter((item) => item.text)
        .reduce<Array<{ text: string; y: number; size: number }>>((result, item) => {
          const line = result.find((candidate) => Math.abs(candidate.y - item.y) <= 2);
          if (line) { line.text += ` ${item.text}`; line.size = Math.max(line.size, item.size); } else result.push({ ...item });
          return result;
        }, []).sort((a, b) => b.y - a.y);
      const lines = structuredLines.map((line) => line.text.replace(/\s+/g, " ").trim());
      const title = cleanString(raw.Title) ?? inferTitle(structuredLines);
      const authors = splitAuthors(cleanString(raw.Author) ?? inferAuthors(structuredLines));
      const year = extractYear(cleanString(raw.CreationDate)) ?? extractYear(lines.slice(0, 12).join(" "));
      const missing = [!title && "title", authors.length === 0 && "authors", !year && "year"].filter(Boolean);
      if (missing.length) throw new PaperSourceError("paper-metadata-incomplete", `缺少 metadata 字段：${missing.join(", ")}`);
      return { title: title!, authors, year: year! };
    } catch (error) {
      if (error instanceof PaperSourceError) throw error;
      throw new PaperSourceError("paper-source-invalid-pdf");
    }
  }
}

function cleanString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.replace(/\s+/g, " ").trim() : null;
}

function splitAuthors(value: string | null): string[] {
  if (!value) return [];
  return value.split(/\s*(?:;|\band\b)\s*/i).map((author) => author.trim()).filter(Boolean);
}

function extractYear(value: string | null): number | null {
  const match = value?.match(/(?:D:)?((?:19|20)\d{2})/);
  return match ? Number(match[1]) : null;
}

function inferAuthors(lines: Array<{ text: string; y: number; size: number }>): string | null {
  const titleBlock = selectTitleBlock(lines);
  if (!titleBlock.length) return null;
  const titleSize = Math.max(...titleBlock.map((line) => line.size));
  const titleBottom = Math.min(...titleBlock.map((line) => line.y));
  const authorLines: string[] = [];
  for (const line of lines.filter((candidate) => candidate.y < titleBottom)) {
    if (/^(?:links?|abstract|introduction|proceedings|university|institute)\b/i.test(line.text) || /\b(?:university|institute)\b/i.test(line.text)) break;
    if (line.size < titleSize * 0.45 || line.size > titleSize * 0.75) continue;
    authorLines.push(line.text.replace(/[†*]/g, "").replace(/\s+/g, " ").trim());
    if (authorLines.length === 3) break;
  }
  const names = authorLines.join(", ").split(/\s*(?:,|;|\band\b)\s*/i).map((name) => name.replace(/^\d+|\d+$/g, "").trim()).filter(Boolean);
  return names.length >= 1 && names.length <= 20 ? names.join("; ") : null;
}

function inferTitle(lines: Array<{ text: string; y: number; size: number }>): string | null {
  const titleBlock = selectTitleBlock(lines);
  if (!titleBlock.length) return null;
  const title = titleBlock.map((line) => line.text).join(" ").replace(/\s+/g, " ").trim();
  return title.length >= 8 ? title : null;
}

function selectTitleBlock(lines: Array<{ text: string; y: number; size: number }>): Array<{ text: string; y: number; size: number }> {
  const candidates = lines.slice(0, 8);
  if (!candidates.length) return [];
  const maxSize = Math.max(...candidates.map((line) => line.size));
  const start = candidates.findIndex((line) => line.size >= maxSize * 0.95);
  if (start < 0 || start > 2) return [];
  const block: typeof candidates = [];
  for (const line of candidates.slice(start)) {
    if (line.size < maxSize * 0.95) break;
    block.push(line);
  }
  const runnerUp = Math.max(0, ...candidates.filter((line) => !block.includes(line)).map((line) => line.size));
  return runnerUp > 0 && maxSize < runnerUp * 1.2 ? [] : block;
}
