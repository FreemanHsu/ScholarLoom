import { chmod, mkdir, mkdtemp, readdir, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { PDFDocument, StandardFonts } from "pdf-lib";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import type { FastifyInstance } from "fastify";

import { createApp, type CreateAppOptions } from "../src/app.js";
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
      pdf: { pageCount: 2 },
      summary: {
        status: "active",
        readStatus: "read",
        claims: [{ claim: "Table 1 reports accuracy 91.2.", evidence: { page: 2, verified: true } }],
      },
    });
    expect(workspace.json().summary.markdownPath).toMatch(/library\/papers\/fixture-paper\/summary-v2-r1\.md$/);

    const pdf = await app.inject({ method: "GET", url: `/api/paper-versions/${workspace.json().paper.versionId}/pdf` });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    expect(pdf.rawPayload.subarray(0, 4).toString()).toBe("%PDF");

    await app.close();
  });

  it("automatically pins and indexes an explicitly linked repository without executing it", async () => {
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
            proposedTakeaways: [
              { claim: "该论文用可追溯证据连接实验与实现。", sourceHandles: ["pdf-page:2", codeHandle], quote: null },
              { claim: "这条候选含有未核验引文。", quote: "NOT PRESENT VERBATIM", sourceHandles: ["pdf-page:2"] },
            ],
          };
        },
        async runEntry(context) {
          expect(context.sources).toHaveLength(2);
          expect(context.sources.map((source) => source.body).join(" ")).not.toContain("WORKING_ONLY_SENTINEL");
          return { answer: "已确认结论与 active Summary 都支持可追溯阅读。", sourceHandles: context.sources.map((source) => source.handle), uncertainty: null };
        },
      },
    });
    const imported = await app.inject({ method: "POST", url: "/api/imports", payload: { arxivUrl: "https://arxiv.org/abs/2401.12345v2" } });
    await waitForImport(app, imported.json().importRequest.id);
    const workspace = await app.inject({ method: "GET", url: `/api/papers/${imported.json().paper.id}` });

    expect(workspace.json().repository).toMatchObject({
      url: "https://github.com/example/fixture", commitSha: stdout.trim(), status: "ready",
      files: [{ path: "README.md" }, { path: "install.sh" }],
    });
    expect(workspace.json().repository.files.map((file: { path: string }) => file.path)).toContain("install.sh");

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
    expect(takeawayProposals).toEqual(expect.arrayContaining([
      expect.objectContaining({ proposalType: "takeaway", oneClickEligible: true }),
      expect.objectContaining({ proposalType: "takeaway", oneClickEligible: false }),
    ]));
    const eligibleProposal = takeawayProposals.find((proposal: { oneClickEligible: boolean }) => proposal.oneClickEligible)!;
    const unverifiedProposal = takeawayProposals.find((proposal: { oneClickEligible: boolean }) => !proposal.oneClickEligible)!;
    const proposalId = eligibleProposal.id;
    const firstDecision = await app.inject({ method: "POST", url: `/api/proposals/${proposalId}/decisions`, headers: { "idempotency-key": "accept-fixture-takeaway" }, payload: { action: "accept" } });
    const retry = await app.inject({ method: "POST", url: `/api/proposals/${proposalId}/decisions`, headers: { "idempotency-key": "accept-fixture-takeaway" }, payload: { action: "accept" } });
    expect(firstDecision.statusCode).toBe(201);
    expect(retry.json()).toEqual(firstDecision.json());
    expect(firstDecision.json()).toMatchObject({ takeaway: { reviewStatus: "confirmed", revision: 1 } });
    const knowledge = await app.inject({ method: "GET", url: `/api/papers/${imported.json().paper.id}/knowledge` });
    expect(knowledge.statusCode).toBe(200);
    expect(knowledge.json()).toMatchObject({
      pendingProposals: [expect.objectContaining({ proposalType: "takeaway", source: {
        conversationId: conversation.json().conversation.id, messageId: expect.stringMatching(/^message:/),
      } })],
      confirmedTakeaways: [expect.objectContaining({ claim: "该论文用可追溯证据连接实验与实现。", source: {
        conversationId: conversation.json().conversation.id, messageId: expect.stringMatching(/^message:/),
      } })],
    });
    const summaryMarkdown = await readFile(join(storageLayout.vaultRoot, workspace.json().summary.markdownPath), "utf8");
    const takeawayMarkdown = await readFile(join(storageLayout.vaultRoot, firstDecision.json().takeaway.markdownPath), "utf8");
    const frontmatter = (markdown: string) => parse(markdown.split("---")[1]!) as Record<string, unknown>;
    expect(frontmatter(summaryMarkdown)).toMatchObject({ summary_revision_id: workspace.json().summary.id, paper_version_id: workspace.json().paper.versionId });
    expect(frontmatter(takeawayMarkdown)).toMatchObject({ id: firstDecision.json().takeaway.id, revision_id: firstDecision.json().takeaway.revisionId, review_status: "confirmed" });
    const blocked = await app.inject({ method: "POST", url: `/api/proposals/${unverifiedProposal.id}/decisions`, headers: { "idempotency-key": "blocked-unverified" }, payload: { action: "accept" } });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toEqual({ code: "source-verification-required" });
    const sourceDatabase = new Database(storageLayout.databasePath);
    const newerVersionId = `${workspace.json().paper.versionId}:newer`;
    sourceDatabase.prepare(`INSERT INTO paper_versions
      (id,paper_id,source_type,source_version,source_url,resolved_at,processing_status,accepted_at,created_at,updated_at,
       source_content_hash,source_media_type,pdf_artifact_id)
      SELECT ?,paper_id,source_type,'v99',source_url,resolved_at,'ready',accepted_at,created_at,updated_at,
        source_content_hash,source_media_type,pdf_artifact_id FROM paper_versions WHERE id=?`)
      .run(newerVersionId, workspace.json().paper.versionId);
    sourceDatabase.prepare("UPDATE papers SET current_version_id=? WHERE id=?").run(newerVersionId, imported.json().paper.id);
    sourceDatabase.close();
    const opened = await app.inject({ method: "POST", url: `/api/proposals/${unverifiedProposal.id}/open-source` });
    expect(opened.statusCode).toBe(201);
    expect(decodeURIComponent(opened.json().pdfUrl)).toContain(`/api/paper-versions/${workspace.json().paper.versionId}/pdf`);
    const openedPdf = await app.inject({ method: "GET", url: opened.json().pdfUrl.split("#")[0] });
    expect(openedPdf.statusCode).toBe(200);
    const acceptedAfterOpen = await app.inject({ method: "POST", url: `/api/proposals/${unverifiedProposal.id}/decisions`,
      headers: { "idempotency-key": "accepted-after-open" },
      payload: { action: "edit-and-accept", editedClaim: "编辑后确认的固定来源结论。", sourceOpened: false } });
    expect(acceptedAfterOpen.statusCode).toBe(201);
    const auditDatabase = new Database(storageLayout.databasePath, { readonly: true });
    expect(auditDatabase.prepare("SELECT action FROM review_decisions WHERE idempotency_key='accepted-after-open'").get())
      .toEqual({ action: "accept-with-edit" });
    auditDatabase.close();

    const entry = await app.inject({ method: "POST", url: "/api/entry-agent/questions", payload: { question: "fixture 可追溯证据" } });
    expect(entry.statusCode).toBe(200);
    expect(entry.json()).toMatchObject({
      answer: "已确认结论与 active Summary 都支持可追溯阅读。",
      sources: [{ sourceType: "summary" }, { sourceType: "takeaway" }],
      projection: { stale: false },
    });
    expect(JSON.stringify(entry.json())).not.toContain("WORKING_ONLY_SENTINEL");
    const rebuilt = await app.inject({ method: "POST", url: "/api/diagnostics/rebuild-curated" });
    expect(rebuilt.json()).toMatchObject({ count: 3 });
    const afterRebuild = await app.inject({ method: "POST", url: "/api/entry-agent/questions", payload: { question: "fixture 可追溯证据" } });
    expect(afterRebuild.json().sources).toEqual(entry.json().sources);
    await app.close();
  });

  it("removes a repository-retry Proposal after a later import links the repository successfully", async () => {
    const root = await mkdtemp(join(tmpdir(), "scholarloom-repository-retry-"));
    const storageLayout = initializeDataRoot(join(root, "data"));
    const working = join(root, "working");
    const bare = join(root, "fixture.git");
    await exec("git", ["init", working]);
    await exec("git", ["-C", working, "config", "user.email", "fixture@example.test"]);
    await exec("git", ["-C", working, "config", "user.name", "Fixture"]);
    await writeFile(join(working, "README.md"), "# Fixture", "utf8");
    await mkdir(join(working, "docs"));
    await writeFile(join(working, "docs", "guide.md"), "# Guide", "utf8");
    await symlink("docs", join(working, "linked-docs"));
    await exec("git", ["-C", working, "add", "."]);
    await exec("git", ["-C", working, "commit", "-m", "fixture"]);
    await exec("git", ["clone", "--bare", working, bare]);
    const repository = new GitRepositoryAdapter({ "https://github.com/example/fixture": bare });
    let attempts = 0;
    const options: CreateAppOptions = {
      storageLayout,
      repositoryAdapter: { async materialize(url, destination) {
        attempts += 1;
        const materialized = await repository.materialize(url, destination);
        if (attempts === 1) {
          await writeFile(join(destination, "README.md"), "# Mutated after clone", "utf8");
          const error = new Error("EISDIR: illegal operation on a directory, read") as NodeJS.ErrnoException;
          error.code = "EISDIR";
          throw error;
        }
        return materialized;
      } },
      paperSource: { async resolve() { return { arxivId: "2401.12345", latestVersion: 2, title: "Fixture Paper", authors: ["Ada Fixture"], year: 2024 }; },
        async fetchPdf() { return fixturePdf(); } },
      codexRunner: { async runSummary() { return { sections: [{ key: "overview", title: "概述", body: "fixture" }],
        claims: [{ voice: "paper-evidence", claim: "Table 1 reports accuracy 91.2.", sourceHandle: "pdf-page:2" }], readStatus: "read" }; } },
    };
    const app = await createApp(options);
    const first = await app.inject({ method: "POST", url: "/api/imports", payload: { arxivUrl: "https://arxiv.org/abs/2401.12345v2" } });
    await waitForImport(app, first.json().importRequest.id);
    expect((await app.inject({ method: "GET", url: "/api/proposals" })).json().proposals)
      .toEqual(expect.arrayContaining([expect.objectContaining({ proposalType: "repository-retry", reviewStatus: "pending" })]));

    const retried = await app.inject({ method: "POST", url: "/api/imports", payload: { arxivUrl: "https://arxiv.org/abs/2401.12345v2" } });
    await waitForImport(app, retried.json().importRequest.id);
    expect(attempts).toBe(2);
    expect((await app.inject({ method: "GET", url: `/api/papers/${retried.json().paper.id}` })).json().repository)
      .toMatchObject({ status: "ready" });
    expect((await app.inject({ method: "GET", url: "/api/proposals" })).json().proposals)
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ proposalType: "repository-retry", reviewStatus: "pending" })]));
    const [repositoryCache] = await readdir(storageLayout.repositoryRoot);
    expect(await readFile(join(storageLayout.repositoryRoot, repositoryCache!, "README.md"), "utf8")).toBe("# Fixture");
    await app.close();

    const database = new Database(storageLayout.databasePath);
    database.prepare("UPDATE proposals SET review_status='pending',decided_at=NULL WHERE proposal_type='repository-retry'").run();
    database.prepare("DELETE FROM schema_migrations WHERE version=14").run();
    database.close();
    const migrated = await createApp(options);
    expect((await migrated.inject({ method: "GET", url: "/api/proposals" })).json().proposals)
      .toEqual(expect.arrayContaining([expect.objectContaining({ proposalType: "repository-retry", reviewStatus: "superseded" })]));
    await migrated.close();
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
