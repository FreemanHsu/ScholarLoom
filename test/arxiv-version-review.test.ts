import { join } from "node:path";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";

import { PDFDocument, StandardFonts } from "pdf-lib";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { initializeDataRoot } from "../src/storage/layout.js";
import { migrate } from "../src/storage/migrations.js";
import { ImportStore } from "../src/storage/import-store.js";

async function layout() {
  return initializeDataRoot(join(await mkdtemp(join(tmpdir(), "scholarloom-version-review-")), "data"));
}

async function pdf(label: string): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  document.addPage().drawText(label, { x: 40, y: 700, font, size: 12 });
  return document.save();
}

async function waitForImport(app: Awaited<ReturnType<typeof createApp>>, importId: string, jobId?: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await app.inject({ method: "GET", url: `/api/imports/${encodeURIComponent(importId)}` });
    const job = response.json().jobs?.find((item: { id: string; jobType: string }) =>
      item.jobType === "paper-import" && (!jobId || item.id === jobId));
    if (job && ["succeeded", "failed", "interrupted"].includes(job.state)) return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("import did not finish");
}

describe("arXiv Paper Version review", () => {
  it("persists a fixed detected candidate when opening a Paper with a newer arXiv version", async () => {
    let latestVersion = 3;
    const app = await createApp({
      storageLayout: await layout(),
      paperSource: {
        async resolve(arxivId) {
          return { arxivId, latestVersion, title: "Versioned Fixture", authors: ["Ada Fixture"], year: 2026 };
        },
        async fetchPdf(_arxivId, version) { return pdf(`Version ${version} reports accuracy ${version * 10}.`); },
      },
      codexRunner: {
        async runSummary(context) {
          const claim = context.pages[0]!.text;
          return { sections: [{ key: "overview", title: "概述", body: claim }],
            claims: [{ voice: "paper-evidence" as const, claim, sourceHandle: "pdf-page:1" }], readStatus: "read" as const };
        },
      },
    });
    const imported = await app.inject({ method: "POST", url: "/api/imports",
      payload: { arxivUrl: "https://arxiv.org/abs/2608.00001v3" } });
    await waitForImport(app, imported.json().importRequest.id);

    latestVersion = 4;
    const workspace = await app.inject({ method: "GET", url: `/api/papers/${encodeURIComponent(imported.json().paper.id)}` });
    expect(workspace.statusCode).toBe(200);
    expect(workspace.json().updateProposal).toMatchObject({
      proposalType: "paper-version-update",
      currentVersion: 3,
      candidateVersion: 4,
      candidateVersionId: expect.stringContaining(":arxiv:v4"),
      reviewStatus: "pending",
    });

    const proposals = await app.inject({ method: "GET", url: "/api/proposals" });
    expect(proposals.json().proposals).toEqual(expect.arrayContaining([expect.objectContaining({
      proposalType: "paper-version-update",
      payload: expect.objectContaining({ sourceType: "arxiv", currentVersion: 3, candidateVersion: 4,
      candidateVersionId: expect.stringContaining(":arxiv:v4") }),
    })]));
    const detectedAt = proposals.json().proposals.find((item: { id: string }) =>
      item.id === workspace.json().updateProposal.id).payload.detectedAt;
    await app.inject({ method: "GET", url: `/api/papers/${encodeURIComponent(imported.json().paper.id)}` });
    expect((await app.inject({ method: "GET", url: "/api/proposals" })).json().proposals.find((item: { id: string }) =>
      item.id === workspace.json().updateProposal.id).payload.detectedAt).toBe(detectedAt);
    latestVersion = 5;
    const redetected = await app.inject({ method: "GET", url: `/api/papers/${encodeURIComponent(imported.json().paper.id)}` });
    expect(redetected.json().updateProposal).toMatchObject({ candidateVersion: 5, reviewStatus: "pending" });
    const latestOnly = (await app.inject({ method: "GET", url: "/api/proposals" })).json().proposals;
    expect(latestOnly.find((item: { id: string }) => item.id.includes(":v4"))).toMatchObject({ reviewStatus: "superseded" });
    await app.close();
  });

  it("prepares a material diff without activating the candidate", async () => {
    let latestVersion = 3;
    let lastChatSources: Array<{ handle: string; text: string }> = [];
    let versionDiffCalls = 0;
    let blockRetry = false;
    let signalRetryStarted = () => {};
    let releaseRetry = () => {};
    const retryStarted = new Promise<void>((resolve) => { signalRetryStarted = resolve; });
    const semanticSummary = "报告准确率从 30 调整为 40。";
    const testLayout = await layout();
    const app = await createApp({
      storageLayout: testLayout,
      paperSource: {
        async resolve(arxivId) {
          return { arxivId, latestVersion, title: latestVersion === 3 ? "Diff Fixture Original" : "Diff Fixture Revised",
            authors: ["Ada Fixture"], year: 2026 };
        },
        async fetchPdf(_arxivId, version) { return pdf(`Version ${version} reports accuracy ${version * 10}.`); },
      },
      codexRunner: {
        async runSummary(context) {
          const claim = context.pages[0]!.text;
          return { sections: [{ key: "overview", title: "概述", body: claim }],
            claims: [{ voice: "paper-evidence" as const, claim, sourceHandle: "pdf-page:1" }], readStatus: "read" as const };
        },
        async runVersionDiff(context) {
          versionDiffCalls += 1;
          if (blockRetry) {
            signalRetryStarted();
            await new Promise<void>((resolve) => { releaseRetry = resolve; });
          }
          return { significance: "major" as const, changes: [{ category: "result" as const,
            summary: semanticSummary, beforeEvidence: [context.before.pages[0]!.handle],
            afterEvidence: [context.after.pages[0]!.handle] }] };
        },
        async runChat(context) {
          lastChatSources = context.sources;
          return { answer: "仍在讨论冻结的版本。", citations: [] };
        },
      },
    });
    const imported = await app.inject({ method: "POST", url: "/api/imports",
      payload: { arxivUrl: "https://arxiv.org/abs/2608.00002v3" } });
    await waitForImport(app, imported.json().importRequest.id);
    const oldConversation = await app.inject({ method: "POST",
      url: `/api/papers/${encodeURIComponent(imported.json().paper.id)}/conversations`, payload: {} });
    latestVersion = 4;
    const detected = await app.inject({ method: "GET", url: `/api/papers/${encodeURIComponent(imported.json().paper.id)}` });
    const proposalId = detected.json().updateProposal.id;

    const prepared = await app.inject({ method: "POST",
      url: `/api/proposals/${encodeURIComponent(proposalId)}/prepare`,
      headers: { "idempotency-key": "prepare-v4" } });
    expect(prepared.statusCode, prepared.body).toBe(202);
    expect(prepared.json()).toMatchObject({ preparation: { status: "processing" },
      importRequest: { id: expect.any(String) }, job: { id: expect.any(String) } });
    expect((await waitForImport(app, prepared.json().importRequest.id)).state).toBe("succeeded");

    const proposals = await app.inject({ method: "GET", url: "/api/proposals" });
    const proposal = proposals.json().proposals.find((item: { id: string }) => item.id === proposalId);
    expect(proposal).toMatchObject({ reviewStatus: "pending", preparation: { status: "ready",
      materialDiff: { beforePageCount: 1, afterPageCount: 1, changedRegions: 1 },
      semanticDiff: { significance: "major", changes: [expect.objectContaining({ category: "result" })] } } });
    const artifactDatabase = new Database(testLayout.databasePath);
    const historicalRefs = artifactDatabase.prepare(`SELECT a.storage_ref FROM artifacts a
      JOIN paper_version_candidates c ON a.id IN (c.summary_artifact_id,
        (SELECT artifact_id FROM paper_version_diffs WHERE id=c.version_diff_id))
      WHERE c.proposal_id=? ORDER BY a.storage_ref`).pluck().all(proposalId) as string[];
    expect(historicalRefs).toHaveLength(2);
    expect(historicalRefs.every((ref) => ref.startsWith("originals/artifacts/"))).toBe(true);
    artifactDatabase.close();
    expect((await app.inject({ method: "POST",
      url: `/api/proposals/${encodeURIComponent(proposalId)}/diff/retry` })).statusCode).toBe(400);
    blockRetry = true;
    const retryRequest = app.inject({ method: "POST", url: `/api/proposals/${encodeURIComponent(proposalId)}/diff/retry`,
      headers: { "idempotency-key": "semantic-retry-v4" } });
    await retryStarted;
    const acceptDuringRetry = await app.inject({ method: "POST",
      url: `/api/proposals/${encodeURIComponent(proposalId)}/decisions`,
      headers: { "content-type": "application/json", "idempotency-key": "accept-during-semantic-retry" },
      payload: { action: "accept" } });
    expect(acceptDuringRetry.statusCode).toBe(409);
    expect(acceptDuringRetry.json()).toEqual({ code: "paper-version-diff-retry-in-progress" });
    const concurrentRetry = await app.inject({ method: "POST",
      url: `/api/proposals/${encodeURIComponent(proposalId)}/diff/retry`,
      headers: { "idempotency-key": "semantic-retry-v4-concurrent" } });
    expect(concurrentRetry.statusCode).toBe(409);
    expect(concurrentRetry.json()).toEqual({ code: "paper-version-diff-retry-in-progress" });
    releaseRetry();
    const retriedSemantic = await retryRequest;
    expect(retriedSemantic.statusCode, retriedSemantic.body).toBe(200);
    const replayedSemantic = await app.inject({ method: "POST",
      url: `/api/proposals/${encodeURIComponent(proposalId)}/diff/retry`,
      headers: { "idempotency-key": "semantic-retry-v4" } });
    expect(replayedSemantic.statusCode).toBe(200);
    expect(versionDiffCalls).toBe(2);
    const workspace = await app.inject({ method: "GET", url: `/api/papers/${encodeURIComponent(imported.json().paper.id)}` });
    expect(workspace.json().paper).toMatchObject({ version: 3 });

    const accepted = await app.inject({ method: "POST",
      url: `/api/proposals/${encodeURIComponent(proposalId)}/decisions`,
      headers: { "content-type": "application/json", "idempotency-key": "accept-v4" },
      payload: { action: "accept" } });
    expect(accepted.statusCode, accepted.body).toBe(201);
    expect(accepted.json()).toMatchObject({ reviewDecision: { action: "accept" },
      paperVersion: { id: expect.stringContaining(":arxiv:v4"), sourceVersion: "v4" } });
    const replayedAccept = await app.inject({ method: "POST",
      url: `/api/proposals/${encodeURIComponent(proposalId)}/decisions`,
      headers: { "content-type": "application/json", "idempotency-key": "accept-v4" },
      payload: { action: "accept" } });
    expect(replayedAccept.statusCode).toBe(200);
    const duplicateAccept = await app.inject({ method: "POST",
      url: `/api/proposals/${encodeURIComponent(proposalId)}/decisions`,
      headers: { "content-type": "application/json", "idempotency-key": "accept-v4-again" },
      payload: { action: "accept" } });
    expect(duplicateAccept.statusCode).toBe(409);
    const activated = await app.inject({ method: "GET", url: `/api/papers/${encodeURIComponent(imported.json().paper.id)}` });
    expect(activated.json()).toMatchObject({ paper: { version: 4, title: "Diff Fixture Revised" }, summary: { status: "active" },
      versions: expect.arrayContaining([
        expect.objectContaining({ sourceVersion: "v4", current: true, summary: expect.objectContaining({ status: "active" }) }),
        expect.objectContaining({ sourceVersion: "v3", current: false, summary: expect.objectContaining({ status: "superseded" }) }),
      ]) });
    const oldConversationId = oldConversation.json().conversation.id;
    const frozen = await app.inject({ method: "GET", url: `/api/conversations/${encodeURIComponent(oldConversationId)}` });
    expect(frozen.json().contextSnapshot.paperVersionId).toContain(":arxiv:v3");
    const turn = await app.inject({ method: "POST", url: `/api/conversations/${encodeURIComponent(oldConversationId)}/messages`,
      headers: { "idempotency-key": "old-v3-turn" }, payload: { content: "继续讨论旧版本" } });
    expect(turn.statusCode).toBe(202);
    for (let attempt = 0; attempt < 100 && lastChatSources.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(lastChatSources.find((source) => source.handle === "pdf-page:1")?.text).toContain("Version 3");
    const aliasLookup = await app.inject({ method: "GET", url: "/api/papers?q=Diff%20Fixture%20Original" });
    expect(aliasLookup.json().papers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: imported.json().paper.id, title: "Diff Fixture Revised" }),
    ]));
    const successor = await app.inject({ method: "POST",
      url: `/api/papers/${encodeURIComponent(imported.json().paper.id)}/conversations`,
      payload: { continuedFromConversationId: oldConversationId } });
    expect(successor.statusCode, successor.body).toBe(201);
    const database = new Database(testLayout.databasePath);
    database.prepare("UPDATE paper_version_candidates SET semantic_diff_json=? WHERE proposal_id=?")
      .run(JSON.stringify({ significance: "minor", changes: [{ category: "other",
        summary: "动态记录已变化。", beforeEvidence: [], afterEvidence: ["after:pdf-page:1"] }] }), proposalId);
    database.close();
    lastChatSources = [];
    await app.inject({ method: "POST",
      url: `/api/conversations/${encodeURIComponent(successor.json().conversation.id)}/messages`,
      headers: { "idempotency-key": "successor-v4-turn" }, payload: { content: "新版变了什么" } });
    for (let attempt = 0; attempt < 100 && lastChatSources.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(lastChatSources.find((source) => source.handle.startsWith("version-diff:"))?.text)
      .toContain("报告准确率从 30 调整为 40");
    await app.close();
  });

  it("opens the fixed arXiv source and can reject a candidate without changing current", async () => {
    let latestVersion = 3;
    const app = await createApp({ storageLayout: await layout(), paperSource: {
      async resolve(arxivId) { return { arxivId, latestVersion, title: "Reject Fixture", authors: ["Ada Fixture"], year: 2026 }; },
    } });
    const imported = await app.inject({ method: "POST", url: "/api/imports",
      payload: { arxivUrl: "https://arxiv.org/abs/2608.00003v3" } });
    latestVersion = 4;
    const detected = await app.inject({ method: "GET", url: `/api/papers/${encodeURIComponent(imported.json().paper.id)}` });
    const proposalId = detected.json().updateProposal.id;
    const opened = await app.inject({ method: "POST", url: `/api/proposals/${encodeURIComponent(proposalId)}/open-source` });
    expect(opened.json()).toEqual({ kind: "external", url: "https://arxiv.org/abs/2608.00003v4", version: 4 });
    const rejected = await app.inject({ method: "POST", url: `/api/proposals/${encodeURIComponent(proposalId)}/decisions`,
      headers: { "content-type": "application/json", "idempotency-key": "reject-v4" }, payload: { action: "reject" } });
    expect(rejected.statusCode).toBe(201);
    const workspace = await app.inject({ method: "GET", url: `/api/papers/${encodeURIComponent(imported.json().paper.id)}` });
    expect(workspace.json()).toMatchObject({ paper: { version: 3 }, updateProposal: null });
    const proposals = (await app.inject({ method: "GET", url: "/api/proposals" })).json().proposals;
    expect(proposals.find((item: { id: string }) => item.id === proposalId).reviewStatus).toBe("rejected");
    await app.close();
  });

  it("retries a failed candidate preparation without treating it as the active Paper", async () => {
    let latestVersion = 3;
    let failCandidateOnce = true;
    let semanticShouldFail = true;
    let semanticCalls = 0;
    const testLayout = await layout();
    const app = await createApp({ storageLayout: testLayout, paperSource: {
      async resolve(arxivId) { return { arxivId, latestVersion, title: "Retry Fixture", authors: ["Ada Fixture"], year: 2026 }; },
      async fetchPdf(_arxivId, version) { return pdf(`Version ${version} retry evidence.`); },
    }, codexRunner: {
      async runSummary(context) {
        if (context.pages[0]!.text.includes("Version 4") && failCandidateOnce) {
          failCandidateOnce = false;
          throw new Error("temporary-agent-failure");
        }
        const claim = context.pages[0]!.text;
        return { sections: [{ key: "overview", title: "概述", body: claim }],
          claims: [{ voice: "paper-evidence" as const, claim, sourceHandle: "pdf-page:1" }], readStatus: "read" as const };
      },
      async runVersionDiff(context) {
        semanticCalls += 1;
        if (semanticShouldFail) throw new Error("raw-agent-error-must-not-persist");
        return { significance: "minor" as const, changes: [{ category: "other" as const,
          summary: "重试后语义摘要可用。", beforeEvidence: [context.before.pages[0]!.handle],
          afterEvidence: [context.after.pages[0]!.handle] }] };
      },
    } });
    const imported = await app.inject({ method: "POST", url: "/api/imports",
      payload: { arxivUrl: "https://arxiv.org/abs/2608.00004v3" } });
    await waitForImport(app, imported.json().importRequest.id);
    latestVersion = 4;
    const proposalId = (await app.inject({ method: "GET",
      url: `/api/papers/${encodeURIComponent(imported.json().paper.id)}` })).json().updateProposal.id;
    const prepared = await app.inject({ method: "POST", url: `/api/proposals/${encodeURIComponent(proposalId)}/prepare`,
      headers: { "idempotency-key": "prepare-retry-v4" } });
    expect((await waitForImport(app, prepared.json().importRequest.id)).state).toBe("failed");
    const retried = await app.inject({ method: "POST", url: `/api/jobs/${encodeURIComponent(prepared.json().job.id)}/retry`,
      headers: { "idempotency-key": "retry-prepare-v4" } });
    expect(retried.statusCode, retried.body).toBe(202);
    const retriedJob = await waitForImport(app, prepared.json().importRequest.id, retried.json().job.id);
    expect(retriedJob.state, JSON.stringify(retriedJob)).toBe("succeeded");
    const proposal = (await app.inject({ method: "GET", url: "/api/proposals" })).json().proposals
      .find((item: { id: string }) => item.id === proposalId);
    expect(proposal).toMatchObject({ reviewStatus: "pending", preparation: { status: "ready",
      semanticError: "paper-version-semantic-diff-failed" } });
    const failedSemanticRetry = await app.inject({ method: "POST",
      url: `/api/proposals/${encodeURIComponent(proposalId)}/diff/retry`,
      headers: { "idempotency-key": "semantic-retry-fails" } });
    expect(failedSemanticRetry.statusCode).toBe(502);
    expect((await app.inject({ method: "POST",
      url: `/api/proposals/${encodeURIComponent(proposalId)}/diff/retry`,
      headers: { "idempotency-key": "semantic-retry-fails" } })).statusCode).toBe(502);
    expect(semanticCalls).toBe(2);
    semanticShouldFail = false;
    const recoveredSemanticRetry = await app.inject({ method: "POST",
      url: `/api/proposals/${encodeURIComponent(proposalId)}/diff/retry`,
      headers: { "idempotency-key": "semantic-retry-recovers" } });
    expect(recoveredSemanticRetry.statusCode).toBe(200);
    expect(semanticCalls).toBe(3);
    const database = new Database(testLayout.databasePath);
    expect(database.prepare(`SELECT count(*) FROM job_runs j JOIN agent_runs a ON a.job_run_id=j.id
      WHERE j.job_type='paper-version-diff' AND j.state='failed' AND j.error_json LIKE '%paper-version-semantic-diff-failed%'`)
      .pluck().get()).toBe(2);
    expect(JSON.stringify(database.prepare("SELECT error_json,output_json FROM job_runs WHERE job_type='paper-version-diff'").get()))
      .not.toContain("raw-agent-error-must-not-persist");
    database.close();
    const workspace = await app.inject({ method: "GET", url: `/api/papers/${encodeURIComponent(imported.json().paper.id)}` });
    expect(workspace.json().paper.version).toBe(3);
    await app.close();
  });

  it("keeps the Proposal pending when an external Paper manifest edit blocks activation", async () => {
    let latestVersion = 3;
    const testLayout = await layout();
    const app = await createApp({ storageLayout: testLayout, paperSource: {
      async resolve(arxivId) { return { arxivId, latestVersion, title: "Manifest Conflict", authors: ["Ada Fixture"], year: 2026 }; },
      async fetchPdf(_arxivId, version) { return pdf(`Manifest version ${version}.`); },
    }, codexRunner: {
      async runSummary(context) {
        const claim = context.pages[0]!.text;
        return { sections: [{ key: "overview", title: "概述", body: claim }],
          claims: [{ voice: "paper-evidence" as const, claim, sourceHandle: "pdf-page:1" }], readStatus: "read" as const };
      },
    } });
    const imported = await app.inject({ method: "POST", url: "/api/imports",
      payload: { arxivUrl: "https://arxiv.org/abs/2608.00005v3" } });
    await waitForImport(app, imported.json().importRequest.id);
    latestVersion = 4;
    const proposalId = (await app.inject({ method: "GET",
      url: `/api/papers/${encodeURIComponent(imported.json().paper.id)}` })).json().updateProposal.id;
    const prepared = await app.inject({ method: "POST", url: `/api/proposals/${encodeURIComponent(proposalId)}/prepare`,
      headers: { "idempotency-key": "prepare-manifest-conflict" } });
    await waitForImport(app, prepared.json().importRequest.id);
    const database = new Database(testLayout.databasePath);
    const manifestPath = database.prepare("SELECT markdown_path FROM paper_manifests WHERE paper_id=?").pluck()
      .get(imported.json().paper.id) as string;
    await writeFile(join(testLayout.vaultRoot, manifestPath),
      `${await readFile(join(testLayout.vaultRoot, manifestPath), "utf8")}\nExternal edit.\n`, "utf8");
    const accepted = await app.inject({ method: "POST", url: `/api/proposals/${encodeURIComponent(proposalId)}/decisions`,
      headers: { "content-type": "application/json", "idempotency-key": "accept-manifest-conflict" },
      payload: { action: "accept" } });
    expect(accepted.statusCode).toBe(409);
    expect((await app.inject({ method: "GET", url: `/api/papers/${encodeURIComponent(imported.json().paper.id)}` }))
      .json().paper.version).toBe(3);
    expect(database.prepare("SELECT review_status FROM proposals WHERE id=?").pluck().get(proposalId)).toBe("pending");
    expect(database.prepare("SELECT count(*) FROM review_decisions WHERE proposal_id=?").pluck().get(proposalId)).toBe(0);
    database.close();
    await app.close();
  });

  it("supersedes a pending activation recovered after the Paper current version moved", async () => {
    let latestVersion = 3;
    const testLayout = await layout();
    const options = { storageLayout: testLayout, paperSource: {
      async resolve(arxivId: string) { return { arxivId, latestVersion, title: "Stale Recovery",
        authors: ["Ada Fixture"], year: 2026 }; },
      async fetchPdf(_arxivId: string, version: number) { return pdf(`Stale recovery version ${version}.`); },
    }, codexRunner: {
      async runSummary(context: { pages: Array<{ text: string }> }) {
        const claim = context.pages[0]!.text;
        return { sections: [{ key: "overview", title: "概述", body: claim }],
          claims: [{ voice: "paper-evidence" as const, claim, sourceHandle: "pdf-page:1" }], readStatus: "read" as const };
      },
    } };
    const initial = await createApp(options);
    const imported = await initial.inject({ method: "POST", url: "/api/imports",
      payload: { arxivUrl: "https://arxiv.org/abs/2608.00007v3" } });
    await waitForImport(initial, imported.json().importRequest.id);
    await initial.close();

    latestVersion = 4;
    const interrupted = await createApp({ ...options, knowledgeWriteFailurePoint: "metadata-committed" });
    const proposalId = (await interrupted.inject({ method: "GET",
      url: `/api/papers/${encodeURIComponent(imported.json().paper.id)}` })).json().updateProposal.id;
    const prepared = await interrupted.inject({ method: "POST",
      url: `/api/proposals/${encodeURIComponent(proposalId)}/prepare`,
      headers: { "idempotency-key": "prepare-stale-recovery" } });
    await waitForImport(interrupted, prepared.json().importRequest.id);
    expect((await interrupted.inject({ method: "POST",
      url: `/api/proposals/${encodeURIComponent(proposalId)}/decisions`,
      headers: { "content-type": "application/json", "idempotency-key": "accept-stale-recovery" },
      payload: { action: "accept" } })).statusCode).toBe(500);
    await interrupted.close();

    const database = new Database(testLayout.databasePath);
    const paperId = imported.json().paper.id as string;
    const v5Id = `paper-version:${paperId}:arxiv:v5`;
    const timestamp = "2026-08-14T12:00:00.000Z";
    database.prepare(`INSERT INTO paper_versions(id,paper_id,source_type,source_version,source_url,resolved_at,
      processing_status,accepted_at,created_at,updated_at,metadata_json)
      VALUES (?,?,'arxiv','v5','https://arxiv.org/abs/2608.00007v5',?,'available',?,?,?,?)`)
      .run(v5Id, paperId, timestamp, timestamp, timestamp, timestamp,
        JSON.stringify({ title: "Stale Recovery v5", authors: ["Ada Fixture"], year: 2026 }));
    database.prepare("UPDATE papers SET current_version_id=? WHERE id=?").run(v5Id, paperId);
    database.close();

    ImportStore.open(testLayout).close();
    const recovered = new Database(testLayout.databasePath);
    expect(recovered.prepare("SELECT current_version_id FROM papers WHERE id=?").pluck().get(paperId)).toBe(v5Id);
    expect(recovered.prepare("SELECT review_status FROM proposals WHERE id=?").pluck().get(proposalId)).toBe("superseded");
    expect(recovered.prepare("SELECT count(*) FROM review_decisions WHERE proposal_id=?").pluck().get(proposalId)).toBe(0);
    recovered.close();
  });

  it("upgrades a deterministic legacy arXiv Proposal and survives restart", async () => {
    const testLayout = await layout();
    const database = new Database(testLayout.databasePath);
    database.exec(`CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,name TEXT NOT NULL UNIQUE,applied_at TEXT NOT NULL) STRICT`);
    const migrationRoot = join(process.cwd(), "src", "storage", "migrations");
    for (const name of readdirSync(migrationRoot).filter((item) => /^\d+-.+\.sql$/.test(item)).sort()) {
      const version = Number.parseInt(name, 10);
      if (version >= 34) continue;
      database.exec(readFileSync(join(migrationRoot, name), "utf8"));
      database.prepare("INSERT INTO schema_migrations(version,name,applied_at) VALUES (?,?,?)")
        .run(version, name, "2026-08-14T00:00:00.000Z");
    }
    database.prepare(`INSERT INTO papers(id,title,acquisition_status,origin,lifecycle_status,current_version_id,created_at,updated_at)
      VALUES ('paper:legacy','Legacy Version','ingested','manual-import','active',NULL,?,?)`)
      .run("2026-08-14T00:00:00.000Z", "2026-08-14T00:00:00.000Z");
    database.prepare(`INSERT INTO paper_versions(id,paper_id,source_type,source_version,source_url,resolved_at,processing_status,
      accepted_at,created_at,updated_at) VALUES ('paper-version:legacy:v3','paper:legacy','arxiv','v3',
      'https://arxiv.org/abs/2608.00006v3',?,'available',?,?,?)`).run("2026-08-14T00:00:00.000Z",
        "2026-08-14T00:00:00.000Z", "2026-08-14T00:00:00.000Z", "2026-08-14T00:00:00.000Z");
    database.prepare("UPDATE papers SET current_version_id='paper-version:legacy:v3' WHERE id='paper:legacy'").run();
    database.prepare(`INSERT INTO paper_external_identities(id,paper_id,identity_type,normalized_value,canonical_url,metadata_json,created_at)
      VALUES ('identity:legacy','paper:legacy','arxiv','2608.00006','https://arxiv.org/abs/2608.00006',?,?)`)
      .run(JSON.stringify({ authors: ["Legacy Author"], year: 2026 }), "2026-08-14T00:00:00.000Z");
    database.prepare(`INSERT INTO proposals(id,proposal_type,paper_id,payload_json,review_status,one_click_eligible,created_at)
      VALUES ('proposal:legacy-v4','paper-version-update','paper:legacy',?,'pending',1,?)`)
      .run(JSON.stringify({ currentVersion: 3, latestVersion: 4 }), "2026-08-14T00:00:00.000Z");
    database.prepare(`INSERT INTO artifacts(id,artifact_type,content_hash,storage_ref,byte_size,created_by_kind,
      retention_class,created_at) VALUES ('artifact:legacy-derived','document-extraction','legacy-derived-hash',
      'derived/document-extraction/le/legacy-derived-hash.json',2,'job-run','historical',?)`)
      .run("2026-08-14T00:00:00.000Z");
    migrate(database);
    expect(JSON.parse(database.prepare("SELECT payload_json FROM proposals WHERE id='proposal:legacy-v4'").pluck().get() as string))
      .toMatchObject({ contractVersion: "paper-version-update.v1", sourceType: "arxiv", candidateVersion: 4,
        candidateVersionId: "paper-version:paper:legacy:arxiv:v4" });
    expect(database.prepare("SELECT preparation_status FROM paper_version_candidates WHERE proposal_id='proposal:legacy-v4'")
      .pluck().get()).toBe("detected");
    expect(database.prepare("SELECT retention_class FROM artifacts WHERE id='artifact:legacy-derived'")
      .pluck().get()).toBe("rebuildable");
    database.close();
    ImportStore.open(testLayout).close();
  });
});
