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
import { agenticEvidenceSchema, chatSchema, createSummarySchema, createVersionDiffSchema, entrySchema } from "../agent/output-contracts.js";
import { takeawaySelectionSchema } from "../agent/takeaway-distillation.js";
import { createPaperOrganizationSchema } from "../agent/paper-organization.js";
import { codexOutputSchema } from "../agent/codex-output-schema.js";
import { createPaperTaxonomySchema } from "../agent/paper-taxonomy.js";
import { SAFE_PDF_DOWNLOADER_DEFAULTS } from "../adapters/safe-pdf-downloader.js";
import type { StorageLayout } from "../storage/layout.js";
import { PDF_RENDERER_LIMITS, PDF_RENDER_SETTINGS } from "../storage/pdf-page-renderer.js";
import { VISUAL_EVIDENCE_LIMITS } from "../storage/visual-evidence-shim.js";
import { PAPER_RESOLVER_VERSION, type PaperResolverMode } from "../storage/paper-resolver.js";
import { PAPER_LOOKUP_NORMALIZATION_VERSION } from "../domain/paper-organization.js";

export type SettingsRuntime = {
  host: "127.0.0.1" | "::1";
  port: number;
  startedAt: string;
  fixture: boolean;
  takeawayQualityReleased: boolean;
  agentMessageTimeoutMs?: number;
  entryResolverMode?: PaperResolverMode;
  pdfOptimization?: "off" | "lossless-linearization";
  pdfNetwork?: PdfNetworkSettings;
  now?: () => Date;
  codexRuntimeStatus(): CodexRuntimeStatus;
};

export type PdfNetworkSettings = {
  strategy: "direct-only" | "direct-first-proxy-fallback";
  proxyConfigured: boolean;
  proxySource: "SCHOLARLOOM_PDF_PROXY" | "ALL_PROXY" | "all_proxy" | null;
  proxyScope: "loopback-http-connect" | null;
};

const DIRECT_ONLY_PDF_NETWORK: PdfNetworkSettings = {
  strategy: "direct-only",
  proxyConfigured: false,
  proxySource: null,
  proxyScope: null,
};

const applicationVersion = (JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { version: string }).version;

