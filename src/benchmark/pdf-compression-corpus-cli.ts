import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  benchmarkPdfCompressionCorpus,
  PDF_COMPRESSION_CORPUS,
  QpdfStructureValidator,
} from "./pdf-compression-corpus.js";
import { GhostscriptEbookTool } from "./ghostscript-ebook-tool.js";
import { downloadPinnedArxivPdf } from "./pinned-arxiv-pdf.js";

const outputRoot = join(process.cwd(), "output", "pdf", "ghostscript-ebook");
const outputPath = join(outputRoot, "report.json");
const localCorpusRoot = process.env.SCHOLARLOOM_PDF_CORPUS_DIR
  ? resolve(process.env.SCHOLARLOOM_PDF_CORPUS_DIR) : null;
const requestedKeys = new Set((process.env.SCHOLARLOOM_PDF_CORPUS_FILTER ?? "")
  .split(",").map((value) => value.trim()).filter(Boolean));
const corpus = requestedKeys.size === 0 ? PDF_COMPRESSION_CORPUS
  : PDF_COMPRESSION_CORPUS.filter((paper) => requestedKeys.has(`${paper.arxivId}v${paper.version}`));
if (corpus.length !== (requestedKeys.size || PDF_COMPRESSION_CORPUS.length)) {
  throw new Error("pdf-compression-corpus-filter-invalid");
}
const runtimeRoot = await mkdtemp(join(tmpdir(), "scholarloom-pdf-compression-corpus-"));
let previousDownloadAt = 0;

try {
  const report = await benchmarkPdfCompressionCorpus({
    runtimeRoot,
    outputRoot,
    corpus,
    tool: new GhostscriptEbookTool(),
    validator: new QpdfStructureValidator(),
    fetchPdf: async (paper) => {
      if (localCorpusRoot) {
        const localPath = join(localCorpusRoot, `${paper.arxivId}v${paper.version}.pdf`);
        try { return await readFile(localPath); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      const delayMs = Math.max(0, 1_000 - (Date.now() - previousDownloadAt));
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      const bytes = await downloadPinnedArxivPdf(paper);
      previousDownloadAt = Date.now();
      return bytes;
    },
  });
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${outputPath}\n`);
} finally {
  await rm(runtimeRoot, { recursive: true, force: true });
}
