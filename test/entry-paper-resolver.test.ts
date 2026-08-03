import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FastifyInstance } from "fastify";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { initializeDataRoot } from "../src/storage/layout.js";

async function pdf(text: string): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  document.addPage().drawText(text, { x: 40, y: 700, font });
  return document.save();
}

async function waitFor<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const value = await read();
    if (ready(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition-not-reached");
}

async function importPaper(app: FastifyInstance, arxivId: string) {
  const response = await app.inject({ method: "POST", url: "/api/imports",
    payload: { arxivUrl: `https://arxiv.org/abs/${arxivId}` } });
  expect(response.statusCode, response.body).toBe(202);
  await waitFor(async () => (await app.inject({ method: "GET",
    url: `/api/imports/${encodeURIComponent(response.json().importRequest.id)}` })).json(),
  (value: any) => value.jobs.at(-1)?.state === "succeeded");
  return response.json().paper.id as string;
}

describe("Entry Agent Paper Alias resolver", () => {
  it("scopes curated evidence by Alias, always disambiguates cross-Paper collisions, and supports bypass", async () => {
    const layout = initializeDataRoot(join(await mkdtemp(join(tmpdir(), "scholarloom-entry-resolver-")), "data"));
    const calls: Array<{ question: string; sources: Array<Record<string, unknown>> }> = [];
    const metadata: Record<string, { title: string; authors: string[]; year: number }> = {
      "2608.01001": { title: "Video Generation Models are General-Purpose Vision Learners",
        authors: ["Ada Alias"], year: 2026 },
      "2608.01002": { title: "GenCeption", authors: ["Grace Collision"], year: 2025 },
    };
    const app = await createApp({
      storageLayout: layout,
      entryResolverMode: "enabled",
      paperSource: {
        async resolve(arxivId) { return { arxivId, latestVersion: 1, ...metadata[arxivId]! }; },
        async fetchPdf(arxivId) { return pdf(`Primary source ${arxivId}.`); },
      },
      codexRunner: {
        async runSummary(context) { return {
          sections: [{ key: "overview", title: "概述", body: `已确认摘要 ${context.paperId}，不包含易记别名。` }],
          claims: [{ voice: "authors-claim" as const, claim: "A confirmed contribution.",
            sourceHandle: "pdf-page:1" }], readStatus: "read" as const,
        }; },
        async runEntry(context) {
          calls.push(context as unknown as typeof calls[number]);
          return { answerStatus: context.sources.length ? "answered" as const : "insufficient_evidence" as const,
            answer: context.sources.length ? "已按确认来源回答。" : "没有确认来源。",
            sourceHandles: context.sources.map((source) => source.handle),
            uncertainty: context.sources.length ? null : "无来源" };
        },
      },
    });
    const aliasPaperId = await importPaper(app, "2608.01001");
    const titlePaperId = await importPaper(app, "2608.01002");
    const saved = await app.inject({ method: "PUT",
      url: `/api/papers/${encodeURIComponent(aliasPaperId)}/organization`,
      headers: { "idempotency-key": "entry-resolver-alias" },
      payload: { aliases: [{ name: "GenCeption", kind: "model-name", preferred: true }], directions: [] } });
    expect(saved.statusCode, saved.body).toBe(200);

    const ambiguous = await app.inject({ method: "POST", url: "/api/entry-agent/questions",
      payload: { question: "GenCeption 的主要贡献是什么？" } });
    expect(ambiguous.statusCode, ambiguous.body).toBe(200);
    expect(ambiguous.json()).toMatchObject({
      answerStatus: "resolution_required",
      sources: [],
      resolution: { state: "ambiguous", reason: "collision",
        groups: [{ candidates: [
          { paperId: aliasPaperId, matchKind: "preferred-alias" },
          { paperId: titlePaperId, matchKind: "canonical-title" },
        ] }] },
    });
    expect(calls).toHaveLength(0);
    const group = ambiguous.json().resolution.groups[0];
    const resolved = await app.inject({ method: "POST", url: "/api/entry-agent/questions",
      payload: { question: "GenCeption 的主要贡献是什么？", resolutionSelection: {
        snapshotHash: ambiguous.json().resolution.snapshotHash,
        groups: { [group.id]: aliasPaperId },
      } } });
    expect(resolved.statusCode, resolved.body).toBe(200);
    expect(resolved.json()).toMatchObject({ answerStatus: "answered",
      resolution: { state: "resolved", matches: [{ paperId: aliasPaperId, text: "GenCeption" }] } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sources).toHaveLength(1);
    expect(calls[0]!.sources[0]).toMatchObject({ sourceType: "summary" });
    expect(JSON.stringify(calls[0]!.sources)).not.toContain("GenCeption");
    expect(Object.keys(calls[0]!).sort()).toEqual(["question", "sources"]);

    const forged = await app.inject({ method: "POST", url: "/api/entry-agent/questions",
      payload: { question: "GenCeption 的主要贡献是什么？", resolutionSelection: {
        snapshotHash: ambiguous.json().resolution.snapshotHash,
        groups: { [group.id]: "paper:forged" },
      } } });
    expect(forged.statusCode, forged.body).toBe(409);
    expect(forged.json().code).toBe("entry-paper-resolution-invalid");

    const bypassed = await app.inject({ method: "POST", url: "/api/entry-agent/questions",
      payload: { question: "GenCeption 的主要贡献是什么？", resolutionMode: "off" } });
    expect(bypassed.statusCode, bypassed.body).toBe(200);
    expect(bypassed.json().resolution.state).toBe("none");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.sources.every((source) => source.sourceId !== calls[0]!.sources[0]!.sourceId)).toBe(true);
    await app.close();
  });

  it("requires quotes for short and common aliases and rejects stale group snapshots", async () => {
    const layout = initializeDataRoot(join(await mkdtemp(join(tmpdir(), "scholarloom-entry-guard-")), "data"));
    let calls = 0;
    const app = await createApp({
      storageLayout: layout,
      paperSource: {
        async resolve(arxivId) { return { arxivId, latestVersion: 1, title: "Guarded Alias Paper",
          authors: ["Lin Guard"], year: 2026 }; },
        async fetchPdf() { return pdf("Guarded alias source."); },
      },
      codexRunner: {
        async runSummary() { return { sections: [{ key: "overview", title: "概述", body: "确认的通用摘要。" }],
          claims: [{ voice: "authors-claim" as const, claim: "A guarded result.", sourceHandle: "pdf-page:1" }],
          readStatus: "read" as const }; },
        async runEntry(context) { calls += 1; return { answerStatus: context.sources.length ? "answered" as const : "insufficient_evidence" as const,
          answer: "结果", sourceHandles: context.sources.map((source) => source.handle),
          uncertainty: context.sources.length ? null : "没有匹配的已确认来源。" }; },
      },
    });
    const paperId = await importPaper(app, "2608.02001");
    expect((await app.inject({ method: "PUT", url: `/api/papers/${encodeURIComponent(paperId)}/organization`,
      headers: { "idempotency-key": "guarded-aliases" }, payload: { aliases: [
        { name: "T5", kind: "model-name", preferred: true },
        { name: "Attention", kind: "method-name", preferred: false },
      ], directions: [] } })).statusCode).toBe(200);

    const shortBroad = await app.inject({ method: "POST", url: "/api/entry-agent/questions",
      payload: { question: "T5 有什么贡献？" } });
    expect(shortBroad.statusCode, shortBroad.body).toBe(200);
    expect(shortBroad.json().resolution.state).toBe("none");
    const quotedShort = await app.inject({ method: "POST", url: "/api/entry-agent/questions",
      payload: { question: "“T5” 有什么贡献？" } });
    expect(quotedShort.json().resolution).toMatchObject({ state: "resolved",
      matches: [{ paperId, text: "T5" }] });
    const commonBroad = await app.inject({ method: "POST", url: "/api/entry-agent/questions",
      payload: { question: "attention 的工作原理是什么？" } });
    expect(commonBroad.json().resolution.state).toBe("none");
    const quotedCommon = await app.inject({ method: "POST", url: "/api/entry-agent/questions",
      payload: { question: "「Attention」的贡献是什么？" } });
    expect(quotedCommon.json().resolution.state).toBe("resolved");

    const stale = await app.inject({ method: "POST", url: "/api/entry-agent/questions",
      payload: { question: "“T5” 有什么贡献？", resolutionSelection: {
        snapshotHash: "stale-snapshot", groups: { "resolution-group:stale": paperId },
      } } });
    expect(stale.statusCode, stale.body).toBe(409);
    expect(stale.json().code).toBe("entry-paper-resolution-stale");
    expect(calls).toBe(4);
    await app.close();
  });
});
