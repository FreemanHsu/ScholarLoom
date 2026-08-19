import { afterEach, describe, expect, it, vi } from "vitest";

import { ArxivPaperSource } from "../src/adapters/arxiv.js";
import { PaperSourceError } from "../src/adapters/safe-pdf-downloader.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("ArxivPaperSource", () => {
  it("recovers when arXiv metadata is temporarily unavailable", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response("Service Unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response(`<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2607.11643v1</id>
    <title>Xiaomi-Robotics-U0</title>
    <published>2026-07-13T14:57:58Z</published>
    <author><name>Xinghang Li</name></author>
  </entry>
</feed>`, { status: 200, headers: { "content-type": "application/atom+xml" } }));
    const waits: number[] = [];
    let now = 0;

    const resolved = await new ArxivPaperSource({
      fetch,
      sleep: async (milliseconds) => { waits.push(milliseconds); now += milliseconds; },
      random: () => 0,
      now: () => now,
    }).resolve("2607.11643");

    expect(resolved).toMatchObject({ arxivId: "2607.11643", latestVersion: 1, title: "Xiaomi-Robotics-U0" });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(waits).toEqual([3_000]);
  });

  it("honors a bounded Retry-After response from arXiv", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response("Too Many Requests", { status: 429, headers: { "retry-after": "7" } }))
      .mockResolvedValueOnce(new Response(`
<feed><entry><id>http://arxiv.org/abs/2607.11643v1</id><title>Xiaomi-Robotics-U0</title>
<published>2026-07-13T14:57:58Z</published><author><name>Xinghang Li</name></author></entry></feed>`, { status: 200 }));
    const waits: number[] = [];
    let now = 0;

    await new ArxivPaperSource({
      fetch,
      sleep: async (milliseconds) => { waits.push(milliseconds); now += milliseconds; },
      random: () => 0,
      now: () => now,
    }).resolve("2607.11643");

    expect(waits).toEqual([7_000]);
  });

  it("does not block the import route for a long Retry-After", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response("Service Unavailable", { status: 503, headers: { "retry-after": "60" } }));
    const waits: number[] = [];

    await expect(new ArxivPaperSource({
      fetch,
      sleep: async (milliseconds) => { waits.push(milliseconds); },
      random: () => 0,
    }).resolve("2607.11643")).rejects.toThrow("paper-source-unavailable:503");

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([]);
  });

  it("restarts a PDF download after a transient arXiv failure", async () => {
    const pdf = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55]);
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response("Service Unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response(pdf, { status: 200, headers: { "content-type": "application/pdf" } }));
    const waits: number[] = [];

    const bytes = await new ArxivPaperSource({
      fetch,
      sleep: async (milliseconds) => { waits.push(milliseconds); },
      random: () => 0,
    }).fetchPdf("2607.11643", 1);

    expect(bytes).toEqual(pdf);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(waits).toEqual([3_000]);
  });

  it("uses the configured safe downloader for an arXiv PDF", async () => {
    const pdf = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55]);
    const fetch = vi.fn<typeof globalThis.fetch>();
    const download = vi.fn(async () => ({ bytes: pdf }));

    await expect(new ArxivPaperSource({ fetch, pdfDownloader: { download } }).fetchPdf("2607.11643", 1))
      .resolves.toEqual(pdf);

    expect(download).toHaveBeenCalledWith("https://arxiv.org/pdf/2607.11643v1");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("retries a transient safe-downloader failure", async () => {
    const pdf = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55]);
    const download = vi.fn()
      .mockRejectedValueOnce(new PaperSourceError("paper-source-http-error", undefined, {
        httpStatus: 503,
        retryAfterMs: 12_000,
      }))
      .mockResolvedValueOnce({ bytes: pdf });
    const waits: number[] = [];

    await expect(new ArxivPaperSource({
      pdfDownloader: { download },
      sleep: async (milliseconds) => { waits.push(milliseconds); },
      random: () => 0,
    }).fetchPdf("2607.11643", 1)).resolves.toEqual(pdf);

    expect(download).toHaveBeenCalledTimes(2);
    expect(waits).toEqual([12_000]);
  });

  it("does not retry a permanent safe-downloader HTTP failure", async () => {
    const failure = new PaperSourceError("paper-source-http-error", undefined, { httpStatus: 404 });
    const download = vi.fn().mockRejectedValue(failure);
    const sleep = vi.fn(async () => undefined);

    await expect(new ArxivPaperSource({ pdfDownloader: { download }, sleep }).fetchPdf("2607.11643", 1))
      .rejects.toBe(failure);

    expect(download).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("does not retry a permanent safe-downloader transport failure", async () => {
    const failure = new PaperSourceError("paper-source-transport-error", undefined, { retryable: false });
    const download = vi.fn().mockRejectedValue(failure);
    const sleep = vi.fn(async () => undefined);

    await expect(new ArxivPaperSource({ pdfDownloader: { download }, sleep }).fetchPdf("2607.11643", 1))
      .rejects.toBe(failure);

    expect(download).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries a transient network failure", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(new Response(`
<feed><entry><id>http://arxiv.org/abs/2607.11643v1</id><title>Xiaomi-Robotics-U0</title>
<published>2026-07-13T14:57:58Z</published><author><name>Xinghang Li</name></author></entry></feed>`, { status: 200 }));

    await expect(new ArxivPaperSource({
      fetch,
      sleep: async () => {},
      random: () => 0,
    }).resolve("2607.11643")).resolves.toMatchObject({ title: "Xiaomi-Robotics-U0" });

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("bounds each metadata attempt with a timeout", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    });
    const pending = new ArxivPaperSource({ fetch, sleep: async () => {}, random: () => 0 }).resolve("2607.11643");
    const rejected = expect(pending).rejects.toThrow("paper-source-unavailable:timeout");

    await vi.runAllTimersAsync();
    await rejected;
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("times out a stalled PDF body read and restarts the full download", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const pdf = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55]);
    const abortTimes: number[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      if (fetch.mock.calls.length === 1) {
        return {
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "application/pdf" }),
          arrayBuffer: async () => await new Promise<ArrayBuffer>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              abortTimes.push(Date.now());
              reject(init.signal?.reason);
            }, { once: true });
          }),
        } as Response;
      }
      return new Response(pdf, { status: 200, headers: { "content-type": "application/pdf" } });
    });
    const pending = new ArxivPaperSource({ fetch, sleep: async () => {}, random: () => 0 })
      .fetchPdf("2607.11643", 1);
    const resolved = expect(pending).resolves.toEqual(pdf);

    await vi.advanceTimersByTimeAsync(120_000);
    await resolved;
    expect(abortTimes).toEqual([120_000]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not retry metadata responses that are not transient", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response("Not Found", { status: 404 }));

    await expect(new ArxivPaperSource({ fetch, sleep: async () => {} }).resolve("2607.99999"))
      .rejects.toThrow("paper-source-unavailable:404");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("stops after three transient failures", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response("Service Unavailable", { status: 503 }));
    const waits: number[] = [];
    let now = 0;

    await expect(new ArxivPaperSource({
      fetch,
      sleep: async (milliseconds) => { waits.push(milliseconds); now += milliseconds; },
      random: () => 0,
      now: () => now,
    }).resolve("2607.11643")).rejects.toThrow("paper-source-unavailable:503");

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(waits).toEqual([3_000, 6_000]);
  });

  it("does not retry an invalid PDF response", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response("not a pdf", { status: 200, headers: { "content-type": "text/html" } }));

    await expect(new ArxivPaperSource({ fetch, sleep: async () => {} }).fetchPdf("2607.11643", 1))
      .rejects.toThrow("paper-source-invalid-pdf");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("serializes metadata requests at least three seconds apart", async () => {
    let now = 0;
    const starts: number[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      starts.push(now);
      const arxivId = String(input).includes("2607.11643") ? "2607.11643" : "2501.12202";
      return new Response(`
<feed><entry><id>http://arxiv.org/abs/${arxivId}v1</id><title>Fixture ${arxivId}</title>
<published>2026-07-13T14:57:58Z</published><author><name>Ada Fixture</name></author></entry></feed>`, { status: 200 });
    });
    const source = new ArxivPaperSource({
      fetch,
      now: () => now,
      sleep: async (milliseconds) => { now += milliseconds; },
      random: () => 0,
    });

    await Promise.all([source.resolve("2607.11643"), source.resolve("2501.12202")]);

    expect(starts).toEqual([0, 3_000]);
  });

  it("resolves authors whose Atom entries include affiliation metadata", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(`<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <entry>
    <id>http://arxiv.org/abs/2501.12202v5</id>
    <title>
      Hunyuan3D 2.0: Scaling Diffusion Models for High Resolution Textured 3D Assets Generation
    </title>
    <published>2025-01-21T15:16:54Z</published>
    <author>
      <name>Zibo Zhao</name>
      <arxiv:affiliation>refer to the report for detailed contributions</arxiv:affiliation>
    </author>
    <author>
      <name>Zeqiang Lai</name>
      <arxiv:affiliation>refer to the report for detailed contributions</arxiv:affiliation>
    </author>
  </entry>
</feed>`, {
      status: 200,
      headers: { "content-type": "application/atom+xml; charset=utf-8" },
    })));

    await expect(new ArxivPaperSource().resolve("2501.12202")).resolves.toEqual({
      arxivId: "2501.12202",
      latestVersion: 5,
      title: "Hunyuan3D 2.0: Scaling Diffusion Models for High Resolution Textured 3D Assets Generation",
      authors: ["Zibo Zhao", "Zeqiang Lai"],
      year: 2025,
    });
  });
});
