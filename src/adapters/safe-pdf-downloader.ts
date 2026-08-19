import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { Agent as HttpAgent, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as netConnect, isIP } from "node:net";
import type { Duplex } from "node:stream";
import { connect as tlsConnect, type ConnectionOptions, type TLSSocket } from "node:tls";

export type PdfTransportResponse = {
  status: number;
  headers: Record<string, string | undefined>;
  body: AsyncIterable<Uint8Array>;
};

export type PdfTransport = {
  request(input: { url: URL; address: string; connectTimeoutMs: number; signal: AbortSignal }): Promise<PdfTransportResponse>;
};

type PaperSourceErrorDetails = {
  httpStatus?: number;
  retryAfterMs?: number;
  retryable?: boolean;
};

export class PaperSourceError extends Error {
  readonly httpStatus: number | undefined;
  readonly retryAfterMs: number | undefined;
  readonly retryable: boolean | undefined;

  constructor(readonly code: string, message = code, details: PaperSourceErrorDetails = {}) {
    super(message);
    this.httpStatus = details.httpStatus;
    this.retryAfterMs = details.retryAfterMs;
    this.retryable = details.retryable;
  }
}

export type DownloadedPdf = {
  bytes: Uint8Array;
  contentHash: string;
  byteSize: number;
  canonicalUrl: string;
  mediaType: string;
};

export const SAFE_PDF_DOWNLOADER_DEFAULTS = {
  maxRedirects: 5,
  maxBytes: 100 * 1024 * 1024,
  connectTimeoutMs: 10_000,
  totalTimeoutMs: 60_000,
} as const;

type SafePdfDownloaderOptions = {
  resolve?: (hostname: string) => Promise<string[]>;
  transport?: PdfTransport;
  proxyTransport?: PdfTransport;
  maxRedirects?: number;
  maxBytes?: number;
  connectTimeoutMs?: number;
  totalTimeoutMs?: number;
  directAttemptTimeoutMs?: number;
};

export class SafePdfDownloader {
  readonly #resolve: (hostname: string) => Promise<string[]>;
  readonly #transport: PdfTransport;
  readonly #proxyTransport: PdfTransport | undefined;
  readonly #maxRedirects: number;
  readonly #maxBytes: number;
  readonly #connectTimeoutMs: number;
  readonly #totalTimeoutMs: number;
  readonly #directAttemptTimeoutMs: number | undefined;

