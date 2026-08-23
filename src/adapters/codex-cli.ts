import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { accessSync, constants, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

import type { CodexRunner } from "../app.js";
import type { ChatResult, EntryResult, SummaryResult } from "../storage/import-store.js";
import type { AgentActivity, AgenticEvidenceResult, AgenticEvidenceRunner } from "../agent/agentic-evidence-runner.js";
import {
  getAgentConfiguration,
  MINIMUM_CODEX_VERSION,
  AGENT_CONFIGURATION_VERSION,
  type AgentExecutionMetadata,
  type AgentTaskKind,
  type CodexRuntimeStatus,
} from "../agent/agent-configuration.js";
import { renderAgentPrompt } from "../agent/agent-prompts.js";
import { codexOutputSchema } from "../agent/codex-output-schema.js";
import {
  agenticEvidenceSchema,
  createChatSchema,
  createEntrySchema,
  createSummarySchema,
  createVersionDiffSchema,
  validateEntryOutput,
  validateSummaryOutput,
  validateVersionDiffOutput,
} from "../agent/output-contracts.js";
import { takeawaySelectionSchema, type TakeawaySelectionRunner } from "../agent/takeaway-distillation.js";
import {
  createPaperOrganizationSchema,
  normalizePaperOrganizationAgentResult,
  validatePaperOrganizationAgentResult,
  type PaperOrganizationAgentResult,
  type PaperOrganizationRunner,
} from "../agent/paper-organization.js";
import type { StorageLayout } from "../storage/layout.js";
import { preflightTextCitations } from "../storage/text-citation-preflight.js";
import {
  createPaperTaxonomySchema,
  validatePaperTaxonomyResult,
  type PaperTaxonomyResult,
  type PaperTaxonomyRunner,
} from "../agent/paper-taxonomy.js";
import {
  knowledgeAnswerSchema,
  validateKnowledgeAnswer,
  type KnowledgeAnswer,
  type KnowledgeAnswerRunner,
} from "../agent/knowledge-answer.js";
import { preflightCuratedKnowledgeAnswer } from "../agent/curated-knowledge-answer-preflight.js";
import { createCuratedKnowledgeMcpLaunch } from "../agent/curated-knowledge-mcp-launch.js";
import { SqliteCuratedKnowledgeReader } from "../storage/curated-knowledge-reader.js";
import { CURATED_TOOL_LIMITS, type CuratedRetrievalSummary, type CuratedToolCitation,
  type CuratedToolLimits } from "../storage/curated-knowledge-tools.js";

const Ajv = createRequire(import.meta.url)("ajv") as new (options: { allErrors: boolean }) => {
  compile(schema: object): ((value: unknown) => boolean) & { errors?: unknown };
};
const SHELL_ENVIRONMENT_INHERIT = 'shell_environment_policy.inherit="core"';
const SHELL_ENVIRONMENT_EXCLUDE =
  'shell_environment_policy.exclude=["*PROXY*","*proxy*","*KEY*","*key*","*SECRET*","*secret*","*TOKEN*","*token*","*SCHOLARLOOM_VISUAL*","*SCHOLARLOOM_CURATED*"]';

function agentExecutionArgs(taskKind: AgentTaskKind): string[] {
  const configuration = getAgentConfiguration(taskKind);
  return ["--model", configuration.model, "-c", `model_reasoning_effort="${configuration.reasoningEffort}"`];
}

export class CodexCliRunner implements CodexRunner, AgenticEvidenceRunner, TakeawaySelectionRunner,
  PaperOrganizationRunner, PaperTaxonomyRunner, KnowledgeAnswerRunner {
  readonly #skill = readFileSync(join(process.cwd(), "skills/paper-reading/SKILL.md"), "utf8");
  readonly #organizationSkill = readFileSync(join(process.cwd(), "skills/paper-organization/SKILL.md"), "utf8");
  readonly #taxonomySkill = readFileSync(join(process.cwd(), "skills/paper-taxonomy/SKILL.md"), "utf8");
  readonly #canaries: boolean;
  readonly #runtimeRoot: string | undefined;
  readonly #storageLayout: StorageLayout | undefined;
  readonly #curatedKnowledgeLimits: Partial<CuratedToolLimits>;
  #runtimeStatus: CodexRuntimeStatus;

  constructor(options: { canaries?: boolean; runtimeRoot?: string; storageLayout?: StorageLayout;
    curatedKnowledgeLimits?: Partial<CuratedToolLimits> } = {}) {
    this.#canaries = options.canaries ?? true;
    this.#runtimeRoot = options.runtimeRoot;
    this.#storageLayout = options.storageLayout;
    this.#curatedKnowledgeLimits = options.curatedKnowledgeLimits ?? {};
    this.#runtimeStatus = inspectCodexRuntimeStatus();
  }

  runtimeStatus(): CodexRuntimeStatus {
    return { ...this.#runtimeStatus };
  }

  executionMetadata(taskKind: AgentTaskKind): AgentExecutionMetadata {
    const configuration = getAgentConfiguration(taskKind);
    return {
      model: configuration.model,
      reasoningEffort: configuration.reasoningEffort,
      codexVersion: this.#runtimeStatus.installedVersion ?? "unknown",
      configurationVersion: AGENT_CONFIGURATION_VERSION,
    };
  }

  async runSummary(context: Parameters<CodexRunner["runSummary"]>[0]): Promise<SummaryResult> {
    const allowedHandles = context.pages.map((page) => page.handle);
    const result = await this.#run<SummaryResult>("paper-summary", createSummarySchema(allowedHandles),
      renderAgentPrompt("paper-summary", { context, skillContent: this.#skill }));
    validateSummaryOutput(result, allowedHandles);
    return result;
  }
  async runVersionDiff(context: Parameters<NonNullable<CodexRunner["runVersionDiff"]>>[0]) {
    const allowedHandles = [...context.before.pages, ...context.after.pages].map((page) => page.handle);
    const result = await this.#run<import("../storage/import-store.js").VersionDiffResult>("paper-version-diff",
      createVersionDiffSchema(allowedHandles), renderAgentPrompt("paper-version-diff", { context }));
    validateVersionDiffOutput(result, allowedHandles);
    return result;
  }
  runChat(context: Parameters<NonNullable<CodexRunner["runChat"]>>[0]): Promise<ChatResult> {
    return this.#run("paper-chat", createChatSchema(context.sources.map((source) => source.handle)),
      renderAgentPrompt("paper-chat", { context }));
  }
  async runEntry(context: Parameters<NonNullable<CodexRunner["runEntry"]>>[0]): Promise<EntryResult> {
    const allowedHandles = context.sources.map((source) => source.handle);
    const result = await this.#run<EntryResult>("entry-answer", createEntrySchema(allowedHandles),
      renderAgentPrompt("entry-answer", { context }));
    validateEntryOutput(result, allowedHandles);
    return result;
  }

  async answer(input: Parameters<KnowledgeAnswerRunner["answer"]>[0]) {
    if (!this.#storageLayout) throw new Error("knowledge-answer-storage-layout-required");
    const bindingRoot = join(this.#storageLayout.tmpRoot, "curated-bindings");
    mkdirSync(bindingRoot, { recursive: true, mode: 0o700 });
    const bindingPath = join(bindingRoot, `curated-binding-${randomUUID()}.json`);
    const statePath = join(bindingRoot, `curated-state-${randomUUID()}.json`);
    writeFileSync(statePath, JSON.stringify({ summary: { searched: false, queryCount: 0, candidateCount: 0,
      openedSourceCount: 0, usedSourceCount: 0, budgetExhausted: false, projectionStale: false,
      lastSuccessfulAt: null }, verified: [] }), { encoding: "utf8", mode: 0o600 });
    writeFileSync(bindingPath, JSON.stringify({ dataRoot: this.#storageLayout.root, statePath,
      limits: { ...CURATED_TOOL_LIMITS, ...this.#curatedKnowledgeLimits },
      attemptId: input.attemptId, jobRunId: input.jobRunId, runEpoch: input.runEpoch }),
    { encoding: "utf8", mode: 0o600 });
    try {
      const serverPath = fileURLToPath(new URL("../agent/curated-knowledge-mcp-server.ts", import.meta.url));
      const mcpLaunch = createCuratedKnowledgeMcpLaunch(serverPath, bindingPath);
      try {
        await mcpLaunch.assertAvailable(input.signal);
        this.#runtimeStatus = recordCapabilityCheck(this.#runtimeStatus, "agenticCurated", "passed");
      } catch (error) {
        if (!input.signal.aborted) {
          this.#runtimeStatus = recordCapabilityCheck(this.#runtimeStatus, "agenticCurated", "failed");
        }
        throw error;
      }
      const result = await this.#run<KnowledgeAnswer>("knowledge-answer", knowledgeAnswerSchema,
        renderAgentPrompt("knowledge-answer", {
          context: { question: input.question, conversation: input.conversation },
        }), input.signal, {
          configs: ['approval_policy="never"', mcpLaunch.codexConfig],
        });
      try {
        const snapshot = JSON.parse(readFileSync(statePath, "utf8")) as {
          summary: CuratedRetrievalSummary; verified: CuratedToolCitation[];
        };
        const reader = SqliteCuratedKnowledgeReader.open(this.#storageLayout);
        try { return preflightCuratedKnowledgeAnswer(result, snapshot, reader); }
        finally { reader.close(); }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.startsWith("knowledge-answer-")) throw error;
        throw new Error("curated-reader-failed", { cause: error });
      }
    } finally {
      rmSync(bindingPath, { force: true });
      rmSync(statePath, { force: true });
    }
  }

  async analyze(input: Parameters<PaperOrganizationRunner["analyze"]>[0]): Promise<PaperOrganizationAgentResult> {
    input.onActivity({ type: "organization", text: "正在分析 Paper 的 Alias 与核心研究方向" });
    const topicIds = input.directions.map((direction) => direction.topicId);
    const schema = createPaperOrganizationSchema(input.context, topicIds);
    const rawResult = await this.#run<PaperOrganizationAgentResult>("paper-organization", schema,
      renderAgentPrompt("paper-organization", {
        context: { manifest: input.context, directions: input.directions },
        skillContent: this.#organizationSkill,
      }), input.signal);
    const result = normalizePaperOrganizationAgentResult(rawResult);
    validatePaperOrganizationAgentResult(result, input.context, input.directions);
    return result;
  }

  async propose(input: Parameters<PaperTaxonomyRunner["propose"]>[0]): Promise<PaperTaxonomyResult> {
    input.onActivity({ type: "taxonomy", text: "正在从 Paper cohort 归纳候选 Research Directions" });
    const schema = createPaperTaxonomySchema(input.context);
    const result = await this.#run<PaperTaxonomyResult>("paper-taxonomy", schema,
      renderAgentPrompt("paper-taxonomy", {
        context: input.context,
        skillContent: this.#taxonomySkill,
      }), input.signal);
    validatePaperTaxonomyResult(result, input.context);
    return result;
  }

  select(input: Parameters<TakeawaySelectionRunner["select"]>[0]): ReturnType<TakeawaySelectionRunner["select"]> {
    input.onActivity({ type: "selection", text: "正在判断回答中是否存在值得长期保留的单一结论" });
    return this.#run("takeaway-distillation", takeawaySelectionSchema,
      renderAgentPrompt("takeaway-distillation", { context: { context: input.context, material: input.material } }),
      input.signal);
  }

  async run(input: Parameters<AgenticEvidenceRunner["run"]>[0]): Promise<AgenticEvidenceResult> {
    if (!this.#runtimeRoot) throw new Error("discussion-runtime-root-required");
    if (this.#canaries) assertPrivateRuntimeRoot(this.#runtimeRoot);
    const directory = mkdtempSync(join(this.#runtimeRoot, "agentic-codex-"));
    let bindingPath: string | undefined;
    try {
      const schemaPath = join(directory, "schema.json");
      const outputPath = join(directory, "output.json");
      writeFileSync(schemaPath, JSON.stringify(codexOutputSchema(agenticEvidenceSchema)), "utf8");
      const codexExecutable = resolveExecutable("codex");
      if (this.#canaries) {
        try {
          const installedVersion = await DiscussionCapability.assert({ workspaceRoot: input.workspaceRoot, runDirectory: directory,
            codexExecutable });
          this.#runtimeStatus = recordCapabilityCheck(this.#runtimeStatus, "agenticEvidence", "passed", installedVersion);
        } catch (error) {
          this.#runtimeStatus = recordCapabilityCheck(this.#runtimeStatus, "agenticEvidence", "failed");
          throw error;
        }
      }
      const prompt = renderAgentPrompt("agentic-evidence", { userQuestion: input.question });
      const codexArgs = ["exec", "-", "--strict-config", "--ephemeral", "--skip-git-repo-check",
        "--ignore-user-config", "--ignore-rules", "--json", "--cd", input.workspaceRoot,
        ...agentExecutionArgs("agentic-evidence"),
        "-c", 'default_permissions="scholarloom-evidence"',
        "-c", permissionProfileConfig(directory),
        "-c", SHELL_ENVIRONMENT_INHERIT,
        "-c", SHELL_ENVIRONMENT_EXCLUDE,
        "--output-schema", schemaPath, "--output-last-message", outputPath, "--color", "never"];
      let processEnvironment = codexProcessEnvironment(process.env, directory);
      if (this.#storageLayout) {
        const bindingRoot = join(this.#storageLayout.tmpRoot, "visual-bindings");
        mkdirSync(bindingRoot, { recursive: true, mode: 0o700 });
        bindingPath = join(bindingRoot, `${randomBindingName()}.json`);
        writeFileSync(bindingPath, JSON.stringify({ dataRoot: this.#storageLayout.root, attemptId: input.attemptId,
          runEpoch: input.runEpoch }), { encoding: "utf8", mode: 0o600 });
        const serverPath = fileURLToPath(new URL("../agent/visual-evidence-mcp-server.ts", import.meta.url));
        codexArgs.splice(codexArgs.indexOf("--output-schema"), 0,
          "-c", 'approval_policy="never"',
          "-c", visualMcpConfig(serverPath));
        processEnvironment = { ...processEnvironment, SCHOLARLOOM_VISUAL_BINDING_FILE: bindingPath };
      }
      assertNativePermissionLaunch(codexArgs);
      await new Promise<void>((resolve, reject) => {
        const child = spawn(codexExecutable, codexArgs, { stdio: ["pipe", "pipe", "pipe"], detached: true,
          cwd: directory,
          env: processEnvironment });
        let stderr = "";
        let buffer = "";
        let failureCode: string | null = null;
        const terminate = () => {
          if (!child.pid) return;
          try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
          const kill = setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); } }, 2_000);
          kill.unref();
        };
        const abort = () => terminate();
        input.signal.addEventListener("abort", abort, { once: true });
        child.stdout.on("data", (chunk: Buffer) => {
          buffer += chunk.toString();
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            failureCode = codexFailureCode(line) ?? failureCode;
            const activity = normalizeCodexEvent(line);
            if (activity) input.onActivity(activity);
          }
        });
        child.stderr.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString()}`.slice(-4_000); });
        child.on("error", (cause) => { input.signal.removeEventListener("abort", abort); reject(cause); });
        child.on("close", (code) => {
          input.signal.removeEventListener("abort", abort);
          if (input.signal.aborted) reject(input.signal.reason ?? new Error("agent-aborted"));
          else if (code === 0) resolve();
          else reject(new Error(`agentic-codex-failed:${code}:${failureCode ?? (stderr ? "stderr" : "no-diagnostic")}`));
        });
        child.stdin.end(prompt);
      });
      const result = JSON.parse(readFileSync(outputPath, "utf8")) as AgenticEvidenceResult;
      const validate = new Ajv({ allErrors: true }).compile(agenticEvidenceSchema);
      if (!validate(result)) throw new Error(`codex-output-invalid:${JSON.stringify(validate.errors)}`);
      if (this.#storageLayout) {
        const database = new Database(this.#storageLayout.databasePath);
        database.pragma("foreign_keys = ON");
        database.pragma("busy_timeout = 5000");
        try { result.citations = preflightTextCitations({ attemptId: input.attemptId, runEpoch: input.runEpoch,
          layout: this.#storageLayout, database, citations: result.citations }); }
        finally { database.close(); }
      }
      return result;
    } finally {
      if (bindingPath) rmSync(bindingPath, { force: true });
      rmSync(directory, { recursive: true, force: true });
    }
  }

  async #run<T>(task: AgentTaskKind, schema: object, prompt: string, signal?: AbortSignal,
    launch: { configs?: string[]; environment?: NodeJS.ProcessEnv } = {}): Promise<T> {
    const configuration = getAgentConfiguration(task);
    const executionRoot = this.#runtimeRoot ?? tmpdir();
    if (this.#canaries && this.#runtimeRoot) assertPrivateRuntimeRoot(this.#runtimeRoot);
    const directory = mkdtempSync(join(executionRoot, "structured-codex-"));
    const workspace = mkdtempSync(join(executionRoot, "structured-workspace-"));
    const schemaPath = join(directory, "schema.json");
    const outputPath = join(directory, "output.json");
    writeFileSync(schemaPath, JSON.stringify(codexOutputSchema(schema)), "utf8");
    writeFileSync(join(workspace, "CANARY"), "readable", "utf8");
    try {
      const codexExecutable = resolveExecutable("codex");
      if (this.#canaries) {
        try {
          const installedVersion = await StructuredCapability.assert({
            codexExecutable, runDirectory: directory, workspaceRoot: workspace,
          });
          this.#runtimeStatus = recordCapabilityCheck(this.#runtimeStatus, "structured", "passed", installedVersion);
        } catch (error) {
          this.#runtimeStatus = recordCapabilityCheck(this.#runtimeStatus, "structured", "failed");
          throw error;
        }
      }
      await new Promise<void>((resolve, reject) => {
        const child = spawn(codexExecutable, ["exec", "-", "--strict-config", "--ephemeral", "--skip-git-repo-check",
          "--ignore-user-config", "--ignore-rules", "--json", "--cd", workspace,
          ...agentExecutionArgs(task),
          "-c", 'default_permissions="scholarloom-structured"',
          "-c", structuredPermissionProfileConfig(directory),
          "-c", SHELL_ENVIRONMENT_INHERIT,
          "-c", SHELL_ENVIRONMENT_EXCLUDE,
          ...(launch.configs?.flatMap((config) => ["-c", config]) ?? []),
          "--output-schema", schemaPath, "--output-last-message", outputPath, "--color", "never"],
        { stdio: ["pipe", "pipe", "pipe"], env: codexProcessEnvironment(launch.environment ?? process.env, directory) });
        let error = "";
        let events = "";
        const terminate = () => child.kill("SIGTERM");
        const timeout = setTimeout(terminate, configuration.execution.timeoutMs);
        signal?.addEventListener("abort", terminate, { once: true });
        child.stdout.on("data", (chunk: Buffer) => { events += chunk.toString(); if (events.length > 2_000_000) events = events.slice(-2_000_000); });
        child.stderr.on("data", (chunk: Buffer) => { error += chunk.toString(); });
        child.on("error", (cause) => { clearTimeout(timeout); signal?.removeEventListener("abort", terminate); reject(cause); });
        child.on("close", (code) => {
          clearTimeout(timeout);
          signal?.removeEventListener("abort", terminate);
          if (signal?.aborted) reject(signal.reason ?? new Error(`${task}-aborted`));
          else if (code === 0) resolve();
          else reject(new Error(`${task} Codex failed (${code}): ${error.slice(-1200)} ${events.slice(-800)}`));
        });
        child.stdin.end(prompt);
      });
      const result = JSON.parse(readFileSync(outputPath, "utf8")) as T;
      const validate = new Ajv({ allErrors: true }).compile(schema);
      if (!validate(result)) throw new Error(`codex-output-invalid:${JSON.stringify(validate.errors)}`);
      return result;
    } finally {
      rmSync(directory, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  }
}

class StructuredCapability {
  static async assert(input: { codexExecutable: string; runDirectory: string; workspaceRoot: string }): Promise<string> {
    const version = readCompatibleVersion(input.codexExecutable, input.runDirectory, "structured-capability");
    const help = execFileSync(input.codexExecutable, ["exec", "--help"], { encoding: "utf8",
      env: codexProcessEnvironment(process.env, input.runDirectory) });
    const requiredFlags = ["--strict-config", "--ephemeral", "--skip-git-repo-check", "--ignore-user-config",
      "--ignore-rules", "--json", "--cd", "--model", "--output-schema", "--output-last-message"];
    const missing = requiredFlags.find((flag) => !help.includes(flag));
    if (missing) throw new Error(`structured-capability-launch-contract:${missing}`);
    const siblingDirectory = mkdtempSync(join(dirname(input.runDirectory), "structured-capability-sibling-"));
    const siblingCanary = join(siblingDirectory, "protected");
    const parentWriteCanary = join(dirname(input.runDirectory), "structured-parent-write-canary");
    writeFileSync(siblingCanary, "protected", { encoding: "utf8", mode: 0o600 });
    let loopback: Awaited<ReturnType<typeof startLoopbackCanary>> | undefined;
    try {
      loopback = await startLoopbackCanary();
      const script = 'test -r "$1/CANARY" || exit 61; touch "$1/workspace-write-canary" >/dev/null 2>&1 && exit 62; touch "$2/run-write-canary" || exit 63; cat "$3" >/dev/null 2>&1 && exit 64; touch "$4/structured-parent-write-canary" >/dev/null 2>&1 && exit 65; /usr/bin/curl -fsS --max-time 2 "$5" >/dev/null 2>&1 && exit 66; /usr/bin/curl -fsS --max-time 2 https://example.com >/dev/null 2>&1 && exit 67; env | cut -d= -f1 | grep -iE "(proxy|key|secret|token)" >/dev/null && exit 68; exit 0';
      const canary = spawnSync(input.codexExecutable, ["sandbox",
        "-c", 'default_permissions="scholarloom-structured"',
        "-c", structuredPermissionProfileConfig(input.runDirectory),
        "-c", SHELL_ENVIRONMENT_INHERIT,
        "-c", SHELL_ENVIRONMENT_EXCLUDE,
        "-P", "scholarloom-structured",
        "-C", input.workspaceRoot, "--", "/bin/sh", "-c", script,
        "canary", input.workspaceRoot, input.runDirectory, siblingCanary, dirname(input.runDirectory),
        `http://127.0.0.1:${loopback.port}`],
      { cwd: input.runDirectory, env: codexProcessEnvironment(process.env, input.runDirectory),
        encoding: "utf8", timeout: 30_000 });
      if (canary.status !== 0) {
        throw new Error(`structured-capability-sandbox:${canary.status}:${canary.signal ?? ""}:` +
          `${canary.error?.message ?? ""}:${canary.stderr.slice(-500)}`);
      }
    } finally {
      loopback?.close();
      rmSync(join(input.workspaceRoot, "workspace-write-canary"), { force: true });
      rmSync(join(input.runDirectory, "run-write-canary"), { force: true });
      rmSync(parentWriteCanary, { force: true });
      rmSync(siblingDirectory, { recursive: true, force: true });
    }
    return version;
  }
}

