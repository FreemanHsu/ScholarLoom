import type { PaperAlias, PaperOrganizationInput } from "../domain/paper-organization.js";
import { normalizePaperLookup } from "../domain/paper-organization.js";
import type { AgentActivity, AgentUsage } from "./agentic-evidence-runner.js";

export const PAPER_ORGANIZATION_CONTRACT_VERSION = "paper-organization.v1";
export const PAPER_ORGANIZATION_DECISION_VERSION = "paper-organization-decision.v1";
export const PAPER_ORGANIZATION_DIRECTION_LIMIT = 64;

export type PaperOrganizationScope = "all" | "alias" | "primary" | "secondary";
export type OrganizationSectionKind = "alias" | "primary-direction" | "secondary-direction";
export type OrganizationRequestedSection = "alias" | "primary" | "secondary";

export type OrganizationDirectionSnapshot = {
  topicId: string;
  title: string;
  aliases: string[];
  scope: string;
  revisionId: string;
  markdownHash: string;
  semanticHash: string;
};

export type PaperOrganizationManifest = {
  contractVersion: typeof PAPER_ORGANIZATION_CONTRACT_VERSION;
  scope: PaperOrganizationScope;
  requestedSections: OrganizationRequestedSection[];
  paper: {
    id: string;
    versionId: string;
    title: string;
    authors: string[];
    externalIdentities: string[];
  };
  summary: {
    revisionId: string;
    markdownHash: string;
    sections: Array<{ key: string; title: string; body: string }>;
  };
  organization: PaperOrganizationInput;
  paperManifest: { path: string; hash: string };
  catalogSnapshotId: string;
  catalogHash: string;
  promptHash: string;
  schemaHash: string;
  skillHash: string;
  lockedPrimaryTopicId: string | null;
};

export type OrganizationAliasCandidate = {
  name: string;
  kind: Exclude<PaperAlias["kind"], "user-defined">;
  preferred: boolean;
  rationale: string;
};
export type OrganizationAliasSection = {
  outcome: "proposal" | "not-needed";
  candidates: OrganizationAliasCandidate[];
};
export type OrganizationPrimarySection = {
  outcome: "proposal" | "ambiguous" | "no-fit";
  recommendedTopicId: string | null;
  rationale: string;
  alternatives: Array<{ topicId: string; rationale: string }>;
};
export type OrganizationSecondarySection = {
  outcome: "proposal" | "ambiguous" | "no-fit" | "not-needed";
  candidates: Array<{ topicId: string; rationale: string }>;
};
export type PaperOrganizationAgentResult = {
  coreProblem: string;
  mainContribution: string;
  alias?: OrganizationAliasSection;
  primary?: OrganizationPrimarySection;
  secondary?: OrganizationSecondarySection;
  usage: AgentUsage;
};

export type PaperOrganizationRunner = {
  analyze(input: {
    context: PaperOrganizationManifest;
    directions: OrganizationDirectionSnapshot[];
    signal: AbortSignal;
    onActivity(activity: AgentActivity): void;
  }): Promise<PaperOrganizationAgentResult>;
};

export function normalizePaperOrganizationAgentResult(
  result: PaperOrganizationAgentResult,
): PaperOrganizationAgentResult {
  if (!result.primary || result.primary.outcome === "no-fit" || !result.primary.recommendedTopicId) {
    return result;
  }
  const seen = new Set([result.primary.recommendedTopicId]);
  const alternatives = result.primary.alternatives.filter((alternative) => {
    if (seen.has(alternative.topicId)) return false;
    seen.add(alternative.topicId);
    return true;
  });
  return {
    ...result,
    primary: {
      ...result.primary,
      outcome: alternatives.length > 0 ? "ambiguous" : "proposal",
      alternatives,
    },
  };
}

export type PaperOrganizationDecisionV1 = {
  schemaVersion: typeof PAPER_ORGANIZATION_DECISION_VERSION;
  sectionKind: OrganizationSectionKind;
  action: "accept" | "accept-with-edit" | "reject";
  agentProposed: unknown;
  userAccepted: unknown | null;
  edited: boolean;
  editedFields: string[];
  resultingOrganization: PaperOrganizationInput | null;
  automation?: {
    actor: "agent-auto";
    eventId: string;
    policyId: string;
    policyVersion: number;
    evaluationHash: string;
    proposalHash: string;
    predicateVersion: string;
    snapshotHash: string;
  };
};

