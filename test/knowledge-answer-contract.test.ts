import { describe, expect, it } from "vitest";

import { knowledgeAnswerSchema, validateKnowledgeAnswer, type KnowledgeAnswer } from "../src/agent/knowledge-answer.js";

function expectStrictResponseSchema(node: unknown, path = "root"): void {
  if (!node || typeof node !== "object") return;
  const schema = node as { type?: string; const?: unknown; enum?: unknown[]; items?: unknown;
    properties?: Record<string, unknown> };
  if ("const" in schema || "enum" in schema) expect(schema.type, `${path} must declare type`).toBeTruthy();
  if (schema.type === "array") expect(schema.items, `${path} must declare items`).toBeTruthy();
  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    expectStrictResponseSchema(child, `${path}.properties.${key}`);
  }
  if (schema.items) expectStrictResponseSchema(schema.items, `${path}.items`);
}

function answer(overrides: Partial<KnowledgeAnswer> = {}): KnowledgeAnswer {
  return {
    answerBasis: "model-knowledge",
    coverage: "none",
    directAnswer: "这是一个明确标记的通用回答。",
    claims: [], disagreements: [], unknowns: [], citations: [],
    retrievalSummary: { searched: false, queryCount: 0, candidateCount: 0,
      openedSourceCount: 0, usedSourceCount: 0, budgetExhausted: false,
      projectionStale: false, lastSuccessfulAt: null },
    ...overrides,
  };
}

describe("Knowledge Answer direct-answer contract", () => {
  it("uses the strict response-format schema subset accepted by Codex", () => {
    expectStrictResponseSchema(knowledgeAnswerSchema);
  });

  it("accepts model knowledge and conversation clarification without citations", () => {
    expect(() => validateKnowledgeAnswer(answer())).not.toThrow();
    expect(() => validateKnowledgeAnswer(answer({ answerBasis: "conversation-context" }))).not.toThrow();
  });

  it("rejects unsafe Markdown and inconsistent retrieval accounting", () => {
    expect(() => validateKnowledgeAnswer(answer({ directAnswer: "<script>alert(1)</script>" })))
      .toThrow("knowledge-answer-markdown-unsafe");
    expect(() => validateKnowledgeAnswer(answer({ directAnswer: "[外部资料](https://example.test)" })))
      .toThrow("knowledge-answer-markdown-unsafe");
    expect(() => validateKnowledgeAnswer(answer({
      retrievalSummary: { searched: false, queryCount: 1, candidateCount: 1,
        openedSourceCount: 0, usedSourceCount: 0, budgetExhausted: false,
        projectionStale: false, lastSuccessfulAt: null },
    }))).toThrow("knowledge-answer-retrieval-invalid");
  });

  it("cannot claim curated coverage or malformed structured claims without retrieval", () => {
    expect(() => validateKnowledgeAnswer(answer({ coverage: "supported" })))
      .toThrow("knowledge-answer-coverage-invalid");
    expect(() => validateKnowledgeAnswer(answer({
      claims: [{ text: "伪造来源支持", status: "source-supported", citationOrdinals: [] }],
    }))).toThrow("knowledge-answer-claim-invalid");
  });

  it("accepts a grounded answer with verified curated citations", () => {
    expect(() => validateKnowledgeAnswer(answer({
      answerBasis: "curated-evidence",
      coverage: "supported",
      claims: [{ text: "Diffusion 通过反向过程逐步去噪。", status: "source-supported", citationOrdinals: [1] }],
      citations: [{ handle: "curated-source-01", sourceType: "summary", sourceId: "summary-1",
        revisionId: "summary-1", contentHash: "a".repeat(64), title: "Diffusion Summary",
        trustLabel: "generated-from-primary-source", locator: { lineStart: 3, lineEnd: 3 },
        quote: "通过反向过程逐步去噪。", whySelected: "直接支持生成过程。" }],
      retrievalSummary: { searched: true, queryCount: 2, candidateCount: 12,
        openedSourceCount: 3, usedSourceCount: 1, budgetExhausted: false,
        projectionStale: true, lastSuccessfulAt: "2026-08-23T00:00:00.000Z" },
    }))).not.toThrow();
  });

  it("does not allow grounded claims without citations or full-support claims after exhausting the budget", () => {
    expect(() => validateKnowledgeAnswer(answer({
      answerBasis: "curated-evidence", coverage: "supported",
      retrievalSummary: { searched: true, queryCount: 1, candidateCount: 0,
        openedSourceCount: 0, usedSourceCount: 0, budgetExhausted: false,
        projectionStale: false, lastSuccessfulAt: null },
    }))).toThrow("knowledge-answer-citation-invalid");
    expect(() => validateKnowledgeAnswer(answer({
      answerBasis: "curated-evidence", coverage: "supported",
      claims: [{ text: "有来源。", status: "source-supported", citationOrdinals: [1] }],
      citations: [{ handle: "curated-source-01", sourceType: "summary", sourceId: "summary-1",
        revisionId: "summary-1", contentHash: "a".repeat(64), title: "Summary",
        trustLabel: "generated-from-primary-source", locator: { lineStart: 1, lineEnd: 1 },
        quote: "有来源。", whySelected: "直接支持。" }],
      retrievalSummary: { searched: true, queryCount: 8, candidateCount: 60,
        openedSourceCount: 20, usedSourceCount: 1, budgetExhausted: true,
        projectionStale: false, lastSuccessfulAt: null },
    }))).toThrow("knowledge-answer-budget-coverage-invalid");
  });

  it("requires consensus claims to reference two distinct curated source identities", () => {
    const citation = { handle: "curated-source-01", sourceType: "summary" as const, sourceId: "summary-1",
      revisionId: "summary-1", contentHash: "a".repeat(64), title: "Summary",
      trustLabel: "generated-from-primary-source" as const, locator: { lineStart: 1, lineEnd: 1 },
      quote: "一致结论。", whySelected: "直接支持。" };
    expect(() => validateKnowledgeAnswer(answer({ answerBasis: "curated-evidence", coverage: "supported",
      claims: [{ text: "一致结论。", status: "source-consensus", citationOrdinals: [1] }], citations: [citation],
      retrievalSummary: { searched: true, queryCount: 1, candidateCount: 2, openedSourceCount: 1,
        usedSourceCount: 1, budgetExhausted: false, projectionStale: false, lastSuccessfulAt: null },
    }))).toThrow("knowledge-answer-consensus-invalid");
  });
});
