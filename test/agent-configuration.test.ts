import { describe, expect, it } from "vitest";

import {
  AGENT_CONFIGURATION_VERSION,
  getAgentConfiguration,
  listAgentConfigurations,
} from "../src/agent/agent-configuration.js";

describe("Agent configuration registry", () => {
  it("defines the model and thinking budget used by every ScholarLoom Agent task", () => {
    expect(AGENT_CONFIGURATION_VERSION).toBe("agent-configuration.v3");
    expect(listAgentConfigurations().map(({ taskKind, model, reasoningEffort }) =>
      ({ taskKind, model, reasoningEffort }))).toEqual([
      { taskKind: "paper-summary", model: "gpt-5.6-sol", reasoningEffort: "high" },
      { taskKind: "agentic-evidence", model: "gpt-5.6-sol", reasoningEffort: "medium" },
      { taskKind: "entry-answer", model: "gpt-5.6-sol", reasoningEffort: "medium" },
      { taskKind: "takeaway-distillation", model: "gpt-5.6-sol", reasoningEffort: "medium" },
      { taskKind: "paper-chat", model: "gpt-5.6-sol", reasoningEffort: "medium" },
    ]);
    expect(getAgentConfiguration("paper-summary")).toMatchObject({
      displayName: "Paper Summary",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
    });
  });
});
