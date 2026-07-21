import { access, mkdtemp, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { AnswerGroundingGate } from "../src/storage/answer-grounding-gate.js";
import { EvidenceWorkspaceBuilder } from "../src/storage/evidence-workspace-builder.js";
import { initializeDataRoot } from "../src/storage/layout.js";

describe("EvidenceWorkspaceBuilder", () => {
  it("builds and reuses a complete read-only content-addressed workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "scholarloom-evidence-workspace-"));
    const layout = initializeDataRoot(join(root, "data"));
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    pdf.addPage().drawText("Agentic evidence lives on page one.", { x: 40, y: 700, font });
    const bytes = await pdf.save();
    const app = await createApp({
      storageLayout: layout,
      paperSource: {
        async resolve(arxivId) { return { arxivId, latestVersion: 1, title: "Workspace Fixture", authors: ["Ada Fixture"], year: 2026 }; },
        async fetchPdf() { return bytes; },
      },
      codexRunner: { async runSummary() { return {
        sections: [{ key: "overview", title: "概述", body: "Agentic evidence lives on page one." }],
        claims: [{ voice: "paper-evidence", claim: "Agentic evidence lives on page one.", sourceHandle: "pdf-page:1" }],
        readStatus: "read",
      }; } },
    });
    const imported = await app.inject({ method: "POST", url: "/api/imports", payload: { arxivUrl: "https://arxiv.org/abs/2601.00002v1" } });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const status = await app.inject({ method: "GET", url: `/api/imports/${imported.json().importRequest.id}` });
      if (status.json().jobs.at(-1)?.state === "succeeded") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const created = await app.inject({ method: "POST", url: `/api/papers/${encodeURIComponent(imported.json().paper.id)}/conversations` });
    await app.close();

    const builder = EvidenceWorkspaceBuilder.open(layout);
    const first = builder.ensure(created.json().contextSnapshot.id);
    const second = builder.ensure(created.json().contextSnapshot.id);
    expect(second).toEqual(first);
    expect(first.status).toBe("built");
    expect(await readFile(join(first.root, "COMPLETE"), "utf8")).toContain(first.workspaceHash);
    expect(await readFile(join(first.root, "paper", "pages", "page-0001.md"), "utf8"))
      .toContain("Agentic evidence lives on page one.");
    expect(await readFile(join(first.root, "paper", "summary.md"), "utf8")).toContain("Workspace Fixture");
    expect(await readFile(join(first.root, "conversation", "recent-messages.md"), "utf8")).toContain("context-only");
    const manifest = JSON.parse(await readFile(join(first.root, "MANIFEST.json"), "utf8")) as {
      sources: Array<{ path: string; citable: boolean }>;
    };
    expect(manifest.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "paper/pages/page-0001.md", citable: true }),
      expect.objectContaining({ path: "paper/summary.md", citable: true }),
      expect.objectContaining({ path: "conversation/recent-messages.md", citable: false }),
    ]));
    expect((await stat(join(first.root, "MANIFEST.json"))).mode & 0o222).toBe(0);
    await expect(access(join(first.root, "MANIFEST.json"), constants.W_OK)).rejects.toThrow();
    builder.close();
  });

  it("verifies final quoted citations and rejects context-only paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "scholarloom-grounding-gate-"));
    const workspace = join(root, "workspace");
    await import("node:fs/promises").then(({ mkdir, writeFile }) => Promise.all([
      mkdir(join(workspace, "paper", "pages"), { recursive: true }),
      mkdir(join(workspace, "conversation"), { recursive: true }),
    ]).then(async () => {
      const paper = "first line\nBounded verbatim evidence.\nlast line\n";
      const context = "private conversation context\n";
      await writeFile(join(workspace, "paper", "pages", "page-0001.md"), paper);
      await writeFile(join(workspace, "conversation", "recent-messages.md"), context);
      const hash = await import("node:crypto").then(({ createHash }) => createHash("sha256").update(paper).digest("hex"));
      await writeFile(join(workspace, "MANIFEST.json"), JSON.stringify({ sources: [
        { kind: "pdf", path: "paper/pages/page-0001.md", sourceId: "paper-version:1", revision: "extraction:1",
          contentHash: hash, citable: true, locator: { page: 1, elementId: "element:1", contentStartLine: 1 } },
        { kind: "conversation", path: "conversation/recent-messages.md", sourceId: "snapshot:1",
          contentHash: "ignored", citable: false },
      ] }));
    }));

    const gate = AnswerGroundingGate.open(workspace);
    expect(gate.verify([{ path: "paper/pages/page-0001.md", lineStart: 2, lineEnd: 2,
      quote: "Bounded verbatim evidence." }])).toEqual([
      expect.objectContaining({ evidenceKind: "pdf", sourceId: "paper-version:1", quote: "Bounded verbatim evidence.",
        locator: expect.objectContaining({ page: 1, elementId: "element:1", lineStart: 2, lineEnd: 2 }) }),
    ]);
    expect(() => gate.verify([{ path: "conversation/recent-messages.md", lineStart: 1, lineEnd: 1,
      quote: "private conversation context" }])).toThrow(/citation-scope-forbidden/);
    expect(() => gate.verify([{ path: "paper/pages/page-0001.md", lineStart: 2, lineEnd: 2,
      quote: "invented quote" }])).toThrow(/citation-quote-mismatch/);
    expect(gate.repair([{ path: "paper/pages/page-0001.md", lineStart: 1, lineEnd: 1,
      quote: "Bounded verbatim evidence." }])).toEqual([
      expect.objectContaining({ locator: expect.objectContaining({ lineStart: 2, lineEnd: 2 }) }),
    ]);
  });
});
