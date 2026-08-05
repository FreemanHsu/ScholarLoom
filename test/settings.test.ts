import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";

import { createApp } from "../src/app.js";
import { createFixturePdf, fixtureSummary } from "../src/adapters/fixture.js";
import { AGENT_CONFIGURATION_VERSION, getAgentConfiguration } from "../src/agent/agent-configuration.js";
import { initializeDataRoot } from "../src/storage/layout.js";

describe("read-only Settings", () => {
  it("returns one versioned allowlisted snapshot for every Agent capability", async () => {
    const layout = initializeDataRoot(join(await mkdtemp(join(tmpdir(), "scholarloom-settings-")), "data"));
    const app = await createApp({
      storageLayout: layout,
      paperSource: { async resolve() { throw new Error("unused"); } },
      settingsRuntime: {
        host: "127.0.0.1",
        port: 3000,
        startedAt: "2026-07-30T08:00:00.000Z",
        now: () => new Date("2026-07-30T08:05:00.000Z"),
        fixture: false,
        takeawayQualityReleased: false,
        pdfViewerEngine: "pdfjs",
        pdfJsRequestPolicy: "range-first",
        pdfOptimization: "lossless-linearization",
        pdfNetwork: {
          strategy: "direct-first-proxy-fallback",
          proxyConfigured: true,
          proxySource: "all_proxy",
          proxyScope: "loopback-http-connect",
        },
        codexRuntimeStatus: () => ({
          installedVersion: "0.145.0",
          minimumVersion: "0.144.6",
          versionStatus: "compatible",
          capabilityStatus: "not-run",
          capabilityChecks: {
            structured: { status: "not-run", checkedAt: null },
            agenticEvidence: { status: "not-run", checkedAt: null },
          },
          checkedAt: "2026-07-30T08:00:00.000Z",
        }),
      },
    });

    const response = await app.inject({ method: "GET", url: "/api/settings" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      schemaVersion: "settings-snapshot.v1",
      loadedAt: "2026-07-30T08:05:00.000Z",
      overview: {
        applicationVersion: "0.1.0",
        configurationVersion: "agent-configuration.v5",
        listener: { host: "127.0.0.1", port: 3000, loopbackOnly: true },
        dataRoot: layout.root,
        codex: {
          installedVersion: "0.145.0",
          minimumVersion: "0.144.6",
          versionStatus: "compatible",
          capabilityStatus: "not-run",
          capabilityChecks: {
            structured: { status: "not-run", checkedAt: null },
            agenticEvidence: { status: "not-run", checkedAt: null },
          },
          checkedAt: "2026-07-30T08:00:00.000Z",
        },
        featureFlags: { takeawayQualityV2: false, pdfJsViewer: true, pdfJsRangeFirst: true,
          pdfLosslessDelivery: true },
        latestAgentActivity: null,
      },
      agents: [
        { taskKind: "paper-summary", status: "enabled",
          configured: { model: "gpt-5.6-sol", reasoningEffort: "high" },
          effective: { model: "gpt-5.6-sol", reasoningEffort: "high" } },
        { taskKind: "agentic-evidence", status: "enabled",
          configured: { model: "gpt-5.6-sol", reasoningEffort: "medium" } },
        { taskKind: "entry-answer", status: "enabled",
          configured: { model: "gpt-5.6-sol", reasoningEffort: "medium" } },
        { taskKind: "paper-organization", status: "enabled",
          configured: { model: "gpt-5.6-sol", reasoningEffort: "medium" } },
        { taskKind: "paper-taxonomy", status: "enabled",
          configured: { model: "gpt-5.6-sol", reasoningEffort: "high" } },
        { taskKind: "takeaway-distillation", status: "feature-disabled",
          configured: { model: "gpt-5.6-sol", reasoningEffort: "medium" } },
        { taskKind: "paper-chat", status: "legacy",
          configured: { model: "gpt-5.6-sol", reasoningEffort: "medium" } },
      ],
      system: { ingestion: { pdf: { network: {
        strategy: "direct-first-proxy-fallback",
        proxyConfigured: true,
        proxySource: "all_proxy",
        proxyScope: "loopback-http-connect",
      } } } },
    });
    expect(response.body).not.toContain("process.env");
    expect(response.body).not.toContain("TOKEN");
    expect(response.body).not.toContain("SECRET");
    expect(response.body).not.toContain("127.0.0.1:7890");
    await app.close();
  });

  it("exposes application-owned prompt contracts without any runtime material or mutation route", async () => {
    const layout = initializeDataRoot(join(await mkdtemp(join(tmpdir(), "scholarloom-settings-contract-")), "data"));
    const app = await createApp({
      storageLayout: layout,
      paperSource: { async resolve() { throw new Error("unused"); } },
    });

    const response = await app.inject({ method: "GET", url: "/api/settings" });
    const snapshot = response.json();
    expect(snapshot.agents.find((agent: { taskKind: string }) => agent.taskKind === "paper-summary").contract)
      .toMatchObject({
        prompt: {
          sourcePath: "src/agent/agent-prompts.ts",
          template: expect.stringContaining("{{SKILL_CONTENT}}"),
        },
        skill: {
          sourcePath: "skills/paper-reading/SKILL.md",
          content: expect.stringContaining("# Paper Reading"),
        },
        outputSchema: { sourcePath: "src/agent/output-contracts.ts" },
      });
    expect(response.body).not.toContain("runtime-sensitive-question");
    expect((await app.inject({ method: "POST", url: "/api/settings" })).statusCode).toBe(404);
    await app.close();
  });

  it("explains the effective execution, ingestion, visual, and renderer limits", async () => {
    const layout = initializeDataRoot(join(await mkdtemp(join(tmpdir(), "scholarloom-settings-limits-")), "data"));
    const app = await createApp({
      storageLayout: layout,
      paperSource: { async resolve() { throw new Error("unused"); } },
      agentMessageTimeoutMs: 75_000,
    });

    const snapshot = (await app.inject({ method: "GET", url: "/api/settings" })).json();
    expect(snapshot.agents.find((agent: { taskKind: string }) => agent.taskKind === "agentic-evidence").execution)
      .toMatchObject({
        timeoutMs: 75_000,
        concurrency: 2,
        network: "denied",
        workspace: "frozen-evidence",
        tools: ["shell", "rg", "file-read", "inspect_pdf_page", "budget_status"],
      });
    expect(snapshot.system).toMatchObject({
      storage: {
        knowledgeAuthority: "vault-markdown-yaml",
        operationalAuthority: "sqlite",
        originals: "immutable-content-addressed",
        rebuildable: ["derived", "cache"],
        missingRoot: "fail-closed",
      },
      ingestion: { pdf: { maxBytes: 100 * 1024 * 1024, maxRedirects: 5, connectTimeoutMs: 10_000,
        totalTimeoutMs: 60_000, network: { strategy: "direct-only", proxyConfigured: false,
          proxySource: null, proxyScope: null } } },
      execution: {
        maximumConcurrency: 2,
        maximumTimeoutMs: 600_000,
        network: "denied",
        environment: "core-scrubbed",
        ignoresUserConfig: true,
        ignoresUserRules: true,
      },
      visualEvidence: { pageLimit: 4, infrastructureFailureLimit: 3 },
      renderer: { dpi: 144, timeoutMs: 20_000, memoryLimitMiB: 512 },
      diagnostics: { command: "npm run diagnostics", browserDetailAvailable: false },
    });
    await app.close();
  });

  it("shows the latest recorded execution metadata without exposing run input or output", async () => {
    const layout = initializeDataRoot(join(await mkdtemp(join(tmpdir(), "scholarloom-settings-observed-")), "data"));
    const app = await createApp({
      storageLayout: layout,
      paperSource: { async resolve() { throw new Error("unused"); } },
    });
    const database = new Database(layout.databasePath);
    database.prepare(`INSERT INTO job_runs
      (id,job_type,state,progress,idempotency_key,input_json,output_json,queued_at,started_at,completed_at,heartbeat_at)
      VALUES ('job:settings-observed','paper-summary','succeeded',1,'settings-observed',
        '{"runtime-sensitive-question":"never expose"}','{"private":"never expose"}',?,?,?,?)`)
      .run("2026-07-30T08:00:00.000Z", "2026-07-30T08:00:01.000Z", "2026-07-30T08:00:02.000Z",
        "2026-07-30T08:00:02.000Z");
    database.prepare(`INSERT INTO agent_runs
      (job_run_id,task_kind,model,reasoning_effort,codex_version,configuration_version,
       output_schema_hash,prompt_hash,output_json)
      VALUES ('job:settings-observed','paper-summary','sol','high','0.145.0','agent-configuration.v1',
        'schema-hash','prompt-hash','{}')`).run();
    database.close();

    const response = await app.inject({ method: "GET", url: "/api/settings" });
    const summary = response.json().agents.find((agent: { taskKind: string }) => agent.taskKind === "paper-summary");
    expect(summary.observed).toEqual({
      runId: "job:settings-observed",
      completedAt: "2026-07-30T08:00:02.000Z",
      model: "sol",
      reasoningEffort: "high",
      codexVersion: "0.145.0",
      configurationVersion: "agent-configuration.v1",
    });
    expect(response.json().overview.latestAgentActivity).toEqual({
      taskKind: "paper-summary",
      runId: "job:settings-observed",
      completedAt: "2026-07-30T08:00:02.000Z",
    });
    expect(response.body).not.toContain("runtime-sensitive-question");
    expect(response.body).not.toContain("never expose");
    await app.close();
  });

  it("records the effective configuration used by a successful production-style Agent run", async () => {
    const layout = initializeDataRoot(join(await mkdtemp(join(tmpdir(), "scholarloom-settings-recording-")), "data"));
    const app = await createApp({
      storageLayout: layout,
      paperSource: {
        async resolve() {
          return { arxivId: "2401.12345", latestVersion: 1, title: "Configured Agent",
            authors: ["Ada Fixture"], year: 2026 };
        },
        async fetchPdf() { return createFixturePdf(); },
      },
      codexRunner: {
        async runSummary() { return fixtureSummary; },
      },
      agentExecutionMetadata(taskKind) {
        const configuration = getAgentConfiguration(taskKind);
        return { model: configuration.model, reasoningEffort: configuration.reasoningEffort,
          codexVersion: "0.145.0", configurationVersion: AGENT_CONFIGURATION_VERSION };
      },
    });
    const imported = await app.inject({ method: "POST", url: "/api/imports",
      payload: { reference: "https://arxiv.org/abs/2401.12345" } });
    const importRequestId = imported.json().importRequest.id as string;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const status = await app.inject({ method: "GET", url: `/api/imports/${encodeURIComponent(importRequestId)}` });
      if (status.json().jobs.some((job: { state: string }) => job.state === "succeeded")) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const snapshot = (await app.inject({ method: "GET", url: "/api/settings" })).json();
    expect(snapshot.agents.find((agent: { taskKind: string }) => agent.taskKind === "paper-summary").observed)
      .toMatchObject({
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        codexVersion: "0.145.0",
        configurationVersion: "agent-configuration.v5",
      });
    await app.close();
  });

  it("rejects a non-positive Agent timeout instead of displaying a value execution would ignore", async () => {
    const layout = initializeDataRoot(join(await mkdtemp(join(tmpdir(), "scholarloom-settings-timeout-")), "data"));
    await expect(createApp({
      storageLayout: layout,
      paperSource: { async resolve() { throw new Error("unused"); } },
      agentMessageTimeoutMs: 0,
    })).rejects.toThrow("agent-message-timeout-invalid");
  });
});
