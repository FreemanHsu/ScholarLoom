import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createCuratedKnowledgeMcpLaunch } from "../src/agent/curated-knowledge-mcp-launch.js";

describe("curated knowledge MCP launch", () => {
  it("fails closed when initialize omits the negotiated MCP capability fields", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scholarloom-malformed-mcp-"));
    const serverPath = join(directory, "malformed-server.js");
    await writeFile(serverPath, `
import readline from "node:readline";
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === 1) {
    process.stdout.write(JSON.stringify({ id: 1, result: {} }) + "\\n");
  } else if (request.id === 2) {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [
      { name: "open_curated_source" },
      { name: "search_curated_knowledge" },
      { name: "verify_curated_citation" }
    ] } }) + "\\n");
  }
});
`, "utf8");

    const launch = createCuratedKnowledgeMcpLaunch(serverPath, join(directory, "binding.json"));
    await expect(launch.assertAvailable(new AbortController().signal))
      .rejects.toThrow("curated-mcp-capability-unavailable");
  });

  it.each([
    ["wrong server identity", {
      jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} },
        serverInfo: { name: "impostor", version: "1" } },
    }],
    ["missing tools capability", {
      jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05", capabilities: {},
        serverInfo: { name: "scholarloom-curated-knowledge", version: "1" } },
    }],
  ])("fails closed for %s", async (_label, initializeResponse) => {
    const directory = await mkdtemp(join(tmpdir(), "scholarloom-wrong-mcp-"));
    const serverPath = join(directory, "wrong-server.js");
    await writeFile(serverPath, `
import readline from "node:readline";
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === 1) process.stdout.write(${JSON.stringify(JSON.stringify(initializeResponse))} + "\\n");
});
`, "utf8");

    const launch = createCuratedKnowledgeMcpLaunch(serverPath, join(directory, "binding.json"));
    await expect(launch.assertAvailable(new AbortController().signal))
      .rejects.toThrow("curated-mcp-capability-unavailable");
  });
});
