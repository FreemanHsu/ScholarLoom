import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { initializeDataRoot } from "../src/storage/layout.js";

async function testLayout() {
  return initializeDataRoot(join(await mkdtemp(join(tmpdir(), "scholarloom-import-")), "data"));
}

describe("POST /api/imports", () => {
  it("imports an explicit arXiv version without silently upgrading it", async () => {
    const app = await createApp({
      storageLayout: await testLayout(),
      paperSource: {
        async resolve() {
          return {
            arxivId: "2401.12345",
            latestVersion: 3,
            title: "Fixture Paper",
            authors: ["Ada Fixture"],
            year: 2024,
          };
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/imports",
      payload: { arxivUrl: "https://arxiv.org/abs/2401.12345v2" },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      paper: { arxivId: "2401.12345", version: 2, title: "Fixture Paper" },
      importRequest: { status: "resolved" },
    });

    await app.close();
  });

  it("resolves a bare arXiv ID once to the source's latest version", async () => {
    let latestVersion = 3;
    const app = await createApp({
      storageLayout: await testLayout(),
      paperSource: {
        async resolve() {
          return { arxivId: "2401.12345", latestVersion, title: "Fixture Paper", authors: ["Ada Fixture"], year: 2024 };
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/imports",
      payload: { arxivUrl: "https://arxiv.org/abs/2401.12345" },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json().paper.version).toBe(3);
    latestVersion = 4;
    const repeated = await app.inject({ method: "POST", url: "/api/imports", payload: { arxivUrl: "https://arxiv.org/abs/2401.12345" } });
    expect(repeated.json().paper.version).toBe(3);

    await app.close();
  });

  it("keeps one Paper after the process restarts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scholarloom-import-"));
    const storageLayout = initializeDataRoot(join(directory, "data"));
    const paperSource = {
      async resolve() {
        return { arxivId: "2401.12345", latestVersion: 3, title: "Fixture Paper", authors: ["Ada Fixture"], year: 2024 };
      },
    };

    const firstApp = await createApp({ paperSource, storageLayout });
    await firstApp.inject({
      method: "POST",
      url: "/api/imports",
      payload: { arxivUrl: "https://arxiv.org/abs/2401.12345v2" },
    });
    await firstApp.close();

    const restartedApp = await createApp({ paperSource, storageLayout });
    const papers = await restartedApp.inject({ method: "GET", url: "/api/papers" });

    expect(papers.statusCode).toBe(200);
    expect(papers.json().papers).toHaveLength(1);
    expect(papers.json().papers[0]).toMatchObject({
      arxivId: "2401.12345", id: "paper:fixture:2024:fixture-paper", title: "Fixture Paper", version: 2,
    });

    await restartedApp.close();
  });

  it("keeps duplicate import intent separate while replaying durable job progress", async () => {
    const paperSource = {
      async resolve() {
        return { arxivId: "2401.12345", latestVersion: 3, title: "Fixture Paper", authors: ["Ada Fixture"], year: 2024 };
      },
    };
    const app = await createApp({ paperSource, storageLayout: await testLayout() });

    const first = await app.inject({
      method: "POST",
      url: "/api/imports",
      payload: { arxivUrl: "https://arxiv.org/abs/2401.12345" },
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/imports",
      payload: { arxivUrl: "https://arxiv.org/pdf/2401.12345v3.pdf" },
    });

    expect(first.json().paper.id).toBe(second.json().paper.id);
    expect(first.json().importRequest.id).not.toBe(second.json().importRequest.id);

    const status = await app.inject({ method: "GET", url: `/api/imports/${first.json().importRequest.id}` });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      importRequest: { resolutionStatus: "resolved" },
      jobs: [{ jobType: "paper-import", state: "succeeded", progress: 1 }],
    });

    const replay = await app.inject({
      method: "GET",
      url: `/api/events?scope=${first.json().importRequest.id}&once=1`,
      headers: { "last-event-id": "0" },
    });
    expect(replay.headers["content-type"]).toContain("text/event-stream");
    expect(replay.body).toContain("event: job-progress");
    expect(replay.body).toContain('"state":"succeeded"');

    await app.close();
  });

  it("rejects an import before creating Paper state when the data root is not writable", async () => {
    const storageLayout = await testLayout();
    await chmod(join(storageLayout.originalsRoot, "papers"), 0o500);
    const app = await createApp({ storageLayout, paperSource: {
      async resolve() { return { arxivId: "2401.12345", latestVersion: 2, title: "Fixture", authors: ["Ada Fixture"], year: 2024 }; },
    } });

    const response = await app.inject({ method: "POST", url: "/api/imports", payload: { arxivUrl: "https://arxiv.org/abs/2401.12345" } });
    const papers = await app.inject({ method: "GET", url: "/api/papers" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: "data-root-not-writable", detail: expect.stringContaining("originals/papers") });
    expect(papers.json()).toEqual({ papers: [] });
    await app.close();
  });
});
import { chmod, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
