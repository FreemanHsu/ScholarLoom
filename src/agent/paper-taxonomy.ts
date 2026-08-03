import type { AgentActivity, AgentUsage } from "./agentic-evidence-runner.js";
import type { OrganizationDirectionSnapshot } from "./paper-organization.js";

export const PAPER_TAXONOMY_CONTRACT_VERSION = "paper-taxonomy.v1";
export const DIRECTION_TAXONOMY_DECISION_VERSION = "direction-taxonomy-decision.v1";
export const TAXONOMY_SELECTION_VERSION = "paper-taxonomy-selection.v1";
export const TAXONOMY_EXCERPT_VERSION = "paper-taxonomy-excerpt.v1";
export const PAPER_LOOKUP_NORMALIZATION_VERSION = "normalizePaperLookup.v1";

export type PaperTaxonomyFact = {
  paperId: string;
  title: string;
  authors: string[];
  externalIdentities: string[];
  summaryRevisionId: string;
  summaryHash: string;
  excerpt: string;
  aliases: Array<{ name: string; kind: string; preferred: boolean }>;
  directions: Array<{ topicId: string; role: "primary" | "secondary" }>;
};

export type PaperTaxonomyManifest = {
  contractVersion: typeof PAPER_TAXONOMY_CONTRACT_VERSION;
  selectionMode: "next" | "regenerate" | "refresh";
  selectionVersion: typeof TAXONOMY_SELECTION_VERSION;
  excerptVersion: typeof TAXONOMY_EXCERPT_VERSION;
  normalizationVersion: typeof PAPER_LOOKUP_NORMALIZATION_VERSION;
  cohortHash: string;
  eligibleCount: number;
  selectedCount: number;
  remainingCount: number;
  papers: PaperTaxonomyFact[];
  directions: OrganizationDirectionSnapshot[];
  promptHash: string;
  schemaHash: string;
  skillHash: string;
};

export type PaperTaxonomyCandidate = {
  suggestedTopicId: string;
  title: string;
  aliases: string[];
  scope: string;
  exclusions: string[];
  representativePaperIds: string[];
  rationale: string;
  overlaps: Array<{ topicId: string; rationale: string }>;
};

export type PaperTaxonomyResult = {
  candidates: PaperTaxonomyCandidate[];
  usage: AgentUsage;
};

export type PaperTaxonomyRunner = {
  propose(input: {
    context: PaperTaxonomyManifest;
    signal: AbortSignal;
    onActivity(activity: AgentActivity): void;
  }): Promise<PaperTaxonomyResult>;
};

const bounded = (maxLength: number) => ({ type: "string", minLength: 1, maxLength });
const usageSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "inputTokens", "cachedInputTokens", "outputTokens", "totalTokens"],
  properties: {
    status: { enum: ["reported", "estimated", "unavailable"] },
    inputTokens: { type: ["integer", "null"], minimum: 0 },
    cachedInputTokens: { type: ["integer", "null"], minimum: 0 },
    outputTokens: { type: ["integer", "null"], minimum: 0 },
    totalTokens: { type: ["integer", "null"], minimum: 0 },
  },
};

export function createPaperTaxonomySchema(manifest: Pick<PaperTaxonomyManifest, "papers" | "directions">) {
  const paperIds = manifest.papers.map((paper) => paper.paperId);
  const directionIds = manifest.directions.map((direction) => direction.topicId);
  return {
    type: "object",
    additionalProperties: false,
    required: ["candidates", "usage"],
    properties: {
      candidates: {
        type: "array",
        maxItems: paperIds.length === 0 ? 0 : 12,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["suggestedTopicId", "title", "aliases", "scope", "exclusions",
            "representativePaperIds", "rationale", "overlaps"],
          properties: {
            suggestedTopicId: { type: "string", pattern: "^topic:[a-z0-9]+(?:-[a-z0-9]+)*$" },
            title: bounded(120),
            aliases: { type: "array", maxItems: 8, uniqueItems: true, items: bounded(120) },
            scope: bounded(2_000),
            exclusions: { type: "array", minItems: 1, maxItems: 8, items: bounded(500) },
            representativePaperIds: {
              type: "array", minItems: paperIds.length === 0 ? 0 : 1,
              maxItems: paperIds.length === 0 ? 0 : 5, uniqueItems: true,
              items: paperIds.length === 0 ? { type: "string", minLength: 1 }
                : { type: "string", enum: paperIds },
            },
            rationale: bounded(2_000),
            overlaps: {
              type: "array", maxItems: directionIds.length === 0 ? 0 : 4, uniqueItems: true,
              items: {
                type: "object", additionalProperties: false, required: ["topicId", "rationale"],
                properties: {
                  topicId: directionIds.length === 0 ? { type: "string", minLength: 1 }
                    : { type: "string", enum: directionIds },
                  rationale: bounded(1_000),
                },
              },
            },
          },
        },
      },
      usage: usageSchema,
    },
  } as const;
}

export function validatePaperTaxonomyResult(result: PaperTaxonomyResult, manifest: PaperTaxonomyManifest): void {
  if (!result || !Array.isArray(result.candidates) || result.candidates.length > 12 || !result.usage) {
    throw new Error("paper-taxonomy-output-invalid");
  }
  const paperIds = new Set(manifest.papers.map((paper) => paper.paperId));
  const directionIds = new Set(manifest.directions.map((direction) => direction.topicId));
  const ids = new Set<string>();
  for (const candidate of result.candidates) {
    if (!/^topic:[a-z0-9]+(?:-[a-z0-9]+)*$/.test(candidate.suggestedTopicId) ||
        ids.has(candidate.suggestedTopicId) || !candidate.title.trim() || !candidate.scope.trim() ||
        !candidate.rationale.trim() || candidate.exclusions.length < 1 ||
        candidate.representativePaperIds.length < 1 || candidate.representativePaperIds.length > 5 ||
        candidate.representativePaperIds.some((id) => !paperIds.has(id)) ||
        candidate.overlaps.some((overlap) => !directionIds.has(overlap.topicId) || !overlap.rationale.trim())) {
      throw new Error("paper-taxonomy-candidate-invalid");
    }
    ids.add(candidate.suggestedTopicId);
  }
}
