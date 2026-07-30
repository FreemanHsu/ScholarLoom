export const AGENT_CONFIGURATION_VERSION = "agent-configuration.v2";
export const MINIMUM_CODEX_VERSION = "0.144.6";

export type AgentTaskKind =
  | "paper-summary"
  | "agentic-evidence"
  | "entry-answer"
  | "takeaway-distillation"
  | "paper-chat";

export type ReasoningEffort = "medium" | "high";

export type CodexRuntimeStatus = {
  installedVersion: string | null;
  minimumVersion: typeof MINIMUM_CODEX_VERSION;
  versionStatus: "compatible" | "below-minimum" | "unavailable";
  capabilityStatus: "passed" | "failed" | "partial" | "not-run";
  capabilityChecks: {
    structured: { status: "passed" | "failed" | "not-run"; checkedAt: string | null };
    agenticEvidence: { status: "passed" | "failed" | "not-run"; checkedAt: string | null };
  };
  checkedAt: string;
};

export type AgentExecutionMetadata = {
  model: string;
  reasoningEffort: ReasoningEffort;
  codexVersion: string;
  configurationVersion: typeof AGENT_CONFIGURATION_VERSION;
};

export type AgentExecutionMetadataProvider = (taskKind: AgentTaskKind) => AgentExecutionMetadata | null;

export type AgentConfiguration = {
  taskKind: AgentTaskKind;
  displayName: string;
  model: "sol";
  reasoningEffort: ReasoningEffort;
  execution: {
    timeoutMs: number;
    concurrency: number | null;
    mode: "structured-one-shot" | "agentic-evidence";
    network: "denied";
    workspace: "ephemeral-read-only" | "frozen-evidence";
    tools: readonly string[];
    environment: "core-scrubbed";
    ignoresUserConfig: true;
    ignoresUserRules: true;
  };
};

const configurations: readonly AgentConfiguration[] = [
  configuration("paper-summary", "Paper Summary", "high", 600_000, null),
  configuration("agentic-evidence", "Discussion / Agentic Evidence", "medium", 180_000, 2, true),
  configuration("entry-answer", "Entry Agent", "medium", 600_000, null),
  configuration("takeaway-distillation", "Takeaway Selection", "medium", 180_000, 1),
  configuration("paper-chat", "Legacy Paper Chat", "medium", 120_000, null),
];

function configuration(taskKind: AgentTaskKind, displayName: string, reasoningEffort: ReasoningEffort,
  timeoutMs: number, concurrency: number | null, agentic = false): AgentConfiguration {
  return {
    taskKind, displayName, model: "sol", reasoningEffort,
    execution: {
      timeoutMs,
      concurrency,
      mode: agentic ? "agentic-evidence" : "structured-one-shot",
      network: "denied",
      workspace: agentic ? "frozen-evidence" : "ephemeral-read-only",
      tools: agentic ? ["shell", "rg", "file-read", "inspect_pdf_page", "budget_status"] : [],
      environment: "core-scrubbed",
      ignoresUserConfig: true,
      ignoresUserRules: true,
    },
  };
}

export function listAgentConfigurations(): readonly AgentConfiguration[] {
  return configurations;
}

export function getAgentConfiguration(taskKind: AgentTaskKind): AgentConfiguration {
  return configurations.find((configuration) => configuration.taskKind === taskKind)!;
}
