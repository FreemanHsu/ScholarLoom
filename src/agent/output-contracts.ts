export const SUMMARY_SECTION_KEYS = [
  "overview",
  "core-ideas",
  "technical-implementation",
  "training-process",
  "inference-process",
  "experiments-analysis",
  "summary-thoughts",
] as const;

const REQUIRED_SUMMARY_SECTION_KEYS = new Set([
  "overview",
  "core-ideas",
  "technical-implementation",
  "experiments-analysis",
  "summary-thoughts",
]);

type SummaryOutput = {
  sections: Array<{ key: string; title: string; body: string }>;
  claims: Array<{ voice: string; claim: string; sourceHandle: string }>;
  readStatus: string;
};

type ChatOutput = {
  answer: string;
  citations: Array<{ sourceHandle: string; locator: string }>;
};

export type EntryAnswerStatus =
  | "answered"
  | "partially_answered"
  | "insufficient_evidence"
  | "conflicting_evidence";

type EntryOutput = {
  answerStatus: EntryAnswerStatus;
  answer: string;
  sourceHandles: string[];
  uncertainty: string | null;
};

export function createSummarySchema(sourceHandles: string[] | null) {
  return {
    type: "object", additionalProperties: false, required: ["sections", "claims", "readStatus"],
    properties: {
      sections: { type: "array", minItems: 5, maxItems: 7, items: { type: "object", additionalProperties: false,
        required: ["key", "title", "body"], properties: {
          key: { type: "string", enum: SUMMARY_SECTION_KEYS },
          title: { type: "string", minLength: 1, maxLength: 120 },
          body: { type: "string", minLength: 1, maxLength: 20_000 },
        } } },
      claims: { type: "array", minItems: 1, maxItems: 20, items: { type: "object", additionalProperties: false,
        required: ["voice", "claim", "sourceHandle"], properties: {
          voice: { enum: ["authors-claim", "paper-evidence"] },
          claim: { type: "string", minLength: 1, maxLength: 2_000 },
          sourceHandle: sourceHandles === null
            ? { type: "string", minLength: 1,
              description: "One exact handle from the runtime Allowed context manifest." }
            : { type: "string", enum: sourceHandles },
        } } },
      readStatus: { enum: ["abstract", "skimmed", "read"] },
    },
  } as const;
}

export function validateSummaryOutput(result: SummaryOutput, allowedHandles: string[]): void {
  const keys = result.sections.map((section) => section.key);
  if (new Set(keys).size !== keys.length) throw new Error("summary-contract-duplicate-section");
  if ([...REQUIRED_SUMMARY_SECTION_KEYS].some((key) => !keys.includes(key))) {
    throw new Error("summary-contract-required-section");
  }
  const ranks = keys.map((key) => SUMMARY_SECTION_KEYS.indexOf(key as typeof SUMMARY_SECTION_KEYS[number]));
  if (ranks.some((rank) => rank < 0) || ranks.some((rank, index) => index > 0 && rank <= ranks[index - 1]!)) {
    throw new Error("summary-contract-section-order");
  }
  const allowed = new Set(allowedHandles);
  for (const section of result.sections) {
    if (!section.title.trim() || !section.body.trim()) throw new Error("summary-contract-empty-section");
    const markers = [...section.body.matchAll(/\[(pdf-page:[^\]]+)\]/g)].map((match) => match[1]!);
    if (markers.some((handle) => !allowed.has(handle))) throw new Error("summary-contract-unknown-marker");
    if (["technical-implementation", "experiments-analysis"].includes(section.key) && markers.length === 0) {
      throw new Error(`summary-contract-citation-required:${section.key}`);
    }
  }
  for (const claim of result.claims) {
    if (!["authors-claim", "paper-evidence"].includes(claim.voice) || !claim.claim.trim() ||
        !allowed.has(claim.sourceHandle)) throw new Error("summary-contract-claim-invalid");
  }
}

function runtimeStringSchema(values: string[] | null, description: string) {
  return values === null
    ? { type: "string", minLength: 1, description }
    : { type: "string", enum: [...new Set(values)] };
}

export function createChatSchema(sourceHandles: string[] | null) {
  return {
    type: "object", additionalProperties: false, required: ["answer", "citations"], properties: {
      answer: { type: "string", minLength: 1, maxLength: 12_000 },
      citations: { type: "array", maxItems: 12, uniqueItems: true,
        items: { type: "object", additionalProperties: false,
          required: ["sourceHandle", "locator"], properties: {
            sourceHandle: runtimeStringSchema(sourceHandles,
              "One exact handle from the runtime Paper source manifest."),
            locator: { type: "string", minLength: 1, maxLength: 500 },
          } } },
    },
  } as const;
}

