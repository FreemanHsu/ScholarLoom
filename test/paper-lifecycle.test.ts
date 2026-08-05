import { chmod, mkdtemp, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { PDFDocument, StandardFonts } from "pdf-lib";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import type { FastifyInstance } from "fastify";

import { createApp } from "../src/app.js";
import { GitRepositoryAdapter } from "../src/adapters/git-repository.js";
import { initializeDataRoot } from "../src/storage/layout.js";

const exec = promisify(execFile);

async function waitForImport(app: FastifyInstance, id: string, expected = "succeeded"): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const status = await app.inject({ method: "GET", url: `/api/imports/${encodeURIComponent(id)}` });
    if (status.json().jobs.at(-1)?.state === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`import did not reach ${expected}`);
}

async function waitForConversation(app: FastifyInstance, id: string): Promise<{
  messages: Array<{ role: string; citations: Array<{ locator: Record<string, unknown> }> }>;
}> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await app.inject({ method: "GET", url: `/api/conversations/${id}` });
    const body = response.json();
    if (body.messages?.some((message: { role: string }) => message.role === "assistant") ||
        body.messages?.some((message: { attempts?: Array<{ state: string }> }) => message.attempts?.some((run) => run.state === "failed"))) return body;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("conversation did not finish");
}

async function fixturePdf(label = "fixture"): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage().drawText(`ScholarLoom ${label} introduction`, { x: 40, y: 700, font });
  pdf.addPage().drawText("Table 1 reports accuracy 91.2. Code: https://github.com/example/fixture", {
    x: 40, y: 700, font, size: 10,
  });
  return pdf.save();
}

