import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { initializeDataRoot } from "../src/storage/layout.js";

describe("browser route delivery", () => {
  it("serves the SPA shell for a direct Paper URL without masking unknown API routes", async () => {
    const root = await mkdtemp(join(tmpdir(), "scholarloom-web-routing-"));
    const webRoot = join(root, "web");
    await mkdir(webRoot);
    await writeFile(join(webRoot, "index.html"), "<!doctype html><title>ScholarLoom route shell</title>");
    const app = await createApp({
      storageLayout: initializeDataRoot(join(root, "data")),
      webRoot,
      paperSource: {
        async resolve(arxivId) {
          return { arxivId, latestVersion: 1, title: "Fixture", authors: [], year: 2024 };
        },
      },
    });

    const page = await app.inject({ method: "GET", url: "/papers/paper%3Afixture%3A2024" });
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toContain("text/html");
    expect(page.body).toContain("ScholarLoom route shell");

    const api = await app.inject({ method: "GET", url: "/api/not-real" });
    expect(api.statusCode).toBe(404);
    expect(api.json()).toEqual({ code: "not-found" });
    await app.close();
  });

  it("exposes durable Paper processing state for navigation summaries", async () => {
    const root = await mkdtemp(join(tmpdir(), "scholarloom-web-overview-"));
    let releasePdf!: (bytes: Uint8Array) => void;
    const pdf = new Promise<Uint8Array>((resolve) => { releasePdf = resolve; });
    const app = await createApp({
      storageLayout: initializeDataRoot(join(root, "data")),
      paperSource: {
        async resolve(arxivId) {
          return { arxivId, latestVersion: 1, title: "Running Fixture", authors: ["Ada Fixture"], year: 2024 };
        },
        async fetchPdf() { return pdf; },
      },
      codexRunner: {
        async runSummary() { return { sections: [], claims: [], readStatus: "read" }; },
      },
    });

    const imported = await app.inject({ method: "POST", url: "/api/imports", payload: { arxivUrl: "https://arxiv.org/abs/2401.12345v1" } });
    expect(imported.statusCode, imported.body).toBe(202);
    const papers = await app.inject({ method: "GET", url: "/api/papers" });
    expect(papers.json().papers).toEqual([
      expect.objectContaining({
        title: "Running Fixture",
        processing: { state: "running", progress: 0.1, needsAttention: false },
        summaryStatus: "processing",
      }),
    ]);

    releasePdf(new Uint8Array([0]));
    await app.close();
  });
});
