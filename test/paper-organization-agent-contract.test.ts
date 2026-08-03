import { describe, expect, it } from "vitest";

import {
  PAPER_ORGANIZATION_DECISION_VERSION,
  createPaperOrganizationSchema,
  validatePaperOrganizationAgentResult,
  validatePaperOrganizationDecision,
  type PaperOrganizationManifest,
} from "../src/agent/paper-organization.js";

const direction = {
  topicId: "topic:vision-learning",
  title: "Vision Learning",
  aliases: [],
  scope: "General visual representation learning.",
  revisionId: "topic-revision:vision-learning:r1",
  markdownHash: "direction-hash",
  semanticHash: "semantic-hash",
};
const manifest: PaperOrganizationManifest = {
  contractVersion: "paper-organization.v1",
  scope: "all",
  requestedSections: ["alias", "primary", "secondary"],
  paper: {
    id: "paper:fixture",
    versionId: "paper-version:fixture:v1",
    title: "Video Models Learn Vision",
    authors: ["Ada Fixture"],
    externalIdentities: ["arxiv:2601.00001"],
  },
  summary: {
    revisionId: "summary:fixture:r1",
    markdownHash: "summary-hash",
    sections: [{ key: "overview", title: "概述", body: "该论文研究视觉表征学习。" }],
  },
  organization: { aliases: [], directions: [] },
  paperManifest: { path: "library/papers/fixture/paper.md", hash: "paper-hash" },
  catalogSnapshotId: "organization-catalog:fixture",
  catalogHash: "catalog-hash",
  promptHash: "prompt-hash",
  schemaHash: "schema-hash",
  skillHash: "skill-hash",
  lockedPrimaryTopicId: null,
};

describe("Paper Organization Agent contract", () => {
  it("builds a runtime schema with only requested sections", () => {
    const schema = createPaperOrganizationSchema({ requestedSections: ["alias"] }, [direction.topicId]);
    expect(schema.required).toEqual(["coreProblem", "mainContribution", "usage", "alias"]);
    expect(schema.properties).not.toHaveProperty("primary");
    expect(schema.properties).not.toHaveProperty("secondary");
  });

  it("builds a valid no-fit schema when the Direction catalog is empty", () => {
    const schema = createPaperOrganizationSchema({ requestedSections: ["primary", "secondary"] }, []);
    expect(schema).toMatchObject({ properties: {
      primary: { properties: {
        outcome: { enum: ["no-fit"] },
        recommendedTopicId: { type: "null" },
        alternatives: { maxItems: 0 },
      } },
      secondary: { properties: {
        outcome: { enum: ["no-fit", "not-needed"] },
        candidates: { maxItems: 0 },
      } },
    } });
  });

  it("accepts a grounded organization result and rejects out-of-scope or duplicate values", () => {
    const result = {
      coreProblem: "视频生成模型能否学习通用视觉表征？",
      mainContribution: "证明生成式视频预训练可以迁移到多类视觉任务。",
      alias: { outcome: "proposal" as const, candidates: [{
        name: "GenCeption", kind: "model-name" as const, preferred: true, rationale: "论文以该名称指代整体方法。",
      }] },
      primary: {
        outcome: "proposal" as const,
        recommendedTopicId: direction.topicId,
        rationale: "核心问题是视觉表征学习。",
        alternatives: [],
      },
      secondary: { outcome: "no-fit" as const, candidates: [] },
      usage: { status: "unavailable" as const },
    };
    expect(() => validatePaperOrganizationAgentResult(result, manifest, [direction])).not.toThrow();
    expect(() => validatePaperOrganizationAgentResult({
      ...result,
      alias: { ...result.alias, candidates: [...result.alias.candidates, { ...result.alias.candidates[0]! }] },
    }, manifest, [direction])).toThrow("organization-agent-alias-preferred-limit");
    expect(() => validatePaperOrganizationAgentResult({
      ...result,
      primary: { ...result.primary, recommendedTopicId: "topic:invented" },
    }, manifest, [direction])).toThrow("organization-agent-primary-invalid");
  });

  it("requires a versioned exact decision payload", () => {
    expect(() => validatePaperOrganizationDecision({
      schemaVersion: PAPER_ORGANIZATION_DECISION_VERSION,
      sectionKind: "alias",
      action: "accept-with-edit",
      agentProposed: [{ name: "GenCeption" }],
      userAccepted: [{ name: "GenCeption" }],
      edited: true,
      editedFields: ["preferred"],
      resultingOrganization: { aliases: [], directions: [] },
    })).not.toThrow();
    expect(() => validatePaperOrganizationDecision({
      schemaVersion: PAPER_ORGANIZATION_DECISION_VERSION,
      sectionKind: "alias",
      action: "reject",
      agentProposed: [],
      userAccepted: [],
      edited: false,
      editedFields: [],
      resultingOrganization: null,
    })).toThrow("paper-organization-decision-invalid");
  });
});
