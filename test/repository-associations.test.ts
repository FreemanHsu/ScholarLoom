import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { PDFDocument, StandardFonts } from "pdf-lib";
import Database from "better-sqlite3";

import { createApp } from "../src/app.js";
import { GitRepositoryAdapter, type RepositoryAdapter } from "../src/adapters/git-repository.js";
import { initializeDataRoot } from "../src/storage/layout.js";

const apps: FastifyInstance[] = [];
const exec = promisify(execFile);

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function createPaper(repositoryAdapter?: RepositoryAdapter): Promise<{
  app: FastifyInstance;
  paperId: string;
  layout: ReturnType<typeof initializeDataRoot>;
}> {
  const root = await mkdtemp(join(tmpdir(), "scholarloom-repository-association-"));
  const layout = initializeDataRoot(join(root, "data"));
  const app = await createApp({
    storageLayout: layout,
    ...(repositoryAdapter ? { repositoryAdapter } : {}),
    paperSource: {
      async resolve() {
        return { arxivId: "2401.12345", latestVersion: 1, title: "Repository Association",
          authors: ["Fixture Author"], year: 2024 };
      },
    },
  });
  apps.push(app);
  const imported = await app.inject({
    method: "POST",
    url: "/api/imports",
    payload: { arxivUrl: "https://arxiv.org/abs/2401.12345v1" },
  });
  return { app, paperId: imported.json().paper.id as string, layout };
}

async function createBareRepository(): Promise<{ bare: string; working: string; branch: string; commitSha: string }> {
  const root = await mkdtemp(join(tmpdir(), "scholarloom-manual-git-"));
  const working = join(root, "working");
  const bare = join(root, "repository.git");
  await exec("git", ["init", working]);
  await exec("git", ["-C", working, "config", "user.email", "fixture@example.test"]);
  await exec("git", ["-C", working, "config", "user.name", "Fixture"]);
  await writeFile(join(working, "README.md"), "# Manual repository\n", "utf8");
  await exec("git", ["-C", working, "add", "."]);
  await exec("git", ["-C", working, "commit", "-m", "fixture"]);
  const { stdout } = await exec("git", ["-C", working, "rev-parse", "HEAD"]);
  const { stdout: branch } = await exec("git", ["-C", working, "branch", "--show-current"]);
  await exec("git", ["clone", "--bare", working, bare]);
  return { bare, working, branch: branch.trim(), commitSha: stdout.trim() };
}

async function pdfWithRepositoryUrl(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage().drawText("Code: https://github.com/Owner/Repository.git/", { x: 40, y: 700, font, size: 10 });
  return pdf.save();
}

async function createPaperWithRepositoryUrl(repositoryAdapter: RepositoryAdapter): Promise<{
  app: FastifyInstance;
  paperId: string;
  layout: ReturnType<typeof initializeDataRoot>;
}> {
  const root = await mkdtemp(join(tmpdir(), "scholarloom-detected-repository-"));
  const layout = initializeDataRoot(join(root, "data"));
  const app = await createApp({
    storageLayout: layout,
    repositoryAdapter,
    paperSource: {
      async resolve() {
        return { arxivId: "2401.67890", latestVersion: 1, title: "Detected Repository",
          authors: ["Fixture Author"], year: 2024 };
      },
      async fetchPdf() { return pdfWithRepositoryUrl(); },
    },
    codexRunner: {
      async runSummary() {
        return {
          sections: [{ key: "overview", title: "概述", body: "fixture" }],
          claims: [{ voice: "paper-evidence", claim: "Code:", sourceHandle: "pdf-page:1" }],
          readStatus: "read",
        };
      },
    },
  });
  apps.push(app);
  const imported = await app.inject({
    method: "POST",
    url: "/api/imports",
    payload: { arxivUrl: "https://arxiv.org/abs/2401.67890v1" },
  });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const status = await app.inject({ method: "GET", url: `/api/imports/${imported.json().importRequest.id}` });
    if (status.json().jobs.at(-1)?.state === "succeeded") break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return { app, paperId: imported.json().paper.id as string, layout };
}

async function createLegacyCandidatePaper(repositoryAdapter: RepositoryAdapter): Promise<{
  app: FastifyInstance;
  paperId: string;
  layout: ReturnType<typeof initializeDataRoot>;
}> {
  const fixture = await createPaperWithRepositoryUrl(repositoryAdapter);
  const canonicalUrl = "https://github.com/owner/repository";
  const repositoryId = "repository:96f59fe1cf90499e";
  const timestamp = "2026-07-23T00:00:00.000Z";
  const database = new Database(fixture.layout.databasePath);
  database.prepare(`INSERT INTO code_repositories
    (id,canonical_url,host,owner_name,repository_name,availability_status,created_at,updated_at)
    VALUES (?,?, 'github.com','owner','repository','unavailable',?,?)`)
    .run(repositoryId, canonicalUrl, timestamp, timestamp);
  database.prepare(`INSERT INTO paper_code_links
    (id,paper_id,code_repository_id,link_type,origin,status,repository_snapshot_id,created_at)
    VALUES (?,?,?,'unknown','detected','candidate',NULL,?)`)
    .run(`paper-code-link:${fixture.paperId}:${repositoryId}`, fixture.paperId, repositoryId, timestamp);
  database.close();
  return fixture;
}

