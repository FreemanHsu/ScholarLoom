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
        configurationVersion: "agent-configuration.v1",
        startedAt: "2026-07-30T08:00:00.000Z",
        listener: { host: "127.0.0.1", port: 3000, loopbackOnly: true },
        dataRoot: "$HOME/ScholarLoomData",
        fixture: false,
        featureFlags: { takeawayQualityV2: false },
        codex: {
          installedVersion: "0.145.0",
          minimumVersion: "0.144.6",
          versionStatus: "compatible",
          capabilityStatus: "passed",
          checkedAt: "2026-07-30T08:00:00.000Z",
        },
      },
      agents: [{
        taskKind: "paper-summary",
        displayName: "Paper Summary",
        model: "sol",
        reasoningEffort: "high",
        status: "enabled",
        configured: { model: "sol", reasoningEffort: "high" },
        effective: { model: "sol", reasoningEffort: "high" },
        observed: null,
        execution: {
          timeoutMs: 600_000, concurrency: null, mode: "structured-one-shot", network: "denied",
          workspace: "ephemeral-read-only", tools: [], ignoresUserConfig: true, ignoresUserRules: true,
        },
        contract: {
          prompt: { sourcePath: "src/agent/agent-prompts.ts", template: "Summary {{CONTEXT_JSON}}" },
          skill: { sourcePath: "skills/paper-reading/SKILL.md", content: "# Paper Reading" },
          outputSchema: { sourcePath: "src/agent/output-contracts.ts", schema: { type: "object" } },
        },
      }],
      system: {
        ingestion: { pdf: { maxRedirects: 5, maxBytes: 104857600, connectTimeoutMs: 10000, totalTimeoutMs: 60000 } },
        visualEvidence: { pageLimit: 4, infrastructureFailureLimit: 3 },
        renderer: { dpi: 144, timeoutMs: 20000, memoryLimitMiB: 512, outputLimitBytes: 29360128,
          settings: { scale: 2, dpi: 144, background: "#ffffff", intent: "display", annotations: "disabled",
            systemFonts: false, eval: false, format: "image/png" } },
        diagnostics: { command: "npm run diagnostics", browserDetailAvailable: false },
      },
    } as SettingsSnapshot} error={null} />);

    expect(html).toContain("系统配置");
    expect(html).toContain("只读");
    expect(html).toContain("Paper Summary");
    expect(html).toContain("sol");
    expect(html).toContain("high");
    expect(html).toContain("0.145.0");
    expect(html).toContain("能力检查通过");
  });
});
