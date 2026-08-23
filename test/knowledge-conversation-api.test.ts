import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import type { KnowledgeAnswerRunner } from "../src/agent/knowledge-answer.js";
import { initializeDataRoot } from "../src/storage/layout.js";

async function waitForAttempt(app: FastifyInstance, attemptId: string) {
  for (let count = 0; count < 100; count += 1) {
    const response = await app.inject({ method: "GET",
      url: `/api/knowledge-question-attempts/${encodeURIComponent(attemptId)}` });
    if (response.json().state !== "running") return response;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("knowledge API attempt did not finish");
}

const runner: KnowledgeAnswerRunner = {
  async answer(input) {
    return {
      answerBasis: input.conversation.length ? "conversation-context" : "model-knowledge",
      coverage: "none",
      directAnswer: input.conversation.length ? "这是基于上一轮的澄清。" : "这是一个通用回答。",
      claims: [], disagreements: [], unknowns: [], citations: [],
      retrievalSummary: { searched: false, queryCount: 0, candidateCount: 0,
        openedSourceCount: 0, usedSourceCount: 0, budgetExhausted: false },
    };
  },
};

describe("Knowledge Conversation HTTP API", () => {
  it("does not expose the retired one-shot Entry Agent question route", async () => {
    const root = await mkdtemp(join(tmpdir(), "scholarloom-retired-entry-question-"));
    const app = await createApp({
      storageLayout: initializeDataRoot(join(root, "data")),
      paperSource: { async resolve() { throw new Error("unused"); } },
      knowledgeAnswerRunner: runner,
    });

    const response = await app.inject({ method: "POST", url: "/api/entry-agent/questions",
      payload: { question: "旧入口不能绕过 Knowledge Conversation" } });

    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("submits, polls, lists, reads, and follows up through one application module", async () => {
    const root = await mkdtemp(join(tmpdir(), "scholarloom-knowledge-api-"));
    const app = await createApp({
      storageLayout: initializeDataRoot(join(root, "data")),
      paperSource: { async resolve(arxivId) {
        return { arxivId, latestVersion: 1, title: "unused", authors: [], year: 2026 };
      } },
      knowledgeAnswerRunner: runner,
    });

    const missingKey = await app.inject({ method: "POST", url: "/api/knowledge-conversations/turns",
      payload: { question: "没有 key" } });
    expect(missingKey.statusCode).toBe(400);
    expect(missingKey.json()).toEqual({ code: "idempotency-key-required" });

    const submitted = await app.inject({ method: "POST", url: "/api/knowledge-conversations/turns",
      headers: { "idempotency-key": "api-first-turn" }, payload: { question: "什么是 Diffusion？" } });
    expect(submitted.statusCode).toBe(202);
    const conflictingReplay = await app.inject({ method: "POST", url: "/api/knowledge-conversations/turns",
      headers: { "idempotency-key": "api-first-turn" }, payload: { question: "另一个问题" } });
    expect(conflictingReplay.statusCode).toBe(409);
    expect(conflictingReplay.json()).toEqual({ code: "idempotency-key-conflict" });
    const succeeded = await waitForAttempt(app, submitted.json().attempt.id);
    expect(succeeded.json()).toMatchObject({ state: "succeeded", conversationId: expect.any(String) });

    const conversationId = succeeded.json().conversationId as string;
    const list = await app.inject({ method: "GET", url: "/api/knowledge-conversations?view=active" });
    expect(list.json().conversations).toEqual([
      expect.objectContaining({ id: conversationId, messageCount: 2 }),
    ]);
    const detail = await app.inject({ method: "GET",
      url: `/api/knowledge-conversations/${encodeURIComponent(conversationId)}` });
    expect(detail.json().messages).toHaveLength(2);

    const followUp = await app.inject({ method: "POST",
      url: `/api/knowledge-conversations/${encodeURIComponent(conversationId)}/turns`,
      headers: { "idempotency-key": "api-follow-up" }, payload: { question: "换句话说呢？" } });
    await waitForAttempt(app, followUp.json().attempt.id);
    const continued = await app.inject({ method: "GET",
      url: `/api/knowledge-conversations/${encodeURIComponent(conversationId)}` });
    expect(continued.json().messages).toHaveLength(4);
    expect(continued.json().messages.at(-1)).toMatchObject({ answerBasis: "conversation-context" });
    await app.close();
  });

  it("cancels a transient first turn through the attempt route without creating history", async () => {
    const root = await mkdtemp(join(tmpdir(), "scholarloom-knowledge-api-cancel-"));
    const app = await createApp({
      storageLayout: initializeDataRoot(join(root, "data")),
      paperSource: { async resolve() { throw new Error("unused"); } },
      knowledgeAnswerRunner: {
        answer(input) {
          return new Promise((_resolve, reject) => {
            if (input.signal.aborted) reject(input.signal.reason);
            else input.signal.addEventListener("abort", () => reject(input.signal.reason), { once: true });
          });
        },
      },
    });
    const submitted = await app.inject({ method: "POST", url: "/api/knowledge-conversations/turns",
      headers: { "idempotency-key": "api-cancel" }, payload: { question: "取消后不保存" } });

    const canceled = await app.inject({ method: "POST",
      url: `/api/knowledge-question-attempts/${encodeURIComponent(submitted.json().attempt.id)}/cancel`,
      headers: { "idempotency-key": "api-cancel-request" } });
    const replayed = await app.inject({ method: "POST",
      url: `/api/knowledge-question-attempts/${encodeURIComponent(submitted.json().attempt.id)}/cancel`,
      headers: { "idempotency-key": "api-cancel-request" } });
    const conflicting = await app.inject({ method: "POST",
      url: `/api/knowledge-question-attempts/${encodeURIComponent(submitted.json().attempt.id)}/cancel`,
      headers: { "idempotency-key": "api-cancel-other" } });

    expect(canceled.statusCode).toBe(202);
    expect(replayed.statusCode).toBe(202);
    expect(replayed.json()).toEqual({ state: "canceled" });
    expect(conflicting.statusCode).toBe(409);
    expect(conflicting.json()).toEqual({ code: "idempotency-key-conflict" });
    expect((await app.inject({ method: "GET", url: "/api/knowledge-conversations?view=active" })).json())
      .toEqual({ conversations: [] });
    await app.close();
  });

  it("requires an idempotency key for cancellation", async () => {
    const root = await mkdtemp(join(tmpdir(), "scholarloom-knowledge-api-cancel-key-"));
    const app = await createApp({
      storageLayout: initializeDataRoot(join(root, "data")),
      paperSource: { async resolve() { throw new Error("unused"); } },
      knowledgeAnswerRunner: runner,
    });

    const response = await app.inject({ method: "POST",
      url: "/api/knowledge-question-attempts/missing/cancel" });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ code: "idempotency-key-required" });
    await app.close();
  });
});