class DiscussionCapability {
  static async assert(input: { workspaceRoot: string; runDirectory: string; codexExecutable: string }): Promise<string> {
    const version = readCompatibleVersion(input.codexExecutable, input.runDirectory, "discussion-capability");
    const help = execFileSync(input.codexExecutable, ["exec", "--strict-config", "--help"], { encoding: "utf8",
      env: codexProcessEnvironment(process.env, input.runDirectory) });
    if (!help.includes("--strict-config") || !help.includes("--json") || !help.includes("--output-schema")) {
      throw new Error("discussion-capability-strict-config");
    }
    const started = normalizeCodexEvent('{"type":"turn.started"}');
    const command = normalizeCodexEvent('{"type":"item.completed","item":{"type":"command_execution","command":"rg evidence"}}');
    if (started?.type !== "started" || command?.type !== "command") throw new Error("discussion-capability-jsonl-contract");
    const siblingDirectory = mkdtempSync(join(dirname(input.runDirectory), "capability-sibling-"));
    const siblingCanary = join(siblingDirectory, "protected");
    const parentWriteCanary = join(dirname(input.runDirectory), "parent-write-canary");
    writeFileSync(siblingCanary, "protected", { encoding: "utf8", mode: 0o600 });
    let loopback: Awaited<ReturnType<typeof startLoopbackCanary>> | undefined;
    try {
      loopback = await startLoopbackCanary();
      const script = 'test -r "$1/MANIFEST.json" || exit 61; touch "$2/write-canary" || exit 62; cat "$3" >/dev/null 2>&1 && exit 63; touch "$4/parent-write-canary" >/dev/null 2>&1 && exit 64; env | cut -d= -f1 | grep -iE "(proxy|key|secret|token)" >/dev/null && exit 65; /usr/bin/curl -fsS --max-time 2 "$5" >/dev/null 2>&1 && exit 66; /usr/bin/curl -fsS --max-time 2 https://example.com >/dev/null 2>&1 && exit 67; exit 0';
      const canary = spawnSync(input.codexExecutable, ["sandbox",
        "-c", 'default_permissions="scholarloom-evidence"',
        "-c", permissionProfileConfig(input.runDirectory),
        "-c", SHELL_ENVIRONMENT_INHERIT,
        "-c", SHELL_ENVIRONMENT_EXCLUDE,
        "-P", "scholarloom-evidence", "-C", input.workspaceRoot, "--", "/bin/sh", "-c", script,
        "canary", input.workspaceRoot, input.runDirectory, siblingCanary, dirname(input.runDirectory), `http://127.0.0.1:${loopback.port}`],
      { cwd: input.runDirectory, env: codexProcessEnvironment(process.env, input.runDirectory), encoding: "utf8", timeout: 30_000 });
      if (canary.status !== 0) throw new Error(`discussion-capability-sandbox:${canary.status}:${canary.signal ?? ""}:${canary.error?.message ?? ""}:${canary.stderr.slice(-500)}`);
    } finally {
      loopback?.close();
      rmSync(join(input.runDirectory, "write-canary"), { force: true });
      rmSync(parentWriteCanary, { force: true });
      rmSync(siblingDirectory, { recursive: true, force: true });
    }
    return version;
  }
}

