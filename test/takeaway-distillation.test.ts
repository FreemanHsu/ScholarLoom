import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { PDFDocument, StandardFonts } from "pdf-lib";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";

import type { AgenticEvidenceRunner } from "../src/agent/agentic-evidence-runner.js";
import {
  TAKEAWAY_CONTRACT_VERSION,
  takeawaySelectionSchema,
  type FrozenDistillationContext,
  type TakeawaySelectionRunner,
} from "../src/agent/takeaway-distillation.js";
import { createApp } from "../src/app.js";
import { ImportStore } from "../src/storage/import-store.js";
import { initializeDataRoot } from "../src/storage/layout.js";
import { TakeawayDistillationCoordinator, validateSelection } from "../src/storage/takeaway-distillation.js";

async function waitFor(app: FastifyInstance, conversationId: string,
  predicate: (body: any) => boolean): Promise<any> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const response = await app.inject({ method: "GET", url: `/api/conversations/${encodeURIComponent(conversationId)}` });
    const body = response.json();
    if (predicate(body)) return body;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("takeaway distillation did not settle");
}

async function fixtureApp(selectionRunner: TakeawaySelectionRunner): Promise<{
  app: FastifyInstance; layout: ReturnType<typeof initializeDataRoot>; paperId: string; conversationId: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "scholarloom-takeaway-distillation-"));
  const layout = initializeDataRoot(join(root, "data"));
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage().drawText("The method fixes source identity before deriving a durable conclusion.", { x: 40, y: 700, font });
  const bytes = await pdf.save();
  const answerRunner: AgenticEvidenceRunner = { async run(input) {
    const page = await readFile(join(input.workspaceRoot, "paper", "pages", "page-0001.md"), "utf8");
    const line = page.split("\n").findIndex((value) => value.includes("fixes source identity")) + 1;
    const quote = page.split("\n")[line - 1]!.trim();
    return { answer: "Fixture Paper 在形成结论前固定 source identity，并用 verified receipt 保留证据链。",
      groundingStatus: "answered",
      citations: [{ kind: "text", path: "paper/pages/page-0001.md", lineStart: line, lineEnd: line,
        quote }],
      usage: { status: "reported", inputTokens: 100, outputTokens: 20, totalTokens: 120 } };
  } };
  const app = await createApp({
    storageLayout: layout,
    paperSource: {
      async resolve(arxivId) { return { arxivId, latestVersion: 1, title: "Fixture Paper",
        authors: ["Ada Fixture"], year: 2026 }; },
      async fetchPdf() { return bytes; },
    },
    codexRunner: { async runSummary() { return {
      sections: [{ key: "overview", title: "概述", body: "The method fixes source identity." }],
      claims: [{ voice: "paper-evidence", claim: "The method fixes source identity.",
        sourceHandle: "pdf-page:1" }], readStatus: "read",
    }; } },
    agenticEvidenceRunner: answerRunner,
    takeawaySelectionRunner: selectionRunner,
  });
  const imported = await app.inject({ method: "POST", url: "/api/imports",
    payload: { arxivUrl: "https://arxiv.org/abs/2601.00111v1" } });
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const status = await app.inject({ method: "GET", url: `/api/imports/${imported.json().importRequest.id}` });
    if (status.json().jobs.at(-1)?.state === "succeeded") break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const conversation = await app.inject({ method: "POST",
    url: `/api/papers/${encodeURIComponent(imported.json().paper.id)}/conversations` });
  return { app, layout, paperId: imported.json().paper.id, conversationId: conversation.json().conversation.id };
}

