import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const TSX_LOADER_PATH = createRequire(import.meta.url).resolve("tsx");
const REQUIRED_TOOLS = [
  "open_curated_source",
  "search_curated_knowledge",
  "verify_curated_citation",
] as const;

export type CuratedKnowledgeMcpLaunch = {
  codexConfig: string;
  assertAvailable(signal: AbortSignal): Promise<void>;
};

export function createCuratedKnowledgeMcpLaunch(serverPath: string, bindingPath: string): CuratedKnowledgeMcpLaunch {
  const command = process.execPath;
  const args = ["--import", TSX_LOADER_PATH, serverPath];
  const environment = { SCHOLARLOOM_CURATED_BINDING_FILE: bindingPath };
  return {
    codexConfig: `mcp_servers.curated={command=${JSON.stringify(command)},args=${JSON.stringify(args)},` +
      `env={SCHOLARLOOM_CURATED_BINDING_FILE=${JSON.stringify(bindingPath)}},` +
      "startup_timeout_sec=10,tool_timeout_sec=30}",
    assertAvailable(signal) {
      return assertMcpToolsAvailable({ command, args, environment, signal });
    },
  };
}

function assertMcpToolsAvailable(input: { command: string; args: string[];
  environment: Record<string, string>; signal: AbortSignal }): Promise<void> {
  if (input.signal.aborted) return Promise.reject(input.signal.reason ?? new Error("knowledge-answer-aborted"));
  return new Promise((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      cwd: process.cwd(),
      env: { ...process.env, ...input.environment },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let settled = false;
    let stdout = "";
    let phase: "initialize" | "tools" = "initialize";
    const timeout = setTimeout(() => fail(new Error("curated-mcp-capability-unavailable")), 10_000);
    timeout.unref();

    const cleanup = () => {
      clearTimeout(timeout);
      input.signal.removeEventListener("abort", onAbort);
      child.stdout.removeAllListeners();
      child.stderr.removeAllListeners();
      child.removeAllListeners();
      if (!child.killed) child.kill("SIGTERM");
    };
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const fail = (error: unknown) => finish(() => reject(input.signal.aborted
      ? input.signal.reason ?? new Error("knowledge-answer-aborted")
      : error instanceof Error && error.message === "curated-mcp-capability-unavailable"
        ? error : new Error("curated-mcp-capability-unavailable")));
    const onAbort = () => fail(input.signal.reason ?? new Error("knowledge-answer-aborted"));
    input.signal.addEventListener("abort", onAbort, { once: true });

    child.once("error", fail);
    child.once("exit", () => fail(new Error("curated-mcp-capability-unavailable")));
    child.stderr.resume();
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      const lines = stdout.split("\n");
      stdout = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let response: { jsonrpc?: unknown; id?: unknown; error?: unknown; result?: unknown };
        try { response = JSON.parse(line) as typeof response; }
        catch { fail(new Error("curated-mcp-capability-unavailable")); return; }
        if (phase === "initialize" && response.id === 1) {
          if (!validInitializeResponse(response)) {
            fail(new Error("curated-mcp-capability-unavailable"));
            return;
          }
          phase = "tools";
          child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
          child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
        } else if (phase === "tools" && response.id === 2) {
          const result = response.result as { tools?: Array<{ name?: unknown }> } | undefined;
          const names = result?.tools?.map((tool) => tool.name).filter((name): name is string => typeof name === "string").sort();
          if (response.jsonrpc !== "2.0" || response.error || !Array.isArray(result?.tools) ||
              JSON.stringify(names) !== JSON.stringify([...REQUIRED_TOOLS])) {
            fail(new Error("curated-mcp-capability-unavailable"));
            return;
          }
          finish(resolve);
        }
      }
    });
    child.stdin.on("error", fail);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "scholarloom", version: "1" },
    } })}\n`);
  });
}

function validInitializeResponse(response: { jsonrpc?: unknown; error?: unknown; result?: unknown }): boolean {
  if (response.jsonrpc !== "2.0" || response.error || !plainObject(response.result)) return false;
  const result = response.result;
  return result.protocolVersion === "2024-11-05" && plainObject(result.capabilities) &&
    plainObject(result.capabilities.tools) && plainObject(result.serverInfo) &&
    result.serverInfo.name === "scholarloom-curated-knowledge" && result.serverInfo.version === "1";
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
