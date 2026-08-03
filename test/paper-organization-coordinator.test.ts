import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FastifyInstance } from "fastify";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { initializeDataRoot } from "../src/storage/layout.js";

async function fixturePdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage().drawText("Video generation models learn transferable visual representations.", {
    x: 40,
    y: 700,
    font,
  });
  return pdf.save();
}

async function waitFor<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const value = await read();
    if (ready(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition-not-reached");
}

async function waitForImport(app: FastifyInstance, id: string): Promise<void> {
  await waitFor(
    async () => (await app.inject({ method: "GET", url: `/api/imports/${encodeURIComponent(id)}` })).json(),
    (value: any) => value.jobs.at(-1)?.state === "succeeded",
  );
}

describe("Paper organization coordinator", () => {
  it("creates independently reviewable suggestions and materializes Alias only", async () => {
    const root = await mkdtemp(join(tmpdir(), "scholarloom-organization-agent-"));
    const storageLayout = initializeDataRoot(join(root, "data"));
    const app = await createApp({
      storageLayout,
      paperSource: {
        async resolve() {
          return {
            arxivId: "2501.01234",
            latestVersion: 1,
            title: "Video Generation Models are General-Purpose Vision Learners",
            authors: ["Ada Fixture"],
            year: 2025,
          };
        },
        async fetchPdf() { return fixturePdf(); },
      },
      codexRunner: {
        async runSummary() {
          return {
            sections: [{ key: "overview", title: "概述", body: "视频生成模型可学习通用视觉表征。" }],
            claims: [{
              voice: "authors-claim" as const,
              claim: "Video generation models learn transferable visual representations.",
              sourceHandle: "pdf-page:1",
            }],
            readStatus: "read" as const,
          };
        },
      },
      paperOrganizationRunner: {
        async analyze(input) {
          if (input.context.scope === "primary") {
            return {
              coreProblem: "视频生成预训练能否学习可迁移视觉表征。",
              mainContribution: "验证视频生成模型可作为通用视觉学习器。",
              primary: {
                outcome: "proposal" as const,
                recommendedTopicId: "topic:vision-representation-learning",
                rationale: "核心研究问题是视觉表征迁移。",
                alternatives: [{
                  topicId: "topic:video-generation",
                  rationale: "视频生成也是一个合理但次要的分类候选。",
                }],
              },
              usage: {
                status: "reported" as const,
                inputTokens: 100,
                cachedInputTokens: 0,
                outputTokens: 60,
                totalTokens: 160,
              },
            };
          }
          return {
            coreProblem: "视频生成预训练能否学习可迁移视觉表征。",
            mainContribution: "验证视频生成模型可作为通用视觉学习器。",
            alias: {
              outcome: "proposal" as const,
              candidates: [{
                name: "GenCeption",
                kind: "model-name" as const,
                preferred: true,
                rationale: "论文使用该名称指代整体方法。",
              }],
            },
            primary: {
              outcome: "proposal" as const,
              recommendedTopicId: "topic:vision-representation-learning",
              rationale: "核心研究问题是视觉表征迁移。",
              alternatives: [],
            },
            secondary: {
              outcome: "proposal" as const,
              candidates: [{
                topicId: "topic:video-generation",
                rationale: "论文更新了视频生成模型的能力边界认知。",
              }],
            },
            usage: {
              status: "reported" as const,
              inputTokens: 100,
              cachedInputTokens: 0,
              outputTokens: 60,
              totalTokens: 160,
            },
          };
        },
      },
    });
    for (const direction of [
      ["topic:vision-representation-learning", "Vision Representation Learning", "学习可迁移视觉表征。"],
      ["topic:video-generation", "Video Generation", "生成、建模与理解视频。"],
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/directions",
        headers: { "idempotency-key": `direction-${direction[0]}` },
        payload: { id: direction[0], title: direction[1], scope: direction[2] },
      });
      expect(response.statusCode, response.body).toBe(201);
    }
    const imported = await app.inject({
      method: "POST",
      url: "/api/imports",
      payload: { arxivUrl: "https://arxiv.org/abs/2501.01234" },
    });
    await waitForImport(app, imported.json().importRequest.id);
    const paperId = imported.json().paper.id as string;
    const suggestions = await waitFor(
      async () => (await app.inject({
        method: "GET",
        url: `/api/papers/${encodeURIComponent(paperId)}/organization-suggestions`,
      })).json(),
      (value: any) => value.runs[0]?.state === "succeeded" && value.suggestions.length === 3,
    ) as any;
    const queue = await app.inject({
      method: "GET",
      url: "/api/paper-organization/queue?view=pending&section=primary&unclassified=true&q=Video",
    });
    expect(queue.statusCode, queue.body).toBe(200);
    expect(queue.json()).toMatchObject({
      truncated: false,
      counts: { pendingPapers: 1, attentionPapers: 1, unclassifiedPapers: 1 },
      items: [{
        paper: { id: paperId },
        pendingSectionCount: 3,
        attention: true,
        unclassified: true,
      }],
    });
    const status = await app.inject({
      method: "POST",
      url: "/api/paper-organization/status",
      payload: {
        jobRunIds: [suggestions.runs[0].id],
        proposalIds: [suggestions.suggestions[0].id],
      },
    });
    expect(status.statusCode, status.body).toBe(200);
    expect(status.json()).toMatchObject({
      jobs: [{ id: suggestions.runs[0].id, state: "succeeded" }],
      proposals: [{ id: suggestions.suggestions[0].id, reviewStatus: "pending" }],
    });
    expect((await app.inject({
      method: "GET",
      url: "/api/paper-organization/queue?unclassified=maybe",
    })).statusCode).toBe(400);
    const alias = suggestions.suggestions.find((proposal: any) => proposal.changeKind === "alias");
    const accepted = await app.inject({
      method: "POST",
      url: `/api/paper-organization/proposals/${encodeURIComponent(alias.id)}/decision`,
      headers: { "idempotency-key": "accept-agent-alias" },
      payload: { action: "accept" },
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json()).toMatchObject({
      schemaVersion: "paper-organization-decision.v1",
      sectionKind: "alias",
      action: "accept",
      resultingOrganization: {
        aliases: [{ name: "GenCeption", kind: "model-name", preferred: true }],
        directions: [],
      },
    });
    const paper = (await app.inject({ method: "GET", url: `/api/papers?q=GenCeption` })).json().papers[0];
    expect(paper).toMatchObject({ id: paperId, preferredAlias: "GenCeption" });
    const remaining = (await app.inject({
      method: "GET",
      url: `/api/papers/${encodeURIComponent(paperId)}/organization-suggestions`,
    })).json();
    expect(remaining.suggestions.filter((proposal: any) => proposal.reviewStatus === "pending")
      .map((proposal: any) => proposal.changeKind).sort())
      .toEqual(["primary-direction", "secondary-direction"]);
    const secondaryBeforePrimary = remaining.suggestions.find(
      (proposal: any) => proposal.changeKind === "secondary-direction",
    );
    expect(secondaryBeforePrimary.applicability).toBe("blocked");
    const primary = remaining.suggestions.find((proposal: any) => proposal.changeKind === "primary-direction");
    const primaryAccepted = await app.inject({
      method: "POST",
      url: `/api/paper-organization/proposals/${encodeURIComponent(primary.id)}/decision`,
      headers: { "idempotency-key": "accept-agent-primary" },
      payload: { action: "accept" },
    });
    expect(primaryAccepted.statusCode, primaryAccepted.body).toBe(200);
    const afterPrimary = (await app.inject({
      method: "GET",
      url: `/api/papers/${encodeURIComponent(paperId)}/organization-suggestions`,
    })).json();
    const secondary = afterPrimary.suggestions.find(
      (proposal: any) => proposal.changeKind === "secondary-direction",
    );
    expect(secondary.applicability).toBe("ready");
    const secondaryAccepted = await app.inject({
      method: "POST",
      url: `/api/paper-organization/proposals/${encodeURIComponent(secondary.id)}/decision`,
      headers: { "idempotency-key": "accept-agent-secondary" },
      payload: { action: "accept" },
    });
    expect(secondaryAccepted.statusCode, secondaryAccepted.body).toBe(200);
    expect(secondaryAccepted.json().resultingOrganization.directions).toEqual([
      { topicId: "topic:vision-representation-learning", role: "primary" },
      { topicId: "topic:video-generation", role: "secondary" },
    ]);
    const regenerated = await app.inject({
      method: "POST",
      url: `/api/papers/${encodeURIComponent(paperId)}/organization-suggestions`,
      headers: { "idempotency-key": "regenerate-agent-primary-with-alternative" },
      payload: { scope: "primary" },
    });
    expect(regenerated.statusCode, regenerated.body).toBe(202);
    const regeneratedSuggestions = await waitFor(
      async () => (await app.inject({
        method: "GET",
        url: `/api/papers/${encodeURIComponent(paperId)}/organization-suggestions`,
      })).json(),
      (value: any) => value.runs[0]?.id === regenerated.json().jobRunId &&
        !["queued", "running"].includes(value.runs[0]?.state),
    ) as any;
    expect(regeneratedSuggestions.runs[0]).toMatchObject({
      id: regenerated.json().jobRunId,
      state: "succeeded",
    });
    expect(regeneratedSuggestions.suggestions.find((proposal: any) =>
      proposal.reviewStatus === "pending" && proposal.changeKind === "primary-direction"))
      .toMatchObject({ ambiguous: true });
    await app.close();
  });

  it("excludes Papers without an organization run from the queue", async () => {
    const root = await mkdtemp(join(tmpdir(), "scholarloom-organization-zero-run-"));
    const storageLayout = initializeDataRoot(join(root, "data"));
    const app = await createApp({
      storageLayout,
      paperSource: {
        async resolve() {
          return {
            arxivId: "2501.05678",
            latestVersion: 1,
            title: "A Paper Awaiting Organization Backfill",
            authors: ["Grace Fixture"],
            year: 2025,
          };
        },
        async fetchPdf() { return fixturePdf(); },
      },
      codexRunner: {
        async runSummary() {
          return {
            sections: [{ key: "overview", title: "概述", body: "等待后续批量整理。" }],
            claims: [{
              voice: "authors-claim" as const,
              claim: "This paper awaits organization backfill.",
              sourceHandle: "pdf-page:1",
            }],
            readStatus: "read" as const,
          };
        },
      },
    });
    const imported = await app.inject({
      method: "POST",
      url: "/api/imports",
      payload: { arxivUrl: "https://arxiv.org/abs/2501.05678" },
    });
    await waitForImport(app, imported.json().importRequest.id);
    const queue = await app.inject({ method: "GET", url: "/api/paper-organization/queue?view=all" });
    expect(queue.statusCode, queue.body).toBe(200);
    expect(queue.json()).toMatchObject({
      items: [],
      counts: { pendingPapers: 0, attentionPapers: 0, unclassifiedPapers: 0 },
    });
    await app.close();
  });
});