export async function assertDiscussionCapability(input: { workspaceRoot: string; runDirectory: string }): Promise<void> {
  await DiscussionCapability.assert({ ...input, codexExecutable: resolveExecutable("codex") });
}

export async function assertStructuredCapability(input: { runDirectory: string; workspaceRoot: string }): Promise<void> {
  await StructuredCapability.assert({ ...input, codexExecutable: resolveExecutable("codex") });
}

function versionAtLeast(version: number[], minimum: number[]): boolean {
  for (let index = 0; index < Math.max(version.length, minimum.length); index += 1) {
    const actual = version[index] ?? 0;
    const required = minimum[index] ?? 0;
    if (actual !== required) return actual > required;
  }
  return true;
}

function readCompatibleVersion(executable: string, runDirectory: string, capability: string): string {
  const versionOutput = execFileSync(executable, ["--version"], { encoding: "utf8",
    env: codexProcessEnvironment(process.env, runDirectory) });
  const match = /codex-cli (\d+)\.(\d+)\.(\d+)/.exec(versionOutput);
  if (!match) throw new Error(`${capability}-version-unreadable`);
  const version = match.slice(1).map(Number);
  if (!versionAtLeast(version, MINIMUM_CODEX_VERSION.split(".").map(Number))) {
    throw new Error(`${capability}-version-uncertified:${version.join(".")}`);
  }
  return version.join(".");
}

