import type { AgentUsage } from "./agentic-evidence-runner.js";

export const TAKEAWAY_CONTRACT_VERSION = "takeaway-selection.v2";

export const TAKEAWAY_KINDS = [
  "correction",
  "mechanism",
  "finding",
  "limitation",
  "comparison",
  "reuse-implication",
] as const;
export const EPISTEMIC_STATUSES = ["evidence-backed", "interpretation", "hypothesis"] as const;
export const ABSTENTION_REASONS = ["not-durable", "duplicate", "insufficient-evidence", "multiple-claims"] as const;

export type TakeawayKind = typeof TAKEAWAY_KINDS[number];
export type EpistemicStatus = typeof EPISTEMIC_STATUSES[number];
export type AbstentionReason = typeof ABSTENTION_REASONS[number];

export type TakeawayCandidateV2 = {
  kind: TakeawayKind;
  claim: string;
  epistemicStatus: EpistemicStatus;
  evidenceRationale: string;
  caveat: string | null;
  receiptIds: string[];
  selectionRationale: string;
  duplicateHints: string[];
};

export type DistillationSelection =
  | { decision: "no-proposal"; reasonCode: AbstentionReason; rationale: string }
  | { decision: "candidate"; candidate: TakeawayCandidateV2 };

export type FrozenDistillationContext = {
  contractVersion: typeof TAKEAWAY_CONTRACT_VERSION;
  paper: { id: string; versionId: string };
  source: {
    userMessageId: string;
    userMessageHash: string;
    assistantMessageId: string;
    assistantMessageHash: string;
  };
  receipts: Array<{
    id: string;
    evidenceKind: string;
    sourceId: string;
    sourceRevision: string | null;
    contentHash: string;
    locatorHash: string;
  }>;
  summary: { revisionId: string; contentHash: string } | null;
  confirmedTakeaways: Array<{ revisionId: string; contentHash: string }>;
  trigger: "automatic" | "explicit-save";
  focus: string | null;
  focusHash: string;
  contractHash: string;
  promptHash: string;
};

export type TakeawaySelectionRunner = {
  select(input: {
    context: FrozenDistillationContext;
    material: {
      question: string;
      answer: string;
      receipts: Array<{ id: string; evidenceKind: string; locator: unknown; quote: string | null; observation: string | null }>;
      summary: string | null;
      confirmedTakeaways: Array<{ revisionId: string; claim: string }>;
    };
    signal: AbortSignal;
    onActivity(activity: { type: string; text: string; metadata?: Record<string, unknown> }): void;
  }): Promise<{ selection: DistillationSelection; usage: AgentUsage }>;
};

export const takeawaySelectionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["selection", "usage"],
  properties: {
    selection: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["decision", "reasonCode", "rationale"],
          properties: {
            decision: { const: "no-proposal" },
            reasonCode: { enum: ABSTENTION_REASONS },
            rationale: { type: "string", minLength: 1, maxLength: 1200 },
          },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["decision", "candidate"],
          properties: {
            decision: { const: "candidate" },
            candidate: {
              type: "object",
              additionalProperties: false,
              required: ["kind", "claim", "epistemicStatus", "evidenceRationale", "caveat", "receiptIds",
                "selectionRationale", "duplicateHints"],
              properties: {
                kind: { enum: TAKEAWAY_KINDS },
                claim: { type: "string", minLength: 40, maxLength: 2000 },
                epistemicStatus: { enum: EPISTEMIC_STATUSES },
                evidenceRationale: { type: "string", minLength: 10, maxLength: 2000 },
                caveat: { type: ["string", "null"], maxLength: 1000 },
                receiptIds: { type: "array", minItems: 1, maxItems: 20, uniqueItems: true,
                  items: { type: "string", minLength: 1 } },
                selectionRationale: { type: "string", minLength: 10, maxLength: 1200 },
                duplicateHints: { type: "array", maxItems: 20, uniqueItems: true,
                  items: { type: "string", minLength: 1 } },
              },
            },
          },
        },
      ],
    },
    usage: {
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
    },
  },
} as const;

export function deriveTakeawayTitle(claim: string): string {
  const normalized = claim.trim().replace(/\s+/g, " ");
  const sentence = normalized.match(/^.*?(?:[。！？!?](?=\s|$)|\.(?=\s|$))/u)?.[0] ?? normalized;
  return sentence.length <= 96 ? sentence : `${sentence.slice(0, 93).trimEnd()}…`;
}
