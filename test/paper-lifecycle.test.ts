import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { PDFDocument, StandardFonts } from "pdf-lib";
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
    if (status.json().jobs[0]?.state === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`import did not reach ${expected}`);
}

async function fixturePdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage().drawText("ScholarLoom fixture introduction", { x: 40, y: 700, font });
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
          expect(context.sources.map((source) => source.handle)).toEqual(expect.arrayContaining(["pdf-page:2", "code:README.md"]));
          return {
            answer: "该实现将 attention 记录在固定仓库快照中。",
            citations: [{ sourceHandle: "code:README.md", locator: "README.md:1-2" }, { sourceHandle: "pdf-page:2", locator: "p. 2" }],
            proposedTakeaways: [
              { claim: "该论文用可追溯证据连接实验与实现。", sourceHandles: ["pdf-page:2", "code:README.md"] },
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
    const answer = await app.inject({ method: "POST", url: `/api/conversations/${conversation.json().conversation.id}/messages`, payload: { content: "WORKING_ONLY_SENTINEL 代码如何实现论文方法？" } });
    expect(answer.statusCode).toBe(201);
    expect(answer.json()).toMatchObject({
      message: { role: "assistant", citations: [{ type: "code", commitSha: stdout.trim(), path: "README.md" }, { type: "pdf", page: 2 }] },
      proposals: [{ proposalType: "takeaway", oneClickEligible: true }, { proposalType: "takeaway", oneClickEligible: false }],
    });
    const proposalId = answer.json().proposals[0].id;
    const firstDecision = await app.inject({ method: "POST", url: `/api/proposals/${proposalId}/decisions`, headers: { "idempotency-key": "accept-fixture-takeaway" }, payload: { action: "accept" } });
    const retry = await app.inject({ method: "POST", url: `/api/proposals/${proposalId}/decisions`, headers: { "idempotency-key": "accept-fixture-takeaway" }, payload: { action: "accept" } });
    expect(firstDecision.statusCode).toBe(201);
    expect(retry.json()).toEqual(firstDecision.json());
    expect(firstDecision.json()).toMatchObject({ takeaway: { reviewStatus: "confirmed", revision: 1 } });
    const summaryMarkdown = await readFile(join(storageLayout.vaultRoot, workspace.json().summary.markdownPath), "utf8");
    const takeawayMarkdown = await readFile(join(storageLayout.vaultRoot, firstDecision.json().takeaway.markdownPath), "utf8");
    const frontmatter = (markdown: string) => parse(markdown.split("---")[1]!) as Record<string, unknown>;
    expect(frontmatter(summaryMarkdown)).toMatchObject({ summary_revision_id: workspace.json().summary.id, paper_version_id: workspace.json().paper.versionId });
    expect(frontmatter(takeawayMarkdown)).toMatchObject({ id: firstDecision.json().takeaway.id, revision_id: firstDecision.json().takeaway.revisionId, review_status: "confirmed" });
    const blocked = await app.inject({ method: "POST", url: `/api/proposals/${answer.json().proposals[1].id}/decisions`, headers: { "idempotency-key": "blocked-unverified" }, payload: { action: "accept" } });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toEqual({ code: "source-verification-required" });
    const opened = await app.inject({ method: "POST", url: `/api/proposals/${answer.json().proposals[1].id}/open-source` });
    expect(opened.statusCode).toBe(201);
    const openedPdf = await app.inject({ method: "GET", url: opened.json().pdfUrl.split("#")[0] });
    expect(openedPdf.statusCode).toBe(200);
    const acceptedAfterOpen = await app.inject({ method: "POST", url: `/api/proposals/${answer.json().proposals[1].id}/decisions`, headers: { "idempotency-key": "accepted-after-open" }, payload: { action: "accept", sourceOpened: false } });
    expect(acceptedAfterOpen.statusCode).toBe(201);

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

  it("safely retries after Summary generation fails without duplicating the Paper", async () => {
    const root = await mkdtemp(join(tmpdir(), "scholarloom-summary-retry-"));
    const storageLayout = initializeDataRoot(join(root, "data"));
    let attempts = 0;
    const app = await createApp({
      storageLayout,
      paperSource: { async resolve() { return { arxivId: "2401.12345", latestVersion: 2, title: "Fixture Paper", authors: ["Ada Fixture"], year: 2024 }; }, async fetchPdf() { return fixturePdf(); } },
      codexRunner: { async runSummary() { attempts += 1; if (attempts === 1) throw new Error("fixture-codex-interrupted");
        return { sections: [{ key: "overview", title: "概述", body: "retry complete" }], claims: [{ voice: "paper-evidence" as const, claim: "Table 1 reports accuracy 91.2.", sourceHandle: "pdf-page:2" }], readStatus: "read" as const }; } },
    });
    const first = await app.inject({ method: "POST", url: "/api/imports", payload: { arxivUrl: "https://arxiv.org/abs/2401.12345v2" } });
    await waitForImport(app, first.json().importRequest.id, "failed");
    const retry = await app.inject({ method: "POST", url: "/api/imports", payload: { arxivUrl: "https://arxiv.org/abs/2401.12345v2" } });
    await waitForImport(app, retry.json().importRequest.id, "succeeded");
    const papers = await app.inject({ method: "GET", url: "/api/papers" });
    expect(papers.json().papers).toHaveLength(1);
    expect(attempts).toBe(2);
    await app.close();
  });
});
