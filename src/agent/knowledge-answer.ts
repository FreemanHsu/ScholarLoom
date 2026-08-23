import type { CuratedToolCitation } from "../storage/curated-knowledge-tools.js";

export type KnowledgeAnswerBasis = "model-knowledge" | "conversation-context" | "curated-evidence";
export type KnowledgeCoverage = "supported" | "partial" | "none" | "conflicting";

export type KnowledgeClaim = {
  text: string;
  status: "source-supported" | "source-consensus" | "agent-inference" | "insufficient-evidence";
  citationOrdinals: number[];
};

export type KnowledgeAnswer = {
  answerBasis: KnowledgeAnswerBasis;
  coverage: KnowledgeCoverage;
  directAnswer: string;
  claims: KnowledgeClaim[];
  disagreements: string[];
  unknowns: string[];
  citations: CuratedToolCitation[];
  retrievalSummary: KnowledgeRetrievalSummary;
};

export type KnowledgeRetrievalSummary = {
  searched: boolean;
  queryCount: number;
  candidateCount: number;
  openedSourceCount: number;
  usedSourceCount: number;
  budgetExhausted: boolean;
  projectionStale?: boolean;
  lastSuccessfulAt?: string | null;
};

export type KnowledgeAnswerRunner = {
  answer(input: {
    question: string;
    conversation: Array<{ role: "user" | "assistant"; content: string }>;
    attemptId: string;
    jobRunId: string;
    runEpoch: number;
    signal: AbortSignal;
  }): Promise<KnowledgeAnswer>;
};

const locatorSchema = {
  type: "object", additionalProperties: false, required: ["lineStart", "lineEnd"],
  properties: { lineStart: { type: "integer", minimum: 1 }, lineEnd: { type: "integer", minimum: 1 } },
} as const;

export const knowledgeAnswerSchema = {
  type: "object",
  additionalProperties: false,
  required: ["answerBasis", "coverage", "directAnswer", "claims", "disagreements", "unknowns", "citations", "retrievalSummary"],
  properties: {
    answerBasis: { type: "string", enum: ["model-knowledge", "conversation-context", "curated-evidence"] },
    coverage: { type: "string", enum: ["supported", "partial", "none", "conflicting"] },
    directAnswer: { type: "string", minLength: 1, maxLength: 30_000 },
    claims: {
      type: "array", maxItems: 50,
      items: {
        type: "object", additionalProperties: false, required: ["text", "status", "citationOrdinals"],
        properties: {
          text: { type: "string", minLength: 1, maxLength: 4_000 },
          status: { type: "string", enum: ["source-supported", "source-consensus", "agent-inference", "insufficient-evidence"] },
          citationOrdinals: { type: "array", maxItems: 20, items: { type: "integer", minimum: 1, maximum: 20 } },
        },
      },
    },
    disagreements: { type: "array", maxItems: 30, items: { type: "string", minLength: 1, maxLength: 4_000 } },
    unknowns: { type: "array", maxItems: 30, items: { type: "string", minLength: 1, maxLength: 4_000 } },
    citations: {
      type: "array", maxItems: 20,
      items: {
        type: "object", additionalProperties: false,
        required: ["handle", "sourceType", "sourceId", "revisionId", "contentHash", "title", "trustLabel", "locator", "quote", "whySelected"],
        properties: {
          handle: { type: "string", pattern: "^curated-source-[0-9]{2}$" },
          sourceType: { type: "string", enum: ["summary", "takeaway", "topic-knowledge"] },
          sourceId: { type: "string", minLength: 1, maxLength: 500 },
          revisionId: { type: "string", minLength: 1, maxLength: 500 },
          contentHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
          title: { type: "string", minLength: 1, maxLength: 2_000 },
          trustLabel: { type: "string", enum: ["generated-from-primary-source", "user-confirmed"] },
          locator: locatorSchema,
          quote: { type: "string", minLength: 1, maxLength: 1_200 },
          whySelected: { type: "string", minLength: 1, maxLength: 1_000 },
        },
      },
    },
    retrievalSummary: {
      type: "object", additionalProperties: false,
      required: ["searched", "queryCount", "candidateCount", "openedSourceCount", "usedSourceCount", "budgetExhausted", "projectionStale", "lastSuccessfulAt"],
      properties: {
        searched: { type: "boolean" },
        queryCount: { type: "integer", minimum: 0, maximum: 8 },
        candidateCount: { type: "integer", minimum: 0, maximum: 60 },
        openedSourceCount: { type: "integer", minimum: 0, maximum: 20 },
        usedSourceCount: { type: "integer", minimum: 0, maximum: 20 },
        budgetExhausted: { type: "boolean" },
        projectionStale: { type: "boolean" },
        lastSuccessfulAt: { type: ["string", "null"], maxLength: 50 },
      },
    },
  },
} as const;

