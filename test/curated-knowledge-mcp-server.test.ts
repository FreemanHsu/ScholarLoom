import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { describe, expect, it } from "vitest";

import { initializeDataRoot } from "../src/storage/layout.js";

describe("curated knowledge stdio MCP", () => {
  it("exposes only the invocation-local search/open/verify contract and persists actual usage state", async () => {
    const root = await mkdtemp(join(tmpdir(), "scholarloom-curated-mcp-"));
    const layout = initializeDataRoot(join(root, "data"));
    const binding = join(layout.tmpRoot, "curated-binding.json");
    const statePath = join(layout.tmpRoot, "curated-state.json");
    await writeFile(binding, JSON.stringify({ dataRoot: layout.root, statePath }), { mode: 0o600 });
    await chmod(binding, 0o600);
    const child = spawn(process.execPath,
      ["--import", "tsx", join(process.cwd(), "src/agent/curated-knowledge-mcp-server.ts")], {
        cwd: process.cwd(), env: { ...process.env, SCHOLARLOOM_CURATED_BINDING_FILE: binding },
        stdio: ["pipe", "pipe", "pipe"],
      });
    const iterator = createInterface({ input: child.stdout, crlfDelay: Infinity })[Symbol.asyncIterator]();
    const request = async (value: object) => {
      child.stdin.write(`${JSON.stringify(value)}\n`);
      const next = await iterator.next();
      if (next.done) throw new Error("curated-mcp-closed");
      return JSON.parse(next.value) as any;
    };

    const initialized = await request({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
    expect(initialized.result.serverInfo.name).toBe("scholarloom-curated-knowledge");
    const listed = await request({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    expect(listed.result.tools.map((tool: any) => tool.name)).toEqual([
      "search_curated_knowledge", "open_curated_source", "verify_curated_citation",
    ]);
    const searched = await request({ jsonrpc: "2.0", id: 3, method: "tools/call", params: {
      name: "search_curated_knowledge", arguments: { query: "no fixture matches" } } });
    expect(JSON.parse(searched.result.content[0].text).results).toEqual([]);
    expect(JSON.parse(await readFile(statePath, "utf8"))).toMatchObject({
      summary: { searched: true, queryCount: 1, candidateCount: 0 }, verified: [],
    });
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => child.once("close", () => resolve()));
  });
});
