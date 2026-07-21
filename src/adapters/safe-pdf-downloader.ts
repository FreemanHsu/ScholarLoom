import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

export type PdfTransportResponse = {
  status: number;
  headers: Record<string, string | undefined>;
  body: AsyncIterable<Uint8Array>;
};

export type PdfTransport = {
  request(input: { url: URL; address: string; connectTimeoutMs: number; signal: AbortSignal }): Promise<PdfTransportResponse>;
};

export class PaperSourceError extends Error {
  constructor(readonly code: string, message = code) { super(message); }
}

export type DownloadedPdf = {
  bytes: Uint8Array;
  contentHash: string;
  byteSize: number;
  canonicalUrl: string;
  mediaType: string;
};

type SafePdfDownloaderOptions = {
  resolve?: (hostname: string) => Promise<string[]>;
  transport?: PdfTransport;
  maxRedirects?: number;
  maxBytes?: number;
  connectTimeoutMs?: number;
  totalTimeoutMs?: number;
};

export class SafePdfDownloader {
  readonly #resolve: (hostname: string) => Promise<string[]>;
  readonly #transport: PdfTransport;
  readonly #maxRedirects: number;
  readonly #maxBytes: number;
  readonly #connectTimeoutMs: number;
  readonly #totalTimeoutMs: number;

  constructor(options: SafePdfDownloaderOptions = {}) {
    this.#resolve = options.resolve ?? resolvePublicAddresses;
    this.#transport = options.transport ?? new HttpsPdfTransport();
    this.#maxRedirects = options.maxRedirects ?? 5;
    this.#maxBytes = options.maxBytes ?? 100 * 1024 * 1024;
    this.#connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
    this.#totalTimeoutMs = options.totalTimeoutMs ?? 60_000;
  }

  async download(input: string): Promise<DownloadedPdf> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#totalTimeoutMs);
    try {
      let url = parseSafeUrl(input);
      for (let redirect = 0; redirect <= this.#maxRedirects; redirect += 1) {
        let addresses: string[];
        try { addresses = await raceAbort(this.#resolve(url.hostname), controller.signal); }
        catch {
          if (controller.signal.aborted) throw new PaperSourceError("paper-source-timeout");
          throw new PaperSourceError("paper-source-dns-failed");
        }
        if (!addresses.length || addresses.some((address) => !isPublicAddress(address))) throw new PaperSourceError("unsafe-source-url");
        let response: PdfTransportResponse | undefined;
        let lastTransportError: unknown;
        for (const address of addresses) {
          try {
            response = await this.#transport.request({ url, address, connectTimeoutMs: this.#connectTimeoutMs, signal: controller.signal });
            break;
          } catch (error) {
            if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) throw new PaperSourceError("paper-source-timeout");
            if (error instanceof PaperSourceError && ["unsafe-source-url", "paper-source-timeout"].includes(error.code)) throw error;
            lastTransportError = error;
          }
        }
        if (!response) {
          if (lastTransportError instanceof PaperSourceError) throw lastTransportError;
          throw new PaperSourceError("paper-source-http-error");
        }
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          if (redirect === this.#maxRedirects) throw new PaperSourceError("paper-source-redirect-invalid");
          const location = response.headers.location;
          if (!location) throw new PaperSourceError("paper-source-redirect-invalid");
          try { url = parseSafeUrl(new URL(location, url).toString()); }
          catch { throw new PaperSourceError("paper-source-redirect-invalid"); }
          continue;
        }
        if (response.status < 200 || response.status >= 300) throw new PaperSourceError("paper-source-http-error");
        const declaredLength = Number(response.headers["content-length"] ?? "0");
        if (Number.isFinite(declaredLength) && declaredLength > this.#maxBytes) throw new PaperSourceError("paper-source-too-large");
        const chunks: Uint8Array[] = [];
        let size = 0;
        for await (const chunk of response.body) {
          size += chunk.byteLength;
          if (size > this.#maxBytes) { controller.abort(); throw new PaperSourceError("paper-source-too-large"); }
          chunks.push(chunk);
        }
        const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
        const mediaType = (response.headers["content-type"] ?? "").split(";", 1)[0]!.trim().toLowerCase();
        if (mediaType !== "application/pdf" && mediaType !== "application/octet-stream") throw new PaperSourceError("paper-source-not-pdf");
        if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-") throw new PaperSourceError("paper-source-not-pdf");
        return { bytes, contentHash: createHash("sha256").update(bytes).digest("hex"), byteSize: bytes.byteLength,
          canonicalUrl: url.toString(), mediaType };
      }
      throw new PaperSourceError("paper-source-redirect-invalid");
    } finally {
      clearTimeout(timeout);
    }
  }
}

function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function parseSafeUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || !url.hostname || url.hostname === "localhost" || url.hostname.endsWith(".localhost")) {
    throw new PaperSourceError("unsafe-source-url");
  }
  url.hash = "";
  return url;
}

function isPublicAddress(address: string): boolean {
  const mappedTail = address.toLowerCase().match(/^(?:::ffff:|(?:0{1,4}:){5}ffff:)(.+)$/)?.[1];
  if (mappedTail && /^\d+\.\d+\.\d+\.\d+$/.test(mappedTail)) return isPublicAddress(mappedTail);
  const mappedHex = mappedTail?.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const high = Number.parseInt(mappedHex[1]!, 16);
    const low = Number.parseInt(mappedHex[2]!, 16);
    return isPublicAddress(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`);
  }
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || (a === 100 && b! >= 64 && b! <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168) || a! >= 224);
  }
  if (isIP(address) === 6) {
    const normalized = address.toLowerCase();
    const first = Number.parseInt(normalized.split(":")[0] || "0", 16);
    return normalized !== "::" && normalized !== "::1" && !(first >= 0xfc00 && first <= 0xfdff) &&
      !(first >= 0xfe80 && first <= 0xfebf) && !(first >= 0xff00 && first <= 0xffff);
  }
  return false;
}

async function resolvePublicAddresses(hostname: string): Promise<string[]> {
  return (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);
}

class HttpsPdfTransport implements PdfTransport {
  request(input: { url: URL; address: string; connectTimeoutMs: number; signal: AbortSignal }): Promise<PdfTransportResponse> {
    return new Promise((resolve, reject) => {
      const request = httpsRequest(input.url, {
        method: "GET",
        headers: { "user-agent": "ScholarLoom/0.1 (personal research ingestion)", accept: "application/pdf, application/octet-stream;q=0.8" },
        signal: input.signal,
        lookup: (_hostname, options, callback) => {
          const family = isIP(input.address) as 4 | 6;
          if (typeof options === "object" && options.all) callback(null, [{ address: input.address, family }]);
          else callback(null, input.address, family);
        },
      }, (response) => {
        const remote = response.socket.remoteAddress?.replace(/^::ffff:/, "");
        if (!remote || remote !== input.address.replace(/^::ffff:/, "")) {
          response.destroy(new PaperSourceError("unsafe-source-url"));
          return;
        }
        const headers: Record<string, string | undefined> = {};
        for (const [key, value] of Object.entries(response.headers)) headers[key] = Array.isArray(value) ? value.join(", ") : value;
        resolve({ status: response.statusCode ?? 0, headers, body: response });
      });
      request.setTimeout(input.connectTimeoutMs, () => request.destroy(new PaperSourceError("paper-source-timeout")));
      request.once("error", reject);
      request.end();
    });
  }
}
