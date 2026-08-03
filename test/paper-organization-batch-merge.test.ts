import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { initializeDataRoot } from "../src/storage/layout.js";

async function pdf(): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  document.addPage().drawText("A durable batch and direction merge fixture.", { x: 40, y: 700, font });
  return document.save();
}

async function waitFor<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const value = await read();
    if (ready(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition-not-reached");
}

describe("Paper organization batches and Topic lifecycle", () => {
  it("batch-accepts independent sections, renames a target, then forward-merges memberships", async () => {
    const root = await mkdtemp(join(tmpdir(), "scholarloom-batch-merge-"));
    const layout = initializeDataRoot(join(root, "data"));
    const app = await createApp({
      storageLayout: layout,
      paperSource: {
        async resolve() {
          return {
            arxivId: "2507.00007",
            latestVersion: 1,
            title: "Durable Direction Learning",
            authors: ["Ada Fixture"],
            year: 2025,
          };
        },
        async fetchPdf() { return pdf(); },
      },
      codexRunner: {
        async runSummary() {
          return {
            sections: [{ key: "overview", title: "概述", body: "研究方向学习与可恢复策展。" }],
            claims: [{ voice: "authors-claim" as const, claim: "Studies direction learning.",
              sourceHandle: "pdf-page:1" }],
            readStatus: "read" as const,
          };
        },
      },
      paperOrganizationRunner: {
        async analyze() {
          return {
            coreProblem: "如何组织可恢复的方向学习。",
            mainContribution: "给出可批量确认的方向学习流程。",
            alias: { outcome: "proposal" as const, candidates: [{
              name: "Direction Loom",
              kind: "project-name" as const,
              preferred: true,
              rationale: "名称可指代整篇 Paper。",
            }] },
            primary: {
              outcome: "proposal" as const,
              recommendedTopicId: "topic:source-direction",
              rationale: "核心问题属于 source direction。",
              alternatives: [],
            },
            secondary: { outcome: "not-needed" as const, candidates: [] },
            usage: { status: "unavailable" as const, inputTokens: 0, cachedInputTokens: 0,
              outputTokens: 0, totalTokens: 0 },
          };
        },
      },
    });
    for (const [id, title] of [
      ["topic:source-direction", "Source Direction"],
      ["topic:target-direction", "Target Direction"],
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/directions",
        headers: { "idempotency-key": `create-${id}` },
        payload: { id, title, aliases: [], scope: `Scope for ${title}.` },
      });
      expect(response.statusCode, response.body).toBe(201);
    }
    const imported = await app.inject({
      method: "POST",
      url: "/api/imports",
      payload: { arxivUrl: "https://arxiv.org/abs/2507.00007" },
    });
    const paperId = imported.json().paper.id as string;
    const proposals = await waitFor(
      async () => (await app.inject({
        method: "GET",
        url: `/api/papers/${encodeURIComponent(paperId)}/organization-suggestions`,
      })).json(),
      (value: any) => value.runs[0]?.state === "succeeded" && value.suggestions.length === 2,
    ) as any;
    const proposalIds = proposals.suggestions.map((proposal: any) => proposal.id);
    const preview = await app.inject({
      method: "POST",
      url: "/api/paper-organization/batches/preview",
      payload: { action: "accept", proposalIds },
    });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json()).toMatchObject({
      selectedProposalCount: 2,
      eligibleProposalCount: 2,
      sectionCounts: { alias: 1, primary: 1, secondary: 0 },
    });
    const started = await app.inject({
      method: "POST",
      url: "/api/paper-organization/batches",
      headers: { "idempotency-key": "batch-accept-two-sections" },
      payload: { action: "accept", proposalIds },
    });
    expect(started.statusCode, started.body).toBe(202);
    const batchId = started.json().batchId as string;
    const batch = await waitFor(
      async () => (await app.inject({
        method: "GET", url: `/api/paper-organization/batches/${encodeURIComponent(batchId)}`,
      })).json(),
      (value: any) => ["complete", "complete-with-issues"].includes(value.batch.state),
    ) as any;
    expect(batch.batch.state).toBe("complete");
    expect(batch.counts.succeeded).toBe(2);
    expect(batch.papers[0].sections).toEqual(expect.arrayContaining([
      expect.objectContaining({ sectionKind: "alias", state: "succeeded" }),
      expect.objectContaining({ sectionKind: "primary-direction", state: "succeeded" }),
    ]));

    const directions = (await app.inject({ method: "GET", url: "/api/directions" })).json().directions;
    const target = directions.find((direction: any) => direction.id === "topic:target-direction");
    const renamed = await app.inject({
      method: "POST",
      url: "/api/directions/topic%3Atarget-direction/rename",
      headers: { "idempotency-key": "rename-target-direction" },
      payload: {
        title: "Canonical Target Direction",
        aliases: ["Target Direction"],
        scope: target.scope,
        scopeMeaningUnchanged: true,
        expectedRevisionId: target.revisionId,
        expectedMarkdownHash: target.markdownHash,
      },
    });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(renamed.json()).toMatchObject({
      direction: { id: "topic:target-direction", title: "Canonical Target Direction" },
      scopeMeaningUnchanged: true,
    });

    const mergePreview = await app.inject({
      method: "POST",
      url: "/api/directions/topic%3Asource-direction/merge/preview",
      payload: { targetTopicId: "topic:target-direction" },
    });
    expect(mergePreview.statusCode, mergePreview.body).toBe(200);
    expect(mergePreview.json()).toMatchObject({ affectedPaperCount: 1 });
    const mergeStarted = await app.inject({
      method: "POST",
      url: "/api/directions/topic%3Asource-direction/merge",
      headers: { "idempotency-key": "merge-source-into-target" },
      payload: { targetTopicId: "topic:target-direction" },
    });
    expect(mergeStarted.statusCode, mergeStarted.body).toBe(202);
    const mergeId = mergeStarted.json().mergeId as string;
    const merge = await waitFor(
      async () => (await app.inject({
        method: "GET", url: `/api/direction-merges/${encodeURIComponent(mergeId)}`,
      })).json(),
      (value: any) => ["complete", "complete-with-exceptions", "failed"].includes(value.merge.state),
    ) as any;
    expect(merge.merge.state).toBe("complete");
    expect(merge.members).toEqual([expect.objectContaining({ paperId, state: "succeeded" })]);
    const paper = (await app.inject({ method: "GET", url: `/api/papers?q=Direction%20Loom` })).json().papers[0];
    expect(paper).toMatchObject({
      preferredAlias: "Direction Loom",
      directions: [{ topicId: "topic:target-direction", title: "Canonical Target Direction", role: "primary" }],
    });
    const database = new Database(layout.databasePath);
    expect(database.prepare("SELECT * FROM topic_redirects WHERE source_topic_id=?")
      .get("topic:source-direction")).toMatchObject({
      direct_target_topic_id: "topic:target-direction",
      canonical_target_topic_id: "topic:target-direction",
      depth: 1,
    });
    database.close();
    await app.close();
  });
});