describe("Takeaway Quality V2 distillation", () => {
  it("removes Takeaways from the answer contract and publishes the bounded V2 Selection contract", () => {
    expect(takeawaySelectionSchema.properties.selection.oneOf).toHaveLength(2);
    const candidate = takeawaySelectionSchema.properties.selection.oneOf[1]!;
    expect(candidate.properties.candidate.properties.receiptIds).toMatchObject({ minItems: 1, uniqueItems: true });
    expect(candidate.properties.candidate.properties.claim).toMatchObject({ minLength: 40, maxLength: 2000 });
  });

  it("commits answer and Receipts before an independent durable candidate Selection", async () => {
    const selectionRunner: TakeawaySelectionRunner = { async select(input) {
      expect(input.material.answer).toContain("source identity");
      expect(input.material.receipts).toHaveLength(1);
      return { selection: { decision: "candidate", candidate: {
        kind: "mechanism",
        claim: "Fixture Paper 在形成可复用结论之前固定 Paper Version 与 source identity，并让 verified Evidence Receipt 保留对原始证据的可追溯连接。",
        epistemicStatus: "evidence-backed",
        evidenceRationale: "唯一的 verified Receipt 逐字记录了固定 source identity 是形成 durable conclusion 的前置步骤。",
        caveat: "该测试只验证 durable lifecycle，不评价真实模型的科学判断质量。",
        receiptIds: [input.material.receipts[0]!.id],
        selectionRationale: "这是一条包含主体、机制、作用与边界的单一完整结论，脱离原问答后仍可理解。",
        duplicateHints: [],
      } }, usage: { status: "reported", inputTokens: 300, outputTokens: 80, totalTokens: 380 } };
    } };
    const { app, layout, conversationId, paperId } = await fixtureApp(selectionRunner);
    await app.inject({ method: "POST", url: `/api/conversations/${conversationId}/messages`,
      payload: { content: "解释这条机制", idempotencyKey: "answer-then-select" } });
    const restored = await waitFor(app, conversationId, (body) =>
      body.messages.find((message: any) => message.role === "assistant")
        ?.distillations?.some((run: any) => run.state === "succeeded"));
    const assistant = restored.messages.find((message: any) => message.role === "assistant");
    expect(assistant.distillations).toEqual([expect.objectContaining({
      state: "succeeded", contractVersion: TAKEAWAY_CONTRACT_VERSION, trigger: "automatic",
      outcome: "candidate", proposalId: expect.stringMatching(/^proposal:/),
    })]);
    const database = new Database(layout.databasePath);
    expect(database.prepare("SELECT count(*) FROM proposals WHERE source_message_id=?").pluck().get(assistant.id)).toBe(1);
    const ownership = database.prepare(`SELECT j.job_type,j.state,d.outcome_kind,m.manifest_hash
      FROM takeaway_distillation_runs d JOIN job_runs j ON j.id=d.job_run_id
      JOIN takeaway_distillation_manifests m ON m.id=d.manifest_id WHERE d.assistant_message_id=?`)
      .get(assistant.id);
    expect(ownership).toMatchObject({ job_type: "takeaway-distillation", state: "succeeded",
      outcome_kind: "candidate", manifest_hash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    const proposalId = assistant.distillations[0].proposalId;
    const accepted = await app.inject({ method: "POST", url: `/api/proposals/${encodeURIComponent(proposalId)}/decisions`,
      headers: { "idempotency-key": "confirm-v2-takeaway" }, payload: { action: "edit-and-accept",
        edited: { title: "Fixture source identity mechanism",
          caveat: "该测试只验证 durable lifecycle、writer 与非 evidence-sensitive edits。" } } });
    expect(accepted.statusCode, accepted.body).toBe(201);
    const knowledge = await app.inject({ method: "GET", url: `/api/papers/${encodeURIComponent(paperId)}/knowledge` });
    expect(knowledge.json().confirmedTakeaways).toHaveLength(1);
    const markdown = await readFile(join(layout.vaultRoot, accepted.json().takeaway.markdownPath), "utf8");
    expect(markdown).toContain("contract_version: \"takeaway-selection.v2\"");
    expect(markdown).toContain("## Evidence\n\n| Source | Evidence Receipt | Relationship |");
    expect(markdown).toContain(`| supports |`);
    expect(markdown).toContain("## Challenges or conflicts");
    expect(markdown).toContain(`Confirmed from Proposal ${proposalId}.`);
    const indexed = database.prepare("SELECT title,body FROM curated_search_documents WHERE source_type='takeaway'")
      .get() as { title: string; body: string };
    expect(indexed.title).not.toBe(indexed.body);
    expect(indexed.body).toContain("唯一的 verified Receipt");
    expect(indexed.body).not.toContain("selectionRationale");
    database.close();
    const duplicateRun = await app.inject({ method: "POST", url: `/api/messages/${encodeURIComponent(assistant.id)}/distill`,
      headers: { "idempotency-key": "explicit-duplicate-check" }, payload: {} });
    expect(duplicateRun.statusCode).toBe(202);
    await waitFor(app, conversationId, (body) =>
      body.messages.find((message: any) => message.id === assistant.id)?.distillations?.length === 2 &&
      body.messages.find((message: any) => message.id === assistant.id).distillations[1].state === "succeeded");
    const duplicateKnowledge = await app.inject({ method: "GET", url: `/api/papers/${encodeURIComponent(paperId)}/knowledge` });
    const duplicateProposal = duplicateKnowledge.json().pendingProposals[0];
    expect(duplicateProposal).toMatchObject({ duplicateAcknowledgementRequired: true,
      liveDuplicateIds: [accepted.json().takeaway.revisionId] });
    const metrics = await app.inject({ method: "GET", url: "/api/metrics/takeaway-distillation" });
    expect(metrics.json()).toMatchObject({
      eligibleGroundedTurns: 1,
      quality: { accepted_receipt_coverage: 1, live_duplicate_warnings: 1,
        editedFields: [{ field: "caveat", count: 1 }, { field: "title", count: 1 }] },
      operations: { failures: 0, retries: 0 },
    });
    const blocked = await app.inject({ method: "POST",
      url: `/api/proposals/${encodeURIComponent(duplicateProposal.id)}/decisions`,
      headers: { "idempotency-key": "duplicate-without-ack" }, payload: { action: "accept" } });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({ code: "duplicate-acknowledgement-required" });
    const acknowledged = await app.inject({ method: "POST",
      url: `/api/proposals/${encodeURIComponent(duplicateProposal.id)}/decisions`,
      headers: { "idempotency-key": "duplicate-with-ack" },
      payload: { action: "accept", duplicateAcknowledged: true } });
    expect(acknowledged.statusCode, acknowledged.body).toBe(201);
    const projectionDatabase = new Database(layout.databasePath);
    projectionDatabase.prepare(`UPDATE takeaway_revisions SET claim='SQLITE POISON',
      structured_json='{"evidenceRationale":"SQLITE POISON"}'`).run();
    projectionDatabase.close();
    const rebuilt = await app.inject({ method: "POST", url: "/api/diagnostics/rebuild-curated" });
    expect(rebuilt.statusCode, rebuilt.body).toBe(200);
    const rebuiltDatabase = new Database(layout.databasePath);
    const rebuiltBodies = rebuiltDatabase.prepare("SELECT body FROM curated_search_documents WHERE source_type='takeaway'")
      .all() as Array<{ body: string }>;
    expect(rebuiltBodies).toHaveLength(2);
    expect(rebuiltBodies.every((item) => item.body.includes("唯一的 verified Receipt"))).toBe(true);
    expect(rebuiltBodies.some((item) => item.body.includes("SQLITE POISON"))).toBe(false);
    rebuiltDatabase.close();
    const sourceOpen = await app.inject({ method: "POST",
      url: `/api/entry-agent/sources/takeaway/${encodeURIComponent(accepted.json().takeaway.revisionId)}/open` });
    expect(sourceOpen.statusCode).toBe(201);
    const metricsAfterOpen = await app.inject({ method: "GET", url: "/api/metrics/takeaway-distillation" });
    expect(metricsAfterOpen.json().quality.entrySourceOpens)
      .toContainEqual({ source_type: "takeaway", count: 1 });
    await app.close();
  });

  it("persists normal abstention and offers replay-safe explicit save with optional focus", async () => {
    const runner: TakeawaySelectionRunner = { async select(input) {
      return { selection: { decision: "no-proposal", reasonCode: input.context.trigger === "automatic"
        ? "multiple-claims" : "not-durable", rationale: "固定输入没有跨过 durable knowledge 的 Proposal 门槛。" },
        usage: { status: "unavailable" } };
    } };
    const { app, conversationId } = await fixtureApp(runner);
    await app.inject({ method: "POST", url: `/api/conversations/${conversationId}/messages`,
      payload: { content: "列出两件事", idempotencyKey: "abstain-answer" } });
    const automatic = await waitFor(app, conversationId, (body) =>
      body.messages.find((message: any) => message.role === "assistant")
        ?.distillations?.some((run: any) => run.reasonCode === "multiple-claims"));
    const assistant = automatic.messages.find((message: any) => message.role === "assistant");
    const request = { method: "POST" as const, url: `/api/messages/${assistant.id}/distill`,
      headers: { "idempotency-key": "explicit-focus" }, payload: { focus: "只提炼 source identity 机制" } };
    const first = await app.inject(request);
    const replay = await app.inject(request);
    expect(first.statusCode).toBe(202);
    expect(replay.json().distillation).toMatchObject({ jobRunId: first.json().distillation.jobRunId, replayed: true });
    const explicit = await waitFor(app, conversationId, (body) =>
      body.messages.find((message: any) => message.id === assistant.id)
        ?.distillations?.some((run: any) => run.trigger === "explicit-save" && run.state === "succeeded"));
    expect(explicit.messages.find((message: any) => message.id === assistant.id).distillations)
      .toEqual(expect.arrayContaining([expect.objectContaining({ trigger: "explicit-save",
        focus: "只提炼 source identity 机制", outcome: "no-proposal", reasonCode: "not-durable" })]));
    await app.close();
  });

  it("requires deliberate full evidence review for interpretation and evidence-sensitive edits", async () => {
    const runner: TakeawaySelectionRunner = { async select(input) {
      return { selection: { decision: "candidate", candidate: {
        kind: "reuse-implication",
        claim: "Fixture Paper 的 source-freezing pattern 可以作为其他异步知识系统的设计启示，但这种跨系统复用属于用户需要审查的 interpretation。",
        epistemicStatus: "interpretation",
        evidenceRationale: "Receipt 直接支持 source freezing 的论文内机制，但不直接证明对其他系统的适用性。",
        caveat: "跨系统复用尚未由 Fixture Paper 的实验直接验证。",
        receiptIds: [input.material.receipts[0]!.id],
        selectionRationale: "该结论具有复用价值，同时明确区分了 Paper evidence 与外推解释。",
        duplicateHints: [],
      } }, usage: { status: "unavailable" } };
    } };
    const { app, conversationId } = await fixtureApp(runner);
    await app.inject({ method: "POST", url: `/api/conversations/${conversationId}/messages`,
      payload: { content: "提出一条复用启示", idempotencyKey: "interpretive-answer" } });
    const restored = await waitFor(app, conversationId, (body) =>
      body.messages.find((message: any) => message.role === "assistant")
        ?.distillations?.some((run: any) => run.outcome === "candidate"));
    const proposalId = restored.messages.find((message: any) => message.role === "assistant").distillations[0].proposalId;
    const blocked = await app.inject({ method: "POST", url: `/api/proposals/${proposalId}/decisions`,
      headers: { "idempotency-key": "interpretation-fast-accept" }, payload: { action: "accept" } });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toEqual({ code: "full-evidence-review-required" });
    const accepted = await app.inject({ method: "POST", url: `/api/proposals/${proposalId}/decisions`,
      headers: { "idempotency-key": "interpretation-reviewed" },
      payload: { action: "accept", evidenceReviewed: true } });
    expect(accepted.statusCode, accepted.body).toBe(201);
    await app.close();
  });

  it("recovers every Takeaway write phase and fails closed on an external Markdown edit", async () => {
    for (const phase of ["staged", "renamed", "metadata-committed"] as const) {
      const runner: TakeawaySelectionRunner = { async select(input) {
        return { selection: { decision: "candidate", candidate: {
          kind: "mechanism",
          claim: `Fixture Paper 在 ${phase} recovery fixture 中固定 source identity，并通过 verified Evidence Receipt 保留可恢复的长期证据链。`,
          epistemicStatus: "evidence-backed",
          evidenceRationale: "冻结 Receipt 直接支持 source identity 与 durable conclusion 之间的机制关系。",
          caveat: "该 fixture 只覆盖 KnowledgeWriteRequest 的崩溃恢复语义。",
          receiptIds: [input.material.receipts[0]!.id],
          selectionRationale: "这条单一结论具有明确主体、机制、结果与恢复边界。",
          duplicateHints: [],
        } }, usage: { status: "unavailable" } };
      } };
      const { app, layout, conversationId } = await fixtureApp(runner);
      await app.inject({ method: "POST", url: `/api/conversations/${conversationId}/messages`,
        payload: { content: `验证 ${phase} recovery`, idempotencyKey: `write-${phase}` } });
      const restored = await waitFor(app, conversationId, (body) =>
        body.messages.find((message: any) => message.role === "assistant")
          ?.distillations?.some((run: any) => run.outcome === "candidate"));
      const proposalId = restored.messages.find((message: any) => message.role === "assistant").distillations[0].proposalId;
      await app.close();
      const faulted = ImportStore.open(layout, phase);
      expect(() => faulted.decideProposal(proposalId, `decision-${phase}`, "accept")).toThrow(`fault-injected:${phase}`);
      faulted.close();
      const recovered = ImportStore.open(layout);
      const database = new Database(layout.databasePath);
      expect(database.prepare("SELECT phase FROM knowledge_write_requests WHERE request_type='takeaway'")
        .pluck().get()).toBe("complete");
      const markdownPath = database.prepare("SELECT markdown_path FROM takeaway_revisions").pluck().get() as string;
      expect(await readFile(join(layout.vaultRoot, markdownPath), "utf8")).toContain("## Evidence");
      database.close();
      recovered.close();
    }

    const runner: TakeawaySelectionRunner = { async select(input) {
      return { selection: { decision: "candidate", candidate: {
        kind: "mechanism",
        claim: "Fixture Paper 固定 source identity 并通过 verified Evidence Receipt 测试 rename 后外部 Markdown 冲突的 fail-closed 行为。",
        epistemicStatus: "evidence-backed",
        evidenceRationale: "Receipt 支持固定 source identity 的机制，而冲突注入只测试 writer coordination。",
        caveat: "外部编辑必须保留并进入 reconciliation，而不是被恢复流程覆盖。",
        receiptIds: [input.material.receipts[0]!.id],
        selectionRationale: "该 fixture 是一条完整且可独立审核的 writer recovery 结论。",
        duplicateHints: [],
      } }, usage: { status: "unavailable" } };
    } };
    const { app, layout, conversationId } = await fixtureApp(runner);
    await app.inject({ method: "POST", url: `/api/conversations/${conversationId}/messages`,
      payload: { content: "验证外部 Markdown 冲突", idempotencyKey: "write-conflict" } });
    const restored = await waitFor(app, conversationId, (body) =>
      body.messages.find((message: any) => message.role === "assistant")
        ?.distillations?.some((run: any) => run.outcome === "candidate"));
    const proposalId = restored.messages.find((message: any) => message.role === "assistant").distillations[0].proposalId;
    await app.close();
    const faulted = ImportStore.open(layout, "renamed");
    expect(() => faulted.decideProposal(proposalId, "decision-conflict", "accept")).toThrow("fault-injected:renamed");
    faulted.close();
    const database = new Database(layout.databasePath);
    const target = database.prepare("SELECT target_path FROM knowledge_write_requests WHERE request_type='takeaway'")
      .pluck().get() as string;
    database.close();
    await writeFile(join(layout.vaultRoot, target), "# user edit\n", "utf8");
    const recovered = ImportStore.open(layout);
    const verify = new Database(layout.databasePath);
    expect(verify.prepare("SELECT phase FROM knowledge_write_requests WHERE request_type='takeaway'")
      .pluck().get()).toBe("conflicted");
    expect(verify.prepare("SELECT count(*) FROM proposals WHERE proposal_type='reconciliation' AND review_status='pending'")
      .pluck().get()).toBe(1);
    expect(await readFile(join(layout.vaultRoot, target), "utf8")).toBe("# user edit\n");
    verify.close();
    recovered.close();
  });

  it("marks a process-interrupted distillation and retries it from the same frozen manifest", async () => {
    const runner: TakeawaySelectionRunner = { async select(input) {
      return { selection: { decision: "candidate", candidate: {
        kind: "mechanism",
        claim: "Fixture Paper 固定 source identity，并让 retry 从同一 immutable manifest 重新执行独立 Selection 而不重跑原始回答。",
        epistemicStatus: "evidence-backed",
        evidenceRationale: "Frozen Receipt 与 manifest hashes 共同支持 retry 输入身份保持不变。",
        caveat: "该 fixture 模拟进程在 Selection terminal commit 之前退出。",
        receiptIds: [input.material.receipts[0]!.id],
        selectionRationale: "它是带明确恢复语义的单一 durable mechanism conclusion。",
        duplicateHints: [],
      } }, usage: { status: "unavailable" } };
    } };
    const { app, layout, conversationId } = await fixtureApp(runner);
    await app.inject({ method: "POST", url: `/api/conversations/${conversationId}/messages`,
      payload: { content: "验证 Selection crash recovery", idempotencyKey: "selection-recovery" } });
    const settled = await waitFor(app, conversationId, (body) =>
      body.messages.find((message: any) => message.role === "assistant")
        ?.distillations?.some((run: any) => run.outcome === "candidate"));
    const originalId = settled.messages.find((message: any) => message.role === "assistant").distillations[0].id;
    await app.close();
    const database = new Database(layout.databasePath);
    database.transaction(() => {
      database.prepare("UPDATE takeaway_distillation_runs SET outcome_kind=NULL,proposal_id=NULL WHERE job_run_id=?")
        .run(originalId);
      database.prepare(`UPDATE job_runs SET state='running',completed_at=NULL,lease_owner='dead-process',
        lease_expires_at='2000-01-01T00:00:00.000Z' WHERE id=?`).run(originalId);
    })();
    database.close();
    const bootstrap = ImportStore.open(layout);
    bootstrap.close();
    const recoveredDatabase = new Database(layout.databasePath);
    expect(recoveredDatabase.prepare(`SELECT state,failure_kind,error_json,run_epoch,lease_owner,lease_expires_at
      FROM job_runs WHERE id=?`).get(originalId)).toMatchObject({
        state: "interrupted", failure_kind: "process_interrupted", error_json: "{\"code\":\"process-interrupted\"}",
        run_epoch: 2, lease_owner: null, lease_expires_at: null,
      });
    recoveredDatabase.prepare("UPDATE evidence_receipts SET verification_status='render-drift'").run();
    recoveredDatabase.close();
    const coordinator = new TakeawayDistillationCoordinator(layout, runner);
    const drifted = coordinator.retry(originalId, "selection-recovery-drift");
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const check = new Database(layout.databasePath);
      const state = check.prepare("SELECT state FROM job_runs WHERE id=?").pluck().get(drifted.jobRunId);
      check.close();
      if (state === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const driftDatabase = new Database(layout.databasePath);
    expect(driftDatabase.prepare("SELECT failure_kind FROM job_runs WHERE id=?").pluck().get(drifted.jobRunId))
      .toBe("runner_failed");
    driftDatabase.prepare("UPDATE evidence_receipts SET verification_status='verified'").run();
    driftDatabase.close();
    const retried = coordinator.retry(drifted.jobRunId, "selection-recovery-retry");
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const check = new Database(layout.databasePath);
      const state = check.prepare("SELECT state FROM job_runs WHERE id=?").pluck().get(retried.jobRunId);
      check.close();
      if (state === "succeeded") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const verified = new Database(layout.databasePath);
    expect(verified.prepare("SELECT state FROM job_runs WHERE id=?").pluck().get(retried.jobRunId)).toBe("succeeded");
    const manifestIds = verified.prepare(`SELECT DISTINCT manifest_id FROM takeaway_distillation_runs
      WHERE job_run_id IN (?,?,?)`).all(originalId, drifted.jobRunId, retried.jobRunId);
    expect(manifestIds).toHaveLength(1);
    verified.close();
    await coordinator.close();
  });

  it("fails closed on obvious dangling references and receipt ownership drift", () => {
    const manifest: FrozenDistillationContext = {
      contractVersion: TAKEAWAY_CONTRACT_VERSION,
      paper: { id: "paper:1", versionId: "version:1" },
      source: { userMessageId: "u", userMessageHash: "u", assistantMessageId: "a", assistantMessageHash: "a" },
      receipts: [{ id: "receipt:1", evidenceKind: "pdf", sourceId: "paper:1", sourceRevision: "version:1",
        contentHash: "hash", locatorHash: "locator" }],
      summary: null, confirmedTakeaways: [], trigger: "automatic" as const, focus: null, focusHash: "",
      contractHash: "contract", promptHash: "prompt",
    };
    expect(() => validateSelection({ decision: "candidate", candidate: {
      kind: "mechanism", claim: "该方法, " + "无法脱离原问题独立理解但长度已经满足确定性边界。".repeat(2),
      epistemicStatus: "evidence-backed", evidenceRationale: "Receipt 支持该片段。",
      caveat: null, receiptIds: ["receipt:1"], selectionRationale: "看似重要但仍是指代片段。",
      duplicateHints: [],
    } }, manifest)).toThrow(/takeaway-lint-referential-fragment/);
    expect(() => validateSelection({ decision: "candidate", candidate: {
      kind: "mechanism", claim: "Fixture Paper 使用一条完整、明确且足够长的机制说明来测试非法 Receipt ownership。",
      epistemicStatus: "evidence-backed", evidenceRationale: "Receipt 应当属于冻结的 source Attempt。",
      caveat: null, receiptIds: ["receipt:invented"], selectionRationale: "该候选用于验证 provenance fail closed。",
      duplicateHints: [],
    } }, manifest)).toThrow(/takeaway-lint-receipt-ownership/);
    expect(() => validateSelection({ decision: "candidate", candidate: {
      kind: "reuse-implication", claim: "Fixture Paper 的 source-freezing pattern 可能适用于其他异步知识系统，但仍需要新的系统实验验证。",
      epistemicStatus: "hypothesis", evidenceRationale: "Receipt 只说明该假设的 provenance 与设计动机。",
      caveat: null, receiptIds: ["receipt:1"], selectionRationale: "该候选是一条需要未来数据验证的单一假设。",
      duplicateHints: [],
    } }, manifest)).toThrow(/takeaway-lint-hypothesis-caveat-required/);
  });
});
