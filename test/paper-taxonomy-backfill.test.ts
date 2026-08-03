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
  document.addPage().drawText("A traceable visual representation research workflow.", {
    x: 40, y: 700, font,
  });
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

describe("Paper taxonomy bootstrap and backfill", () => {
  it("confirms one Agent Direction then schedules an existing Paper through ordinary proposals", async () => {
    const parent = await mkdtemp(join(tmpdir(), "scholarloom-taxonomy-"));
    const layout = initializeDataRoot(join(parent, "data"));
    const source = {
      async resolve() {
        return {
          arxivId: "2502.01234",
          latestVersion: 1,
          title: "Traceable Visual Representation Learning",
          authors: ["Ada Fixture"],
          year: 2025,
        };
      },
      async fetchPdf() { return pdf(); },
    };
    const summaryRunner = {
      async runSummary() {
        return {
          sections: [
            { key: "overview", title: "概述", body: "研究如何学习可迁移、可追溯的视觉表征。" },
            { key: "core-ideas", title: "核心", body: "核心贡献是可验证的视觉表征学习流程。" },
          ],
          claims: [{ voice: "authors-claim" as const, claim: "Learns visual representations.",
            sourceHandle: "pdf-page:1" }],
          readStatus: "read" as const,
        };
      },
    };
    const ingestApp = await createApp({ storageLayout: layout, paperSource: source, codexRunner: summaryRunner });
    const imported = await ingestApp.inject({
      method: "POST", url: "/api/imports", payload: { arxivUrl: "https://arxiv.org/abs/2502.01234" },
    });
    const importId = imported.json().importRequest.id as string;
    await waitFor(
      async () => (await ingestApp.inject({ method: "GET", url: `/api/imports/${importId}` })).json(),
      (value: any) => value.jobs.at(-1)?.state === "succeeded",
    );
    await ingestApp.close();
    const database = new Database(layout.databasePath);
    database.prepare("DELETE FROM paper_organization_triggers").run();
    database.close();

    const taxonomyApp = await createApp({
      storageLayout: layout,
      paperSource: source,
      codexRunner: summaryRunner,
      paperTaxonomyRunner: {
        async propose(input) {
          return {
            candidates: [{
              suggestedTopicId: "topic:vision-representation-learning",
              title: "Vision Representation Learning",
              aliases: ["Visual Representation Learning"],
              scope: "研究如何学习可迁移的视觉表征。",
              exclusions: ["仅使用视觉 backbone 而不研究表征学习。"],
              representativePaperIds: [input.context.papers[0]!.paperId],
              rationale: "核心问题与主要贡献都围绕可迁移视觉表征。",
              overlaps: [],
            }],
            usage: { status: "reported" as const, inputTokens: 10, cachedInputTokens: 0,
              outputTokens: 10, totalTokens: 20 },
          };
        },
      },
    });
    const requested = await taxonomyApp.inject({
      method: "POST",
      url: "/api/paper-taxonomy/bootstrap",
      headers: { "idempotency-key": "taxonomy-bootstrap-one" },
      payload: { mode: "next", limit: 100 },
    });
    expect(requested.statusCode, requested.body).toBe(202);
    const taxonomy = await waitFor(
      async () => (await taxonomyApp.inject({ method: "GET", url: "/api/paper-taxonomy/bootstrap" })).json(),
      (value: any) => value.runs[0]?.state === "succeeded" && value.proposals.length === 1,
    ) as any;
    expect(taxonomy.proposals[0]).toMatchObject({
      suggested: { topicId: "topic:vision-representation-learning" },
      reviewStatus: "pending",
    });
    const accepted = await taxonomyApp.inject({
      method: "POST",
      url: `/api/direction-taxonomy/proposals/${encodeURIComponent(taxonomy.proposals[0].id)}/decision`,
      headers: { "idempotency-key": "accept-taxonomy-one" },
      payload: { action: "accept" },
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json()).toMatchObject({
      schemaVersion: "direction-taxonomy-decision.v1",
      resultingDirection: { id: "topic:vision-representation-learning" },
    });
    expect((await taxonomyApp.inject({ method: "GET", url: "/api/directions" })).json().directions)
      .toEqual([expect.objectContaining({ id: "topic:vision-representation-learning" })]);
    await taxonomyApp.close();

    const app = await createApp({
      storageLayout: layout,
      paperSource: source,
      codexRunner: summaryRunner,
      paperOrganizationRunner: {
        async analyze(input) {
          return {
            coreProblem: "如何学习可迁移视觉表征。",
            mainContribution: "提出可追溯表征学习流程。",
            alias: { outcome: "not-needed" as const, candidates: [] },
            primary: {
              outcome: "proposal" as const,
              recommendedTopicId: input.directions[0]!.topicId,
              rationale: "核心问题属于视觉表征学习。",
              alternatives: [],
            },
            secondary: { outcome: "not-needed" as const, candidates: [] },
            usage: { status: "reported" as const, inputTokens: 10, cachedInputTokens: 0,
              outputTokens: 10, totalTokens: 20 },
          };
        },
      },
      paperTaxonomyRunner: { async propose() {
        return { candidates: [], usage: { status: "reported" as const, inputTokens: 0,
          cachedInputTokens: 0, outputTokens: 0, totalTokens: 0 } };
      } },
    });
    const preview = await app.inject({ method: "GET", url: "/api/paper-organization/backfill/preview?limit=25" });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json()).toMatchObject({ eligibleCount: 1, selectedCount: 1 });
    const campaign = await app.inject({
      method: "POST",
      url: "/api/paper-organization/backfill",
      headers: { "idempotency-key": "backfill-one" },
      payload: { limit: 25 },
    });
    expect(campaign.statusCode, campaign.body).toBe(202);
    const campaignId = campaign.json().campaignId as string;
    const complete = await waitFor(
      async () => (await app.inject({
        method: "GET", url: `/api/paper-organization/backfills/${encodeURIComponent(campaignId)}`,
      })).json(),
      (value: any) => ["complete", "complete-with-issues"].includes(value.campaign.state),
    ) as any;
    expect(complete.campaign.state).toBe("complete");
    expect(complete.members[0]).toMatchObject({ state: "scheduled", jobState: "succeeded" });
    const queue = (await app.inject({ method: "GET", url: "/api/paper-organization/queue?view=pending" })).json();
    expect(queue.items).toEqual([expect.objectContaining({ pendingSectionCount: 1 })]);
    await app.close();
  });
});
