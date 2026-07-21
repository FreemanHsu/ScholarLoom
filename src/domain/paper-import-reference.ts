import { parseArxivReference, type ArxivReference } from "./arxiv.js";

export type DirectPdfReference = {
  kind: "direct-pdf";
  originalUrl: string;
  normalizedUrl: string;
};

export type PaperImportReference = ({ kind: "arxiv" } & ArxivReference) | DirectPdfReference;

export function parsePaperImportReference(input: string): PaperImportReference | null {
  const value = input.trim();
  const arxiv = parseArxivReference(value);
  if (arxiv) return { kind: "arxiv", ...arxiv };

  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || !/\.pdf$/i.test(url.pathname)) return null;
    url.hash = "";
    return { kind: "direct-pdf", originalUrl: value, normalizedUrl: url.toString() };
  } catch {
    return null;
  }
}
