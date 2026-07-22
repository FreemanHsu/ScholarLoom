import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { initializeDataRoot } from "../src/storage/layout.js";

describe("agentic evidence schema", () => {
  it("installs forward-only visual evidence storage without overloading text receipts", async () => {
    const root = await mkdtemp(join(tmpdir(), "scholarloom-visual-schema-"));
    const layout = initializeDataRoot(join(root, "data"));
    const app = await createApp({ storageLayout: layout, paperSource: { async resolve() { throw new Error("unused"); } } });
    await app.close();

    const database = new Database(layout.databasePath);
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").pluck().all() as string[];
    expect(tables).toEqual(expect.arrayContaining([
      "visual_render_artifacts",
      "visual_page_inspections",
      "visual_evidence_receipts",
    ]));
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type='view' AND name='all_evidence_receipts'").get()).toBeTruthy();
    expect(database.prepare("PRAGMA table_info(visual_render_artifacts)").all())
      .toEqual(expect.arrayContaining([expect.objectContaining({ name: "page_count", notnull: 1 })]));
    expect(database.prepare("PRAGMA foreign_key_list(visual_page_inspections)").all())
      .toEqual(expect.arrayContaining([expect.objectContaining({ from: "render_artifact_id", on_delete: "SET NULL" })]));
    expect(() => database.prepare(`INSERT INTO evidence_receipts
      (id,job_run_id,run_epoch,message_id,ordinal,evidence_kind,source_id,workspace_path,locator_json,
       content_hash,quote_text,verification_status,created_at)
      VALUES ('receipt:visual-invalid','missing-job',1,NULL,1,'visual','source','visual','{}','hash','fake','verified','now')`).run())
      .toThrow();
    database.close();
  });

  it("installs frozen corpus/workspace/run records and immutable Summary source guards", async () => {
    const root = await mkdtemp(join(tmpdir(), "scholarloom-agentic-schema-"));
    const layout = initializeDataRoot(join(root, "data"));
    const app = await createApp({
      storageLayout: layout,
      paperSource: { async resolve(arxivId) {
        return { arxivId, latestVersion: 1, title: "Fixture", authors: ["Ada Fixture"], year: 2026 };
      } },
    });
    await app.close();

    const database = new Database(layout.databasePath);
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").pluck().all() as string[];
    expect(tables).toEqual(expect.arrayContaining([
      "knowledge_corpus_manifests",
      "evidence_workspaces",
      "agent_run_activities",
      "agent_run_usage",
      "evidence_receipts",
    ]));
    const snapshotColumns = database.prepare("PRAGMA table_info(context_snapshots)").all() as Array<{ name: string }>;
    expect(snapshotColumns.map((column) => column.name)).toContain("knowledge_corpus_manifest_id");
    const runColumns = database.prepare("PRAGMA table_info(job_runs)").all() as Array<{ name: string }>;
    expect(runColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "run_epoch", "lease_owner", "lease_expires_at", "cancel_requested_at", "runner_kind", "failure_kind",
    ]));
    database.close();
  });

  it("freezes a curated Knowledge Corpus Manifest into each new Context Snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "scholarloom-corpus-freeze-"));
    const layout = initializeDataRoot(join(root, "data"));
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    pdf.addPage().drawText("Frozen corpus fixture", { x: 40, y: 700, font });
    const bytes = await pdf.save();
    const app = await createApp({
      storageLayout: layout,
      paperSource: {
        async resolve(arxivId) { return { arxivId, latestVersion: 1, title: "Corpus Fixture", authors: ["Ada Fixture"], year: 2026 }; },
        async fetchPdf() { return bytes; },
      },
      codexRunner: { async runSummary() { return {
        sections: [{ key: "overview", title: "概述", body: "Frozen corpus fixture" }],
        claims: [{ voice: "paper-evidence", claim: "Frozen corpus fixture", sourceHandle: "pdf-page:1" }],
        readStatus: "read",
      }; } },
    });
    const imported = await app.inject({ method: "POST", url: "/api/imports", payload: { arxivUrl: "https://arxiv.org/abs/2601.00001v1" } });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const status = await app.inject({ method: "GET", url: `/api/imports/${imported.json().importRequest.id}` });
      if (status.json().jobs.at(-1)?.state === "succeeded") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const created = await app.inject({ method: "POST", url: `/api/papers/${encodeURIComponent(imported.json().paper.id)}/conversations` });
    expect(created.statusCode, created.body).toBe(201);

    const database = new Database(layout.databasePath);
    const frozen = database.prepare(`SELECT cs.knowledge_corpus_manifest_id manifest_id,m.manifest_hash,m.manifest_json
      FROM context_snapshots cs JOIN knowledge_corpus_manifests m ON m.id=cs.knowledge_corpus_manifest_id
      WHERE cs.id=?`).get(created.json().contextSnapshot.id) as { manifest_id: string; manifest_hash: string; manifest_json: string };
    expect(frozen.manifest_id).toMatch(/^knowledge-corpus:/);
    expect(frozen.manifest_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(frozen.manifest_json)).toEqual({ summaries: [], knowledge: [] });
    expect(() => database.prepare("UPDATE knowledge_corpus_manifests SET manifest_json='{}' WHERE id=?")
      .run(frozen.manifest_id)).toThrow(/knowledge-corpus-manifest-immutable/);
    database.close();
    await app.close();
  });
});