function inspectCodexRuntimeStatus(): CodexRuntimeStatus {
  const checkedAt = new Date().toISOString();
  try {
    const executable = resolveExecutable("codex");
    const output = execFileSync(executable, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const match = /codex-cli (\d+)\.(\d+)\.(\d+)/.exec(output);
    if (!match) throw new Error("version-unreadable");
    const version = match.slice(1).map(Number);
    return {
      installedVersion: version.join("."),
      minimumVersion: MINIMUM_CODEX_VERSION,
      versionStatus: versionAtLeast(version, MINIMUM_CODEX_VERSION.split(".").map(Number)) ? "compatible" : "below-minimum",
      capabilityStatus: "not-run",
      capabilityChecks: emptyCapabilityChecks(),
      checkedAt,
    };
  } catch {
    return {
      installedVersion: null,
      minimumVersion: MINIMUM_CODEX_VERSION,
      versionStatus: "unavailable",
      capabilityStatus: "not-run",
      capabilityChecks: emptyCapabilityChecks(),
      checkedAt,
    };
  }
}

function emptyCapabilityChecks(): CodexRuntimeStatus["capabilityChecks"] {
  return {
    structured: { status: "not-run", checkedAt: null },
    agenticEvidence: { status: "not-run", checkedAt: null },
    agenticCurated: { status: "not-run", checkedAt: null },
  };
}

function recordCapabilityCheck(status: CodexRuntimeStatus,
  kind: keyof CodexRuntimeStatus["capabilityChecks"], result: "passed" | "failed",
  installedVersion?: string): CodexRuntimeStatus {
  const checkedAt = new Date().toISOString();
  const capabilityChecks = { ...status.capabilityChecks, [kind]: { status: result, checkedAt } };
  const results = Object.values(capabilityChecks).map((check) => check.status);
  const capabilityStatus = results.includes("failed") ? "failed"
    : results.every((check) => check === "passed") ? "passed"
      : results.includes("passed") ? "partial" : "not-run";
  return {
    ...status,
    ...(installedVersion ? { installedVersion, versionStatus: "compatible" as const } : {}),
    capabilityStatus,
    capabilityChecks,
    checkedAt,
  };
}

function normalizeCodexEvent(line: string): AgentActivity | null {
  if (!line.trim()) return null;
  let event: { type?: string; item?: { type?: string; command?: string } };
  try { event = JSON.parse(line) as typeof event; } catch { throw new Error("codex-jsonl-invalid"); }
  if (event.type === "turn.started") return { type: "started", text: "Agent 已开始检查证据" };
  if (event.item?.type === "command_execution") return { type: "command", text: summarizeCommand(event.item.command ?? "shell") };
  if (event.type === "turn.completed") return { type: "converging", text: "Agent 已完成证据整理" };
  return null;
}

function codexFailureCode(line: string): string | null {
  let event: { type?: string; message?: unknown; error?: { message?: unknown } };
  try { event = JSON.parse(line) as typeof event; } catch { return null; }
  if (event.type !== "error" && event.type !== "turn.failed") return null;
  const message = event.type === "error" ? event.message : event.error?.message;
  if (typeof message !== "string") return "codex-turn-failed";
  try {
    const payload = JSON.parse(message) as { error?: { code?: unknown } };
    if (typeof payload.error?.code === "string" && /^[a-z0-9_-]{1,80}$/i.test(payload.error.code)) {
      return payload.error.code.toLowerCase().replaceAll("_", "-");
    }
  } catch { /* Provider messages are untrusted diagnostics; do not surface them. */ }
  return "codex-turn-failed";
}

function summarizeCommand(command: string): string {
  const firstToken = command.trim().split(/\s+/, 1)[0];
  const executable = firstToken ? firstToken.split("/").at(-1)?.toLowerCase() : undefined;
  if (["rg", "grep"].includes(executable ?? "")) return "正在搜索 Evidence Workspace";
  if (["cat", "sed", "head", "tail", "less"].includes(executable ?? "")) return "正在读取冻结证据";
  if (executable === "git") return "正在检查冻结代码快照";
  if (["find", "ls", "fd"].includes(executable ?? "")) return "正在枚举 Evidence Workspace";
  return "正在执行受限 workspace 检查";
}

function codexProcessEnvironment(environment: NodeJS.ProcessEnv, runDirectory: string): NodeJS.ProcessEnv {
  return { ...environment, TMPDIR: runDirectory };
}

function randomBindingName(): string { return `visual-binding-${randomUUID()}`; }

function visualMcpConfig(serverPath: string): string {
  return `mcp_servers.visual={command=${JSON.stringify(process.execPath)},args=${JSON.stringify([
    "--import", "tsx", serverPath,
  ])},startup_timeout_sec=10,tool_timeout_sec=30}`;
}

function permissionProfileConfig(runDirectory: string): string {
  const quotedRunDirectory = JSON.stringify(runDirectory);
  return `permissions.scholarloom-evidence={extends=":read-only",filesystem={":root"="deny",":minimal"="read",${quotedRunDirectory}="write",":workspace_roots"={"."="read"}},network={enabled=false}}`;
}

function structuredPermissionProfileConfig(runDirectory: string): string {
  return `permissions.scholarloom-structured={extends=":read-only",filesystem={":root"="deny",":minimal"="read",${JSON.stringify(runDirectory)}="write",":workspace_roots"={"."="read"}},network={enabled=false}}`;
}

function assertNativePermissionLaunch(args: string[]): void {
  const configs = args.flatMap((argument, index) => args[index - 1] === "-c" ? [argument] : []);
  if (args.includes("--sandbox") || !configs.includes('default_permissions="scholarloom-evidence"') ||
      !configs.some((config) => config.startsWith("permissions.scholarloom-evidence="))) {
    throw new Error("discussion-capability-permission-profile-conflict");
  }
  if (configs.some((config) => config.startsWith("mcp_servers.visual=")) && !configs.includes('approval_policy="never"')) {
    throw new Error("discussion-capability-visual-approval-conflict");
  }
}

function assertPrivateRuntimeRoot(runtimeRoot: string): void {
  const actual = realpathSync(runtimeRoot);
  const details = statSync(actual);
  const currentUid = process.getuid?.();
  if (!details.isDirectory() || (currentUid !== undefined && details.uid !== currentUid) || (details.mode & 0o077) !== 0) {
    throw new Error(`discussion-runtime-root-permissions:${actual}`);
  }
  const forbidden = ["/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp", tmpdir()]
    .map((path) => { try { return realpathSync(path); } catch { return resolve(path); } });
  for (const root of new Set(forbidden)) {
    const pathFromRoot = relative(root, actual);
    if (pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot))) {
      throw new Error(`discussion-runtime-root-unsafe:${actual}`);
    }
  }
}