export function buildSettingsSnapshot(layout: StorageLayout, runtime: SettingsRuntime) {
  const observed = latestAgentExecutions(layout);
  const aliasAutomation = readAliasAutomationSettings(layout);
  const latestAgentActivity = [...observed.entries()]
    .sort((left, right) => right[1].completedAt.localeCompare(left[1].completedAt))[0] ?? null;
  const configurations = listAgentConfigurations();
  const effectiveExecutions = configurations.map((configuration) => ({
    taskKind: configuration.taskKind,
    execution: {
      ...configuration.execution,
      timeoutMs: runtime.agentMessageTimeoutMs !== undefined &&
        ["agentic-evidence", "takeaway-distillation", "paper-chat"].includes(configuration.taskKind)
        ? runtime.agentMessageTimeoutMs : configuration.execution.timeoutMs,
    },
  }));
  return {
    schemaVersion: "settings-snapshot.v1",
    loadedAt: (runtime.now?.() ?? new Date()).toISOString(),
    overview: {
      applicationVersion,
      configurationVersion: AGENT_CONFIGURATION_VERSION,
      startedAt: runtime.startedAt,
      listener: { host: runtime.host, port: runtime.port, loopbackOnly: true },
      dataRoot: layout.root,
      fixture: runtime.fixture,
      featureFlags: {
        takeawayQualityV2: runtime.takeawayQualityReleased,
        pdfLosslessDelivery: runtime.pdfOptimization === "lossless-linearization",
      },
      codex: runtime.codexRuntimeStatus(),
      latestAgentActivity: latestAgentActivity ? {
        taskKind: latestAgentActivity[0],
        runId: latestAgentActivity[1].runId,
        completedAt: latestAgentActivity[1].completedAt,
      } : null,
    },
    agents: configurations.map((configuration) => ({
      ...configuration,
      execution: effectiveExecutions.find((entry) => entry.taskKind === configuration.taskKind)!.execution,
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
        skill: ["paper-summary", "paper-organization", "paper-taxonomy"].includes(configuration.taskKind) ? {
          sourcePath: configuration.taskKind === "paper-summary"
            ? "skills/paper-reading/SKILL.md" : configuration.taskKind === "paper-organization"
              ? "skills/paper-organization/SKILL.md" : "skills/paper-taxonomy/SKILL.md",
          content: readFileSync(join(process.cwd(), configuration.taskKind === "paper-summary"
            ? "skills/paper-reading/SKILL.md" : configuration.taskKind === "paper-organization"
              ? "skills/paper-organization/SKILL.md" : "skills/paper-taxonomy/SKILL.md"), "utf8"),
        } : null,
        outputSchema: {
          sourcePath: configuration.taskKind === "takeaway-distillation"
            ? "src/agent/takeaway-distillation.ts" : "src/agent/output-contracts.ts",
          schema: outputSchema(configuration.taskKind),
        },
      },
    })),
    system: {
      storage: {
        knowledgeAuthority: "vault-markdown-yaml",
        operationalAuthority: "sqlite",
        originals: "immutable-content-addressed",
        rebuildable: ["derived", "cache"],
        missingRoot: "fail-closed",
      },
      ingestion: { pdf: { ...SAFE_PDF_DOWNLOADER_DEFAULTS,
        network: runtime.pdfNetwork ?? DIRECT_ONLY_PDF_NETWORK } },
      execution: {
        maximumConcurrency: Math.max(...effectiveExecutions.map((entry) => entry.execution.concurrency ?? 1)),
        maximumTimeoutMs: Math.max(...effectiveExecutions.map((entry) => entry.execution.timeoutMs)),
        network: "denied",
        environment: "core-scrubbed",
        ignoresUserConfig: true,
        ignoresUserRules: true,
      },
      visualEvidence: VISUAL_EVIDENCE_LIMITS,
      renderer: {
        dpi: PDF_RENDER_SETTINGS.dpi,
        timeoutMs: PDF_RENDERER_LIMITS.timeoutMs,
        memoryLimitMiB: PDF_RENDERER_LIMITS.memoryLimitMiB,
        outputLimitBytes: PDF_RENDERER_LIMITS.outputLimitBytes,
        settings: PDF_RENDER_SETTINGS,
      },
      diagnostics: { command: "npm run diagnostics", browserDetailAvailable: false },
      entryPaperResolver: {
        mode: runtime.entryResolverMode ?? "enabled",
        resolverVersion: PAPER_RESOLVER_VERSION,
        normalizationVersion: PAPER_LOOKUP_NORMALIZATION_VERSION,
        killSwitchAvailable: true,
      },
      aliasAutomation,
    },
  } as const;
}

function readAliasAutomationSettings(layout: StorageLayout) {
  const database = new Database(layout.databasePath, { readonly: true });
  try {
    const policies = database.prepare(`SELECT status,count(*) count FROM paper_organization_auto_policies
      GROUP BY status`).all() as Array<{ status: string; count: number }>;
    const latest = database.prepare(`SELECT version,status,created_at FROM paper_organization_auto_policies
      ORDER BY version DESC LIMIT 1`).get() as { version: number; status: string; created_at: string } | undefined;
    const evaluatedAt = database.prepare(`SELECT created_at FROM paper_organization_policy_evaluations
      ORDER BY created_at DESC,id DESC LIMIT 1`).pluck().get() as string | undefined;
    return {
      scope: "alias-only",
      gates: { minimumLabels: 75, maturityDays: 30, wilsonLower: .95,
        holdoutRate: .1, dailyCap: 10 },
      policyCounts: Object.fromEntries(policies.map((row) => [row.status, row.count])),
      latestPolicy: latest ? { version: latest.version, status: latest.status, createdAt: latest.created_at } : null,
      lastEvaluationAt: evaluatedAt ?? null,
    } as const;
  } finally {
    database.close();
  }
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
  let schema: object;
  if (taskKind === "paper-summary") schema = createSummarySchema(null);
  else if (taskKind === "paper-version-diff") schema = createVersionDiffSchema(null);
  else if (taskKind === "agentic-evidence") schema = agenticEvidenceSchema;
  else if (taskKind === "entry-answer") schema = entrySchema;
  else if (taskKind === "paper-organization") {
    schema = createPaperOrganizationSchema({ requestedSections: ["alias", "primary", "secondary"] }, null);
  }
  else if (taskKind === "paper-taxonomy") {
    schema = createPaperTaxonomySchema({ papers: [], directions: [] });
  }
  else if (taskKind === "paper-chat") schema = chatSchema;
  else schema = takeawaySelectionSchema;
  return codexOutputSchema(schema);
}