const outcome = (values: string[]) => ({ type: "string", enum: values });
const rationale = { type: "string", minLength: 1, maxLength: 2_000 };
const usage = {
  type: "object", additionalProperties: false,
  required: ["status", "inputTokens", "cachedInputTokens", "outputTokens", "totalTokens"],
  properties: {
    status: { enum: ["reported", "estimated", "unavailable"] },
    inputTokens: { type: ["integer", "null"], minimum: 0 },
    cachedInputTokens: { type: ["integer", "null"], minimum: 0 },
    outputTokens: { type: ["integer", "null"], minimum: 0 },
    totalTokens: { type: ["integer", "null"], minimum: 0 },
  },
};

export function createPaperOrganizationSchema(manifest: Pick<PaperOrganizationManifest,
  "requestedSections">, topicIds: string[] | null) {
  const hasNoTopics = topicIds !== null && topicIds.length === 0;
  const topicIdSchema = topicIds === null || hasNoTopics
    ? { type: "string", minLength: 1 }
    : { type: "string", enum: topicIds };
  const properties: Record<string, unknown> = {
    coreProblem: { type: "string", minLength: 1, maxLength: 2_000 },
    mainContribution: { type: "string", minLength: 1, maxLength: 2_000 },
    usage,
  };
  const required = ["coreProblem", "mainContribution", "usage"];
  if (manifest.requestedSections.includes("alias")) {
    properties.alias = {
      type: "object", additionalProperties: false, required: ["outcome", "candidates"],
      properties: {
        outcome: outcome(["proposal", "not-needed"]),
        candidates: { type: "array", maxItems: 8, items: {
          type: "object", additionalProperties: false,
          required: ["name", "kind", "preferred", "rationale"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 120 },
            kind: { enum: ["model-name", "method-name", "acronym", "project-name"] },
            preferred: { type: "boolean" },
            rationale,
          },
        } },
      },
    };
    required.push("alias");
  }
  if (manifest.requestedSections.includes("primary")) {
    properties.primary = {
      type: "object", additionalProperties: false,
      required: ["outcome", "recommendedTopicId", "rationale", "alternatives"],
      properties: {
        outcome: outcome(hasNoTopics ? ["no-fit"] : ["proposal", "ambiguous", "no-fit"]),
        recommendedTopicId: hasNoTopics ? { type: "null" }
          : { anyOf: [topicIdSchema, { type: "null" }] },
        rationale,
        alternatives: { type: "array", maxItems: hasNoTopics ? 0 : 2, uniqueItems: true, items: {
          type: "object", additionalProperties: false, required: ["topicId", "rationale"],
          properties: { topicId: topicIdSchema, rationale },
        } },
      },
    };
    required.push("primary");
  }
  if (manifest.requestedSections.includes("secondary")) {
    properties.secondary = {
      type: "object", additionalProperties: false, required: ["outcome", "candidates"],
      properties: {
        outcome: outcome(hasNoTopics ? ["no-fit", "not-needed"]
          : ["proposal", "ambiguous", "no-fit", "not-needed"]),
        candidates: { type: "array", maxItems: hasNoTopics ? 0 : 3, uniqueItems: true, items: {
          type: "object", additionalProperties: false, required: ["topicId", "rationale"],
          properties: { topicId: topicIdSchema, rationale },
        } },
      },
    };
    required.push("secondary");
  }
  return { type: "object", additionalProperties: false, required, properties } as const;
}

