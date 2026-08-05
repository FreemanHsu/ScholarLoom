import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { initializeDataRoot } from "../src/storage/layout.js";

describe("Paper Library preferences", () => {
  it("persists a star across restarts and filters the catalog", async () => {
    const storageLayout = initializeDataRoot(join(await mkdtemp(join(tmpdir(), "scholarloom-paper-star-")), "data"));
    const paperSource = {
      async resolve() {
        return {
          arxivId: "2401.12345",
          latestVersion: 1,
          title: "A Paper Worth Returning To",
          authors: ["Ada Researcher"],
          year: 2024,
        };
      },
    };
    const first = await createApp({ paperSource, storageLayout });
    const imported = await first.inject({
      method: "POST",
      url: "/api/imports",
      payload: { arxivUrl: "https://arxiv.org/abs/2401.12345v1" },
    });
    const paperId = imported.json().paper.id as string;

    expect((await first.inject({ method: "GET", url: "/api/papers" })).json().papers[0].starred).toBe(false);
    expect((await first.inject({
      method: "PUT",
      url: `/api/papers/${encodeURIComponent(paperId)}/star`,
      payload: { starred: true },
    })).json()).toEqual({ paperId, starred: true });
    await first.close();

    const restarted = await createApp({ paperSource, storageLayout });
    const starred = await restarted.inject({ method: "GET", url: "/api/papers?view=starred" });
    expect(starred.statusCode).toBe(200);
    expect(starred.json().papers).toEqual([
      expect.objectContaining({ id: paperId, title: "A Paper Worth Returning To", starred: true }),
    ]);

    await restarted.inject({
      method: "PUT",
      url: `/api/papers/${encodeURIComponent(paperId)}/star`,
      payload: { starred: false },
    });
    expect((await restarted.inject({ method: "GET", url: "/api/papers?view=starred" })).json().papers).toEqual([]);
    await restarted.close();
  });

  it("rejects invalid star commands and unknown papers", async () => {
    const app = await createApp({
      storageLayout: initializeDataRoot(join(await mkdtemp(join(tmpdir(), "scholarloom-paper-star-invalid-")), "data")),
      paperSource: { async resolve() { throw new Error("unused"); } },
    });
    expect((await app.inject({
      method: "PUT",
      url: "/api/papers/missing/star",
      payload: { starred: "yes" },
    })).statusCode).toBe(400);
    expect((await app.inject({
      method: "PUT",
      url: "/api/papers/missing/star",
      payload: { starred: true },
    })).statusCode).toBe(404);
    await app.close();
  });
});
