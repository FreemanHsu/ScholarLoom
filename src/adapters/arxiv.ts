import type { PaperSource, ResolvedPaper } from "../app.js";
import { PaperSourceError } from "./safe-pdf-downloader.js";

const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);
const RETRYABLE_PAPER_SOURCE_CODES = new Set([
  "paper-source-timeout", "paper-source-dns-failed", "paper-source-transport-error",
]);
const USER_AGENT = "ScholarLoom/0.1 (personal research ingestion)";
const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 3_000;
const RETRY_JITTER_MS = 1_000;
const MAX_RETRY_DELAY_MS = 30_000;
const METADATA_REQUEST_INTERVAL_MS = 3_000;
const METADATA_TIMEOUT_MS = 15_000;
const PDF_TIMEOUT_MS = 120_000;

type ArxivPaperSourceOptions = {
  fetch?: typeof globalThis.fetch;
  pdfDownloader?: { download(input: string): Promise<{ bytes: Uint8Array }> };
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
};

class ArxivHttpError extends Error {
  constructor(readonly status: number, readonly retryAfterMs: number | null) {
    super(`paper-source-unavailable:${status}`);
  }
}

class ArxivRequestTimeoutError extends Error {
  constructor() { super("paper-source-unavailable:timeout"); }
}

export class ArxivPaperSource implements PaperSource {
  readonly #fetch: typeof globalThis.fetch;
  readonly #pdfDownloader: { download(input: string): Promise<{ bytes: Uint8Array }> } | undefined;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #random: () => number;
  readonly #now: () => number;
  #metadataQueue: Promise<void> = Promise.resolve();
  #nextMetadataRequestAt: number | null = null;

  constructor(options: ArxivPaperSourceOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#pdfDownloader = options.pdfDownloader;
    this.#sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.#random = options.random ?? Math.random;
    this.#now = options.now ?? Date.now;
  }

  async resolve(arxivId: string): Promise<ResolvedPaper> {
    return this.#withRetry(() => this.#scheduleMetadataRequest(() => this.#withTimeout(METADATA_TIMEOUT_MS, async (signal) => {
      const response = await this.#request(
        `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(arxivId)}`, signal);
      const xml = await response.text();
      const entry = xml.match(/<entry>([\s\S]*?)<\/entry>/)?.[1];
      const title = entry?.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.replace(/\s+/g, " ").trim();
      const resolvedId = entry?.match(/<id>[^<]*\/abs\/([^<]+)<\/id>/)?.[1];
      const authors = [...(entry?.matchAll(/<author>([\s\S]*?)<\/author>/g) ?? [])]
        .map((match) => match[1]?.match(/<name>([\s\S]*?)<\/name>/)?.[1]?.replace(/\s+/g, " ").trim())
        .filter((author): author is string => Boolean(author));
      const year = Number.parseInt(entry?.match(/<published>(\d{4})-/)?.[1] ?? "", 10);
      if (!entry || !title || !resolvedId || !authors.length || !Number.isInteger(year)) throw new Error("paper-source-unavailable:not-found");
      const versionMatch = resolvedId.match(/v(\d+)$/);
      return { arxivId, latestVersion: versionMatch ? Number.parseInt(versionMatch[1]!, 10) : 1, title, authors, year };
    })));
  }

  async fetchPdf(arxivId: string, version: number): Promise<Uint8Array> {
    const url = `https://arxiv.org/pdf/${encodeURIComponent(arxivId)}v${version}`;
    if (this.#pdfDownloader) return this.#withRetry(async () => (await this.#pdfDownloader!.download(url)).bytes);
    return this.#withRetry(() => this.#withTimeout(PDF_TIMEOUT_MS, async (signal) => {
      const response = await this.#request(url, signal);
      const type = response.headers.get("content-type") ?? "";
      if (!type.includes("pdf")) throw new Error("paper-source-invalid-pdf");
      return new Uint8Array(await response.arrayBuffer());
    }));
  }

  async #withRetry<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try { return await operation(); }
      catch (error) {
        const retryableHttp = error instanceof ArxivHttpError && RETRYABLE_STATUS_CODES.has(error.status);
        const retryableTransport = error instanceof TypeError || error instanceof ArxivRequestTimeoutError;
        const retryablePaperSource = error instanceof PaperSourceError &&
          (RETRYABLE_PAPER_SOURCE_CODES.has(error.code) ||
            (error.code === "paper-source-http-error" && error.httpStatus !== undefined &&
              RETRYABLE_STATUS_CODES.has(error.httpStatus)));
        if ((!retryableHttp && !retryableTransport && !retryablePaperSource) || attempt >= MAX_ATTEMPTS - 1) throw error;
        const backoffMs = RETRY_BACKOFF_MS * (2 ** attempt);
        const jitterMs = Math.floor(this.#random() * RETRY_JITTER_MS);
        const delayMs = Math.max(backoffMs + jitterMs, error instanceof ArxivHttpError ? error.retryAfterMs ?? 0 : 0);
        if (delayMs > MAX_RETRY_DELAY_MS) throw error;
        await this.#sleep(delayMs);
      }
    }
  }

  async #withTimeout<T>(timeoutMs: number, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new ArxivRequestTimeoutError();
        controller.abort(error);
        reject(error);
      }, timeoutMs);
    });
    try { return await Promise.race([operation(controller.signal), timeout]); }
    finally { if (timer) clearTimeout(timer); }
  }

  #scheduleMetadataRequest<T>(operation: () => Promise<T>): Promise<T> {
    const scheduled = this.#metadataQueue.then(async () => {
      const now = this.#now();
      const earliestStart = this.#nextMetadataRequestAt ?? now;
      const waitMs = Math.max(0, earliestStart - now);
      if (waitMs > 0) await this.#sleep(waitMs);
      this.#nextMetadataRequestAt = Math.max(this.#now(), earliestStart) + METADATA_REQUEST_INTERVAL_MS;
      return operation();
    });
    this.#metadataQueue = scheduled.then(() => undefined, () => undefined);
    return scheduled;
  }

  async #request(url: string, signal: AbortSignal): Promise<Response> {
    const response = await this.#fetch(url, { headers: { "user-agent": USER_AGENT }, signal });
    if (!response.ok) throw new ArxivHttpError(response.status,
      retryAfterMilliseconds(response.headers.get("retry-after"), this.#now()));
    return response;
  }
}

function retryAfterMilliseconds(value: string | null, now: number): number | null {
  if (!value) return null;
  if (/^\d+$/.test(value.trim())) return Number.parseInt(value, 10) * 1_000;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : null;
}
