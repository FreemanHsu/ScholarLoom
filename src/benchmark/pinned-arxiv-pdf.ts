import type { PdfDeliveryCorpusPaper } from "./pdf-delivery-corpus.js";

const maximumPdfBytes = 128 * 1024 * 1024;
const maximumRedirects = 5;
const redirectStatuses = new Set([301, 302, 303, 307, 308]);

export async function downloadPinnedArxivPdf(paper: PdfDeliveryCorpusPaper,
  fetchPdf: typeof fetch = fetch): Promise<Uint8Array> {
  const expectedUrl = `https://arxiv.org/pdf/${paper.arxivId}v${paper.version}`;
  if (paper.pdfUrl !== expectedUrl) throw new Error(`corpus-source-url-unpinned:${paper.arxivId}`);
  let currentUrl = paper.pdfUrl;
  const signal = AbortSignal.timeout(120_000);

  for (let redirect = 0; redirect <= maximumRedirects; redirect += 1) {
    assertArxivResponse(currentUrl, paper);
    const response = await fetchPdf(currentUrl, {
      redirect: "manual",
      signal,
      headers: { "user-agent": "ScholarLoom-PDF-Delivery-Benchmark/1.0 (local research corpus)" },
    });
    if (redirectStatuses.has(response.status)) {
      const location = response.headers.get("location");
      if (!location || redirect === maximumRedirects) {
        throw new Error(`corpus-source-redirect-invalid:${paper.arxivId}v${paper.version}`);
      }
      currentUrl = new URL(location, currentUrl).toString();
      assertArxivResponse(currentUrl, paper);
      continue;
    }
    if (!response.ok) throw new Error(`corpus-source-http-${response.status}:${paper.arxivId}v${paper.version}`);
    if (response.url) assertArxivResponse(response.url, paper);
    const declaredBytes = Number(response.headers.get("content-length") ?? "0");
    if (declaredBytes > maximumPdfBytes) throw new Error(`corpus-source-too-large:${paper.arxivId}v${paper.version}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maximumPdfBytes) throw new Error(`corpus-source-too-large:${paper.arxivId}v${paper.version}`);
    return bytes;
  }
  throw new Error(`corpus-source-redirect-invalid:${paper.arxivId}v${paper.version}`);
}

function assertArxivResponse(responseUrl: string, paper: PdfDeliveryCorpusPaper): void {
  const url = new URL(responseUrl);
  if (url.protocol !== "https:" || !(url.hostname === "arxiv.org" || url.hostname.endsWith(".arxiv.org"))) {
    throw new Error(`corpus-source-redirect-invalid:${paper.arxivId}v${paper.version}`);
  }
}