export function validatePaperOrganizationAgentResult(result: PaperOrganizationAgentResult,
  manifest: PaperOrganizationManifest, directions: OrganizationDirectionSnapshot[]): void {
  const requested = new Set(manifest.requestedSections);
  if (!result.coreProblem.trim() || !result.mainContribution.trim()) throw new Error("organization-agent-summary-empty");
  if (Boolean(result.alias) !== requested.has("alias") ||
      Boolean(result.primary) !== requested.has("primary") ||
      Boolean(result.secondary) !== requested.has("secondary")) {
    throw new Error("organization-agent-scope-mismatch");
  }
  const allowed = new Set(directions.map((direction) => direction.topicId));
  if (result.alias) {
    if ((result.alias.outcome === "proposal") !== (result.alias.candidates.length > 0)) {
      throw new Error("organization-agent-alias-outcome-invalid");
    }
    if (result.alias.candidates.filter((candidate) => candidate.preferred).length > 1) {
      throw new Error("organization-agent-alias-preferred-limit");
    }
    const normalized = result.alias.candidates.map((candidate) => {
      const name = candidate.name.trim();
      if (name.length < 1 || [...name].length > 120 || /[\u0000-\u001f\u007f-\u009f]/u.test(name) ||
          !candidate.rationale.trim() || candidate.kind === ("user-defined" as string) ||
          normalizePaperLookup(name) === normalizePaperLookup(manifest.paper.title)) {
        throw new Error("organization-agent-alias-invalid");
      }
      return normalizePaperLookup(name);
    });
    if (new Set(normalized).size !== normalized.length) throw new Error("organization-agent-alias-duplicate");
  }
  let proposedPrimary: string | null = manifest.lockedPrimaryTopicId;
  if (result.primary) {
    const values = [result.primary.recommendedTopicId,
      ...result.primary.alternatives.map((alternative) => alternative.topicId)].filter((value): value is string => Boolean(value));
    if (values.some((value) => !allowed.has(value)) || new Set(values).size !== values.length ||
        !result.primary.rationale.trim() ||
        (result.primary.outcome === "no-fit" && (result.primary.recommendedTopicId !== null ||
          result.primary.alternatives.length > 0)) ||
        (result.primary.outcome !== "no-fit" && result.primary.recommendedTopicId === null) ||
        (result.primary.outcome === "proposal" && result.primary.alternatives.length > 0) ||
        (result.primary.outcome === "ambiguous" && result.primary.alternatives.length === 0)) {
      throw new Error("organization-agent-primary-invalid");
    }
    if (result.primary.alternatives.some((alternative) => !alternative.rationale.trim())) {
      throw new Error("organization-agent-primary-rationale-empty");
    }
    proposedPrimary = result.primary.recommendedTopicId;
  }
  if (result.secondary) {
    const ids = result.secondary.candidates.map((candidate) => candidate.topicId);
    if (ids.some((id) => !allowed.has(id)) || new Set(ids).size !== ids.length ||
        ids.some((id) => id === proposedPrimary) ||
        result.secondary.candidates.some((candidate) => !candidate.rationale.trim()) ||
        (["proposal", "ambiguous"].includes(result.secondary.outcome) !== (ids.length > 0)) ||
        (["no-fit", "not-needed"].includes(result.secondary.outcome) && ids.length > 0)) {
      throw new Error("organization-agent-secondary-invalid");
    }
  }
}

export function validatePaperOrganizationDecision(value: PaperOrganizationDecisionV1): void {
  if (value.schemaVersion !== PAPER_ORGANIZATION_DECISION_VERSION ||
      !["alias", "primary-direction", "secondary-direction"].includes(value.sectionKind) ||
      !["accept", "accept-with-edit", "reject"].includes(value.action) ||
      !Array.isArray(value.editedFields) ||
      value.editedFields.some((field) => typeof field !== "string" || !field.trim()) ||
      (value.action === "reject" && (value.userAccepted !== null || value.resultingOrganization !== null)) ||
      (value.action !== "reject" && (!value.userAccepted || !value.resultingOrganization)) ||
      value.edited !== (value.action === "accept-with-edit") ||
      (value.automation !== undefined && (value.automation.actor !== "agent-auto" ||
        !value.automation.eventId || !value.automation.policyId ||
        !Number.isInteger(value.automation.policyVersion) || !value.automation.evaluationHash ||
        !value.automation.proposalHash || !value.automation.predicateVersion ||
        !value.automation.snapshotHash))) {
    throw new Error("paper-organization-decision-invalid");
  }
}