  constructor(options: SafePdfDownloaderOptions = {}) {
    this.#resolve = options.resolve ?? resolvePublicAddresses;
    this.#transport = options.transport ?? new HttpsPdfTransport();
    this.#proxyTransport = options.proxyTransport;
    this.#maxRedirects = options.maxRedirects ?? SAFE_PDF_DOWNLOADER_DEFAULTS.maxRedirects;
    this.#maxBytes = options.maxBytes ?? SAFE_PDF_DOWNLOADER_DEFAULTS.maxBytes;
    this.#connectTimeoutMs = options.connectTimeoutMs ?? SAFE_PDF_DOWNLOADER_DEFAULTS.connectTimeoutMs;
    this.#totalTimeoutMs = options.totalTimeoutMs ?? SAFE_PDF_DOWNLOADER_DEFAULTS.totalTimeoutMs;
    this.#directAttemptTimeoutMs = options.directAttemptTimeoutMs;
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
          if (controller.signal.aborted) {
            throw new PaperSourceError("paper-source-timeout", undefined, { retryable: true });
          }
          throw new PaperSourceError("paper-source-dns-failed", undefined, { retryable: true });
        }
        if (!addresses.length || addresses.some((address) => !isPublicAddress(address))) throw new PaperSourceError("unsafe-source-url");
        const outcome = await this.#requestHop(url, addresses, controller);
        if (outcome.kind === "redirect") {
          if (redirect === this.#maxRedirects) throw new PaperSourceError("paper-source-redirect-invalid");
          try { url = parseSafeUrl(new URL(outcome.location, url).toString()); }
          catch { throw new PaperSourceError("paper-source-redirect-invalid"); }
          continue;
        }
        return { ...outcome.downloaded, canonicalUrl: url.toString() };
      }
      throw new PaperSourceError("paper-source-redirect-invalid");
    } finally {
      clearTimeout(timeout);
    }
  }

  async #requestHop(url: URL, addresses: string[], controller: AbortController): Promise<{
    kind: "redirect";
    location: string;
  } | {
    kind: "downloaded";
    downloaded: Omit<DownloadedPdf, "canonicalUrl">;
  }> {
    const transports = [this.#transport, ...(this.#proxyTransport ? [this.#proxyTransport] : [])];
    let lastTransportError: unknown;
    for (const [transportIndex, transport] of transports.entries()) {
      const attempt = linkedAttemptSignal(controller.signal,
        transportIndex === 0 && this.#proxyTransport ? this.#directAttemptTimeoutMs : undefined);
      try {
        for (const address of addresses) {
          try {
            const response = await transport.request({ url, address,
              connectTimeoutMs: this.#connectTimeoutMs, signal: attempt.signal });
            if ([301, 302, 303, 307, 308].includes(response.status)) {
              const location = response.headers.location;
              if (!location) throw new PaperSourceError("paper-source-redirect-invalid");
              return { kind: "redirect", location };
            }
            if (response.status < 200 || response.status >= 300) {
              const retryAfterMs = retryAfterMilliseconds(response.headers["retry-after"]);
              throw new PaperSourceError("paper-source-http-error", undefined, {
                httpStatus: response.status,
                ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
              });
            }
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
            return { kind: "downloaded", downloaded: { bytes,
              contentHash: createHash("sha256").update(bytes).digest("hex"), byteSize: bytes.byteLength, mediaType } };
          } catch (error) {
            if (attempt.timedOut()) {
              lastTransportError = transportError("ETIMEDOUT", "direct transfer attempt timeout");
              break;
            }
            if (error instanceof PaperSourceError) throw error;
            if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
              throw new PaperSourceError("paper-source-timeout", undefined, { retryable: true });
            }
            if (!isRetryableConnectivityError(error)) {
              throw new PaperSourceError("paper-source-transport-error", undefined, { retryable: false });
            }
            lastTransportError = error;
          }
        }
      } finally { attempt.cleanup(); }
      if (transportIndex === 0 && this.#proxyTransport && isRetryableConnectivityError(lastTransportError)) continue;
      break;
    }
    if (transportErrorCode(lastTransportError) === "ETIMEDOUT") {
      throw new PaperSourceError("paper-source-timeout", undefined, { retryable: true });
    }
    throw new PaperSourceError("paper-source-transport-error", undefined, { retryable: true });
  }
}

function linkedAttemptSignal(parent: AbortSignal, timeoutMs: number | undefined): {
  signal: AbortSignal;
  timedOut(): boolean;
  cleanup(): void;
} {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let didTimeout = false;
  const abort = () => controller.abort(parent.reason);
  if (parent.aborted) abort();
  else parent.addEventListener("abort", abort, { once: true });
  if (timeoutMs !== undefined) {
    timeout = setTimeout(() => {
      didTimeout = true;
      controller.abort(transportError("ETIMEDOUT", "direct transfer attempt timeout"));
    }, timeoutMs);
  }
  return {
    signal: controller.signal,
    timedOut: () => didTimeout,
    cleanup() {
      if (timeout) clearTimeout(timeout);
      parent.removeEventListener("abort", abort);
    },
  };
}

function isRetryableConnectivityError(error: unknown): boolean {
  const code = transportErrorCode(error);
  return ["ECONNRESET", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT", "EPIPE"].includes(code);
}

function transportErrorCode(error: unknown): string {
  return error instanceof Error && "code" in error ? String(error.code) : "";
}

function retryAfterMilliseconds(value: string | undefined): number | undefined {
  if (!value) return undefined;
  if (/^\d+$/.test(value.trim())) return Number.parseInt(value, 10) * 1_000;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : undefined;
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
      request.setTimeout(input.connectTimeoutMs, () => request.destroy(transportError("ETIMEDOUT", "direct connection timeout")));
      request.once("error", reject);
      request.end();
    });
  }
}

export class HttpConnectPdfTransport implements PdfTransport {
  constructor(readonly proxyUrl: URL, readonly options: { ca?: ConnectionOptions["ca"] } = {}) {}

  async request(input: { url: URL; address: string; connectTimeoutMs: number;
    signal: AbortSignal }): Promise<PdfTransportResponse> {
    const tunnel = await this.#openTunnel(input);
    const tlsSocket = await this.#openTls(tunnel, input);
    return new Promise((resolve, reject) => {
      const agent = new HttpAgent({ keepAlive: false });
      agent.createConnection = (_options, callback) => {
        callback?.(null, tlsSocket);
        return tlsSocket;
      };
      const request = httpRequest({
        protocol: "http:",
        hostname: input.url.hostname,
        port: input.url.port || "443",
        path: `${input.url.pathname}${input.url.search}`,
        method: "GET",
        headers: { "user-agent": "ScholarLoom/0.1 (personal research ingestion)",
          accept: "application/pdf, application/octet-stream;q=0.8", host: input.url.host, connection: "close" },
        agent,
        signal: input.signal,
      }, (response) => {
        const headers: Record<string, string | undefined> = {};
        for (const [key, value] of Object.entries(response.headers)) {
          headers[key] = Array.isArray(value) ? value.join(", ") : value;
        }
        resolve({ status: response.statusCode ?? 0, headers, body: response });
      });
      request.setTimeout(input.connectTimeoutMs, () => request.destroy(transportError("ETIMEDOUT", "proxy origin timeout")));
      request.once("error", reject);
      request.end();
    });
  }

  #openTunnel(input: { url: URL; address: string; connectTimeoutMs: number; signal: AbortSignal }): Promise<Duplex> {
    const port = input.url.port || "443";
    const authority = `${input.address.includes(":") ? `[${input.address}]` : input.address}:${port}`;
    return new Promise((resolve, reject) => {
      if (input.signal.aborted) { reject(new DOMException("Aborted", "AbortError")); return; }
      const proxyHost = this.proxyUrl.hostname.replace(/^\[|\]$/g, "");
      const socket = netConnect({ host: proxyHost, port: Number(this.proxyUrl.port || "80") });
      let received = Buffer.alloc(0);
      let settled = false;
      const cleanup = () => {
        socket.setTimeout(0);
        socket.removeListener("data", onData);
        socket.removeListener("error", fail);
        socket.removeListener("end", onEnd);
        socket.removeListener("close", onClose);
        input.signal.removeEventListener("abort", abort);
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        socket.destroy();
        reject(error);
      };
      const abort = () => fail(new DOMException("Aborted", "AbortError"));
      const incompleteResponse = () => transportError("EPROXYCONNECT", "proxy closed before completing CONNECT response");
      const onEnd = () => fail(incompleteResponse());
      const onClose = () => fail(incompleteResponse());
      const onData = (chunk: Buffer) => {
        received = Buffer.concat([received, chunk]);
        if (received.byteLength > 16 * 1024) { fail(transportError("EPROXYCONNECT", "proxy CONNECT response headers too large")); return; }
        const headerEnd = received.indexOf("\r\n\r\n");
        if (headerEnd < 0) return;
        const status = received.subarray(0, headerEnd).toString("latin1").match(/^HTTP\/1\.[01] (\d{3})(?: |\r?$)/m)?.[1];
        if (status !== "200") { fail(transportError("EPROXYCONNECT", `proxy CONNECT returned ${status ?? 0}`)); return; }
        settled = true;
        cleanup();
        const head = received.subarray(headerEnd + 4);
        if (head.byteLength) socket.unshift(head);
        resolve(socket);
      };
      input.signal.addEventListener("abort", abort, { once: true });
      socket.setTimeout(input.connectTimeoutMs, () => fail(transportError("ETIMEDOUT", "proxy connect timeout")));
      socket.once("error", fail);
      socket.once("end", onEnd);
      socket.once("close", onClose);
      socket.on("data", onData);
      socket.once("connect", () => socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nProxy-Connection: Keep-Alive\r\n\r\n`));
    });
  }

  #openTls(tunnel: Duplex, input: { url: URL; connectTimeoutMs: number; signal: AbortSignal }): Promise<TLSSocket> {
    return new Promise((resolve, reject) => {
      if (input.signal.aborted) {
        tunnel.destroy();
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      const socket = tlsConnect({ socket: tunnel, servername: input.url.hostname, ...this.options });
      const abort = () => socket.destroy(new DOMException("Aborted", "AbortError"));
      input.signal.addEventListener("abort", abort, { once: true });
      socket.setTimeout(input.connectTimeoutMs, () => socket.destroy(transportError("ETIMEDOUT", "proxy TLS timeout")));
      socket.once("secureConnect", () => {
        input.signal.removeEventListener("abort", abort);
        socket.setTimeout(0);
        resolve(socket);
      });
      socket.once("error", (error) => { input.signal.removeEventListener("abort", abort); reject(error); });
    });
  }
}

function transportError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