async function startLoopbackCanary(): Promise<{ port: number; close(): void }> {
  const source = 'const net=require("node:net");const server=net.createServer((socket)=>socket.end("HTTP/1.1 204 No Content\\r\\nContent-Length: 0\\r\\n\\r\\n"));server.listen(0,"127.0.0.1",()=>process.stdout.write(String(server.address().port)+"\\n"));';
  const child = spawn(process.execPath, ["-e", source], { stdio: ["ignore", "pipe", "pipe"] });
  const port = await new Promise<number>((resolvePort, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("discussion-capability-loopback-timeout"));
    }, 5_000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      const match = /^(\d+)\n/.exec(stdout);
      if (!match) return;
      clearTimeout(timeout);
      resolvePort(Number(match[1]));
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString()}`.slice(-500); });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("exit", (code) => {
      if (!stdout.includes("\n")) {
        clearTimeout(timeout);
        reject(new Error(`discussion-capability-loopback:${code}:${stderr}`));
      }
    });
  });
  return { port, close() { child.kill("SIGTERM"); } };
}

function resolveExecutable(name: string, environment: NodeJS.ProcessEnv = process.env): string {
  if (isAbsolute(name)) return name;
  for (const directory of (environment.PATH ?? "").split(":")) {
    if (!directory) continue;
    const candidate = resolve(directory, name);
    try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* keep searching */ }
  }
  throw new Error(`discussion-capability-executable-unavailable:${name}`);
}
