import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  benchmarkPdfDeliveryCorpus,
  PDF_DELIVERY_CORPUS,
} from "./pdf-delivery-corpus.js";
import { downloadPinnedArxivPdf } from "./pinned-arxiv-pdf.js";

const outputPath = join(process.cwd(), "output", "pdf-delivery-corpus", "report.json");
const runtimeRoot = await mkdtemp(join(tmpdir(), "scholarloom-pdf-delivery-corpus-"));
let previousDownloadAt = 0;

try {
  const report = await benchmarkPdfDeliveryCorpus({
    runtimeRoot,
    corpus: PDF_DELIVERY_CORPUS,
    fetchPdf: async (paper) => {
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
