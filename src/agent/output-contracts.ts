export function createSummarySchema(sourceHandles: string[] | null) {
  return {
    type: "object", additionalProperties: false, required: ["sections", "claims", "readStatus"],
    properties: {
      sections: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false,
        required: ["key", "title", "body"], properties: {
          key: { type: "string" }, title: { type: "string" }, body: { type: "string" },
        } } },
      claims: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false,
        required: ["voice", "claim", "sourceHandle"], properties: {
          voice: { enum: ["authors-claim", "paper-evidence", "agent-assessment"] },
          claim: { type: "string" },
          sourceHandle: sourceHandles === null
            ? { type: "string", description: "One exact handle from the runtime Allowed context manifest." }
            : { type: "string", enum: sourceHandles },
        } } },
      readStatus: { enum: ["abstract", "skimmed", "read"] },
    },
  } as const;
}

export const chatSchema = {
  type: "object", additionalProperties: false, required: ["answer", "citations"], properties: {
    answer: { type: "string" }, citations: { type: "array", items: { type: "object", additionalProperties: false,
      required: ["sourceHandle", "locator"], properties: {
        sourceHandle: { type: "string" }, locator: { type: "string" },
      } } },
  },
} as const;

export const entrySchema = {
  type: "object", additionalProperties: false, required: ["answer", "sourceHandles", "uncertainty"], properties: {
    answer: { type: "string" }, sourceHandles: { type: "array", items: { type: "string" } },
    uncertainty: { type: ["string", "null"] },
  },
} as const;

export const agenticEvidenceSchema = {
  type: "object", additionalProperties: false,
  required: ["answer", "groundingStatus", "citations", "usage"],
  properties: {
    answer: { type: "string" },
    groundingStatus: { enum: ["answered", "partially_answered", "insufficient_evidence", "conflicting_evidence"] },
    citations: { type: "array", items: { anyOf: [
      { type: "object", additionalProperties: false, required: ["kind", "path", "lineStart", "lineEnd", "quote"],
        properties: {
          kind: { type: "string", const: "text" }, path: { type: "string" },
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