describe("paper ingestion lifecycle", () => {
  it("stores a PDF, extracts page evidence, and activates a schema-valid Summary", async () => {
    const root = await mkdtemp(join(tmpdir(), "scholarloom-lifecycle-"));
    const storageLayout = initializeDataRoot(join(root, "data"));
    const app = await createApp({
      storageLayout,
      paperSource: {
        async resolve() { return { arxivId: "2401.12345", latestVersion: 2, title: "Fixture Paper", authors: ["Ada Fixture"], year: 2024 }; },
        async fetchPdf() { return fixturePdf(); },
      },
      codexRunner: {
        async runSummary(context) {
          expect(context.pages).toHaveLength(2);
          return {
            sections: [
              { key: "overview", title: "论文概述", body: "该论文报告了 fixture 实验。" },
              { key: "experiments", title: "实验分析", body: "Table 1 报告 accuracy 91.2。" },
            ],
            claims: [{ voice: "paper-evidence", claim: "Table 1 reports accuracy 91.2.", sourceHandle: "pdf-page:2" }],
            readStatus: "read",
          };
        },
      },
    });

    const imported = await app.inject({
      method: "POST", url: "/api/imports", payload: { arxivUrl: "https://arxiv.org/abs/2401.12345v2" },
    });
    expect(imported.statusCode, imported.body).toBe(202);
    await waitForImport(app, imported.json().importRequest.id);

    const workspace = await app.inject({ method: "GET", url: `/api/papers/${imported.json().paper.id}` });
    expect(workspace.statusCode).toBe(200);
    expect(workspace.json()).toMatchObject({
      paper: { title: "Fixture Paper", version: 2 },
      pdf: { pageCount: 2, url: expect.stringMatching(/^\/api\/artifacts\/[0-9a-f]{64}\/pdf$/) },
      summary: {
        status: "active",
        readStatus: "read",
        claims: [{ claim: "Table 1 reports accuracy 91.2.", evidence: { page: 2, verified: true } }],
      },
    });
    expect(workspace.json()).not.toHaveProperty("viewer");
    expect(workspace.json().summary.markdownPath).toMatch(/library\/papers\/fixture-paper\/summary-v2-r1\.md$/);

    const versionPdf = await app.inject({ method: "GET", url: `/api/paper-versions/${workspace.json().paper.versionId}/pdf` });
    expect(versionPdf.statusCode).toBe(307);
    expect(versionPdf.headers.location).toBe(workspace.json().pdf.url);
    expect(versionPdf.headers["cache-control"]).toBe("private, no-cache");

    const pdf = await app.inject({ method: "GET", url: workspace.json().pdf.url });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    expect(pdf.headers.etag).toMatch(/^"[0-9a-f]{64}"$/);
    expect(pdf.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
    expect(pdf.headers["accept-ranges"]).toBe("bytes");
    expect(pdf.rawPayload.subarray(0, 4).toString()).toBe("%PDF");

    const range = await app.inject({ method: "GET", url: workspace.json().pdf.url,
      headers: { range: "bytes=0-3" } });
    expect(range.statusCode).toBe(206);
    expect(range.headers["content-range"]).toBe(`bytes 0-3/${pdf.rawPayload.byteLength}`);
    expect(range.headers["content-length"]).toBe("4");
    expect(range.rawPayload.toString()).toBe("%PDF");

    const head = await app.inject({ method: "HEAD", url: workspace.json().pdf.url });
    expect(head.statusCode).toBe(200);
    expect(head.headers["content-length"]).toBe(String(pdf.rawPayload.byteLength));
    expect(head.headers.etag).toBe(pdf.headers.etag);
    expect(head.rawPayload.byteLength).toBe(0);

    const notModified = await app.inject({ method: "GET", url: workspace.json().pdf.url,
      headers: { "if-none-match": String(pdf.headers.etag) } });
    expect(notModified.statusCode).toBe(304);
    expect(notModified.headers.etag).toBe(pdf.headers.etag);
    expect(notModified.rawPayload.byteLength).toBe(0);
    const weakNotModified = await app.inject({ method: "GET", url: workspace.json().pdf.url,
      headers: { "if-none-match": `"other", W/${String(pdf.headers.etag)}` } });
    expect(weakNotModified.statusCode).toBe(304);

    const staleIfRange = await app.inject({ method: "GET", url: workspace.json().pdf.url,
      headers: { range: "bytes=0-3", "if-range": '"stale"' } });
    expect(staleIfRange.statusCode).toBe(200);
    expect(staleIfRange.rawPayload.byteLength).toBe(pdf.rawPayload.byteLength);
    const validIfRange = await app.inject({ method: "GET", url: workspace.json().pdf.url,
      headers: { range: "bytes=-4", "if-range": String(pdf.headers.etag) } });
    expect(validIfRange.statusCode).toBe(206);
    expect(validIfRange.headers["content-range"]).toBe(
      `bytes ${pdf.rawPayload.byteLength - 4}-${pdf.rawPayload.byteLength - 1}/${pdf.rawPayload.byteLength}`);

    const unsatisfiable = await app.inject({ method: "GET", url: workspace.json().pdf.url,
      headers: { range: `bytes=${pdf.rawPayload.byteLength}-` } });
    expect(unsatisfiable.statusCode).toBe(416);
    expect(unsatisfiable.headers["content-range"]).toBe(`bytes */${pdf.rawPayload.byteLength}`);

    const multiRange = await app.inject({ method: "GET", url: workspace.json().pdf.url,
      headers: { range: "bytes=0-1,4-5" } });
    expect(multiRange.statusCode).toBe(200);
    expect(multiRange.headers["content-range"]).toBeUndefined();
    expect(multiRange.rawPayload.byteLength).toBe(pdf.rawPayload.byteLength);

    const integrityDatabase = new Database(storageLayout.databasePath);
    const artifact = integrityDatabase.prepare(`SELECT storage_ref FROM artifacts
      WHERE artifact_type='paper-pdf' AND content_hash=?`).get(String(pdf.headers.etag).slice(1, -1)) as { storage_ref: string };
    const artifactPath = join(storageLayout.root, artifact.storage_ref);
    await chmod(artifactPath, 0o600);
    await writeFile(artifactPath, Buffer.alloc(pdf.rawPayload.byteLength, 0x78));
    const corruptPdf = await app.inject({ method: "GET", url: workspace.json().pdf.url });
    expect(corruptPdf.statusCode).toBe(404);
    expect((integrityDatabase.prepare("SELECT integrity_status FROM artifacts WHERE content_hash=?")
      .get(String(pdf.headers.etag).slice(1, -1)) as { integrity_status: string }).integrity_status).toBe("corrupt");
    await writeFile(artifactPath, pdf.rawPayload);
    await chmod(artifactPath, 0o400);
    const recoveredPdf = await app.inject({ method: "GET", url: workspace.json().pdf.url });
    expect(recoveredPdf.statusCode).toBe(200);
    expect((integrityDatabase.prepare("SELECT integrity_status FROM artifacts WHERE content_hash=?")
      .get(String(pdf.headers.etag).slice(1, -1)) as { integrity_status: string }).integrity_status).toBe("verified");
    await chmod(artifactPath, 0o600);
    await writeFile(artifactPath, pdf.rawPayload.subarray(0, pdf.rawPayload.byteLength - 1));
    const truncatedPdf = await app.inject({ method: "GET", url: workspace.json().pdf.url });
    expect(truncatedPdf.statusCode).toBe(404);
    expect((integrityDatabase.prepare("SELECT integrity_status FROM artifacts WHERE content_hash=?")
      .get(String(pdf.headers.etag).slice(1, -1)) as { integrity_status: string }).integrity_status).toBe("corrupt");
    await writeFile(artifactPath, pdf.rawPayload);
    await chmod(artifactPath, 0o400);
    expect((await app.inject({ method: "GET", url: workspace.json().pdf.url })).statusCode).toBe(200);
    integrityDatabase.close();

    await app.close();
  });

  it("ignores a Paper-explicit URL until manual add, then pins and indexes without executing it", async () => {
    const root = await mkdtemp(join(tmpdir(), "scholarloom-git-"));
    const storageLayout = initializeDataRoot(join(root, "data"));
    const working = join(root, "working");
    const bare = join(root, "fixture.git");
    await exec("git", ["init", working]);
    await exec("git", ["-C", working, "config", "user.email", "fixture@example.test"]);
    await exec("git", ["-C", working, "config", "user.name", "Fixture"]);
    await writeFile(join(working, "README.md"), "# Fixture\nImplementation sentinel: WORKING_ONLY_SENTINEL", "utf8");
    await writeFile(join(working, "install.sh"), "exit 99", "utf8");
    await exec("git", ["-C", working, "add", "."]);
    await exec("git", ["-C", working, "commit", "-m", "fixture"]);
    const { stdout } = await exec("git", ["-C", working, "rev-parse", "HEAD"]);
    await exec("git", ["clone", "--bare", working, bare]);

    const app = await createApp({
      storageLayout,
      repositoryAdapter: new GitRepositoryAdapter({ "https://github.com/example/fixture": bare }),
      paperSource: { async resolve() { return { arxivId: "2401.12345", latestVersion: 2, title: "Fixture Paper", authors: ["Ada Fixture"], year: 2024 }; }, async fetchPdf() { return fixturePdf(); } },
      codexRunner: {
        async runSummary() { return { sections: [{ key: "overview", title: "概述", body: "fixture" }], claims: [{ voice: "paper-evidence", claim: "Table 1 reports accuracy 91.2.", sourceHandle: "pdf-page:2" }], readStatus: "read" }; },
        async runChat(context) {
          const codeHandle = context.sources.find((source) => source.type === "code" && source.locator.startsWith("README.md:"))!.handle;
          const summaryHandle = context.sources.find((source) => source.type === "summary")!.handle;
          expect(codeHandle).toMatch(/^code:repository-snapshot:.+:README\.md$/);
          expect(summaryHandle).toMatch(/^summary:.+:overview$/);
          return {
            answer: "该实现将 attention 记录在固定仓库快照中。",
            citations: [{ sourceHandle: codeHandle, locator: "README.md:1-2" }, { sourceHandle: "pdf-page:2", locator: "p. 2" },
              { sourceHandle: summaryHandle, locator: "overview" }],
          };
        },
        async runEntry(context) {
          expect(context.sources).toHaveLength(1);
          expect(context.sources.map((source) => source.body).join(" ")).not.toContain("WORKING_ONLY_SENTINEL");
          return { answerStatus: "answered" as const,
            answer: "已确认结论与 active Summary 都支持可追溯阅读。",
            sourceHandles: context.sources.map((source) => source.handle), uncertainty: null };
        },
      },
    });
    const imported = await app.inject({ method: "POST", url: "/api/imports", payload: { arxivUrl: "https://arxiv.org/abs/2401.12345v2" } });
    await waitForImport(app, imported.json().importRequest.id);
    const candidates = await app.inject({ method: "GET", url: `/api/papers/${imported.json().paper.id}/repositories` });
    expect(candidates.json()).toEqual({ repositories: [] });
    const confirmed = await app.inject({
      method: "POST",
      url: `/api/papers/${imported.json().paper.id}/repositories`,
      headers: { "idempotency-key": "manually-add-paper-explicit-repository" },
      payload: { url: "https://github.com/example/fixture" },
    });
    expect(confirmed.statusCode).toBe(202);
    let repositoryView: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const repositories = await app.inject({ method: "GET", url: `/api/papers/${imported.json().paper.id}/repositories` });
      repositoryView = repositories.json().repositories[0];
      if (repositoryView?.materializationStatus === "ready") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const workspace = await app.inject({ method: "GET", url: `/api/papers/${imported.json().paper.id}` });

    expect(repositoryView).toMatchObject({
      canonicalUrl: "https://github.com/example/fixture", commitSha: stdout.trim(), materializationStatus: "ready",
    });

    const conversation = await app.inject({ method: "POST", url: `/api/papers/${imported.json().paper.id}/conversations` });
    expect(conversation.statusCode).toBe(201);
    expect(conversation.json().contextSnapshot).toMatchObject({
      paperVersionId: workspace.json().paper.versionId,
      summaryRevisionId: workspace.json().summary.id,
      repositorySnapshots: [{ commitSha: stdout.trim() }],
    });
    const accepted = await app.inject({ method: "POST", url: `/api/conversations/${conversation.json().conversation.id}/messages`,
      payload: { content: "WORKING_ONLY_SENTINEL 代码如何实现论文方法？", idempotencyKey: "fixture-chat" } });
    expect(accepted.statusCode).toBe(202);
    const answer = await waitForConversation(app, conversation.json().conversation.id);
    expect(answer.messages.at(-1)).toMatchObject({
      role: "assistant",
      citations: [
        { locator: { type: "code", commitSha: stdout.trim(), path: "README.md" } },
        { locator: { type: "pdf", page: 2, paperVersionId: workspace.json().paper.versionId,
          evidenceAnchorId: expect.stringMatching(/^evidence:/) } },
        { locator: { type: "summary", summaryRevisionId: workspace.json().summary.id, sectionKey: "overview" } },
      ],
    });
    const proposalResponse = await app.inject({ method: "GET", url: "/api/proposals" });
    const takeawayProposals = proposalResponse.json().proposals.filter((proposal: { proposalType: string }) => proposal.proposalType === "takeaway");
    expect(takeawayProposals).toEqual([]);
    const summaryMarkdown = await readFile(join(storageLayout.vaultRoot, workspace.json().summary.markdownPath), "utf8");
    const frontmatter = (markdown: string) => parse(markdown.split("---")[1]!) as Record<string, unknown>;
    expect(frontmatter(summaryMarkdown)).toMatchObject({ summary_revision_id: workspace.json().summary.id, paper_version_id: workspace.json().paper.versionId });

    const entry = await app.inject({ method: "POST", url: "/api/entry-agent/questions", payload: { question: "fixture 可追溯证据" } });
    expect(entry.statusCode).toBe(200);
    expect(entry.json()).toMatchObject({
      answer: "已确认结论与 active Summary 都支持可追溯阅读。",
      sources: [{ sourceType: "summary" }],
      projection: { stale: false },
    });
    expect(JSON.stringify(entry.json())).not.toContain("WORKING_ONLY_SENTINEL");
    const rebuilt = await app.inject({ method: "POST", url: "/api/diagnostics/rebuild-curated" });
    expect(rebuilt.json()).toMatchObject({ count: 1 });
    const afterRebuild = await app.inject({ method: "POST", url: "/api/entry-agent/questions", payload: { question: "fixture 可追溯证据" } });
    expect(afterRebuild.json().sources).toEqual(entry.json().sources);
    await app.close();
  });

  it("recovers every Summary write phase and preserves a competing external edit", async () => {
    const phases = ["staged", "renamed", "metadata-committed"] as const;
    for (const phase of phases) {
      const root = await mkdtemp(join(tmpdir(), `scholarloom-recover-${phase}-`));
      const storageLayout = initializeDataRoot(join(root, "data"));
      const options = {
        storageLayout,
        paperSource: { async resolve() { return { arxivId: "2401.12345", latestVersion: 2, title: "Fixture Paper", authors: ["Ada Fixture"], year: 2024 }; }, async fetchPdf() { return fixturePdf(); } },
        codexRunner: { async runSummary() { return { sections: [{ key: "overview", title: "概述", body: "recoverable" }], claims: [{ voice: "paper-evidence" as const, claim: "Table 1 reports accuracy 91.2.", sourceHandle: "pdf-page:2" }], readStatus: "read" as const }; } },
      };
      const interrupted = await createApp({ ...options, knowledgeWriteFailurePoint: phase });
      const response = await interrupted.inject({ method: "POST", url: "/api/imports", payload: { arxivUrl: "https://arxiv.org/abs/2401.12345v2" } });
      expect(response.statusCode).toBe(202);
      await waitForImport(interrupted, response.json().importRequest.id, "failed");
      await interrupted.close();
      const restarted = await createApp(options);
      const workspace = await restarted.inject({ method: "GET", url: "/api/papers/paper%3Afixture%3A2024%3Afixture-paper" });
      expect(workspace.json().summary).toMatchObject({ status: "active" });
      await restarted.close();
    }

    const root = await mkdtemp(join(tmpdir(), "scholarloom-conflict-"));
    const storageLayout = initializeDataRoot(join(root, "data"));
    const options = {
      storageLayout,
      paperSource: { async resolve() { return { arxivId: "2401.12345", latestVersion: 2, title: "Fixture Paper", authors: ["Ada Fixture"], year: 2024 }; }, async fetchPdf() { return fixturePdf(); } },
      codexRunner: { async runSummary() { return { sections: [{ key: "overview", title: "概述", body: "recoverable" }], claims: [{ voice: "paper-evidence" as const, claim: "Table 1 reports accuracy 91.2.", sourceHandle: "pdf-page:2" }], readStatus: "read" as const }; } },
    };
    const interrupted = await createApp({ ...options, knowledgeWriteFailurePoint: "staged" });
    const conflictedImport = await interrupted.inject({ method: "POST", url: "/api/imports", payload: { arxivUrl: "https://arxiv.org/abs/2401.12345v2" } });
    await waitForImport(interrupted, conflictedImport.json().importRequest.id, "failed");
    await interrupted.close();
    const target = join(storageLayout.vaultRoot, "library", "papers", "fixture-paper", "summary-v2-r1.md");
    await writeFile(target, "external owner edit", "utf8");
    const restarted = await createApp(options);
    const proposals = await restarted.inject({ method: "GET", url: "/api/proposals" });
    expect(proposals.json()).toMatchObject({ proposals: [{ proposalType: "reconciliation", reviewStatus: "pending" }] });
    expect(await import("node:fs/promises").then(({ readFile }) => readFile(target, "utf8"))).toBe("external owner edit");
    await restarted.close();
    const future = await createApp({ ...options, clock: { now: () => new Date(Date.now() + 31 * 24 * 60 * 60 * 1000) } });
    const archived = await future.inject({ method: "GET", url: "/api/proposals" });
    expect(archived.json().proposals[0]).toMatchObject({ reviewStatus: "archived" });
    const reopened = await future.inject({ method: "POST", url: `/api/proposals/${encodeURIComponent(archived.json().proposals[0].id)}/reopen` });
    expect(reopened.json()).toEqual({ status: "pending" });
    await future.close();
  });

  it("retries a failed import as a new Job attempt without duplicating the Paper", async () => {
    const root = await mkdtemp(join(tmpdir(), "scholarloom-summary-retry-"));
    const storageLayout = initializeDataRoot(join(root, "data"));
    let attempts = 0;
    let pdfFetches = 0;
    const app = await createApp({
      storageLayout,
      paperSource: { async resolve() { return { arxivId: "2401.12345", latestVersion: 2, title: "Fixture Paper", authors: ["Ada Fixture"], year: 2024 }; },
        async fetchPdf() { pdfFetches += 1; return fixturePdf(); } },
      codexRunner: { async runSummary() { attempts += 1; if (attempts === 1) throw new Error("fixture-codex-interrupted");
        return { sections: [{ key: "overview", title: "概述", body: "retry complete" }], claims: [{ voice: "paper-evidence" as const, claim: "Table 1 reports accuracy 91.2.", sourceHandle: "pdf-page:2" }], readStatus: "read" as const }; } },
    });
    const first = await app.inject({ method: "POST", url: "/api/imports", payload: { arxivUrl: "https://arxiv.org/abs/2401.12345v2" } });
    await waitForImport(app, first.json().importRequest.id, "failed");
    const failedStatus = await app.inject({ method: "GET", url: `/api/imports/${first.json().importRequest.id}` });
    expect(failedStatus.json().jobs).toMatchObject([{ state: "failed", attempt: 1,
      error: { code: "summary-generation-failed", stage: "paper-summary", retryable: true } }]);
    const failedWorkspace = await app.inject({ method: "GET", url: `/api/papers/${encodeURIComponent(first.json().paper.id)}` });
    expect(failedWorkspace.json()).toMatchObject({ summary: null, processing: { state: "failed",
      jobId: failedStatus.json().jobs[0].id, attempt: 1,
      error: { code: "summary-generation-failed", stage: "paper-summary", retryable: true } } });
    const failedPapers = await app.inject({ method: "GET", url: "/api/papers" });
    expect(failedPapers.json().papers[0]).toMatchObject({
      processing: {
        state: "failed",
        error: {
          code: "summary-generation-failed",
          message: "fixture-codex-interrupted",
          stage: "paper-summary",
        },
      },
    });

    await chmod(join(storageLayout.originalsRoot, "papers"), 0o500);
    const blockedRetry = await app.inject({ method: "POST", url: `/api/jobs/${failedStatus.json().jobs[0].id}/retry`,
      headers: { "idempotency-key": "retry-fixture-attempt-1" } });
    expect(blockedRetry.statusCode).toBe(503);
    expect(blockedRetry.json()).toMatchObject({ code: "data-root-not-writable" });
    await chmod(join(storageLayout.originalsRoot, "papers"), 0o700);

    const missingKey = await app.inject({ method: "POST", url: `/api/jobs/${failedStatus.json().jobs[0].id}/retry` });
    expect(missingKey.statusCode).toBe(400);
    expect(missingKey.json()).toEqual({ code: "idempotency-key-required" });

    const retry = await app.inject({ method: "POST", url: `/api/jobs/${failedStatus.json().jobs[0].id}/retry`,
      headers: { "idempotency-key": "retry-fixture-attempt-1" } });
    expect(retry.statusCode).toBe(202);
    expect(retry.json()).toMatchObject({ importRequest: { id: first.json().importRequest.id }, job: { attempt: 2, state: "running" } });
    await waitForImport(app, first.json().importRequest.id, "succeeded");
    const completedStatus = await app.inject({ method: "GET", url: `/api/imports/${first.json().importRequest.id}` });
    expect(completedStatus.json().jobs).toMatchObject([
      { state: "failed", attempt: 1 },
      { state: "succeeded", attempt: 2 },
    ]);
    const papers = await app.inject({ method: "GET", url: "/api/papers" });
    expect(papers.json().papers).toHaveLength(1);
    expect(attempts).toBe(2);
    expect(pdfFetches).toBe(1);
    const replay = await app.inject({ method: "POST", url: `/api/jobs/${failedStatus.json().jobs[0].id}/retry`,
      headers: { "idempotency-key": "retry-fixture-attempt-1" } });
    expect(replay.statusCode).toBe(202);
    expect(replay.json().job.id).toBe(retry.json().job.id);
    const staleRetry = await app.inject({ method: "POST", url: `/api/jobs/${failedStatus.json().jobs[0].id}/retry`,
      headers: { "idempotency-key": "retry-fixture-stale" } });
    expect(staleRetry.statusCode).toBe(409);
    expect(staleRetry.json()).toEqual({ code: "job-not-retryable" });
    await app.close();
  });

  it("resumes the failed stage without rerunning Summary and keeps the Job's frozen Paper Version", async () => {
    const root = await mkdtemp(join(tmpdir(), "scholarloom-stage-retry-"));
    const storageLayout = initializeDataRoot(join(root, "data"));
    let summaryRuns = 0;
    const options = {
      storageLayout,
      paperSource: {
        async resolve() { return { arxivId: "2401.12345", latestVersion: 2, title: "Fixture Paper", authors: ["Ada Fixture"], year: 2024 }; },
        async fetchPdf() { return fixturePdf(); },
      },
      codexRunner: { async runSummary() { summaryRuns += 1; return { sections: [{ key: "overview", title: "概述", body: "frozen version" }],
        claims: [{ voice: "paper-evidence" as const, claim: "Table 1 reports accuracy 91.2.", sourceHandle: "pdf-page:2" }], readStatus: "read" as const }; } },
    };
    const app = await createApp({ ...options, knowledgeWriteFailurePoint: "staged" });
    const first = await app.inject({ method: "POST", url: "/api/imports", payload: { arxivUrl: "https://arxiv.org/abs/2401.12345v1" } });
    await waitForImport(app, first.json().importRequest.id, "failed");
    await unlink(join(storageLayout.vaultRoot, "library", "papers", "fixture-paper", "summary-v1-r1.md.staged"));
    const failed = await app.inject({ method: "GET", url: `/api/imports/${first.json().importRequest.id}` });
    await app.close();
    await exec("sqlite3", [storageLayout.databasePath,
      "UPDATE knowledge_write_requests SET phase='reserved',error_code=NULL WHERE request_type='summary';"]);
    const resumed = await createApp(options);
    const retry = await resumed.inject({ method: "POST", url: `/api/jobs/${failed.json().jobs[0].id}/retry`,
      headers: { "idempotency-key": "resume-staged-v1" } });
    await waitForImport(resumed, first.json().importRequest.id, "succeeded");
    expect(retry.statusCode).toBe(202);
    expect(summaryRuns).toBe(1);
    expect(await readFile(join(storageLayout.vaultRoot, "library", "papers", "fixture-paper", "summary-v1-r1.md"), "utf8"))
      .toContain("frozen version");
    await resumed.close();

    const versionedRoot = await mkdtemp(join(tmpdir(), "scholarloom-frozen-version-retry-"));
    const versionedStorage = initializeDataRoot(join(versionedRoot, "data"));
    let failV1 = true;
    const versions: number[] = [];
    const versioned = await createApp({ storageLayout: versionedStorage,
      paperSource: { ...options.paperSource, async fetchPdf(_id: string, version: number) { versions.push(version); return fixturePdf(`v${version}`); } },
      codexRunner: { async runSummary() { if (failV1) { failV1 = false; throw new Error("v1-summary-failed"); }
        return { sections: [{ key: "overview", title: "概述", body: "version complete" }],
          claims: [{ voice: "paper-evidence" as const, claim: "Table 1 reports accuracy 91.2.", sourceHandle: "pdf-page:2" }], readStatus: "read" as const }; } },
    });
    const old = await versioned.inject({ method: "POST", url: "/api/imports", payload: { arxivUrl: "https://arxiv.org/abs/2401.12345v1" } });
    await waitForImport(versioned, old.json().importRequest.id, "failed");
    const newer = await versioned.inject({ method: "POST", url: "/api/imports", payload: { arxivUrl: "https://arxiv.org/abs/2401.12345v2" } });
    await waitForImport(versioned, newer.json().importRequest.id, "succeeded");
    const oldStatus = await versioned.inject({ method: "GET", url: `/api/imports/${old.json().importRequest.id}` });
    await versioned.inject({ method: "POST", url: `/api/jobs/${oldStatus.json().jobs[0].id}/retry`,
      headers: { "idempotency-key": "retry-frozen-v1" } });
    await waitForImport(versioned, old.json().importRequest.id, "succeeded");
    expect(versions).toEqual([1, 2]);
    expect(await readFile(join(versionedStorage.vaultRoot, "library", "papers", "fixture-paper", "summary-v1-r1.md"), "utf8"))
      .toContain("arxiv:v1");
    const currentWorkspace = await versioned.inject({ method: "GET", url: `/api/papers/${encodeURIComponent(old.json().paper.id)}` });
    expect(currentWorkspace.json()).toMatchObject({ paper: { version: 2 }, summary: { sections: [{ body: "version complete" }] } });
    expect(currentWorkspace.json().summary.id).toContain("arxiv:v2");
    await versioned.close();
  });

  it("refetches a corrupt stored PDF and rebuilds an invalid extraction before retrying", async () => {
    const root = await mkdtemp(join(tmpdir(), "scholarloom-integrity-retry-"));
    const storageLayout = initializeDataRoot(join(root, "data"));
    let summaries = 0;
    let fetches = 0;
    const app = await createApp({ storageLayout,
      paperSource: { async resolve() { return { arxivId: "2401.12345", latestVersion: 2, title: "Fixture Paper", authors: ["Ada Fixture"], year: 2024 }; },
        async fetchPdf() { fetches += 1; return fixturePdf(); } },
      codexRunner: { async runSummary() { summaries += 1; if (summaries === 1) throw new Error("summary-failed");
        return { sections: [{ key: "overview", title: "概述", body: "integrity rebuilt" }],
          claims: [{ voice: "paper-evidence" as const, claim: "Table 1 reports accuracy 91.2.", sourceHandle: "pdf-page:2" }], readStatus: "read" as const }; } },
    });
    const first = await app.inject({ method: "POST", url: "/api/imports", payload: { arxivUrl: "https://arxiv.org/abs/2401.12345v2" } });
    await waitForImport(app, first.json().importRequest.id, "failed");
    const pdfDirectories = await readdir(join(storageLayout.originalsRoot, "papers"));
    const pdfNames = await readdir(join(storageLayout.originalsRoot, "papers", pdfDirectories[0]!));
    await chmod(join(storageLayout.originalsRoot, "papers", pdfDirectories[0]!, pdfNames[0]!), 0o600);
    await writeFile(join(storageLayout.originalsRoot, "papers", pdfDirectories[0]!, pdfNames[0]!), "corrupt");
    const extractionTypes = await readdir(join(storageLayout.derivedRoot, "document-extraction"));
    const extractionNames = await readdir(join(storageLayout.derivedRoot, "document-extraction", extractionTypes[0]!));
    await writeFile(join(storageLayout.derivedRoot, "document-extraction", extractionTypes[0]!, extractionNames[0]!), "corrupt");
    const failed = await app.inject({ method: "GET", url: `/api/imports/${first.json().importRequest.id}` });
    await app.inject({ method: "POST", url: `/api/jobs/${failed.json().jobs[0].id}/retry`,
      headers: { "idempotency-key": "retry-corrupt-artifacts" } });
    await waitForImport(app, first.json().importRequest.id, "succeeded");
    expect(fetches).toBe(2);
    expect(JSON.parse(await readFile(join(storageLayout.derivedRoot, "document-extraction", extractionTypes[0]!, extractionNames[0]!), "utf8")))
      .toHaveLength(2);
    expect((await app.inject({ method: "GET", url: "/api/diagnostics" })).json()).toMatchObject({ healthy: true, missingArtifacts: [] });
    await app.close();
  });
});