export function validateKnowledgeAnswer(answer: KnowledgeAnswer): void {
  if (!["model-knowledge", "conversation-context", "curated-evidence"].includes(answer.answerBasis)) {
    throw new Error("knowledge-answer-basis-invalid");
  }
  if (!["supported", "partial", "none", "conflicting"].includes(answer.coverage)) {
    throw new Error("knowledge-answer-coverage-invalid");
  }
  if (!answer.directAnswer?.trim() || answer.directAnswer.length > 30_000) {
    throw new Error("knowledge-answer-content-invalid");
  }
  if (!safeMarkdown(answer.directAnswer)) throw new Error("knowledge-answer-markdown-unsafe");
  validateRetrievalSummary(answer.retrievalSummary);
  if (!Array.isArray(answer.citations) || answer.citations.length > 20) {
    throw new Error("knowledge-answer-citation-invalid");
  }
  answer.citations.forEach(validateCitation);

  const grounded = answer.answerBasis === "curated-evidence";
  if (grounded) {
    if (!answer.retrievalSummary.searched || answer.citations.length === 0 || answer.coverage === "none") {
      throw new Error("knowledge-answer-citation-invalid");
    }
    if (answer.retrievalSummary.budgetExhausted && answer.coverage === "supported") {
      throw new Error("knowledge-answer-budget-coverage-invalid");
    }
    if (answer.coverage === "conflicting" && new Set(answer.citations.map((citation) =>
      `${citation.sourceType}:${citation.sourceId}:${citation.revisionId}`)).size < 2) {
      throw new Error("knowledge-answer-conflict-invalid");
    }
  } else if (answer.coverage !== "none" || answer.citations.length !== 0) {
    throw new Error(answer.citations.length ? "knowledge-answer-citation-invalid" : "knowledge-answer-coverage-invalid");
  }

  if (!Array.isArray(answer.claims) || answer.claims.length > 50) throw new Error("knowledge-answer-claim-invalid");
  const referencedOrdinals = new Set<number>();
  for (const claim of answer.claims) {
    const ordinals = claim?.citationOrdinals;
    if (!claim || typeof claim.text !== "string" || !claim.text.trim() || claim.text.length > 4_000 ||
        !safeMarkdown(claim.text) || !["source-supported", "source-consensus", "agent-inference", "insufficient-evidence"].includes(claim.status) ||
        !Array.isArray(ordinals) || ordinals.length > 20 || new Set(ordinals).size !== ordinals.length ||
        ordinals.some((ordinal) => !Number.isInteger(ordinal) || ordinal < 1 || ordinal > answer.citations.length) ||
        (["source-supported", "source-consensus"].includes(claim.status) ? ordinals.length === 0 : ordinals.length !== 0) ||
        (!grounded && !["agent-inference", "insufficient-evidence"].includes(claim.status))) {
      throw new Error("knowledge-answer-claim-invalid");
    }
    ordinals.forEach((ordinal) => referencedOrdinals.add(ordinal));
    if (claim.status === "source-consensus" && new Set(ordinals.map((ordinal) => {
      const citation = answer.citations[ordinal - 1]!;
      return `${citation.sourceType}:${citation.sourceId}:${citation.revisionId}`;
    })).size < 2) throw new Error("knowledge-answer-consensus-invalid");
  }
  if (grounded && answer.citations.some((_citation, index) => !referencedOrdinals.has(index + 1))) {
    throw new Error("knowledge-answer-citation-unused");
  }
  for (const values of [answer.disagreements, answer.unknowns]) {
    if (!Array.isArray(values) || values.length > 30 || values.some((value) =>
      typeof value !== "string" || !value.trim() || value.length > 4_000 || !safeMarkdown(value))) {
      throw new Error("knowledge-answer-boundary-invalid");
    }
  }
}

function validateRetrievalSummary(summary: KnowledgeRetrievalSummary): void {
  if (!summary || typeof summary.searched !== "boolean" || typeof summary.budgetExhausted !== "boolean" ||
      !(summary.projectionStale === undefined || typeof summary.projectionStale === "boolean") ||
      !(summary.lastSuccessfulAt === undefined || summary.lastSuccessfulAt === null ||
        (typeof summary.lastSuccessfulAt === "string" && summary.lastSuccessfulAt.length <= 50)) ||
      !integerIn(summary.queryCount, 0, 8) || !integerIn(summary.candidateCount, 0, 60) ||
      !integerIn(summary.openedSourceCount, 0, 20) || !integerIn(summary.usedSourceCount, 0, 20) ||
      (!summary.searched && (summary.queryCount !== 0 || summary.candidateCount !== 0 || summary.openedSourceCount !== 0 ||
        summary.usedSourceCount !== 0 || summary.budgetExhausted))) {
    throw new Error("knowledge-answer-retrieval-invalid");
  }
}

function validateCitation(citation: CuratedToolCitation): void {
  if (!citation || !/^curated-source-\d{2}$/u.test(citation.handle) ||
      !["summary", "takeaway", "topic-knowledge"].includes(citation.sourceType) ||
      !citation.sourceId?.trim() || !citation.revisionId?.trim() || !/^[a-f0-9]{64}$/u.test(citation.contentHash) ||
      !citation.title?.trim() || !["generated-from-primary-source", "user-confirmed"].includes(citation.trustLabel) ||
      !Number.isInteger(citation.locator?.lineStart) || !Number.isInteger(citation.locator?.lineEnd) ||
      citation.locator.lineStart < 1 || citation.locator.lineEnd < citation.locator.lineStart ||
      !citation.quote?.trim() || citation.quote.length > 1_200 || !citation.whySelected?.trim() ||
      citation.whySelected.length > 1_000 || !safeMarkdown(citation.quote) || !safeMarkdown(citation.whySelected)) {
    throw new Error("knowledge-answer-citation-invalid");
  }
}

function integerIn(value: number, minimum: number, maximum: number): boolean {
  return Number.isInteger(value) && value >= minimum && value <= maximum;
}

function safeMarkdown(value: string): boolean {
  return !/<\/?[a-z][^>]*>/iu.test(value) && !/!\[[^\]]*\]\([^)]*\)/u.test(value) &&
    !/\[[^\]]+\]\(\s*(?:https?:|mailto:)/iu.test(value);
}
