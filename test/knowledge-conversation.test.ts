import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import type { KnowledgeAnswerRunner } from "../src/agent/knowledge-answer.js";
import { createSnapshot, verifySnapshot } from "../src/storage/data-operations.js";
import { KnowledgeConversationCoordinator } from "../src/storage/knowledge-conversation.js";
import { initializeDataRoot } from "../src/storage/layout.js";

function directAnswer(directAnswer: string, answerBasis: "model-knowledge" | "conversation-context" = "model-knowledge") {
  return {
    answerBasis,
    coverage: "none" as const,
    directAnswer,
    claims: [],
    disagreements: [],
    unknowns: [],
    citations: [],
    retrievalSummary: { searched: false as const, queryCount: 0 as const, candidateCount: 0 as const,
      openedSourceCount: 0 as const, usedSourceCount: 0 as const, budgetExhausted: false as const },
  };
}

async function eventually<T>(read: () => T, complete: (value: T) => boolean): Promise<T> {
  for (let count = 0; count < 100; count += 1) {
    const value = read();
    if (complete(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("knowledge attempt did not finish");
}

describe("Knowledge Conversation", () => {
  it("upgrades a v34 data root only after a healthy rollback snapshot can be created", async () => {
    const root = await mkdtemp(join(tmpdir(), "scholarloom-knowledge-migration-"));
    const layout = initializeDataRoot(join(root, "data"));
    let conversations = KnowledgeConversationCoordinator.open(layout, { async answer() { return directAnswer("unused"); } });
    await conversations.close();
    const before = new Database(layout.databasePath);
    before.exec(`
      DROP TRIGGER knowledge_messages_no_delete;
      DROP TRIGGER knowledge_messages_no_update;
      DROP TRIGGER knowledge_messages_reply_owner;
      DROP TABLE knowledge_turn_attempts;
      DROP TABLE knowledge_messages;
      DROP TABLE knowledge_conversations;
      DELETE FROM schema_migrations WHERE version=35;
    `);
    before.close();
    const rollbackSnapshot = join(root, "rollback-v34");
    await createSnapshot(layout, rollbackSnapshot);
    expect(verifySnapshot(rollbackSnapshot)).toMatchObject({ healthy: true, errors: [] });

    conversations = KnowledgeConversationCoordinator.open(layout, { async answer() { return directAnswer("unused"); } });

    expect(conversations.list("active")).toEqual([]);
    const migrated = new Database(layout.databasePath, { readonly: true });
    expect(migrated.prepare("SELECT name FROM schema_migrations WHERE version=35").pluck().get())
      .toBe("035-knowledge-conversations.sql");
    expect(migrated.prepare("SELECT name FROM schema_migrations WHERE version=36").pluck().get())
      .toBe("036-curated-evidence-receipts.sql");
    migrated.close();
    await conversations.close();
  });

  it("atomically creates one Conversation and two Messages after the first successful answer", async () => {
    const root = await mkdtemp(join(tmpdir(), "scholarloom-knowledge-conversation-"));
    const layout = initializeDataRoot(join(root, "data"));
    const runner: KnowledgeAnswerRunner = {
      async answer() {
        return {
          answerBasis: "model-knowledge",
          coverage: "none",
          directAnswer: "Diffusion 模型通过逐步去噪生成样本。",
          claims: [],
          disagreements: [],
          unknowns: [],
          citations: [],
          retrievalSummary: {
            searched: false,
            queryCount: 0,
            candidateCount: 0,
            openedSourceCount: 0,
            usedSourceCount: 0,
            budgetExhausted: false,
          },
        };
      },
    };
    const conversations = KnowledgeConversationCoordinator.open(layout, runner);

    const submitted = conversations.submit({
      question: "Diffusion 模型是怎样生成图像的？",
      idempotencyKey: "knowledge-first-turn-1",
    });
    const succeeded = await eventually(
      () => conversations.readAttempt(submitted.id),
      (attempt) => attempt.state !== "running",
    );

    expect(succeeded.state, JSON.stringify(succeeded.error)).toBe("succeeded");
    expect(succeeded.conversationId).toBeTruthy();
    expect(conversations.list("active")).toEqual([
      expect.objectContaining({
        id: succeeded.conversationId,
        title: "Diffusion 模型是怎样生成图像的？",
        messageCount: 2,
      }),
    ]);
    expect(conversations.read(succeeded.conversationId!)).toMatchObject({
      messages: [
        { role: "user", ordinal: 0, content: "Diffusion 模型是怎样生成图像的？" },
        {
          role: "assistant",
          ordinal: 1,
          content: "Diffusion 模型通过逐步去噪生成样本。",
          answerBasis: "model-knowledge",
          coverage: "none",
        },
      ],
    });
    const database = new Database(layout.databasePath);
    expect(() => database.prepare("UPDATE knowledge_messages SET content='mutated' WHERE role='assistant'").run())
      .toThrow("knowledge-message-immutable");
    expect(() => database.prepare("DELETE FROM knowledge_messages WHERE role='assistant'").run())
      .toThrow("knowledge-message-immutable");
    database.prepare(`INSERT INTO knowledge_conversations(id,title,status,created_at,updated_at)
      VALUES ('cross-conversation','cross','active',?,?)`).run(new Date().toISOString(), new Date().toISOString());
    database.prepare(`INSERT INTO knowledge_messages
      (id,knowledge_conversation_id,role,ordinal,content,created_at)
      VALUES ('cross-user','cross-conversation','user',0,'cross',?)`).run(new Date().toISOString());
    expect(() => database.prepare(`INSERT INTO knowledge_messages
      (id,knowledge_conversation_id,role,ordinal,reply_to_message_id,content,answer_basis,coverage,structured_answer_json,created_at)
      VALUES ('cross-reply',?,'assistant',2,'cross-user','invalid','model-knowledge','none','{}',?)`)
      .run(succeeded.conversationId, new Date().toISOString())).toThrow("knowledge-message-reply-invalid");
    database.close();
    await conversations.close();
  });

  it("keeps a failed first turn as operational audit without creating a Conversation", async () => {
    const root = await mkdtemp(join(tmpdir(), "scholarloom-knowledge-failure-"));
    const layout = initializeDataRoot(join(root, "data"));
    const conversations = KnowledgeConversationCoordinator.open(layout, {
      async answer() { throw new Error("fixture-answer-failed"); },
    }, { waitBeforeRetry: async () => undefined });

    const submitted = conversations.submit({ question: "这个问题会失败", idempotencyKey: "knowledge-failure-1" });
    const failed = await eventually(() => conversations.readAttempt(submitted.id),
      (attempt) => attempt.state !== "running");

    expect(failed).toMatchObject({
      state: "failed",
      conversationId: null,
      error: { code: "knowledge-answer-failed", detail: null },
    });
    expect(conversations.list("active")).toEqual([]);
    await conversations.close();
  });

  it("retries a transient curated MCP capability failure with a new run epoch", async () => {
    const root = await mkdtemp(join(tmpdir(), "scholarloom-knowledge-capability-retry-"));
    const layout = initializeDataRoot(join(root, "data"));
    const epochs: number[] = [];
    const conversations = KnowledgeConversationCoordinator.open(layout, {
      async answer(input) {
        epochs.push(input.runEpoch);
        if (epochs.length < 4) throw new Error("curated-mcp-capability-unavailable");
        return directAnswer("第四个执行 epoch 成功。");
      },
    }, { waitBeforeRetry: async () => undefined });

    const submitted = conversations.submit({ question: "需要检索的问题", idempotencyKey: "capability-retry" });
    const result = await eventually(() => conversations.readAttempt(submitted.id),
      (attempt) => attempt.state !== "running");

    expect(result).toMatchObject({ state: "succeeded", conversationId: expect.any(String), error: null });
    expect(epochs).toEqual([1, 2, 3, 4]);
    await conversations.close();
  });

  it("reports a capability error after exhausting three automatic retries", async () => {
    const root = await mkdtemp(join(tmpdir(), "scholarloom-knowledge-capability-exhausted-"));
    const layout = initializeDataRoot(join(root, "data"));
    const epochs: number[] = [];
    const conversations = KnowledgeConversationCoordinator.open(layout, {
      async answer(input) {
        epochs.push(input.runEpoch);
        throw new Error("curated-mcp-capability-unavailable");
      },
    }, { waitBeforeRetry: async () => undefined });

    const submitted = conversations.submit({ question: "无法启动检索", idempotencyKey: "capability-exhausted" });
    const result = await eventually(() => conversations.readAttempt(submitted.id),
      (attempt) => attempt.state !== "running");

    expect(result).toMatchObject({ state: "failed", conversationId: null,
      error: { code: "knowledge-answer-capability-unavailable", detail: null } });
    expect(epochs).toEqual([1, 2, 3, 4]);
    expect(conversations.list("active")).toEqual([]);
    await conversations.close();
  });

  it("waits 1s, 3s, and 10s before the three automatic retries", async () => {
    const root = await mkdtemp(join(tmpdir(), "scholarloom-knowledge-retry-backoff-"));
    const layout = initializeDataRoot(join(root, "data"));
    const delays: number[] = [];
    const conversations = KnowledgeConversationCoordinator.open(layout, {
      async answer() { throw new Error("curated-reader-failed"); },
    }, {
      waitBeforeRetry: async (milliseconds) => { delays.push(milliseconds); },
    });

    const submitted = conversations.submit({ question: "验证重试退避", idempotencyKey: "retry-backoff" });
    const result = await eventually(() => conversations.readAttempt(submitted.id),
      (attempt) => attempt.state !== "running");

    expect(result.state).toBe("failed");
    expect(delays).toEqual([1_000, 3_000, 10_000]);
    await conversations.close();
  });

  it("retries curated reader failures but does not retry a static Codex capability failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "scholarloom-knowledge-retry-classes-"));
    const layout = initializeDataRoot(join(root, "data"));
    const readerEpochs: number[] = [];
    const readerConversations = KnowledgeConversationCoordinator.open(layout, {
      async answer(input) {
        readerEpochs.push(input.runEpoch);
        if (readerEpochs.length === 1) throw new Error("curated-reader-failed");
        return directAnswer("读取恢复后成功。");
      },
    }, { waitBeforeRetry: async () => undefined });
    const readerAttempt = readerConversations.submit({ question: "读取失败后重试", idempotencyKey: "reader-retry" });
    const readerResult = await eventually(() => readerConversations.readAttempt(readerAttempt.id),
      (attempt) => attempt.state !== "running");
    expect(readerResult.state).toBe("succeeded");
    expect(readerEpochs).toEqual([1, 2]);
    await readerConversations.close();

    const staticEpochs: number[] = [];
    const staticConversations = KnowledgeConversationCoordinator.open(layout, {
      async answer(input) {
        staticEpochs.push(input.runEpoch);
        throw new Error("structured-capability-version-uncertified:0.144.5");
      },
    });
    const staticAttempt = staticConversations.submit({ question: "静态能力失败", idempotencyKey: "static-failure" });
    const staticResult = await eventually(() => staticConversations.readAttempt(staticAttempt.id),
      (attempt) => attempt.state !== "running");
    expect(staticResult.state).toBe("failed");
    expect(staticEpochs).toEqual([1]);
    await staticConversations.close();
  });

  it("rejects a context-only classification when no successful conversation context exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "scholarloom-knowledge-context-basis-"));
    const layout = initializeDataRoot(join(root, "data"));
    const conversations = KnowledgeConversationCoordinator.open(layout, {
      async answer() { return directAnswer("没有历史却声称基于历史。", "conversation-context"); },
    }, { waitBeforeRetry: async () => undefined });
    const submitted = conversations.submit({ question: "第一次问题", idempotencyKey: "invalid-context-basis" });

    const result = await eventually(() => conversations.readAttempt(submitted.id), (attempt) => attempt.state !== "running");

    expect(result).toMatchObject({ state: "failed", conversationId: null,
      error: { code: "knowledge-answer-context-missing", detail: null } });
    expect(conversations.list("active")).toEqual([]);
    await conversations.close();
  });

  it("cancels a running first turn without persisting the pending question", async () => {
    const root = await mkdtemp(join(tmpdir(), "scholarloom-knowledge-cancel-"));
    const layout = initializeDataRoot(join(root, "data"));
    const conversations = KnowledgeConversationCoordinator.open(layout, {
      answer() {
        return new Promise(() => undefined);
      },
    });

    const submitted = conversations.submit({ question: "不要保存这个问题", idempotencyKey: "knowledge-cancel-1" });
    expect(conversations.cancel(submitted.id, "knowledge-cancel-request")).toBe(true);
    expect(conversations.cancel(submitted.id, "knowledge-cancel-request")).toBe(true);
    expect(() => conversations.cancel(submitted.id, "knowledge-cancel-other")).toThrow("idempotency-key-conflict");

    expect(conversations.readAttempt(submitted.id)).toMatchObject({ state: "canceled", conversationId: null });
    expect(conversations.list("active")).toEqual([]);
    const database = new Database(layout.databasePath, { readonly: true });
    const operationalInput = database.prepare(`SELECT j.input_json FROM job_runs j
      JOIN knowledge_turn_attempts a ON a.job_run_id=j.id WHERE a.id=?`).pluck().get(submitted.id) as string;
    expect(operationalInput).not.toContain("不要保存这个问题");
    expect(operationalInput).toContain("questionHash");
    database.close();
    await conversations.close();
  });

  it("passes prior successful Messages to a follow-up and appends the next ordinals idempotently", async () => {
    const root = await mkdtemp(join(tmpdir(), "scholarloom-knowledge-follow-up-"));
    const layout = initializeDataRoot(join(root, "data"));
    const received: Array<Array<{ role: "user" | "assistant"; content: string }>> = [];
    const conversations = KnowledgeConversationCoordinator.open(layout, {
      async answer(input) {
        received.push(input.conversation);
        return received.length === 1 ? directAnswer("它通过逐步去噪生成图像。")
          : directAnswer("这里的“逐步”指多个反向扩散时间步。", "conversation-context");
      },
    });

    const first = conversations.submit({ question: "Diffusion 如何生成图像？", idempotencyKey: "follow-up-first" });
    const firstDone = await eventually(() => conversations.readAttempt(first.id), (attempt) => attempt.state !== "running");
    const second = conversations.submit({ conversationId: firstDone.conversationId!, question: "这里的逐步是什么意思？",
      idempotencyKey: "follow-up-second" });
    const replay = conversations.submit({ conversationId: firstDone.conversationId!, question: "这里的逐步是什么意思？",
      idempotencyKey: "follow-up-second" });
    const secondDone = await eventually(() => conversations.readAttempt(second.id), (attempt) => attempt.state !== "running");

    expect(replay.id).toBe(second.id);
    expect(() => conversations.submit({ conversationId: firstDone.conversationId!, question: "不同的问题",
      idempotencyKey: "follow-up-second" })).toThrow("idempotency-key-conflict");
    expect(secondDone.state).toBe("succeeded");
    expect(received[1]).toEqual([
      { role: "user", content: "Diffusion 如何生成图像？" },
      { role: "assistant", content: "它通过逐步去噪生成图像。" },
    ]);
    expect(conversations.read(firstDone.conversationId!).messages.map((message) => [message.ordinal, message.role]))
      .toEqual([[0, "user"], [1, "assistant"], [2, "user"], [3, "assistant"]]);
    await conversations.close();
  });

  it("enforces the configured timeout without persisting a hanging turn", async () => {
    const root = await mkdtemp(join(tmpdir(), "scholarloom-knowledge-timeout-"));
    const layout = initializeDataRoot(join(root, "data"));
    const conversations = KnowledgeConversationCoordinator.open(layout, {
      answer() {
        return new Promise(() => undefined);
      },
    }, { hardTimeoutMs: 10, waitBeforeRetry: async () => undefined });
    const submitted = conversations.submit({ question: "超时问题", idempotencyKey: "knowledge-timeout" });

    const result = await eventually(() => conversations.readAttempt(submitted.id), (attempt) => attempt.state !== "running");

    expect(result).toMatchObject({ state: "failed", conversationId: null,
      error: { code: "knowledge-answer-timeout", detail: null } });
    expect(conversations.list("active")).toEqual([]);
    await conversations.close();
  });

  it("does not execute more Knowledge Answer runners than the configured concurrency", async () => {
    const root = await mkdtemp(join(tmpdir(), "scholarloom-knowledge-concurrency-"));
    const layout = initializeDataRoot(join(root, "data"));
    let active = 0;
    let maximum = 0;
    let started = 0;
    const releases: Array<() => void> = [];
    const conversations = KnowledgeConversationCoordinator.open(layout, {
      async answer() {
        active += 1;
        started += 1;
        maximum = Math.max(maximum, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active -= 1;
        return directAnswer("完成");
      },
    }, { maximumConcurrency: 2, hardTimeoutMs: 1_000 });
    const attempts = ["one", "two", "three"].map((key) =>
      conversations.submit({ question: `问题 ${key}`, idempotencyKey: `concurrency-${key}` }));

    await eventually(() => started, (value) => value === 2);
    expect(maximum).toBe(2);
    expect(started).toBe(2);
    releases.shift()?.();
    await eventually(() => started, (value) => value === 3);
    releases.splice(0).forEach((release) => release());
    await eventually(() => attempts.map((attempt) => conversations.readAttempt(attempt.id)),
      (values) => values.every((attempt) => attempt.state !== "running"));

    expect(maximum).toBe(2);
    await conversations.close();
  });

  it("marks an unfinished transient turn interrupted across application restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "scholarloom-knowledge-restart-"));
    const layout = initializeDataRoot(join(root, "data"));
    let conversations = KnowledgeConversationCoordinator.open(layout, {
      answer(input) {
        return new Promise((_resolve, reject) => {
          if (input.signal.aborted) reject(input.signal.reason);
          else input.signal.addEventListener("abort", () => reject(input.signal.reason), { once: true });
        });
      },
    });
    const submitted = conversations.submit({ question: "重启时不能保存", idempotencyKey: "restart-interrupted" });

    await conversations.close();
    conversations = KnowledgeConversationCoordinator.open(layout, { async answer() { return directAnswer("unused"); } });

    expect(conversations.readAttempt(submitted.id)).toMatchObject({
      state: "interrupted",
      conversationId: null,
      error: { code: "application-closing" },
    });
    expect(conversations.list("active")).toEqual([]);
    await conversations.close();
  });
});
