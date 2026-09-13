import type { PaperSource, ResolvedPaper } from "../app.js";
import {
  isPublicAddress,
  isRetryableConnectivityError,
  PaperSourceError,
  resolvePublicAddresses,
  type PdfTransport,
} from "./safe-pdf-downloader.js";

const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);
const USER_AGENT = "ScholarLoom/0.1 (personal research ingestion)";
const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 3_000;
const RETRY_JITTER_MS = 1_000;
const MAX_RETRY_DELAY_MS = 30_000;
const METADATA_REQUEST_INTERVAL_MS = 3_000;
const METADATA_TIMEOUT_MS = 15_000;
const METADATA_CONNECT_TIMEOUT_MS = 10_000;
const METADATA_MAX_BYTES = 2 * 1024 * 1024;
const PDF_TIMEOUT_MS = 120_000;

type ArxivPaperSourceOptions = {
  fetch?: typeof globalThis.fetch;
  metadataProxyTransport?: PdfTransport;
  pdfDownloader?: { download(input: string): Promise<{ bytes: Uint8Array }> };
  resolve?: (hostname: string) => Promise<string[]>;
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
  readonly #metadataProxyTransport: PdfTransport | undefined;
  readonly #pdfDownloader: { download(input: string): Promise<{ bytes: Uint8Array }> } | undefined;
  readonly #resolve: (hostname: string) => Promise<string[]>;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #random: () => number;
  readonly #now: () => number;
  #metadataQueue: Promise<void> = Promise.resolve();
  #nextMetadataRequestAt: number | null = null;

  constructor(options: ArxivPaperSourceOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#metadataProxyTransport = options.metadataProxyTransport;
    this.#pdfDownloader = options.pdfDownloader;
    this.#resolve = options.resolve ?? resolvePublicAddresses;
    this.#sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.#random = options.random ?? Math.random;
    this.#now = options.now ?? Date.now;
  }

  async resolve(arxivId: string): Promise<ResolvedPaper> {
    try { return await this.#resolveApi(arxivId); }
    catch (error) {
      if (!canUseAbstractFallback(error)) throw error;
      return this.#scheduleMetadataRequest(() => this.#withTimeout(METADATA_TIMEOUT_MS, async (signal) => {
        const response = await this.#request(`https://arxiv.org/abs/${arxivId}`, signal, true);
        return parseAbstractMetadata(await readMetadataBody(response), arxivId);
      }));
    }
  }

  async #resolveApi(arxivId: string): Promise<ResolvedPaper> {
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
          (error.retryable === true || (error.code === "paper-source-http-error" &&
            error.httpStatus !== undefined && RETRYABLE_STATUS_CODES.has(error.httpStatus)));
        if ((!retryableHttp && !retryableTransport && !retryablePaperSource) || attempt >= MAX_ATTEMPTS - 1) throw error;
        const backoffMs = RETRY_BACKOFF_MS * (2 ** attempt);
        const jitterMs = Math.floor(this.#random() * RETRY_JITTER_MS);
        const retryAfterMs = error instanceof ArxivHttpError ? error.retryAfterMs ?? 0 :
          error instanceof PaperSourceError ? error.retryAfterMs ?? 0 : 0;
        const delayMs = Math.max(backoffMs + jitterMs, retryAfterMs);
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

  async #request(url: string, signal: AbortSignal, abstractPage = false): Promise<Response> {
    let response: Response;
    try {
      response = await this.#fetch(url, { headers: { "user-agent": USER_AGENT }, signal, ...(abstractPage ? { redirect: "error" as const } : {}) });
    } catch (error) {
      if (!this.#metadataProxyTransport || signal.aborted || !isRetryableFetchConnectivityError(error)) throw error;
      response = await this.#requestMetadataThroughProxy(new URL(url), signal);
    }
    if (!response.ok) throw new ArxivHttpError(response.status,
      retryAfterMilliseconds(response.headers.get("retry-after"), this.#now()));
    return response;
  }

  async #requestMetadataThroughProxy(url: URL, signal: AbortSignal): Promise<Response> {
    let addresses: string[];
    try { addresses = await this.#resolve(url.hostname); }
    catch {
      if (signal.aborted) throw signal.reason;
      throw new PaperSourceError("paper-source-dns-failed", undefined, { retryable: true });
    }
    if (!addresses.length || addresses.some((address) => !isPublicAddress(address))) {
      throw new PaperSourceError("unsafe-source-url");
    }

    let lastError: unknown;
    for (const address of addresses) {
      try {
        const result = await this.#metadataProxyTransport!.request({
          url,
          address,
          connectTimeoutMs: METADATA_CONNECT_TIMEOUT_MS,
          signal,
          headers: { accept: "text/html, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8" },
        });
        const chunks: Uint8Array[] = [];
        let size = 0;
        for await (const chunk of result.body) {
          size += chunk.byteLength;
          if (size > METADATA_MAX_BYTES) throw new PaperSourceError("paper-source-too-large");
          chunks.push(chunk);
        }
        const headers = new Headers();
        for (const [key, value] of Object.entries(result.headers)) if (value !== undefined) headers.set(key, value);
        return new Response(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))), {
          status: result.status,
          headers,
        });
      } catch (error) {
        if (error instanceof PaperSourceError) throw error;
        if (signal.aborted) throw signal.reason;
        if (!isRetryableConnectivityError(error)) {
          throw new PaperSourceError("paper-source-transport-error", undefined, { retryable: false });
        }
        lastError = error;
      }
    }
    throw new PaperSourceError("paper-source-transport-error", String(lastError ?? "metadata proxy failed"), {
      retryable: true,
    });
  }
}

