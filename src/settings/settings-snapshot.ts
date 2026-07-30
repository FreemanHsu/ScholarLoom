import { readFileSync } from "node:fs";
import { join } from "node:path";

import Database from "better-sqlite3";

import {
  AGENT_CONFIGURATION_VERSION,
  listAgentConfigurations,
  type AgentTaskKind,
  type CodexRuntimeStatus,
} from "../agent/agent-configuration.js";
import { AGENT_PROMPT_TEMPLATES } from "../agent/agent-prompts.js";
import { agenticEvidenceSchema, chatSchema, createSummarySchema, entrySchema } from "../agent/output-contracts.js";
import { takeawaySelectionSchema } from "../agent/takeaway-distillation.js";
import { SAFE_PDF_DOWNLOADER_DEFAULTS } from "../adapters/safe-pdf-downloader.js";
import type { StorageLayout } from "../storage/layout.js";
import { PDF_RENDERER_LIMITS, PDF_RENDER_SETTINGS } from "../storage/pdf-page-renderer.js";
import { VISUAL_EVIDENCE_LIMITS } from "../storage/visual-evidence-shim.js";

export type SettingsRuntime = {
  host: "127.0.0.1" | "::1";
  port: number;
  startedAt: string;
  fixture: boolean;
  takeawayQualityReleased: boolean;
  codexRuntimeStatus(): CodexRuntimeStatus;
};

export function buildSettingsSnapshot(layout: StorageLayout, runtime: SettingsRuntime) {
  const observed = latestAgentExecutions(layout);
  return {
    schemaVersion: "settings-snapshot.v1",
    loadedAt: runtime.startedAt,
    overview: {
      configurationVersion: AGENT_CONFIGURATION_VERSION,
      startedAt: runtime.startedAt,
      listener: { host: runtime.host, port: runtime.port, loopbackOnly: true },
      dataRoot: layout.root,
      fixture: runtime.fixture,
      featureFlags: { takeawayQualityV2: runtime.takeawayQualityReleased },
      codex: runtime.codexRuntimeStatus(),
    },
    agents: listAgentConfigurations().map((configuration) => ({
      ...configuration,
      status: configuration.taskKind === "paper-chat" ? "legacy"
        : configuration.taskKind === "takeaway-distillation" && !runtime.takeawayQualityReleased
          ? "feature-disabled" : "enabled",
      configured: { model: configuration.model, reasoningEffort: configuration.reasoningEffort },
      effective: { model: configuration.model, reasoningEffort: configuration.reasoningEffort },
      observed: observed.get(configuration.taskKind) ?? null,
      contract: {
        prompt: {
          sourcePath: "src/agent/agent-prompts.ts",
          template: AGENT_PROMPT_TEMPLATES[configuration.taskKind],
        },
        skill: configuration.taskKind === "paper-summary" ? {
          sourcePath: "skills/paper-reading/SKILL.md",
          content: readFileSync(join(process.cwd(), "skills/paper-reading/SKILL.md"), "utf8"),
        } : null,
        outputSchema: {
          sourcePath: configuration.taskKind === "takeaway-distillation"
            ? "src/agent/takeaway-distillation.ts" : "src/agent/output-contracts.ts",
          schema: outputSchema(configuration.taskKind),
        },
      },
    })),
    system: {
      ingestion: { pdf: SAFE_PDF_DOWNLOADER_DEFAULTS },
      visualEvidence: VISUAL_EVIDENCE_LIMITS,
      renderer: {
        dpi: PDF_RENDER_SETTINGS.dpi,
        timeoutMs: PDF_RENDERER_LIMITS.timeoutMs,
        memoryLimitMiB: PDF_RENDERER_LIMITS.memoryLimitMiB,
        outputLimitBytes: PDF_RENDERER_LIMITS.outputLimitBytes,
        settings: PDF_RENDER_SETTINGS,
      },
      diagnostics: { command: "npm run diagnostics", browserDetailAvailable: false },
    },
  } as const;
}

export type SettingsSnapshot = ReturnType<typeof buildSettingsSnapshot>;

function latestAgentExecutions(layout: StorageLayout): Map<AgentTaskKind, {
  runId: string;
  completedAt: string;
  model: string | null;
  reasoningEffort: string | null;
  codexVersion: string;
  configurationVersion: string | null;
}> {
  const database = new Database(layout.databasePath, { readonly: true });
  try {
    const rows = database.prepare(`SELECT ar.job_run_id,ar.task_kind,ar.model,ar.reasoning_effort,
      ar.codex_version,ar.configuration_version,j.completed_at,j.runner_kind
      FROM agent_runs ar JOIN job_runs j ON j.id=ar.job_run_id
      WHERE j.completed_at IS NOT NULL ORDER BY j.completed_at DESC,ar.job_run_id DESC`).all() as Array<{
        job_run_id: string; task_kind: string; model: string | null; reasoning_effort: string | null;
        codex_version: string; configuration_version: string | null; completed_at: string; runner_kind: string | null;
      }>;
    const latest = new Map<AgentTaskKind, {
      runId: string; completedAt: string; model: string | null; reasoningEffort: string | null;
      codexVersion: string; configurationVersion: string | null;
    }>();
    for (const row of rows) {
      const taskKind = normalizeRecordedTaskKind(row.task_kind, row.runner_kind);
      if (!taskKind || latest.has(taskKind)) continue;
      latest.set(taskKind, { runId: row.job_run_id, completedAt: row.completed_at, model: row.model,
        reasoningEffort: row.reasoning_effort, codexVersion: row.codex_version,
        configurationVersion: row.configuration_version });
    }
    return latest;
  } finally {
    database.close();
  }
}

function normalizeRecordedTaskKind(taskKind: string, runnerKind: string | null): AgentTaskKind | null {
  if (taskKind === "paper-chat" && runnerKind === "agentic_evidence") return "agentic-evidence";
  return listAgentConfigurations().some((configuration) => configuration.taskKind === taskKind)
    ? taskKind as AgentTaskKind : null;
}

function outputSchema(taskKind: ReturnType<typeof listAgentConfigurations>[number]["taskKind"]): object {
  if (taskKind === "paper-summary") return createSummarySchema(null);
  if (taskKind === "agentic-evidence") return agenticEvidenceSchema;
  if (taskKind === "entry-answer") return entrySchema;
  if (taskKind === "paper-chat") return chatSchema;
  return takeawaySelectionSchema;
}
