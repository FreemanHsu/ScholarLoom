import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { wilsonLowerBound } from "../src/storage/paper-organization-automation.js";
import { initializeDataRoot } from "../src/storage/layout.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const stableJson = (value: unknown) => JSON.stringify(value, (_key, item) => {
  if (!item || typeof item !== "object" || Array.isArray(item)) return item;
  return Object.fromEntries(Object.entries(item as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right)));
});

async function pdf(): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  document.addPage().drawText("A memorable whole-paper alias.", { x: 40, y: 700, font });
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

describe("Alias-only calibrated auto-accept", () => {
  it("uses the corrected Wilson gate", () => {
    expect(wilsonLowerBound(50, 50)).toBeLessThan(.95);
    expect(wilsonLowerBound(75, 75)).toBeGreaterThanOrEqual(.95);
  });

  it("stays disabled without evidence, then explicitly enables, applies and safely undoes an Alias", async () => {
    const root = await mkdtemp(join(tmpdir(), "scholarloom-alias-automation-"));
    const layout = initializeDataRoot(join(root, "data"));
    const clock = { now: () => new Date("2026-08-01T08:00:00.000Z") };
    const app = await createApp({
      storageLayout: layout,
      clock,
      paperSource: {
        async resolve() { return { arxivId: "2608.00001", latestVersion: 1,
          title: "General Alias Learners", authors: ["Ada Fixture"], year: 2026 }; },
        async fetchPdf() { return pdf(); },
      },
      codexRunner: {
        async runSummary() { return { sections: [{ key: "overview", title: "概述", body: "Alias 学习。" }],
          claims: [{ voice: "authors-claim" as const, claim: "Learns an alias.", sourceHandle: "pdf-page:1" }],
          readStatus: "read" as const }; },
      },
      paperOrganizationRunner: {
        async analyze() { return {
          coreProblem: "如何提供可记忆的 Paper 名称。", mainContribution: "给出整体 Paper Alias。",
          alias: { outcome: "proposal" as const, candidates: [{ name: "AliasLoom",
            kind: "project-name" as const, preferred: true, rationale: "该名称指代整篇 Paper。" }] },
          primary: { outcome: "no-fit" as const, recommendedTopicId: null, rationale: "当前目录无匹配方向。", alternatives: [] },
          secondary: { outcome: "not-needed" as const, candidates: [] },
          usage: { status: "unavailable" as const, inputTokens: 0, cachedInputTokens: 0,
            outputTokens: 0, totalTokens: 0 },
        }; },
      },
    });
    const imported = await app.inject({ method: "POST", url: "/api/imports",
      payload: { arxivUrl: "https://arxiv.org/abs/2608.00001" } });
    const paperId = imported.json().paper.id as string;
    const suggestions = await waitFor(
      async () => (await app.inject({ method: "GET",
        url: `/api/papers/${encodeURIComponent(paperId)}/organization-suggestions` })).json(),
      (value: any) => value.runs[0]?.state === "succeeded" && value.suggestions.length === 1,
    ) as any;
    let proposalId = suggestions.suggestions[0].id as string;
    const initial = await app.inject({ method: "POST", url: "/api/paper-organization/automation/evaluate" });
    expect(initial.statusCode, initial.body).toBe(200);
    expect(initial.json()).toMatchObject({ passed: false, labelCount: 0 });

    const database = new Database(layout.databasePath);
    const runtime = database.prepare(`SELECT a.model,m.manifest_json FROM paper_organization_runs r
      JOIN paper_organization_manifests m ON m.id=r.manifest_id
      LEFT JOIN agent_runs a ON a.job_run_id=r.job_run_id ORDER BY r.sequence DESC LIMIT 1`).get() as
      { model: string | null; manifest_json: string };
    const manifest = JSON.parse(runtime.manifest_json) as { promptHash: string; schemaHash: string };
    const tupleHash = hash(stableJson({ modelIdentity: runtime.model ?? "unknown",
      normalizationVersion: "paper-lookup.v1", predicateVersion: "alias-auto-accept.v1",
      promptHash: manifest.promptHash, schemaHash: manifest.schemaHash }));
    const terminal = "2026-06-01T08:00:00.000Z";
    const mature = "2026-07-01T08:00:00.000Z";
    database.transaction(() => {
      for (let index = 0; index < 75; index += 1) {
        const id = `proposal:calibration:${index}`;
        const payload = JSON.stringify({ sourceKind: "agent", changeKind: "alias", after: [{
          name: `Alias ${index}`, kind: "project-name", preferred: true,
        }] });
        database.prepare(`INSERT INTO proposals
          (id,proposal_type,paper_id,payload_json,review_status,one_click_eligible,created_at,decided_at)
          VALUES (?,'paper-organization',?,?,'accepted',1,?,?)`).run(id, paperId, payload, terminal, terminal);
        database.prepare(`INSERT INTO paper_organization_calibration_labels
          (proposal_id,paper_id,normalized_alias,outcome,exclusion_reason,review_decision_id,
           proposal_hash,resulting_hash,policy_tuple_hash,terminal_at,matures_at,created_at,updated_at)
          VALUES (?,? ,?,'accepted-unchanged',NULL,NULL,?,?,?, ?,?,?,?)`).run(id, paperId,
            `alias ${index}`, hash(payload), hash(`result:${index}`), tupleHash, terminal, mature, terminal, terminal);
      }
      database.prepare("DELETE FROM paper_organization_auto_events WHERE proposal_id=?").run(proposalId);
      let candidate = 0;
      while (Number.parseInt(hash(`proposal:auto-canary:${candidate}`).slice(0, 8), 16) % 10 === 0) candidate += 1;
      const nextId = `proposal:auto-canary:${candidate}`;
      database.prepare("UPDATE proposals SET id=? WHERE id=?").run(nextId, proposalId);
      proposalId = nextId;
    })();
    database.close();

    const evaluation = await app.inject({ method: "POST", url: "/api/paper-organization/automation/evaluate" });
    expect(evaluation.statusCode, evaluation.body).toBe(200);
    expect(evaluation.json()).toMatchObject({ passed: true, labelCount: 75, acceptedCount: 75 });
    const policy = await app.inject({ method: "POST", url: "/api/paper-organization/automation/policies",
      payload: { evaluationId: evaluation.json().id } });
    expect(policy.statusCode, policy.body).toBe(200);
    expect(policy.json()).toMatchObject({ version: 1, status: "eligible" });
    const enabled = await app.inject({ method: "POST",
      url: `/api/paper-organization/automation/policies/${encodeURIComponent(policy.json().id)}/enable` });
    expect(enabled.statusCode, enabled.body).toBe(200);
    expect(enabled.json().status).toBe("enabled");
    const paper = await waitFor(
      async () => (await app.inject({ method: "GET", url: "/api/papers?q=AliasLoom" })).json(),
      (value: any) => value.papers[0]?.preferredAlias === "AliasLoom",
    ) as any;
    expect(paper.papers[0].id).toBe(paperId);
    const model = (await app.inject({ method: "GET", url: "/api/paper-organization/automation" })).json();
    const event = model.events.find((item: any) => item.state === "succeeded");
    expect(event).toBeTruthy();
    const preview = await app.inject({ method: "POST",
      url: `/api/paper-organization/automation/events/${encodeURIComponent(event.id)}/undo/preview` });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json().safe).toBe(true);
    const undone = await app.inject({ method: "POST",
      url: `/api/paper-organization/automation/events/${encodeURIComponent(event.id)}/undo` });
    expect(undone.statusCode, undone.body).toBe(200);
    expect(undone.json()).toMatchObject({ state: "undone", policySuspended: true });
    expect((await app.inject({ method: "GET", url: "/api/paper-organization/automation" })).json().mode)
      .toBe("suspended");
    await app.close();
  });
});