function isRetryableFetchConnectivityError(error: unknown): boolean {
  if (!(error instanceof TypeError)) return false;
  if (!("cause" in error) || error.cause === undefined) return true;
  if (isRetryableConnectivityError(error.cause)) return true;
  return error.cause instanceof AggregateError && error.cause.errors.some(isRetryableConnectivityError);
}

function retryAfterMilliseconds(value: string | null, now: number): number | null {
  if (!value) return null;
  if (/^\d+$/.test(value.trim())) return Number.parseInt(value, 10) * 1_000;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : null;
}

// Only availability failures qualify; certificates, unsafe addresses and not-found do not.
function canUseAbstractFallback(error: unknown): boolean {
  return error instanceof ArxivRequestTimeoutError || isRetryableFetchConnectivityError(error) ||
    (error instanceof ArxivHttpError && RETRYABLE_STATUS_CODES.has(error.status)) ||
    (error instanceof PaperSourceError && error.retryable === true);
}

async function readMetadataBody(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("paper-source-unavailable:invalid-metadata");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > METADATA_MAX_BYTES) throw new PaperSourceError("paper-source-too-large");
      chunks.push(value);
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  return Buffer.concat(chunks).toString("utf8");
}

function decodeHtml(value: string): string {
  const named: Record<string, string> = { amp: "&", quot: '\"', apos: "'", lt: "<", gt: ">", nbsp: " " };
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|amp|quot|apos|lt|gt|nbsp);/gi, (entity, key: string) => {
    if (!key.startsWith("#")) return named[key.toLowerCase()] ?? entity;
    const code = key[1]?.toLowerCase() === "x" ? Number.parseInt(key.slice(2), 16) : Number.parseInt(key.slice(1), 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : entity;
  }).replace(/\s+/g, " ").trim();
}

function parseAbstractMetadata(html: string, arxivId: string): ResolvedPaper {
  // Restrict citation fields to the head; never infer metadata from page prose.
  const head = html.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i)?.[1] ?? "";
  const fields = new Map<string, string[]>();
  for (const tag of head.matchAll(/<meta\b[^>]*>/gi)) {
    const attributes = new Map<string, string>();
    for (const attr of tag[0].matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      attributes.set(attr[1]!.toLowerCase(), decodeHtml(attr[2] ?? attr[3] ?? ""));
    }
    const name = attributes.get("name")?.toLowerCase();
    const content = attributes.get("content");
    if (name && content) fields.set(name, [...(fields.get(name) ?? []), content]);
  }
  const title = fields.get("citation_title")?.[0];
  const authors = fields.get("citation_author") ?? [];
  const date = fields.get("citation_date")?.[0] ?? "";
  const year = /^\d{4}[/-]\d{2}[/-]\d{2}$/.test(date) ? Number(date.slice(0, 4)) : NaN;
  const identity = fields.get("citation_arxiv_id")?.[0];
  const versions: number[] = [];
  for (const link of html.matchAll(/href\s*=\s*["']https:\/\/arxiv\.org\/abs\/([^"']+)["']/gi)) {
    const version = link[1]!.match(/^(.+)v([1-9]\d*)$/);
    if (version?.[1] === arxivId && Number.isSafeInteger(Number(version[2]))) versions.push(Number(version[2]));
  }
  if (identity !== arxivId || !title || !authors.length || !Number.isInteger(year) || !versions.length) {
    throw new Error("paper-source-unavailable:invalid-metadata");
  }
  return { arxivId, title, authors, year, latestVersion: Math.max(...versions) };
}
