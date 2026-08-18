import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SettingsPage } from "../src/web/settings-page.js";
import type { SettingsSnapshot } from "../src/settings/settings-snapshot.js";

describe("SettingsPage", () => {
  it("makes the effective Agent model, thinking budget, status, and Codex compatibility understandable", () => {
    const html = renderToStaticMarkup(<SettingsPage snapshot={{
      schemaVersion: "settings-snapshot.v1",
      loadedAt: "2026-07-30T08:00:00.000Z",
      overview: {
        applicationVersion: "0.1.0",
        configurationVersion: "agent-configuration.v7",
        startedAt: "2026-07-30T08:00:00.000Z",
        listener: { host: "127.0.0.1", port: 3000, loopbackOnly: true },
        dataRoot: "/tmp/scholarloom-settings-fixture",
        fixture: false,
        featureFlags: { takeawayQualityV2: false, pdfLosslessDelivery: false },
        latestAgentActivity: {
          taskKind: "paper-summary",
          runId: "job:summary",
          completedAt: "2026-07-30T08:00:00.000Z",
        },
        codex: {
          installedVersion: "0.145.0",
          minimumVersion: "0.144.6",
          versionStatus: "compatible",
          capabilityStatus: "passed",
          capabilityChecks: {
            structured: { status: "passed", checkedAt: "2026-07-30T08:00:00.000Z" },
            agenticEvidence: { status: "passed", checkedAt: "2026-07-30T08:00:00.000Z" },
          },
          checkedAt: "2026-07-30T08:00:00.000Z",
        },
      },
      agents: [{
        taskKind: "paper-summary",
        displayName: "Paper Summary",
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        status: "enabled",
        configured: { model: "gpt-5.6-sol", reasoningEffort: "high" },
        effective: { model: "gpt-5.6-sol", reasoningEffort: "high" },
        observed: {
          runId: "job:summary", completedAt: "2026-07-30T08:00:00.000Z",
          model: "sol", reasoningEffort: "high", codexVersion: "0.145.0",
          configurationVersion: "agent-configuration.v1",
        },
        execution: {
          timeoutMs: 600_000, concurrency: null, mode: "structured-one-shot", network: "denied",
          workspace: "ephemeral-read-only", tools: [], environment: "core-scrubbed",
          ignoresUserConfig: true, ignoresUserRules: true,
        },
        contract: {
          prompt: { sourcePath: "src/agent/agent-prompts.ts", template: "Summary {{CONTEXT_JSON}}" },
          skill: { sourcePath: "skills/paper-reading/SKILL.md", content: "# Paper Reading" },
          outputSchema: { sourcePath: "src/agent/output-contracts.ts", schema: { type: "object" } },
        },
      }],
      system: {
        storage: {
          knowledgeAuthority: "vault-markdown-yaml", operationalAuthority: "sqlite",
          originals: "immutable-content-addressed", rebuildable: ["derived", "cache"], missingRoot: "fail-closed",
        },
        ingestion: { pdf: { maxRedirects: 5, maxBytes: 104857600, connectTimeoutMs: 10000, totalTimeoutMs: 60000,
          network: { strategy: "direct-first-proxy-fallback", proxyConfigured: true,
            proxySource: "all_proxy", proxyScope: "loopback-http-connect" } } },
        execution: {
          maximumConcurrency: 2, maximumTimeoutMs: 600000, network: "denied",
          environment: "core-scrubbed",
          ignoresUserConfig: true, ignoresUserRules: true,
        },
        visualEvidence: { pageLimit: 4, infrastructureFailureLimit: 3 },
        renderer: { dpi: 144, timeoutMs: 20000, memoryLimitMiB: 512, outputLimitBytes: 29360128,
          settings: { scale: 2, dpi: 144, background: "#ffffff", intent: "display", annotations: "disabled",
            systemFonts: false, eval: false, format: "image/png" } },
        diagnostics: { command: "npm run diagnostics", browserDetailAvailable: false },
        entryPaperResolver: { mode: "enabled", resolverVersion: "paper-resolver.v1",
          normalizationVersion: "paper-lookup-v1", killSwitchAvailable: true },
        aliasAutomation: {
          scope: "alias-only",
          gates: { minimumLabels: 75, maturityDays: 30, wilsonLower: 0.95,
            holdoutRate: 0.1, dailyCap: 10 },
          policyCounts: {}, latestPolicy: null, lastEvaluationAt: null,
        },
      },
    } as SettingsSnapshot} error={null} />);

    expect(html).toContain("系统配置");
    expect(html).toContain("只读");
    expect(html).toContain("Paper Summary");
    expect(html).toContain("gpt-5.6-sol");
    expect(html).toContain("high");
    expect(html).toContain("0.145.0");
    expect(html).toContain("能力检查通过");
    expect(html).toContain("0.1.0");
    expect(html).toContain("Takeaway Quality V2");
    expect(html).not.toContain("PDF.js Reader");
    expect(html).not.toContain("PDF.js Range-first");
    expect(html).toContain("Lossless PDF Delivery 未启用");
    expect(html).toContain("vault-markdown-yaml");
    expect(html).toContain("agent-configuration.v7");
    expect(html).toContain("job:summary");
    expect(html).toContain("环境变量最小化");
    expect(html).toContain("Direct first → Proxy fallback");
    expect(html).toContain("all_proxy");
    expect(html).toContain("Loopback HTTP CONNECT");
  });
});