describe("repository associations", () => {
  it("removes a historical candidate and hides it from the current Paper", async () => {
    const { app, paperId, layout } = await createLegacyCandidatePaper({
      async materialize() { return { commitSha: "a".repeat(40) }; },
    });
    const before = await app.inject({
      method: "GET",
      url: `/api/papers/${paperId}/repositories`,
    });
    const associationId = before.json().repositories[0].id as string;

    const removed = await app.inject({
      method: "POST",
      url: `/api/papers/${paperId}/repositories/${encodeURIComponent(associationId)}/remove`,
      headers: { "idempotency-key": "remove-historical-candidate" },
    });
    const listed = await app.inject({
      method: "GET",
      url: `/api/papers/${paperId}/repositories`,
    });
    const database = new Database(layout.databasePath);
    const ledger = database.prepare(`SELECT state,output_json FROM job_runs
      WHERE job_type='repository-association-remove' AND idempotency_key=?`)
      .get("remove-historical-candidate") as { state: string; output_json: string } | undefined;
    database.close();

    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toEqual({ ok: true, replayed: false });
    expect(listed.json()).toEqual({ repositories: [] });
    expect(ledger).toEqual({
      state: "succeeded",
      output_json: JSON.stringify({
        previousStatus: "candidate",
        repositorySnapshotId: null,
        status: "rejected",
      }),
    });
  });

  it("does not allow the confirm command to reactivate a removed association", async () => {
    const { app, paperId } = await createLegacyCandidatePaper({
      async materialize() { return { commitSha: "a".repeat(40) }; },
    });
    const before = await app.inject({ method: "GET", url: `/api/papers/${paperId}/repositories` });
    const associationId = before.json().repositories[0].id as string;
    await app.inject({
      method: "POST",
      url: `/api/papers/${paperId}/repositories/${encodeURIComponent(associationId)}/remove`,
      headers: { "idempotency-key": "remove-before-confirm" },
    });

    const confirmed = await app.inject({
      method: "POST",
      url: `/api/papers/${paperId}/repositories/${encodeURIComponent(associationId)}/confirm`,
      headers: { "idempotency-key": "confirm-after-remove" },
    });

    expect(confirmed.statusCode).toBe(409);
    expect(confirmed.json()).toEqual({ code: "repository-association-not-confirmable" });
  });

  it("reactivates a removed association only through manual add and ignores a delayed remove replay", async () => {
    let finish!: (value: { commitSha: string }) => void;
    const materialized = new Promise<{ commitSha: string }>((resolve) => { finish = resolve; });
    const { app, paperId } = await createLegacyCandidatePaper({ materialize: async () => materialized });
    const before = await app.inject({ method: "GET", url: `/api/papers/${paperId}/repositories` });
    const associationId = before.json().repositories[0].id as string;
    await app.inject({
      method: "POST",
      url: `/api/papers/${paperId}/repositories/${encodeURIComponent(associationId)}/remove`,
      headers: { "idempotency-key": "remove-before-readd" },
    });

    const added = await app.inject({
      method: "POST",
      url: `/api/papers/${paperId}/repositories`,
      headers: { "idempotency-key": "readd-removed-repository" },
      payload: { url: "https://github.com/owner/repository.git/" },
    });
    const delayedReplay = await app.inject({
      method: "POST",
      url: `/api/papers/${paperId}/repositories/${encodeURIComponent(associationId)}/remove`,
      headers: { "idempotency-key": "remove-before-readd" },
    });
    const listed = await app.inject({ method: "GET", url: `/api/papers/${paperId}/repositories` });

    expect(added.statusCode).toBe(202);
    expect(delayedReplay.json()).toEqual({ ok: true, replayed: true });
    expect(listed.json().repositories).toEqual([
      expect.objectContaining({
        id: associationId,
        origin: "manual",
        associationStatus: "confirmed",
        materializationStatus: "running",
      }),
    ]);
    finish({ commitSha: "a".repeat(40) });
  });

  it("reuses an in-flight materialization when a removed association is manually re-added", async () => {
    const repository = await createBareRepository();
    let finish!: () => void;
    let calls = 0;
    const continueMaterialization = new Promise<void>((resolve) => { finish = resolve; });
    const adapter = new GitRepositoryAdapter({ "https://github.com/owner/repository": repository.bare });
    const { app, paperId } = await createPaper({
      async materialize(canonicalUrl, destination, expectedCommitSha) {
        calls += 1;
        await continueMaterialization;
        return adapter.materialize(canonicalUrl, destination, expectedCommitSha);
      },
    });
    const first = await app.inject({
      method: "POST",
      url: `/api/papers/${paperId}/repositories`,
      headers: { "idempotency-key": "add-before-running-remove" },
      payload: { url: "https://github.com/owner/repository" },
    });
    const associationId = first.json().association.id as string;
    await app.inject({
      method: "POST",
      url: `/api/papers/${paperId}/repositories/${encodeURIComponent(associationId)}/remove`,
      headers: { "idempotency-key": "remove-while-running" },
    });

    const readded = await app.inject({
      method: "POST",
      url: `/api/papers/${paperId}/repositories`,
      headers: { "idempotency-key": "readd-while-running" },
      payload: { url: "https://github.com/owner/repository" },
    });
    const running = await app.inject({ method: "GET", url: `/api/papers/${paperId}/repositories` });

    expect(readded.statusCode).toBe(200);
    expect(readded.json().replayed).toBe(true);
    expect(calls).toBe(1);
    expect(running.json().repositories[0]).toEqual(expect.objectContaining({
      associationStatus: "confirmed",
      materializationStatus: "running",
    }));

    finish();
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const listed = await app.inject({ method: "GET", url: `/api/papers/${paperId}/repositories` });
      if (listed.json().repositories[0]?.materializationStatus === "ready") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const ready = await app.inject({ method: "GET", url: `/api/papers/${paperId}/repositories` });
    expect(ready.json().repositories[0]).toEqual(expect.objectContaining({
      materializationStatus: "ready",
      commitSha: repository.commitSha,
    }));
  });

  it("keeps an association removed when its in-flight materialization completes late", async () => {
    const repository = await createBareRepository();
    let finish!: () => void;
    const continueMaterialization = new Promise<void>((resolve) => { finish = resolve; });
    const adapter = new GitRepositoryAdapter({ "https://github.com/owner/repository": repository.bare });
    const { app, paperId, layout } = await createPaper({
      async materialize(canonicalUrl, destination, expectedCommitSha) {
        await continueMaterialization;
        return adapter.materialize(canonicalUrl, destination, expectedCommitSha);
      },
    });
    const added = await app.inject({
      method: "POST",
      url: `/api/papers/${paperId}/repositories`,
      headers: { "idempotency-key": "late-completion-add" },
      payload: { url: "https://github.com/owner/repository" },
    });
    const associationId = added.json().association.id as string;
    await app.inject({
      method: "POST",
      url: `/api/papers/${paperId}/repositories/${encodeURIComponent(associationId)}/remove`,
      headers: { "idempotency-key": "late-completion-remove" },
    });

    finish();
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const database = new Database(layout.databasePath);
      const state = database.prepare(`SELECT state FROM job_runs WHERE job_type='repository-materialization'
        AND json_extract(input_json,'$.associationId')=? ORDER BY attempt DESC LIMIT 1`)
        .get(associationId) as { state: string };
      database.close();
      if (state.state === "succeeded") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const listed = await app.inject({ method: "GET", url: `/api/papers/${paperId}/repositories` });
    const database = new Database(layout.databasePath);
    const stored = database.prepare(`SELECT status,repository_snapshot_id FROM paper_code_links WHERE id=?`)
      .get(associationId) as { status: string; repository_snapshot_id: string | null };
    const snapshotCount = (database.prepare(`SELECT count(*) count FROM repository_snapshots`)
      .get() as { count: number }).count;
    database.close();

    expect(listed.json()).toEqual({ repositories: [] });
    expect(stored).toEqual({ status: "rejected", repository_snapshot_id: null });
    expect(snapshotCount).toBe(1);
  });

  it("rejects an invalid manual URL without creating an association", async () => {
    const { app, paperId } = await createPaper();

    const added = await app.inject({
      method: "POST",
      url: `/api/papers/${paperId}/repositories`,
      headers: { "idempotency-key": "invalid-url" },
      payload: { url: "https://github.com/owner/repository/issues/1" },
    });
    const listed = await app.inject({
      method: "GET",
      url: `/api/papers/${paperId}/repositories`,
    });

    expect(added.statusCode).toBe(422);
    expect(added.json()).toEqual({ code: "invalid-github-repository-url" });
    expect(listed.json()).toEqual({ repositories: [] });
  });

  it("confirms a manual association while its materialization remains observable", async () => {
    let finish!: (value: { commitSha: string }) => void;
    const materialized = new Promise<{ commitSha: string }>((resolve) => { finish = resolve; });
    const { app, paperId } = await createPaper({ materialize: async () => materialized });

    const added = await app.inject({
      method: "POST",
      url: `/api/papers/${paperId}/repositories`,
      headers: { "idempotency-key": "add-manual-repository" },
      payload: { url: "https://github.com/Owner/Repository.git/" },
    });
    const listed = await app.inject({
      method: "GET",
      url: `/api/papers/${paperId}/repositories`,
    });

    expect(added.statusCode).toBe(202);
    expect(listed.json().repositories).toEqual([
      expect.objectContaining({
        owner: "owner",
        repository: "repository",
        canonicalUrl: "https://github.com/owner/repository",
        origin: "manual",
        associationStatus: "confirmed",
        materializationStatus: "running",
        commitSha: null,
      }),
    ]);
    finish({ commitSha: "a".repeat(40) });
  });

  it("materializes a manual association at a fixed commit", async () => {
    const repository = await createBareRepository();
    const canonicalUrl = "https://github.com/owner/repository";
    const { app, paperId } = await createPaper(new GitRepositoryAdapter({ [canonicalUrl]: repository.bare }));

    const added = await app.inject({
      method: "POST",
      url: `/api/papers/${paperId}/repositories`,
      headers: { "idempotency-key": "materialize-manual-repository" },
      payload: { url: canonicalUrl },
    });
    let association: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const listed = await app.inject({ method: "GET", url: `/api/papers/${paperId}/repositories` });
      association = listed.json().repositories[0];
      if (association?.materializationStatus === "ready") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(added.statusCode).toBe(202);
    expect(association).toMatchObject({
      canonicalUrl,
      materializationStatus: "ready",
      commitSha: repository.commitSha,
      materializedPath: expect.stringMatching(/^cache\/repositories\/[a-f0-9]{16}$/),
      failureReason: null,
    });
  });

  it("returns the existing association without materializing a canonical duplicate", async () => {
    const repository = await createBareRepository();
    const canonicalUrl = "https://github.com/owner/repository";
    const git = new GitRepositoryAdapter({ [canonicalUrl]: repository.bare });
    let materializations = 0;
    const { app, paperId } = await createPaper({
      async materialize(url, destination) {
        materializations += 1;
        return git.materialize(url, destination);
      },
    });
    const first = await app.inject({
      method: "POST",
      url: `/api/papers/${paperId}/repositories`,
      headers: { "idempotency-key": "canonical-duplicate-1" },
      payload: { url: "https://github.com/Owner/Repository.git/" },
    });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const listed = await app.inject({ method: "GET", url: `/api/papers/${paperId}/repositories` });
      if (listed.json().repositories[0]?.materializationStatus === "ready") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const duplicate = await app.inject({
      method: "POST",
      url: `/api/papers/${paperId}/repositories`,
      headers: { "idempotency-key": "canonical-duplicate-2" },
      payload: { url: canonicalUrl },
    });
    const listed = await app.inject({ method: "GET", url: `/api/papers/${paperId}/repositories` });

    expect(first.statusCode).toBe(202);
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json()).toMatchObject({ ok: true, replayed: true });
    expect(listed.json().repositories).toHaveLength(1);
    expect(materializations).toBe(1);
  });

  it("keeps archived Paper associations readable while rejecting mutation", async () => {
    const repository = await createBareRepository();
    const canonicalUrl = "https://github.com/owner/repository";
    const { app, paperId, layout } = await createPaper(
      new GitRepositoryAdapter({ [canonicalUrl]: repository.bare }),
    );
    await app.inject({
      method: "POST",
      url: `/api/papers/${paperId}/repositories`,
      headers: { "idempotency-key": "archive-existing" },
      payload: { url: canonicalUrl },
    });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const listed = await app.inject({ method: "GET", url: `/api/papers/${paperId}/repositories` });
      if (listed.json().repositories[0]?.materializationStatus === "ready") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const database = new Database(layout.databasePath);
    database.prepare("UPDATE papers SET lifecycle_status='archived' WHERE id=?").run(paperId);
    database.close();

    const listed = await app.inject({ method: "GET", url: `/api/papers/${paperId}/repositories` });
    const rejected = await app.inject({
      method: "POST",
      url: `/api/papers/${paperId}/repositories`,
      headers: { "idempotency-key": "archive-rejected" },
      payload: { url: "https://github.com/owner/another-repository" },
    });

    expect(listed.json().repositories[0]).toMatchObject({
      canonicalUrl,
      materializationStatus: "ready",
    });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json()).toEqual({ code: "paper-not-active" });
  });

  it("does not associate a repository URL found in Paper text", async () => {
    let materializations = 0;
    const { app, paperId } = await createPaperWithRepositoryUrl({
      async materialize() {
        materializations += 1;
        return { commitSha: "b".repeat(40) };
      },
    });
    const listed = await app.inject({
      method: "GET",
      url: `/api/papers/${paperId}/repositories`,
    });

    expect(listed.json()).toEqual({ repositories: [] });
    expect(materializations).toBe(0);
  });

  it("confirms a detected candidate before materialization starts", async () => {
    let finish!: (value: { commitSha: string }) => void;
    const materialized = new Promise<{ commitSha: string }>((resolve) => { finish = resolve; });
    const { app, paperId } = await createLegacyCandidatePaper({ materialize: async () => materialized });
    const before = await app.inject({ method: "GET", url: `/api/papers/${paperId}/repositories` });
    const associationId = before.json().repositories[0].id as string;

    const confirmed = await app.inject({
      method: "POST",
      url: `/api/papers/${paperId}/repositories/${encodeURIComponent(associationId)}/confirm`,
      headers: { "idempotency-key": "confirm-detected-repository" },
    });
    const listed = await app.inject({ method: "GET", url: `/api/papers/${paperId}/repositories` });

    expect(confirmed.statusCode).toBe(202);
    expect(listed.json().repositories[0]).toMatchObject({
      origin: "detected",
      associationStatus: "confirmed",
      materializationStatus: "running",
      commitSha: null,
    });
    finish({ commitSha: "c".repeat(40) });
  });

  it("confirms a historical candidate after a prior materialization attempt", async () => {
    let finish!: (value: { commitSha: string }) => void;
    const materialized = new Promise<{ commitSha: string }>((resolve) => { finish = resolve; });
    const { app, paperId, layout } = await createLegacyCandidatePaper({ materialize: async () => materialized });
    const before = await app.inject({ method: "GET", url: `/api/papers/${paperId}/repositories` });
    const associationId = before.json().repositories[0].id as string;
    const timestamp = "2026-07-23T00:00:00.000Z";
    const database = new Database(layout.databasePath);
    database.prepare(`INSERT INTO job_runs
      (id,job_type,paper_id,state,progress,attempt,idempotency_key,input_json,queued_at,started_at,completed_at,heartbeat_at)
      VALUES (?,'repository-materialization',?,'failed',1,1,?,?,?,?,?,?)`)
      .run(`job:repository-materialization:${associationId}:1`, paperId, "historical-materialization-attempt",
        JSON.stringify({ associationId }), timestamp, timestamp, timestamp, timestamp);
    database.close();

    const confirmed = await app.inject({
      method: "POST",
      url: `/api/papers/${paperId}/repositories/${encodeURIComponent(associationId)}/confirm`,
      headers: { "idempotency-key": "confirm-after-historical-attempt" },
    });
    const listed = await app.inject({ method: "GET", url: `/api/papers/${paperId}/repositories` });

    expect(confirmed.statusCode).toBe(202);
    expect(listed.json().repositories[0]).toMatchObject({
      associationStatus: "confirmed",
      materializationStatus: "running",
    });
    finish({ commitSha: "c".repeat(40) });
  });

  it("treats manual addition of a detected candidate as confirmation", async () => {
    let finish!: (value: { commitSha: string }) => void;
    const materialized = new Promise<{ commitSha: string }>((resolve) => { finish = resolve; });
    const { app, paperId } = await createLegacyCandidatePaper({ materialize: async () => materialized });

    const added = await app.inject({
      method: "POST",
      url: `/api/papers/${paperId}/repositories`,
      headers: { "idempotency-key": "manually-confirm-detected-repository" },
      payload: { url: "https://github.com/owner/repository" },
    });
    const listed = await app.inject({ method: "GET", url: `/api/papers/${paperId}/repositories` });

    expect(added.statusCode).toBe(202);
    expect(listed.json().repositories).toEqual([
      expect.objectContaining({
        origin: "detected",
        associationStatus: "confirmed",
        materializationStatus: "running",
      }),
    ]);
    finish({ commitSha: "d".repeat(40) });
  });

  it("keeps a failed association readable and retries it explicitly", async () => {
    const repository = await createBareRepository();
    const canonicalUrl = "https://github.com/owner/repository";
    const git = new GitRepositoryAdapter({ [canonicalUrl]: repository.bare });
    let attempts = 0;
    const { app, paperId } = await createPaper({
      async materialize(url, destination) {
        attempts += 1;
        if (attempts === 1) throw new Error("fixture clone unavailable");
        return git.materialize(url, destination);
      },
    });
    await app.inject({
      method: "POST",
      url: `/api/papers/${paperId}/repositories`,
      headers: { "idempotency-key": "failed-repository-1" },
      payload: { url: canonicalUrl },
    });
    let failed: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const listed = await app.inject({ method: "GET", url: `/api/papers/${paperId}/repositories` });
      failed = listed.json().repositories[0];
      if (failed?.materializationStatus === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const retried = await app.inject({
      method: "POST",
      url: `/api/papers/${paperId}/repositories/${encodeURIComponent(String(failed?.id))}/retry`,
      headers: { "idempotency-key": "failed-repository-2" },
    });
    let ready: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const listed = await app.inject({ method: "GET", url: `/api/papers/${paperId}/repositories` });
      ready = listed.json().repositories[0];
      if (ready?.materializationStatus === "ready") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(failed).toMatchObject({
      associationStatus: "confirmed",
      materializationStatus: "failed",
      failureReason: "fixture clone unavailable",
    });
    expect(retried.statusCode).toBe(202);
    expect(ready).toMatchObject({
      materializationStatus: "ready",
      commitSha: repository.commitSha,
      failureReason: null,
    });
    expect(attempts).toBe(2);
  });

  it("marks interrupted materialization on restart and ignores its late completion", async () => {
    const root = await mkdtemp(join(tmpdir(), "scholarloom-repository-restart-"));
    const layout = initializeDataRoot(join(root, "data"));
    let finishOld!: (value: { commitSha: string }) => void;
    const oldMaterialization = new Promise<{ commitSha: string }>((resolve) => { finishOld = resolve; });
    const paperSource = {
      async resolve() {
        return { arxivId: "2401.99999", latestVersion: 1, title: "Restart Repository",
          authors: ["Fixture Author"], year: 2024 };
      },
    };
    const firstApp = await createApp({
      storageLayout: layout,
      repositoryAdapter: { materialize: async () => oldMaterialization },
      paperSource,
    });
    apps.push(firstApp);
    const imported = await firstApp.inject({
      method: "POST",
      url: "/api/imports",
      payload: { arxivUrl: "https://arxiv.org/abs/2401.99999v1" },
    });
    const paperId = imported.json().paper.id as string;
    await firstApp.inject({
      method: "POST",
      url: `/api/papers/${paperId}/repositories`,
      headers: { "idempotency-key": "restart-repository-1" },
      payload: { url: "https://github.com/owner/repository" },
    });

    const repository = await createBareRepository();
    const canonicalUrl = "https://github.com/owner/repository";
    const secondApp = await createApp({
      storageLayout: layout,
      repositoryAdapter: new GitRepositoryAdapter({ [canonicalUrl]: repository.bare }),
      paperSource,
    });
    apps.push(secondApp);
    const interrupted = await secondApp.inject({ method: "GET", url: `/api/papers/${paperId}/repositories` });
    const associationId = interrupted.json().repositories[0].id as string;
    const retried = await secondApp.inject({
      method: "POST",
      url: `/api/papers/${paperId}/repositories/${encodeURIComponent(associationId)}/retry`,
      headers: { "idempotency-key": "restart-repository-2" },
    });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const listed = await secondApp.inject({ method: "GET", url: `/api/papers/${paperId}/repositories` });
      if (listed.json().repositories[0]?.materializationStatus === "ready") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    finishOld({ commitSha: "e".repeat(40) });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const afterLateCompletion = await secondApp.inject({
      method: "GET",
      url: `/api/papers/${paperId}/repositories`,
    });

    expect(interrupted.json().repositories[0]).toMatchObject({ materializationStatus: "interrupted" });
    expect(retried.statusCode).toBe(202);
    expect(afterLateCompletion.json().repositories[0]).toMatchObject({
      materializationStatus: "ready",
      commitSha: repository.commitSha,
    });
  });

  it("reuses an existing fixed snapshot when another Paper manually adds the repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "scholarloom-shared-repository-"));
    const repository = await createBareRepository();
    const canonicalUrl = "https://github.com/owner/repository";
    const git = new GitRepositoryAdapter({ [canonicalUrl]: repository.bare });
    let materializations = 0;
    const layout = initializeDataRoot(join(root, "data"));
    const app = await createApp({
      storageLayout: layout,
      repositoryAdapter: {
        async materialize(url, destination, expectedCommitSha) {
          materializations += 1;
          return git.materialize(url, destination, expectedCommitSha);
        },
      },
      paperSource: {
        async resolve(arxivId) {
          return { arxivId, latestVersion: 1, title: `Paper ${arxivId}`, authors: ["Fixture Author"], year: 2024 };
        },
        async fetchPdf() { return pdfWithRepositoryUrl(); },
      },
      codexRunner: {
        async runSummary() {
          return {
            sections: [{ key: "overview", title: "概述", body: "fixture" }],
            claims: [{ voice: "paper-evidence", claim: "Code:", sourceHandle: "pdf-page:1" }],
            readStatus: "read",
          };
        },
      },
    });
    apps.push(app);
    const firstImport = await app.inject({ method: "POST", url: "/api/imports",
      payload: { arxivUrl: "https://arxiv.org/abs/2401.11111v1" } });
    const secondImport = await app.inject({ method: "POST", url: "/api/imports",
      payload: { arxivUrl: "https://arxiv.org/abs/2401.22222v1" } });
    for (const imported of [firstImport, secondImport]) {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const status = await app.inject({ method: "GET",
          url: `/api/imports/${imported.json().importRequest.id}` });
        if (status.json().jobs.at(-1)?.state === "succeeded") break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    const firstPaperId = firstImport.json().paper.id as string;
    const secondPaperId = secondImport.json().paper.id as string;
    await app.inject({ method: "POST", url: `/api/papers/${firstPaperId}/repositories`,
      headers: { "idempotency-key": "shared-repository-1" }, payload: { url: canonicalUrl } });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const listed = await app.inject({ method: "GET", url: `/api/papers/${firstPaperId}/repositories` });
      if (listed.json().repositories[0]?.materializationStatus === "ready") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const secondAdd = await app.inject({
      method: "POST",
      url: `/api/papers/${secondPaperId}/repositories`,
      headers: { "idempotency-key": "shared-repository-2" },
      payload: { url: canonicalUrl },
    });
    const secondList = await app.inject({ method: "GET", url: `/api/papers/${secondPaperId}/repositories` });

    expect(secondAdd.statusCode).toBe(200);
    expect(secondList.json().repositories[0]).toMatchObject({
      associationStatus: "confirmed",
      materializationStatus: "ready",
      commitSha: repository.commitSha,
    });
    expect(materializations).toBe(1);

    await rm(layout.repositoryRoot, { recursive: true, force: true });
    await writeFile(join(repository.working, "AFTER-SHARED-SNAPSHOT.md"), "# Later commit\n", "utf8");
    await exec("git", ["-C", repository.working, "add", "."]);
    await exec("git", ["-C", repository.working, "commit", "-m", "advance after shared snapshot"]);
    await exec("git", ["-C", repository.working, "push", repository.bare,
      `HEAD:refs/heads/${repository.branch}`]);
    const thirdImport = await app.inject({ method: "POST", url: "/api/imports",
      payload: { arxivUrl: "https://arxiv.org/abs/2401.33333v1" } });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const status = await app.inject({ method: "GET",
        url: `/api/imports/${thirdImport.json().importRequest.id}` });
      if (status.json().jobs.at(-1)?.state === "succeeded") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const thirdPaperId = thirdImport.json().paper.id as string;
    const thirdConfirm = await app.inject({
      method: "POST",
      url: `/api/papers/${thirdPaperId}/repositories`,
      headers: { "idempotency-key": "shared-repository-3" },
      payload: { url: canonicalUrl },
    });
    let recovered: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const listed = await app.inject({ method: "GET", url: `/api/papers/${thirdPaperId}/repositories` });
      recovered = listed.json().repositories[0];
      if (recovered?.materializationStatus === "ready") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(thirdConfirm.statusCode).toBe(202);
    expect(recovered).toMatchObject({
      materializationStatus: "ready",
      commitSha: repository.commitSha,
    });
    expect(materializations).toBe(2);
  });

  it("prefers a removed association's own ready snapshot when manually reactivating it", async () => {
    const repository = await createBareRepository();
    const canonicalUrl = "https://github.com/owner/repository";
    const git = new GitRepositoryAdapter({ [canonicalUrl]: repository.bare });
    let materializations = 0;
    const { app, paperId, layout } = await createPaper({
      async materialize(url, destination, expectedCommitSha) {
        materializations += 1;
        return git.materialize(url, destination, expectedCommitSha);
      },
    });
    await app.inject({
      method: "POST",
      url: `/api/papers/${paperId}/repositories`,
      headers: { "idempotency-key": "own-snapshot-initial" },
      payload: { url: canonicalUrl },
    });
    let association: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const listed = await app.inject({ method: "GET", url: `/api/papers/${paperId}/repositories` });
      association = listed.json().repositories[0];
      if (association?.materializationStatus === "ready") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    await writeFile(join(repository.working, "NEWER.md"), "# Newer own snapshot\n", "utf8");
    await exec("git", ["-C", repository.working, "add", "."]);
    await exec("git", ["-C", repository.working, "commit", "-m", "newer own snapshot"]);
    await exec("git", ["-C", repository.working, "push", repository.bare,
      `HEAD:refs/heads/${repository.branch}`]);
    const ownPath = "own-newer";
    const own = await git.materialize(canonicalUrl, join(layout.repositoryRoot, ownPath));
    const ownSnapshotId = `repository-snapshot:${String(association!.repositoryId)}:${own.commitSha}`;
    const database = new Database(layout.databasePath);
    database.prepare(`INSERT INTO repository_snapshots
      (id,code_repository_id,commit_sha,local_path,created_at) VALUES (?,?,?,?,?)`)
      .run(ownSnapshotId, association!.repositoryId, own.commitSha, ownPath, "2026-07-23T01:00:00.000Z");
    database.prepare("UPDATE paper_code_links SET repository_snapshot_id=? WHERE id=?")
      .run(ownSnapshotId, association!.id);
    database.close();
    await app.inject({
      method: "POST",
      url: `/api/papers/${paperId}/repositories/${encodeURIComponent(String(association!.id))}/remove`,
      headers: { "idempotency-key": "remove-own-snapshot" },
    });

    const readded = await app.inject({
      method: "POST",
      url: `/api/papers/${paperId}/repositories`,
      headers: { "idempotency-key": "readd-own-snapshot" },
      payload: { url: canonicalUrl },
    });
    const listed = await app.inject({ method: "GET", url: `/api/papers/${paperId}/repositories` });

    expect(readded.statusCode).toBe(200);
    expect(listed.json().repositories[0]).toMatchObject({
      origin: "manual",
      associationStatus: "confirmed",
      materializationStatus: "ready",
      commitSha: own.commitSha,
    });
    expect(materializations).toBe(1);
  });

  it("does not reactivate a removed ready association when an old manual-add key is replayed", async () => {
    const repository = await createBareRepository();
    const canonicalUrl = "https://github.com/owner/repository";
    const { app, paperId } = await createPaper(new GitRepositoryAdapter({ [canonicalUrl]: repository.bare }));
    const added = await app.inject({
      method: "POST",
      url: `/api/papers/${paperId}/repositories`,
      headers: { "idempotency-key": "ready-delayed-add-initial" },
      payload: { url: canonicalUrl },
    });
    const associationId = added.json().association.id as string;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const listed = await app.inject({ method: "GET", url: `/api/papers/${paperId}/repositories` });
      if (listed.json().repositories[0]?.materializationStatus === "ready") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await app.inject({
      method: "POST",
      url: `/api/papers/${paperId}/repositories/${encodeURIComponent(associationId)}/remove`,
      headers: { "idempotency-key": "ready-delayed-add-remove-1" },
    });
    const readded = await app.inject({
      method: "POST",
      url: `/api/papers/${paperId}/repositories`,
      headers: { "idempotency-key": "ready-delayed-readd" },
      payload: { url: canonicalUrl },
    });
    await app.inject({
      method: "POST",
      url: `/api/papers/${paperId}/repositories/${encodeURIComponent(associationId)}/remove`,
      headers: { "idempotency-key": "ready-delayed-add-remove-2" },
    });

    const delayedReplay = await app.inject({
      method: "POST",
      url: `/api/papers/${paperId}/repositories`,
      headers: { "idempotency-key": "ready-delayed-readd" },
      payload: { url: canonicalUrl },
    });
    const listed = await app.inject({ method: "GET", url: `/api/papers/${paperId}/repositories` });

    expect(readded.statusCode).toBe(200);
    expect(delayedReplay.statusCode).toBe(200);
    expect(delayedReplay.json()).toMatchObject({ ok: true, replayed: true, association: null });
    expect(listed.json()).toEqual({ repositories: [] });
  });

  it("includes a ready association only in future frozen Conversation context", async () => {
    const repository = await createBareRepository();
    const canonicalUrl = "https://github.com/owner/repository";
    const { app, paperId } = await createLegacyCandidatePaper(
      new GitRepositoryAdapter({ [canonicalUrl]: repository.bare }),
    );
    const before = await app.inject({ method: "POST", url: `/api/papers/${paperId}/conversations` });
    const candidates = await app.inject({ method: "GET", url: `/api/papers/${paperId}/repositories` });
    const associationId = candidates.json().repositories[0].id as string;
    await app.inject({
      method: "POST",
      url: `/api/papers/${paperId}/repositories/${encodeURIComponent(associationId)}/confirm`,
      headers: { "idempotency-key": "freeze-future-repository" },
    });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const listed = await app.inject({ method: "GET", url: `/api/papers/${paperId}/repositories` });
      if (listed.json().repositories[0]?.materializationStatus === "ready") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const after = await app.inject({ method: "POST", url: `/api/papers/${paperId}/conversations` });
    await app.inject({
      method: "POST",
      url: `/api/papers/${paperId}/repositories/${encodeURIComponent(associationId)}/remove`,
      headers: { "idempotency-key": "remove-after-freeze" },
    });
    const removed = await app.inject({
      method: "POST",
      url: `/api/papers/${paperId}/conversations`,
      payload: { continuedFromConversationId: after.json().conversation.id },
    });
    const removedLineage = await app.inject({
      method: "GET",
      url: `/api/conversations/${removed.json().conversation.id}/lineage`,
    });
    const rereadBefore = await app.inject({
      method: "GET",
      url: `/api/conversations/${before.json().conversation.id}`,
    });
    const rereadAfter = await app.inject({
      method: "GET",
      url: `/api/conversations/${after.json().conversation.id}`,
    });

    expect(before.json().contextSnapshot.repositorySnapshots).toEqual([]);
    expect(after.json().contextSnapshot.repositorySnapshots).toEqual([
      expect.objectContaining({ commitSha: repository.commitSha }),
    ]);
    expect(removed.json().contextSnapshot.repositorySnapshots).toEqual([]);
    expect(rereadBefore.json().contextSnapshot.repositorySnapshots).toEqual([]);
    expect(rereadAfter.json().contextSnapshot.repositorySnapshots).toEqual([
      expect.objectContaining({ commitSha: repository.commitSha }),
    ]);
    expect(removedLineage.json().contextComparison.diff.repositories.removed).toEqual([
      expect.objectContaining({ commitSha: repository.commitSha }),
    ]);
  });

  it("fails closed when cached materialization is missing and recovers the same commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "scholarloom-missing-repository-cache-"));
    const layout = initializeDataRoot(join(root, "data"));
    const repository = await createBareRepository();
    const canonicalUrl = "https://github.com/owner/repository";
    const app = await createApp({
      storageLayout: layout,
      repositoryAdapter: new GitRepositoryAdapter({ [canonicalUrl]: repository.bare }),
      paperSource: {
        async resolve() {
          return { arxivId: "2401.33333", latestVersion: 1, title: "Missing Cache",
            authors: ["Fixture Author"], year: 2024 };
        },
        async fetchPdf() { return pdfWithRepositoryUrl(); },
      },
      codexRunner: {
        async runSummary() {
          return {
            sections: [{ key: "overview", title: "概述", body: "fixture" }],
            claims: [{ voice: "paper-evidence", claim: "Code:", sourceHandle: "pdf-page:1" }],
            readStatus: "read",
          };
        },
      },
    });
    apps.push(app);
    const imported = await app.inject({ method: "POST", url: "/api/imports",
      payload: { arxivUrl: "https://arxiv.org/abs/2401.33333v1" } });
    const paperId = imported.json().paper.id as string;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const status = await app.inject({ method: "GET", url: `/api/imports/${imported.json().importRequest.id}` });
      if (status.json().jobs.at(-1)?.state === "succeeded") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await app.inject({ method: "POST", url: `/api/papers/${paperId}/repositories`,
      headers: { "idempotency-key": "missing-cache-1" }, payload: { url: canonicalUrl } });
    let associationId = "";
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const listed = await app.inject({ method: "GET", url: `/api/papers/${paperId}/repositories` });
      associationId = listed.json().repositories[0]?.id ?? "";
      if (listed.json().repositories[0]?.materializationStatus === "ready") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const availableConversation = await app.inject({
      method: "POST",
      url: `/api/papers/${paperId}/conversations`,
    });
    await rm(layout.repositoryRoot, { recursive: true, force: true });

    const missing = await app.inject({ method: "GET", url: `/api/papers/${paperId}/repositories` });
    const blockedConversation = await app.inject({
      method: "POST",
      url: `/api/papers/${paperId}/conversations`,
    });
    await writeFile(join(repository.working, "AFTER-SNAPSHOT.md"), "# New default-branch commit\n", "utf8");
    await exec("git", ["-C", repository.working, "add", "."]);
    await exec("git", ["-C", repository.working, "commit", "-m", "advance default branch"]);
    await exec("git", ["-C", repository.working, "push", repository.bare,
      `HEAD:refs/heads/${repository.branch}`]);

    const retried = await app.inject({
      method: "POST",
      url: `/api/papers/${paperId}/repositories/${encodeURIComponent(associationId)}/retry`,
      headers: { "idempotency-key": "missing-cache-2" },
    });
    let recovered: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const listed = await app.inject({ method: "GET", url: `/api/papers/${paperId}/repositories` });
      recovered = listed.json().repositories[0];
      if (recovered?.materializationStatus === "ready") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(missing.json().repositories[0]).toMatchObject({
      materializationStatus: "materialization-missing",
      commitSha: repository.commitSha,
    });
    expect(availableConversation.statusCode).toBe(201);
    expect(blockedConversation.statusCode).toBe(409);
    expect(blockedConversation.json()).toEqual({ code: "conversation-context-unavailable" });

    expect(retried.statusCode).toBe(202);
    expect(recovered).toMatchObject({
      materializationStatus: "ready",
      commitSha: repository.commitSha,
    });

    const [materializedDirectory] = await readdir(layout.repositoryRoot);
    await writeFile(join(layout.repositoryRoot, materializedDirectory!, "README.md"), "tampered\n", "utf8");
    const tampered = await app.inject({ method: "GET", url: `/api/papers/${paperId}/repositories` });
    const repair = await app.inject({
      method: "POST",
      url: `/api/papers/${paperId}/repositories/${encodeURIComponent(associationId)}/retry`,
      headers: { "idempotency-key": "missing-cache-3" },
    });
    let repaired: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const listed = await app.inject({ method: "GET", url: `/api/papers/${paperId}/repositories` });
      repaired = listed.json().repositories[0];
      if (repaired?.materializationStatus === "ready") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(tampered.json().repositories[0]).toMatchObject({
      materializationStatus: "materialization-missing",
      commitSha: repository.commitSha,
    });
    expect(repair.statusCode).toBe(202);
    expect(repaired).toMatchObject({
      materializationStatus: "ready",
      commitSha: repository.commitSha,
    });
  });
});
