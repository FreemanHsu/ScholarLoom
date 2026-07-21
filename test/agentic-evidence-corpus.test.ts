import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { EvidenceWorkspaceBuilder } from "../src/storage/evidence-workspace-builder.js";
import { initializeDataRoot } from "../src/storage/layout.js";

describe("cross-paper Agentic Evidence corpus", () => {
  it("freezes curated library summaries and refreshes only through a linked successor Conversation", async () => {
    const root = await mkdtemp(join(tmpdir(), "scholarloom-agentic-corpus-"));
    const layout = initializeDataRoot(join(root, "data"));
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    pdf.addPage().drawText("Cross paper frozen evidence.", { x: 40, y: 700, font });
    const bytes = await pdf.save();
    const app = await createApp({ storageLayout: layout,
      paperSource: {
        async resolve(arxivId) { return { arxivId, latestVersion: 1, title: `Corpus Fixture ${arxivId.slice(-2)}`, authors: ["Ada Fixture"], year: 2026 }; },
        async fetchPdf() { return bytes; },
      },
      codexRunner: { async runSummary() { return { sections: [{ key: "overview", title: "概述", body: "Cross paper frozen evidence." }],
        claims: [{ voice: "paper-evidence", claim: "Cross paper frozen evidence.", sourceHandle: "pdf-page:1" }], readStatus: "read" }; } },
    });
    const importPaper = async (id: string) => {
      const response = await app.inject({ method: "POST", url: "/api/imports", payload: { arxivUrl: `https://arxiv.org/abs/${id}v1` } });
      for (let index = 0; index < 200; index += 1) {
        const status = await app.inject({ method: "GET", url: `/api/imports/${response.json().importRequest.id}` });
        if (status.json().jobs.at(-1)?.state === "succeeded") return response.json().paper.id as string;
        if (status.json().jobs.at(-1)?.state === "failed") throw new Error(JSON.stringify(status.json().jobs.at(-1)));
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error("fixture import did not settle");
    };
    await importPaper("2601.00011");
    const currentPaper = await importPaper("2601.00012");
    const first = await app.inject({ method: "POST", url: `/api/papers/${encodeURIComponent(currentPaper)}/conversations` });
    const firstBody = first.json();
    await importPaper("2601.00013");
    const successor = await app.inject({ method: "POST", url: `/api/papers/${encodeURIComponent(currentPaper)}/conversations`,
      payload: { continuedFromConversationId: firstBody.conversation.id } });
    expect(successor.statusCode, successor.body).toBe(201);
    expect(successor.json().conversation.continuedFromConversationId).toBe(firstBody.conversation.id);
    expect(successor.json().contextSnapshot.knowledgeCorpusManifestId)
      .not.toBe(firstBody.contextSnapshot.knowledgeCorpusManifestId);
    await app.close();

    const builder = EvidenceWorkspaceBuilder.open(layout);
    const oldWorkspace = builder.ensure(firstBody.contextSnapshot.id);
    const newWorkspace = builder.ensure(successor.json().contextSnapshot.id);
    const oldManifest = JSON.parse(await readFile(join(oldWorkspace.root, "MANIFEST.json"), "utf8")) as { sources: Array<{ kind: string }> };
    const newManifest = JSON.parse(await readFile(join(newWorkspace.root, "MANIFEST.json"), "utf8")) as { sources: Array<{ kind: string }> };
    expect(oldManifest.sources.filter((source) => source.kind === "library")).toHaveLength(1);
    expect(newManifest.sources.filter((source) => source.kind === "library")).toHaveLength(2);
    builder.close();
  });
});
