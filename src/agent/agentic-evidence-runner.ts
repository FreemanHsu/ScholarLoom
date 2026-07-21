import type { ProposedCitation } from "../storage/answer-grounding-gate.js";

export type AgentActivity = { type: string; text: string; metadata?: Record<string, unknown> };
export type AgentUsage = {
  status: "reported" | "estimated" | "unavailable";
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};
export type AgenticEvidenceResult = {
  answer: string;
  groundingStatus: "answered" | "partially_answered" | "insufficient_evidence" | "conflicting_evidence";
  citations: ProposedCitation[];
  proposedTakeaways: Array<{ claim: string; receiptOrdinals: number[] }>;
  usage: AgentUsage;
};
export type AgenticEvidenceRunner = {
  run(input: {
    attemptId: string;
    runEpoch: number;
    workspaceRoot: string;
    question: string;
    signal: AbortSignal;
    onActivity(activity: AgentActivity): void;
  }): Promise<AgenticEvidenceResult>;
};
