import { describe, expect, it } from "vitest";

import {
  PAPER_TAXONOMY_CONTRACT_VERSION,
  createPaperTaxonomySchema,
  validatePaperTaxonomyResult,
  type PaperTaxonomyManifest,
} from "../src/agent/paper-taxonomy.js";

const manifest: PaperTaxonomyManifest = {
  contractVersion: PAPER_TAXONOMY_CONTRACT_VERSION,
  selectionMode: "next",
  selectionVersion: "paper-taxonomy-selection.v1",
  excerptVersion: "paper-taxonomy-excerpt.v1",
  normalizationVersion: "normalizePaperLookup.v1",
  cohortHash: "cohort-hash",
  eligibleCount: 1,
  selectedCount: 1,
  remainingCount: 0,
  papers: [{
    paperId: "paper:fixture",
    title: "Fixture Vision Learning",
    authors: ["Ada Fixture"],
    externalIdentities: ["arxiv:2601.00001"],
    summaryRevisionId: "summary:fixture:r1",
    summaryHash: "summary-hash",
    excerpt: "研究可迁移视觉表征。",
    aliases: [],
    directions: [],
  }],
  directions: [{
    topicId: "topic:existing",
    title: "Existing Direction",
    aliases: [],
    scope: "Existing scope.",
    revisionId: "topic-revision:existing:r1",
    markdownHash: "markdown-hash",
    semanticHash: "semantic-hash",
  }],
  promptHash: "prompt-hash",
  schemaHash: "schema-hash",
  skillHash: "skill-hash",
};

describe("Paper Taxonomy Agent contract", () => {
  it("binds representatives and overlaps to the frozen manifest", () => {
    const schema = createPaperTaxonomySchema(manifest);
    expect(schema.properties.candidates.items.properties.representativePaperIds.items.enum)
      .toEqual(["paper:fixture"]);
    expect(schema.properties.candidates.items.properties.overlaps.items.properties.topicId.enum)
      .toEqual(["topic:existing"]);
  });

  it("does not emit empty enums for an empty taxonomy context", () => {
    const schema = createPaperTaxonomySchema({ papers: [], directions: [] });
    const candidate = schema.properties.candidates;
    expect(candidate.maxItems).toBe(0);
    expect(candidate.items.properties.representativePaperIds).toMatchObject({ minItems: 0, maxItems: 0 });
    expect(candidate.items.properties.overlaps).toMatchObject({ maxItems: 0 });
    expect(candidate.items.properties.representativePaperIds.items).not.toHaveProperty("enum");
    expect(candidate.items.properties.overlaps.items.properties.topicId).not.toHaveProperty("enum");
  });

  it("accepts a zero result and rejects invented representatives or overlaps", () => {
    const usage = { status: "unavailable" as const, inputTokens: 0, cachedInputTokens: 0,
      outputTokens: 0, totalTokens: 0 };
    expect(() => validatePaperTaxonomyResult({ candidates: [], usage }, manifest)).not.toThrow();
    const candidate = {
      suggestedTopicId: "topic:vision-representation-learning",
      title: "Vision Representation Learning",
      aliases: [],
      scope: "研究如何学习可迁移视觉表征。",
      exclusions: ["仅使用视觉模型但不研究表征。"],
      representativePaperIds: ["paper:fixture"],
      rationale: "多篇工作共享同一核心研究问题。",
      overlaps: [{ topicId: "topic:existing", rationale: "Scope 部分相交。" }],
    };
    expect(() => validatePaperTaxonomyResult({ candidates: [candidate], usage }, manifest)).not.toThrow();
    expect(() => validatePaperTaxonomyResult({
      candidates: [{ ...candidate, representativePaperIds: ["paper:invented"] }], usage,
    }, manifest)).toThrow("paper-taxonomy-candidate-invalid");
    expect(() => validatePaperTaxonomyResult({
      candidates: [{ ...candidate, overlaps: [{ topicId: "topic:invented", rationale: "Invented." }] }],
      usage,
    }, manifest)).toThrow("paper-taxonomy-candidate-invalid");
  });
});
