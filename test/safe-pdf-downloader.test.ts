import { describe, expect, it } from "vitest";

import { PaperSourceError, SafePdfDownloader, type PdfTransportResponse } from "../src/adapters/safe-pdf-downloader.js";

const body = (text: string) => (async function* () { yield new TextEncoder().encode(text); })();
const response = (overrides: Partial<PdfTransportResponse> = {}): PdfTransportResponse => ({
  status: 200, headers: { "content-type": "application/pdf" }, body: body("%PDF-test"), ...overrides,
});
const expectCode = async (promise: Promise<unknown>, code: string) => {
  await expect(promise).rejects.toMatchObject({ code });
};

describe("SafePdfDownloader", () => {
  it("falls back to the configured proxy after direct transport connectivity fails", async () => {
    const attempts: string[] = [];
    const downloader = new SafePdfDownloader({
      resolve: async () => ["203.0.113.10"],
      transport: { async request() {
        attempts.push("direct");
        throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
      } },
      proxyTransport: { async request() {
        attempts.push("proxy");
        return response();
      } },
    });

    await expect(downloader.download("https://papers.example.test/paper.pdf")).resolves.toMatchObject({
      mediaType: "application/pdf",
      byteSize: 9,
    });
    expect(attempts).toEqual(["direct", "proxy"]);
  });

  it("restarts the download through the proxy when the direct response body resets", async () => {
    const attempts: string[] = [];
    const downloader = new SafePdfDownloader({
      resolve: async () => ["203.0.113.10"],
      transport: { async request() {
        attempts.push("direct");
        return response({ body: (async function* () {
          yield new TextEncoder().encode("%PDF-");
          throw Object.assign(new Error("body reset"), { code: "ECONNRESET" });
        })() });
      } },
      proxyTransport: { async request() {
        attempts.push("proxy");
        return response();
      } },
    });

    await expect(downloader.download("https://papers.example.test/paper.pdf")).resolves.toMatchObject({
      mediaType: "application/pdf",
      byteSize: 9,
    });
    expect(attempts).toEqual(["direct", "proxy"]);
  });

  it("restarts the download through the proxy when the direct transfer exceeds its attempt budget", async () => {
    const attempts: string[] = [];
    const downloader = new SafePdfDownloader({
      resolve: async () => ["203.0.113.10", "203.0.113.11"],
      directAttemptTimeoutMs: 5,
      totalTimeoutMs: 1_000,
      transport: { async request(input) {
        attempts.push(`direct:${input.address}`);
        return response({ body: (async function* () {
          yield new TextEncoder().encode("%PDF-");
          await new Promise<void>((_resolve, reject) => {
            input.signal.addEventListener("abort", () => reject(input.signal.reason), { once: true });
          });
        })() });
      } },
      proxyTransport: { async request() {
        attempts.push("proxy");
        return response();
      } },
    });

    await expect(downloader.download("https://papers.example.test/paper.pdf")).resolves.toMatchObject({
      mediaType: "application/pdf",
      byteSize: 9,
    });
    expect(attempts).toEqual(["direct:203.0.113.10", "proxy"]);
  });

  it("does not use the proxy after receiving an HTTP response", async () => {
    let proxyAttempts = 0;
    const downloader = new SafePdfDownloader({
      resolve: async () => ["203.0.113.10"],
      transport: { async request() {
        return response({ status: 503, headers: { "retry-after": "12" } });
      } },
      proxyTransport: { async request() { proxyAttempts += 1; return response(); } },
    });

    await expect(downloader.download("https://papers.example.test/paper.pdf"))
      .rejects.toMatchObject({ code: "paper-source-http-error", httpStatus: 503, retryAfterMs: 12_000 });
    expect(proxyAttempts).toBe(0);
  });

  it("does not use the proxy after a non-connectivity TLS failure", async () => {
    let proxyAttempts = 0;
    const downloader = new SafePdfDownloader({
      resolve: async () => ["203.0.113.10"],
      transport: { async request() {
        throw Object.assign(new Error("certificate expired"), { code: "CERT_HAS_EXPIRED" });
      } },
      proxyTransport: { async request() { proxyAttempts += 1; return response(); } },
    });

    await expect(downloader.download("https://papers.example.test/paper.pdf"))
      .rejects.toMatchObject({ code: "paper-source-transport-error", retryable: false });
    expect(proxyAttempts).toBe(0);
  });

  it("downloads a verified public PDF through the injected DNS and transport seams", async () => {
    const downloader = new SafePdfDownloader({
      resolve: async () => ["203.0.113.10"],
      transport: { async request() { return {
        status: 200,
        headers: { "content-type": "application/pdf", "content-length": "9" },
        body: (async function* () { yield new TextEncoder().encode("%PDF-test"); })(),
      }; } },
    });

    await expect(downloader.download("https://papers.example.test/paper.pdf")).resolves.toMatchObject({
      canonicalUrl: "https://papers.example.test/paper.pdf",
      mediaType: "application/pdf",
      byteSize: 9,
    });
  });

  it.each(["0.0.0.0", "127.0.0.1", "10.0.0.1", "169.254.169.254", "192.168.1.1", "224.0.0.1",
    "::", "::1", "fe80::1", "fd00::1", "ff02::1", "::ffff:10.0.0.1", "::ffff:a00:1", "0:0:0:0:0:ffff:a00:1"])
    ("rejects unsafe resolved address %s before transport", async (address) => {
      let requested = false;
      const downloader = new SafePdfDownloader({ resolve: async () => [address], transport: { async request() { requested = true; return response(); } } });
      await expectCode(downloader.download("https://papers.example.test/paper.pdf"), "unsafe-source-url");
      expect(requested).toBe(false);
    });

  it("revalidates DNS on every redirect and rejects a private redirect target", async () => {
    const downloader = new SafePdfDownloader({
      resolve: async (host) => host === "cdn.example.test" ? ["10.0.0.2"] : ["203.0.113.10"],
      transport: { async request() { return response({ status: 302, headers: { location: "https://cdn.example.test/paper.pdf" } }); } },
    });
    await expectCode(downloader.download("https://papers.example.test/paper.pdf"), "unsafe-source-url");
  });

  it("rejects a hostname when any DNS answer is non-public", async () => {
    let requested = false;
    const downloader = new SafePdfDownloader({ resolve: async () => ["203.0.113.10", "10.0.0.2"], transport: { async request() {
      requested = true; return response();
    } } });
    await expectCode(downloader.download("https://papers.example.test/paper.pdf"), "unsafe-source-url");
    expect(requested).toBe(false);
  });

  it("applies the total timeout while DNS resolution is pending", async () => {
    const downloader = new SafePdfDownloader({ totalTimeoutMs: 5, resolve: () => new Promise<string[]>(() => undefined),
      transport: { async request() { return response(); } } });
    await expectCode(downloader.download("https://papers.example.test/paper.pdf"), "paper-source-timeout");
  });

  it("pins transport to the validated address and preserves a rebinding refusal", async () => {
    const downloader = new SafePdfDownloader({ connectTimeoutMs: 123, resolve: async () => ["203.0.113.10"], transport: { async request(input) {
      expect(input.address).toBe("203.0.113.10");
      expect(input.connectTimeoutMs).toBe(123);
      throw new PaperSourceError("unsafe-source-url");
    } } });
    await expectCode(downloader.download("https://papers.example.test/paper.pdf"), "unsafe-source-url");
  });

  it.each([
    { name: "HTTP status", value: response({ status: 404 }), code: "paper-source-http-error" },
    { name: "declared size", value: response({ headers: { "content-type": "application/pdf", "content-length": "10" } }), code: "paper-source-too-large" },
    { name: "media type", value: response({ headers: { "content-type": "text/html" } }), code: "paper-source-not-pdf" },
    { name: "magic bytes", value: response({ body: body("not a pdf") }), code: "paper-source-not-pdf" },
  ])("rejects invalid $name", async ({ value, code }) => {
    const downloader = new SafePdfDownloader({ maxBytes: 9, resolve: async () => ["203.0.113.10"],
      transport: { async request() { return value; } } });
    await expectCode(downloader.download("https://papers.example.test/paper.pdf"), code);
  });

  it("stops reading a streaming response above the size limit", async () => {
    const downloader = new SafePdfDownloader({ maxBytes: 8, resolve: async () => ["203.0.113.10"], transport: { async request() {
      return response({ body: (async function* () { yield new TextEncoder().encode("%PDF-"); yield new TextEncoder().encode("toolarge"); })() });
    } } });
    await expectCode(downloader.download("https://papers.example.test/paper.pdf"), "paper-source-too-large");
  });

  it("accepts octet-stream only when PDF magic bytes are valid", async () => {
    const downloader = new SafePdfDownloader({ resolve: async () => ["203.0.113.10"], transport: { async request() {
      return response({ headers: { "content-type": "application/octet-stream" } });
    } } });
    await expect(downloader.download("https://papers.example.test/paper.pdf")).resolves.toMatchObject({ mediaType: "application/octet-stream" });
  });

  it("maps transport aborts to a stable timeout code", async () => {
    const downloader = new SafePdfDownloader({ resolve: async () => ["203.0.113.10"], transport: { async request() {
      const error = new Error("aborted"); error.name = "AbortError"; throw error;
    } } });
    await expectCode(downloader.download("https://papers.example.test/paper.pdf"), "paper-source-timeout");
  });

  it("limits redirect loops", async () => {
    const downloader = new SafePdfDownloader({ maxRedirects: 1, resolve: async () => ["203.0.113.10"], transport: { async request(input) {
      return response({ status: 302, headers: { location: input.url.toString() } });
    } } });
    await expectCode(downloader.download("https://papers.example.test/paper.pdf"), "paper-source-redirect-invalid");
  });
});
