import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
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

async function waitForImport(app: FastifyInstance, id: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const result = await app.inject({ method: "GET", url: `/api/imports/${encodeURIComponent(id)}` });
    if (result.json().jobs.at(-1)?.state === "succeeded") return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("import-timeout");
}

describe("optional Domain → Direction hierarchy", () => {
  it("gates enablement, preserves parentage, filters/searches, and retains knowledge history", async () => {
    const layout = initializeDataRoot(join(await mkdtemp(join(tmpdir(), "scholarloom-domain-hierarchy-")), "data"));
    const app = await createApp({ storageLayout: layout,
      paperSource: {
        async resolve(arxivId) { return { arxivId, latestVersion: 1, title: "Hierarchy Paper",
          authors: ["Ada Domain"], year: 2026 }; },
        async fetchPdf() { return pdf("Hierarchy evidence"); },
      },
      codexRunner: { async runSummary() { return {
        sections: [{ key: "overview", title: "Overview", body: "Hierarchy evidence." }],
        claims: [{ voice: "authors-claim" as const, claim: "Evidence.", sourceHandle: "pdf-page:1" }],
        readStatus: "read" as const,
      }; } },
    });

    for (let index = 1; index <= 14; index += 1) {
      const response = await app.inject({ method: "POST", url: "/api/directions",
        headers: { "idempotency-key": `direction-${index}` }, payload: {
          id: `topic:direction-${index}`, title: `Direction ${index}`, scope: `Scope ${index}`,
        } });
      expect(response.statusCode, response.body).toBe(201);
    }
    expect((await app.inject({ method: "POST", url: "/api/taxonomy-hierarchy/enable",
      headers: { "idempotency-key": "enable-too-soon" } })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: "/api/directions",
      headers: { "idempotency-key": "direction-15" }, payload: {
        id: "topic:direction-15", title: "Direction 15", scope: "Scope 15",
      } })).statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: "/api/taxonomy-hierarchy/enable",
      headers: { "idempotency-key": "enable-hierarchy" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/domains",
      headers: { "idempotency-key": "create-domain" }, payload: {
        id: "topic:computer-vision", title: "Computer Vision", scope: "视觉研究的上层导航分组。",
      } })).statusCode).toBe(201);

    let directions = (await app.inject({ method: "GET", url: "/api/directions" })).json().directions;
    const direction = directions.find((item: { id: string }) => item.id === "topic:direction-1");
    let domain = (await app.inject({ method: "GET", url: "/api/domains" })).json().domains[0];
    const assigned = await app.inject({ method: "POST", url: "/api/directions/topic%3Adirection-1/domain",
      headers: { "idempotency-key": "assign-domain" }, payload: {
        parentDomainId: domain.id, expectedRevisionId: direction.revisionId,
        expectedMarkdownHash: direction.markdownHash, expectedParentRevisionId: domain.revisionId,
        expectedParentMarkdownHash: domain.markdownHash,
      } });
    expect(assigned.statusCode, assigned.body).toBe(200);

    directions = (await app.inject({ method: "GET", url: "/api/directions" })).json().directions;
    const grouped = directions.find((item: { id: string }) => item.id === "topic:direction-1");
    expect(grouped.parentDomainId).toBe(domain.id);
    const renamed = await app.inject({ method: "POST", url: "/api/directions/topic%3Adirection-1/rename",
      headers: { "idempotency-key": "rename-grouped-direction" }, payload: {
        title: "Grouped Direction", aliases: [], scope: grouped.scope, scopeMeaningUnchanged: true,
        expectedRevisionId: grouped.revisionId, expectedMarkdownHash: grouped.markdownHash,
      } });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/directions" })).json().directions
      .find((item: { id: string }) => item.id === grouped.id).parentDomainId).toBe(domain.id);

    const imported = await app.inject({ method: "POST", url: "/api/imports",
      payload: { arxivUrl: "https://arxiv.org/abs/2608.04001" } });
    await waitForImport(app, imported.json().importRequest.id);
    const paperId = imported.json().paper.id as string;
    expect((await app.inject({ method: "PUT", url: `/api/papers/${encodeURIComponent(paperId)}/organization`,
      headers: { "idempotency-key": "assign-paper-directions" }, payload: { aliases: [], directions: [
        { topicId: "topic:direction-1", role: "primary" },
        { topicId: "topic:direction-2", role: "secondary" },
      ] } })).statusCode).toBe(200);
    expect((await app.inject({ method: "PUT", url: `/api/papers/${encodeURIComponent(paperId)}/organization`,
      headers: { "idempotency-key": "reject-domain-paper-assignment" }, payload: { aliases: [], directions: [
        { topicId: domain.id, role: "primary" },
      ] } })).statusCode).toBe(409);

    expect((await app.inject({ method: "GET", url: "/api/papers?q=Computer%20Vision" })).json().papers).toHaveLength(1);
    expect((await app.inject({ method: "GET", url: "/api/papers?domain=topic%3Acomputer-vision" })).json().papers).toHaveLength(1);
    expect((await app.inject({ method: "GET", url: "/api/papers?domain=ungrouped" })).json().papers).toHaveLength(1);
    expect((await app.inject({ method: "POST", url: "/api/taxonomy-hierarchy/disable",
      headers: { "idempotency-key": "disable-hierarchy" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/papers?q=Computer%20Vision" })).json().papers).toHaveLength(0);
    expect((await app.inject({ method: "POST", url: "/api/taxonomy-hierarchy/enable",
      headers: { "idempotency-key": "reenable-hierarchy" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/papers?q=Computer%20Vision" })).json().papers).toHaveLength(1);

    const renamedDomain = await app.inject({ method: "POST", url: "/api/domains/topic%3Acomputer-vision/rename",
      headers: { "idempotency-key": "rename-domain" }, payload: {
        title: "Visual Domain", aliases: [], scope: domain.scope, scopeMeaningUnchanged: true,
        expectedRevisionId: domain.revisionId, expectedMarkdownHash: domain.markdownHash,
      } });
    expect(renamedDomain.statusCode, renamedDomain.body).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/papers?q=Computer%20Vision" })).json().papers).toHaveLength(0);
    expect((await app.inject({ method: "GET", url: "/api/papers?q=Visual%20Domain" })).json().papers).toHaveLength(1);
    domain = (await app.inject({ method: "GET", url: "/api/domains" })).json().domains[0];

    const knowledge = (await app.inject({ method: "GET", url: "/api/directions/topic%3Adirection-1/knowledge" })).json();
    const source = (await app.inject({ method: "GET",
      url: "/api/directions/topic%3Adirection-1/knowledge/provenance-options" })).json().sources[0];
    const promoted = await app.inject({ method: "POST",
      url: "/api/directions/topic%3Adirection-1/knowledge/revisions",
      headers: { "idempotency-key": "promote-grouped-topic" }, payload: {
        title: knowledge.title, aliases: knowledge.aliases, scope: knowledge.scope,
        parentDomainId: domain.id, expectedParentRevisionId: domain.revisionId,
        expectedParentMarkdownHash: domain.markdownHash, usageLevel: "knowledge-ready",
        sections: { ...knowledge.sections, Syntheses: "可复用的层级方向知识。" },
        provenance: [{ sourceType: source.sourceType, sourceId: source.sourceId }], ownerAttested: true,
        expectedRevisionId: knowledge.revisionId, expectedMarkdownHash: knowledge.markdownHash,
      } });
    expect(promoted.statusCode, promoted.body).toBe(201);
    const current = (await app.inject({ method: "GET", url: "/api/directions/topic%3Adirection-1/knowledge" })).json();
    const database = new Database(layout.databasePath, { readonly: true });
    const curatedBefore = database.prepare(`SELECT body FROM curated_search_documents
      WHERE source_type='topic-knowledge' AND source_id='topic:direction-1'`).pluck().get();
    database.close();
    const ungrouped = await app.inject({ method: "POST",
      url: "/api/directions/topic%3Adirection-1/knowledge/revisions",
      headers: { "idempotency-key": "ungroup-knowledge-topic" }, payload: {
        title: current.title, aliases: current.aliases, scope: current.scope, parentDomainId: null,
        usageLevel: "knowledge-ready", sections: current.sections, provenance: current.provenance,
        ownerAttested: true, expectedRevisionId: current.revisionId, expectedMarkdownHash: current.markdownHash,
      } });
    expect(ungrouped.statusCode, ungrouped.body).toBe(201);
    const after = (await app.inject({ method: "GET", url: "/api/directions/topic%3Adirection-1/knowledge" })).json();
    expect(after.parentDomainId).toBeNull();
    const check = new Database(layout.databasePath, { readonly: true });
    expect(check.prepare(`SELECT body FROM curated_search_documents
      WHERE source_type='topic-knowledge' AND source_id='topic:direction-1'`).pluck().get()).toBe(curatedBefore);
    expect(check.prepare(`SELECT count(*) FROM topic_knowledge_revisions
      WHERE topic_id='topic:direction-1' AND history_path IS NOT NULL`).pluck().get()).toBeGreaterThanOrEqual(2);
    check.close();
    expect(await readFile(join(layout.vaultRoot, "knowledge", "topics", "direction-1.md"), "utf8"))
      .toContain("parent_domain_id: null");
    await app.close();
  }, 20_000);
});
