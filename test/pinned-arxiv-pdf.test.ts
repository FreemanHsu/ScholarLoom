import { describe, expect, it } from "vitest";

import type { PdfDeliveryCorpusPaper } from "../src/benchmark/pdf-delivery-corpus.js";
import { downloadPinnedArxivPdf } from "../src/benchmark/pinned-arxiv-pdf.js";

const paper = {
  arxivId: "1706.03762",
  version: 7,
  title: "Attention Is All You Need",
  authors: ["Ashish Vaswani"],
  year: 2017,
  profile: "figures-and-two-column-text",
  pdfUrl: "https://arxiv.org/pdf/1706.03762v7",
} satisfies PdfDeliveryCorpusPaper;

describe("pinned arXiv PDF downloader", () => {
  it("downloads only the exact pinned Paper Version URL", async () => {
    let requestedUrl: string | URL | Request | null = null;
    const bytes = new TextEncoder().encode("%PDF-fixture");
    const fetchPdf = (async (input: string | URL | Request) => {
      requestedUrl = input;
      return responseAt(paper.pdfUrl, bytes);
    }) as typeof fetch;

    await expect(downloadPinnedArxivPdf(paper, fetchPdf)).resolves.toEqual(Buffer.from(bytes));
    expect(requestedUrl).toBe(paper.pdfUrl);
  });

  it("rejects an unpinned manifest URL before fetching", async () => {
    let fetched = false;
    const fetchPdf = (async () => {
      fetched = true;
      return responseAt(paper.pdfUrl, new Uint8Array());
    }) as typeof fetch;

    await expect(downloadPinnedArxivPdf({ ...paper, pdfUrl: `${paper.pdfUrl}?download=1` }, fetchPdf))
      .rejects.toThrow("corpus-source-url-unpinned:1706.03762");
    expect(fetched).toBe(false);
  });

  it("rejects a redirect outside the arXiv HTTPS origin family", async () => {
    const fetchPdf = (async () => responseAt(paper.pdfUrl, new Uint8Array(), {
      location: "https://example.com/paper.pdf",
    }, 302)) as typeof fetch;

    await expect(downloadPinnedArxivPdf(paper, fetchPdf))
      .rejects.toThrow("corpus-source-redirect-invalid:1706.03762v7");
  });

  it("rejects an oversized declared response without reading its body", async () => {
    let bodyRead = false;
    const response = responseAt(paper.pdfUrl, new Uint8Array(), {
      "content-length": String(128 * 1024 * 1024 + 1),
    });
    Object.defineProperty(response, "arrayBuffer", { value: async () => {
      bodyRead = true;
      return new ArrayBuffer(0);
    } });
    const fetchPdf = (async () => response) as typeof fetch;

    await expect(downloadPinnedArxivPdf(paper, fetchPdf))
      .rejects.toThrow("corpus-source-too-large:1706.03762v7");
    expect(bodyRead).toBe(false);
  });

  it("stops an undeclared streaming response as soon as it crosses the byte limit", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3, 4]));
        controller.enqueue(new Uint8Array([5, 6, 7, 8]));
      },
      cancel() { cancelled = true; },
    });
    const response = new Response(stream, { status: 200 });
    Object.defineProperty(response, "url", { value: paper.pdfUrl });
    const fetchPdf = (async () => response) as typeof fetch;

    await expect(downloadPinnedArxivPdf(paper, fetchPdf, 5))
      .rejects.toThrow("corpus-source-too-large:1706.03762v7");
    expect(cancelled).toBe(true);
  });
});

function responseAt(url: string, bytes: Uint8Array, headers?: HeadersInit, status = 200): Response {
  const body = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(body).set(bytes);
  const response = new Response(body, { status, ...(headers ? { headers } : {}) });
  Object.defineProperty(response, "url", { value: url });
  return response;
}