export const chatSchema = createChatSchema(null);

export function validateChatOutput(result: ChatOutput,
  sources: Array<{ handle: string; locator: string }>): void {
  if (!result.answer.trim() || result.answer.length > 12_000 || result.citations.length > 12) {
    throw new Error("chat-contract-bounds");
  }
  const allowed = new Map(sources.map((source) => [source.handle, source.locator]));
  const seen = new Set<string>();
  for (const citation of result.citations) {
    if (allowed.get(citation.sourceHandle) !== citation.locator) throw new Error("chat-contract-citation-mismatch");
    const key = JSON.stringify([citation.sourceHandle, citation.locator]);
    if (seen.has(key)) throw new Error("chat-contract-citation-duplicate");
    seen.add(key);
  }
}

export function createEntrySchema(sourceHandles: string[] | null) {
  return {
    type: "object", additionalProperties: false,
    required: ["answerStatus", "answer", "sourceHandles", "uncertainty"], properties: {
      answerStatus: { enum: ["answered", "partially_answered", "insufficient_evidence", "conflicting_evidence"] },
      answer: { type: "string", minLength: 1, maxLength: 12_000 },
      sourceHandles: { type: "array", maxItems: 12, uniqueItems: true,
        items: runtimeStringSchema(sourceHandles,
          "One exact handle from the runtime curated source manifest.") },
      uncertainty: { type: ["string", "null"], minLength: 1, maxLength: 1_000 },
    },
  } as const;
}

export const entrySchema = createEntrySchema(null);

export function validateEntryOutput(result: EntryOutput, allowedHandles: string[]): void {
  if (!result.answer.trim() || result.answer.length > 12_000 || result.sourceHandles.length > 12 ||
      new Set(result.sourceHandles).size !== result.sourceHandles.length ||
      result.sourceHandles.some((handle) => !allowedHandles.includes(handle)) ||
      (typeof result.uncertainty === "string" &&
        (!result.uncertainty.trim() || result.uncertainty.length > 1_000))) {
    throw new Error("entry-contract-invalid");
  }
  const hasUncertainty = typeof result.uncertainty === "string";
  const valid = result.answerStatus === "answered"
    ? result.sourceHandles.length >= 1 && !hasUncertainty
    : result.answerStatus === "partially_answered"
      ? result.sourceHandles.length >= 1 && hasUncertainty
      : result.answerStatus === "insufficient_evidence"
        ? result.sourceHandles.length === 0 && hasUncertainty
        : result.answerStatus === "conflicting_evidence"
          ? result.sourceHandles.length >= 2 && hasUncertainty
          : false;
  if (!valid) throw new Error("entry-contract-status-inconsistent");
}

export const agenticEvidenceSchema = {
  type: "object", additionalProperties: false,
  required: ["answer", "groundingStatus", "citations", "usage"],
  properties: {
    answer: { type: "string", minLength: 1, maxLength: 12_000 },
    groundingStatus: { enum: ["answered", "partially_answered", "insufficient_evidence", "conflicting_evidence"] },
    citations: { type: "array", maxItems: 20, items: { anyOf: [
      { type: "object", additionalProperties: false, required: ["kind", "path", "lineStart", "lineEnd", "quote"],
        properties: {
          kind: { type: "string", const: "text" }, path: { type: "string", minLength: 1 },
          lineStart: { type: "integer", minimum: 1 }, lineEnd: { type: "integer", minimum: 1 },
          quote: { type: "string", minLength: 1, maxLength: 500 },
        } },
      { type: "object", additionalProperties: false, required: ["kind", "sourceId", "page", "imageHash", "observation"],
        properties: {
          kind: { type: "string", const: "visual" }, sourceId: { type: "string", minLength: 1 },
          page: { type: "integer", minimum: 1 }, imageHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
          observation: { type: "string", minLength: 1, maxLength: 1000 },
        } },
    ] } },
    usage: { type: "object", additionalProperties: false,
      required: ["status", "inputTokens", "cachedInputTokens", "outputTokens", "totalTokens"], properties: {
        status: { enum: ["reported", "estimated", "unavailable"] },
        inputTokens: { type: ["integer", "null"], minimum: 0 },
        cachedInputTokens: { type: ["integer", "null"], minimum: 0 },
        outputTokens: { type: ["integer", "null"], minimum: 0 },
        totalTokens: { type: ["integer", "null"], minimum: 0 },
      } },
  },
} as const;
