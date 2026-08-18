import { describe, expect, it } from "vitest";

import { AGENT_PROMPT_TEMPLATES } from "../src/agent/agent-prompts.js";
import {
  agenticEvidenceSchema,
  createChatSchema,
  createEntrySchema,
  createSummarySchema,
  validateChatOutput,
  validateEntryOutput,
  validateSummaryOutput,
} from "../src/agent/output-contracts.js";
import { validateGroundingReceiptContract } from "../src/storage/agent-run-coordinator.js";
import type { GroundedTextReceipt } from "../src/storage/answer-grounding-gate.js";

const summary = () => ({
  sections: [
    { key: "overview", title: "概述", body: "总体结论 [pdf-page:1]" },
    { key: "core-ideas", title: "核心想法", body: "研究动机 [pdf-page:1]" },
    { key: "technical-implementation", title: "方法", body: "核心机制 [pdf-page:2]" },
    { key: "experiments-analysis", title: "实验", body: "主要结果 [pdf-page:3]" },
    { key: "summary-thoughts", title: "总结", body: "Agent 评价：仍需外部复现。" },
  ],
  claims: [{ voice: "paper-evidence", claim: "方法在固定评测上得到结果。", sourceHandle: "pdf-page:3" }],
  readStatus: "read",
});

describe("Agent output contracts", () => {
  it("specializes Summary handles and enforces canonical sections without structured Agent assessments", () => {
    const schema = createSummarySchema(["pdf-page:1", "pdf-page:2", "pdf-page:3"]);
    expect(schema.properties.sections).toMatchObject({ minItems: 5, maxItems: 7 });
    expect(schema.properties.claims.items.properties.voice.enum).toEqual(["authors-claim", "paper-evidence"]);
    expect(schema.properties.claims.items.properties.sourceHandle).toEqual({
      type: "string", enum: ["pdf-page:1", "pdf-page:2", "pdf-page:3"],
    });
    expect(() => validateSummaryOutput(summary(), ["pdf-page:1", "pdf-page:2", "pdf-page:3"]))
      .not.toThrow();

    const duplicate = summary();
    duplicate.sections.splice(1, 0, { ...duplicate.sections[0]! });
    expect(() => validateSummaryOutput(duplicate, ["pdf-page:1", "pdf-page:2", "pdf-page:3"]))
      .toThrow("summary-contract-duplicate-section");

    const uncitedMethod = summary();
    uncitedMethod.sections[2] = { ...uncitedMethod.sections[2]!, body: "没有页码锚点的方法描述。" };
    expect(() => validateSummaryOutput(uncitedMethod, ["pdf-page:1", "pdf-page:2", "pdf-page:3"]))
      .toThrow("summary-contract-citation-required:technical-implementation");

    const inventedMarker = summary();
    inventedMarker.sections[2] = { ...inventedMarker.sections[2]!, body: "核心机制 [pdf-page:99]" };
    expect(() => validateSummaryOutput(inventedMarker, ["pdf-page:1", "pdf-page:2", "pdf-page:3"]))
      .toThrow("summary-contract-unknown-marker");
    const malformedMarker = summary();
    malformedMarker.sections[2] = { ...malformedMarker.sections[2]!, body: "禁止页码范围 [pdf-page:2-3]" };
    expect(() => validateSummaryOutput(malformedMarker, ["pdf-page:1", "pdf-page:2", "pdf-page:3"]))
      .toThrow("summary-contract-unknown-marker");
  });

  it("binds legacy Paper Chat citations to exact runtime handle/locator pairs", () => {
    const schema = createChatSchema(["pdf-page:1", "summary:1:overview"]);
    expect(schema.properties.answer).toMatchObject({ minLength: 1, maxLength: 12_000 });
    expect(schema.properties.citations).toMatchObject({ maxItems: 12, uniqueItems: true });
    expect(schema.properties.citations.items.properties.sourceHandle).toEqual({
      type: "string", enum: ["pdf-page:1", "summary:1:overview"],
    });
    const sources = [
      { handle: "pdf-page:1", locator: "p. 1" },
      { handle: "summary:1:overview", locator: "overview" },
    ];
    expect(() => validateChatOutput({ answer: "资料支持该回答。",
      citations: [{ sourceHandle: "pdf-page:1", locator: "p. 1" }] }, sources)).not.toThrow();
    expect(() => validateChatOutput({ answer: "locator 被改写。",
      citations: [{ sourceHandle: "pdf-page:1", locator: "page 1" }] }, sources))
      .toThrow("chat-contract-citation-mismatch");
    expect(() => validateChatOutput({ answer: "重复引用。", citations: [
      { sourceHandle: "pdf-page:1", locator: "p. 1" },
      { sourceHandle: "pdf-page:1", locator: "p. 1" },
    ] }, sources)).toThrow("chat-contract-citation-duplicate");
  });

  it("makes curated Entry answer status machine-checkable", () => {
    const schema = createEntrySchema(["curated:summary:1", "curated:takeaway:1"]);
    expect(schema.properties.answerStatus.enum).toEqual([
      "answered", "partially_answered", "insufficient_evidence", "conflicting_evidence",
    ]);
    expect(schema.properties.sourceHandles).toMatchObject({ maxItems: 12, uniqueItems: true });

    expect(() => validateEntryOutput({
      answerStatus: "answered", answer: "来源直接支持。", sourceHandles: ["curated:summary:1"], uncertainty: null,
    }, ["curated:summary:1", "curated:takeaway:1"])).not.toThrow();
    expect(() => validateEntryOutput({
      answerStatus: "partially_answered", answer: "只能回答一部分。",
      sourceHandles: ["curated:summary:1"], uncertainty: "缺少实验后续结果。",
    }, ["curated:summary:1", "curated:takeaway:1"])).not.toThrow();
    expect(() => validateEntryOutput({
      answerStatus: "insufficient_evidence", answer: "当前 curated 资料无法回答。",
      sourceHandles: [], uncertainty: "没有相关 Summary 或 confirmed Takeaway。",
    }, ["curated:summary:1", "curated:takeaway:1"])).not.toThrow();
    expect(() => validateEntryOutput({
      answerStatus: "conflicting_evidence", answer: "两个来源结论冲突。",
      sourceHandles: ["curated:summary:1"], uncertainty: "只有一个来源卡。",
    }, ["curated:summary:1", "curated:takeaway:1"])).toThrow("entry-contract-status-inconsistent");
    expect(() => validateEntryOutput({
      answerStatus: "partially_answered", answer: "只有部分依据。",
      sourceHandles: ["curated:summary:1"], uncertainty: "缺".repeat(1_001),
    }, ["curated:summary:1", "curated:takeaway:1"])).toThrow("entry-contract-invalid");
  });

  it("bounds Agentic Evidence output and validates status after receipts are verified", () => {
    expect(agenticEvidenceSchema.properties.answer).toMatchObject({ minLength: 1, maxLength: 12_000 });
    expect(agenticEvidenceSchema.properties.citations).toMatchObject({ maxItems: 20 });
    const receipt = (path: string, lineStart: number): GroundedTextReceipt => ({
      evidenceKind: "pdf",
      sourceId: "paper-version:1",
      sourceRevision: "extraction:1",
      workspacePath: path,
      contentHash: "hash",
      quote: "evidence",
      locator: { lineStart, lineEnd: lineStart },
    });
    expect(() => validateGroundingReceiptContract("answered", [receipt("paper/page-1.md", 2)])).not.toThrow();
    expect(() => validateGroundingReceiptContract("partially_answered", [])).toThrow("grounding-required");
    expect(() => validateGroundingReceiptContract("insufficient_evidence", [receipt("paper/page-1.md", 2)]))
      .toThrow("grounding-status-inconsistent");
    expect(() => validateGroundingReceiptContract("conflicting_evidence", [
      receipt("paper/page-1.md", 2), receipt("paper/page-1.md", 2),
    ])).toThrow("grounding-conflict-required");
    expect(() => validateGroundingReceiptContract("conflicting_evidence", [
      receipt("paper/page-1.md", 2), receipt("paper/page-2.md", 3),
    ])).not.toThrow();
  });

  it("exposes the reviewed semantic rules in the read-only prompt registry", () => {
    expect(AGENT_PROMPT_TEMPLATES["paper-summary"]).toContain("canonical 顺序");
    expect(AGENT_PROMPT_TEMPLATES["paper-summary"]).toContain("所有 Agent 评价都不要放入 claims");
    expect(AGENT_PROMPT_TEMPLATES["entry-answer"]).toContain("answerStatus 与输出必须一致");
    expect(AGENT_PROMPT_TEMPLATES["agentic-evidence"]).toContain("search → verify → answer");
    expect(AGENT_PROMPT_TEMPLATES["agentic-evidence"]).toContain("verify_text_citation");
    expect(AGENT_PROMPT_TEMPLATES["agentic-evidence"]).toContain("逐字复制工具返回的 citation");
    expect(AGENT_PROMPT_TEMPLATES["takeaway-distillation"]).toContain("候选很多不是 multiple-claims 的理由");
    expect(AGENT_PROMPT_TEMPLATES["paper-chat"]).toContain("sourceHandle 与 locator 都必须逐字复制");
  });
});
