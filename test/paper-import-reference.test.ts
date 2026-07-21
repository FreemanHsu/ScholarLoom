import { describe, expect, it } from "vitest";

import { parsePaperImportReference } from "../src/domain/paper-import-reference.js";

describe("PaperImportReference", () => {
  it("classifies an HTTPS PDF URL without changing arXiv parsing", () => {
    expect(parsePaperImportReference("https://research.nvidia.com/labs/lpr/locate-anything/LocateAnything.pdf"))
      .toEqual({ kind: "direct-pdf", originalUrl: "https://research.nvidia.com/labs/lpr/locate-anything/LocateAnything.pdf",
        normalizedUrl: "https://research.nvidia.com/labs/lpr/locate-anything/LocateAnything.pdf" });
    expect(parsePaperImportReference("https://arxiv.org/pdf/2401.12345v2.pdf"))
      .toEqual({ kind: "arxiv", arxivId: "2401.12345", explicitVersion: 2 });
  });

  it.each([
    "http://papers.example.test/paper.pdf",
    "file:///tmp/paper.pdf",
    "https://user:secret@papers.example.test/paper.pdf",
    "https://papers.example.test/landing",
    "https://papers.example.test/index.html",
  ])("rejects unsupported or credential-bearing reference %s", (reference) => {
    expect(parsePaperImportReference(reference)).toBeNull();
  });
});
