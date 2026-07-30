import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { assertDiscussionCapability, CodexCliRunner } from "../src/adapters/codex-cli.js";
import { initializeDataRoot } from "../src/storage/layout.js";

describe("CodexCliRunner Paper Summary contract", () => {
  it("reports a newer installed Codex CLI as version-compatible before the capability canary runs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scholarloom-codex-version-"));
    const executable = join(directory, "codex");
    await writeFile(executable, `#!/bin/sh
if [ "$1" = "--version" ]; then echo "codex-cli 0.145.0"; exit 0; fi
exit 1
`, "utf8");
    await chmod(executable, 0o700);
    const originalPath = process.env.PATH;
    process.env.PATH = `${directory}:${originalPath ?? ""}`;
    try {
      expect(new CodexCliRunner().runtimeStatus()).toMatchObject({
        installedVersion: "0.145.0",
        minimumVersion: "0.144.6",
        versionStatus: "compatible",
        capabilityStatus: "not-run",
      });
    } finally { process.env.PATH = originalPath; }
  });

  it("constrains every Key Claim to one exact handle from the context manifest", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scholarloom-fake-codex-"));
    const executable = join(directory, "codex");
    await writeFile(executable, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
	const schemaPath = args[args.indexOf("--output-schema") + 1];
	const outputPath = args[args.indexOf("--output-last-message") + 1];
	if (args[args.indexOf("--model") + 1] !== "sol") process.exit(39);
	const configValues = args.flatMap((arg, index) => args[index - 1] === "-c" ? [arg] : []);
	if (!configValues.includes('model_reasoning_effort="high"')) process.exit(40);
	const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
const allowed = schema.properties.claims.items.properties.sourceHandle.enum;
if (JSON.stringify(allowed) !== JSON.stringify(["pdf-page:1", "pdf-page:2"])) process.exit(41);
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  if (!prompt.includes("claims[].sourceHandle 必须逐字等于一个 Allowed context manifest handle")) process.exit(42);
  if (!prompt.includes("没有直接页码证据的 Agent 评价不要放入 claims")) process.exit(43);
  fs.writeFileSync(outputPath, JSON.stringify({
    sections: [{ key: "overview", title: "概述", body: "正文 [pdf-page:1] [pdf-page:2]" }],
    claims: [{ voice: "paper-evidence", claim: "有证据的结论", sourceHandle: "pdf-page:1" }],
    readStatus: "read"
  }));
});
`, "utf8");
    await chmod(executable, 0o700);
    const originalPath = process.env.PATH;
    process.env.PATH = `${directory}:${originalPath ?? ""}`;
    try {
      const result = await new CodexCliRunner().runSummary({
        paperId: "paper:fixture",
        title: "Fixture",
        pages: [
          { handle: "pdf-page:1", page: 1, text: "第一页" },
          { handle: "pdf-page:2", page: 2, text: "第二页" },
        ],
      });
      expect(result.claims).toEqual([
        { voice: "paper-evidence", claim: "有证据的结论", sourceHandle: "pdf-page:1" },
      ]);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("keeps Takeaway generation out of the strict Paper answer schema", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scholarloom-fake-chat-codex-"));
    const executable = join(directory, "codex");
    await writeFile(executable, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const schemaPath = args[args.indexOf("--output-schema") + 1];
const outputPath = args[args.indexOf("--output-last-message") + 1];
const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
if (schema.properties.proposedTakeaways || schema.required.includes("proposedTakeaways")) process.exit(44);
process.stdin.resume();
process.stdin.on("end", () => fs.writeFileSync(outputPath, JSON.stringify({
  answer: "fixture answer",
  citations: []
})));
`, "utf8");
    await chmod(executable, 0o700);
    const originalPath = process.env.PATH;
    process.env.PATH = `${directory}:${originalPath ?? ""}`;
    try {
      await expect(new CodexCliRunner().runChat!({
        paperId: "paper:fixture",
        conversationId: "conversation:fixture",
        content: "question",
        sources: [{ handle: "pdf-page:1", type: "pdf", text: "evidence", locator: "p. 1" }],
      })).resolves.toMatchObject({ answer: "fixture answer" });
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("launches one strict workspace-scoped Agentic Evidence exec and normalizes JSONL activity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scholarloom-fake-agentic-codex-"));
    const workspace = join(directory, "workspace");
    const runtimeRoot = join(directory, "runtime");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));
    await mkdir(runtimeRoot);
    const executable = join(directory, "codex");
    await writeFile(executable, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
	if (args[0] !== "exec" || !args.includes("--strict-config") || args.includes("--sandbox")) process.exit(51);
	const configValues = args.flatMap((arg, index) => args[index - 1] === "-c" ? [arg] : []);
	if (args[args.indexOf("--model") + 1] !== "sol") process.exit(58);
	if (!configValues.includes('model_reasoning_effort="medium"')) process.exit(59);
	if (!configValues.includes('default_permissions="scholarloom-evidence"')) process.exit(54);
if (!configValues.some((value) => value.includes('permissions.scholarloom-evidence=') &&
  value.includes('":root"="deny"') && value.includes('":minimal"="read"') &&
  value.includes('":workspace_roots"={"."="read"}') && value.includes('network={enabled=false}'))) process.exit(55);
if (args.includes("resume") || args[args.indexOf("--cd") + 1] !== ${JSON.stringify(workspace)}) process.exit(52);
if (process.env.SCHOLARLOOM_FAKE_TOKEN !== "model-auth-sentinel") process.exit(53);
if (!configValues.some((value) => value.includes('shell_environment_policy.exclude=') &&
  value.includes('*PROXY*') && value.includes('*TOKEN*'))) process.exit(57);
if (!process.env.TMPDIR?.startsWith(${JSON.stringify(`${runtimeRoot}/`)})) process.exit(56);
const output = args[args.indexOf("--output-last-message") + 1];
process.stdout.write(JSON.stringify({ type: "turn.started" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "rg user-secret-quote paper" } }) + "\\n");
fs.writeFileSync(output, JSON.stringify({ answer: "grounded", groundingStatus: "answered",
  citations: [{ kind: "text", path: "paper/pages/page-0001.md", lineStart: 10, lineEnd: 10, quote: "evidence" }],
  usage: { status: "reported", inputTokens: 10, cachedInputTokens: 2, outputTokens: 3, totalTokens: 13 } }));
`, "utf8");
    await chmod(executable, 0o700);
    const originalPath = process.env.PATH;
    const originalHttpProxy = process.env.HTTP_PROXY;
    const originalNoProxy = process.env.NO_PROXY;
    const originalFakeToken = process.env.SCHOLARLOOM_FAKE_TOKEN;
    process.env.PATH = `${directory}:${originalPath ?? ""}`;
    process.env.HTTP_PROXY = "http://should-be-scrubbed.invalid";
    process.env.NO_PROXY = "should-also-be-scrubbed.invalid";
    process.env.SCHOLARLOOM_FAKE_TOKEN = "model-auth-sentinel";
    const activities: string[] = [];
    try {
      const result = await new CodexCliRunner({ canaries: false, runtimeRoot }).run({ attemptId: "job:1", runEpoch: 1,
        workspaceRoot: workspace, question: "question", signal: new AbortController().signal,
        onActivity(activity) { activities.push(`${activity.type}:${activity.text}`); } });
      expect(result).toMatchObject({ answer: "grounded", citations: [{ quote: "evidence" }], usage: { totalTokens: 13 } });
      expect(activities).toEqual(expect.arrayContaining([expect.stringMatching(/^started:/), expect.stringMatching(/^command:/)]));
      expect(activities.join(" ")).not.toContain("user-secret-quote");
    } finally {
      process.env.PATH = originalPath;
      restoreEnvironment("HTTP_PROXY", originalHttpProxy);
      restoreEnvironment("NO_PROXY", originalNoProxy);
      restoreEnvironment("SCHOLARLOOM_FAKE_TOKEN", originalFakeToken);
    }
  });

  it("accepts a visual citation without requiring a fabricated text quote", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scholarloom-fake-visual-codex-"));
    const workspace = join(directory, "workspace");
    const runtimeRoot = join(directory, "runtime");
    await mkdir(workspace);
    await mkdir(runtimeRoot);
    const executable = join(directory, "codex");
    await writeFile(executable, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const output = args[args.indexOf("--output-last-message") + 1];
const schema = JSON.parse(fs.readFileSync(args[args.indexOf("--output-schema") + 1], "utf8"));
const citationBranches = schema.properties.citations.items.anyOf;
if (!citationBranches.every((branch) => branch.properties.kind.type === "string")) process.exit(58);
process.stdin.resume();
process.stdin.on("end", () => fs.writeFileSync(output, JSON.stringify({
  answer: "the orange bar is tallest", groundingStatus: "answered",
  citations: [{ kind: "visual", sourceId: "artifact:pdf:fixture", page: 2,
    imageHash: "${"a".repeat(64)}", observation: "The orange bar labelled B is tallest." }],
  usage: { status: "unavailable", inputTokens: null, cachedInputTokens: null,
    outputTokens: null, totalTokens: null }
})));
`, "utf8");
    await chmod(executable, 0o700);
    const originalPath = process.env.PATH;
    process.env.PATH = `${directory}:${originalPath ?? ""}`;
    try {
      const result = await new CodexCliRunner({ canaries: false, runtimeRoot }).run({
        attemptId: "job:visual", runEpoch: 1, workspaceRoot: workspace, question: "question",
        signal: new AbortController().signal, onActivity() {},
      });
      expect(result.citations).toEqual([{ kind: "visual", sourceId: "artifact:pdf:fixture", page: 2,
        imageHash: "a".repeat(64), observation: "The orange bar labelled B is tallest." }]);
    } finally { process.env.PATH = originalPath; }
  });

  it("surfaces a sanitized Codex JSONL failure code when stderr is empty", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scholarloom-fake-jsonl-failure-"));
    const workspace = join(directory, "workspace");
    const runtimeRoot = join(directory, "runtime");
    await mkdir(workspace);
    await mkdir(runtimeRoot);
    const executable = join(directory, "codex");
    await writeFile(executable, `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ type: "error", message: JSON.stringify({ error: {
    code: "invalid_json_schema", message: "sensitive raw provider detail" } }) }) + "\\n");
  process.exit(1);
});
`, "utf8");
    await chmod(executable, 0o700);
    const originalPath = process.env.PATH;
    process.env.PATH = `${directory}:${originalPath ?? ""}`;
    try {
      let failure = "";
      try {
        await new CodexCliRunner({ canaries: false, runtimeRoot }).run({ attemptId: "job:jsonl-failure", runEpoch: 1,
          workspaceRoot: workspace, question: "question", signal: new AbortController().signal, onActivity() {} });
      } catch (error) { failure = error instanceof Error ? error.message : String(error); }
      expect(failure).toBe("agentic-codex-failed:1:invalid-json-schema");
      expect(failure).not.toContain("sensitive raw provider detail");
    } finally { process.env.PATH = originalPath; }
  });

  it("registers the two-tool visual shim over stdio in the same strict exec", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scholarloom-fake-visual-mcp-"));
    const layout = initializeDataRoot(join(directory, "data"));
    const workspace = join(directory, "workspace");
    await mkdir(workspace);
    const executable = join(directory, "codex");
    await writeFile(executable, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const configs = args.flatMap((arg, index) => args[index - 1] === "-c" ? [arg] : []);
if (!configs.includes('approval_policy="never"')) process.exit(61);
const visual = configs.find((value) => value.startsWith("mcp_servers.visual="));
if (!visual || !visual.includes("visual-evidence-mcp-server.ts") || !visual.includes("command=")) process.exit(62);
if (visual.includes("http") || visual.includes("filesystem") || visual.includes("search")) process.exit(63);
const binding = process.env.SCHOLARLOOM_VISUAL_BINDING_FILE;
if (!binding || !fs.existsSync(binding)) process.exit(64);
const parsed = JSON.parse(fs.readFileSync(binding, "utf8"));
if (parsed.attemptId !== "job:visual-mcp" || parsed.runEpoch !== 7) process.exit(65);
const output = args[args.indexOf("--output-last-message") + 1];
process.stdin.resume();
process.stdin.on("end", () => fs.writeFileSync(output, JSON.stringify({ answer: "insufficient",
  groundingStatus: "insufficient_evidence", citations: [], usage: { status: "unavailable",
  inputTokens: null, cachedInputTokens: null, outputTokens: null, totalTokens: null } })));
`, "utf8");
    await chmod(executable, 0o700);
    const originalPath = process.env.PATH;
    process.env.PATH = `${directory}:${originalPath ?? ""}`;
    try {
      await expect(new CodexCliRunner({ canaries: false, runtimeRoot: layout.tmpRoot, storageLayout: layout }).run({
        attemptId: "job:visual-mcp", runEpoch: 7, workspaceRoot: workspace, question: "question",
        signal: new AbortController().signal, onActivity() {},
      })).resolves.toMatchObject({ groundingStatus: "insufficient_evidence" });
      await expect(readdir(join(layout.tmpRoot, "visual-bindings"))).resolves.toEqual([]);
    } finally { process.env.PATH = originalPath; }
  });

  it("accepts a newer Codex CLI after running the launch canary through the same native permission profile", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scholarloom-sandbox-codex-path-"));
    const workspace = join(directory, "workspace");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));
    await writeFile(join(workspace, "MANIFEST.json"), "{}", "utf8");
    const codex = join(directory, "codex");
    const canaryLog = join(directory, "canary.log");
    await writeFile(codex, `#!/bin/sh
	if [ "$1" = "--version" ]; then echo "codex-cli 0.145.0"; exit 0; fi
if [ "$1" = "exec" ]; then echo --strict-config --json --output-schema; exit 0; fi
if [ "$1" = "sandbox" ]; then
  printf '%s\\n' "$@" > ${JSON.stringify(canaryLog)}
  case " $* " in *" -P scholarloom-evidence "*) ;; *) exit 72 ;; esac
  case " $* " in *" default_permissions=\\\"scholarloom-evidence\\\" "*) ;; *) exit 73 ;; esac
  case " $* " in *" permissions.scholarloom-evidence="*) ;; *) exit 74 ;; esac
  case " $* " in *" shell_environment_policy.inherit="*) ;; *) exit 75 ;; esac
  case " $* " in *" shell_environment_policy.exclude="*) ;; *) exit 76 ;; esac
  case " $* " in *"MANIFEST.json"*) ;; *) exit 77 ;; esac
  case " $* " in *"parent-write-canary"*) ;; *) exit 78 ;; esac
  case " $* " in *"127.0.0.1"*) ;; *) exit 79 ;; esac
  case " $* " in *"example.com"*) ;; *) exit 80 ;; esac
  exit 0
fi
exit 70
`, "utf8");
    await chmod(codex, 0o700);
    const originalPath = process.env.PATH;
    process.env.PATH = `${directory}:${originalPath ?? ""}`;
    try {
      await expect(assertDiscussionCapability({ workspaceRoot: workspace, runDirectory: directory })).resolves.toBeUndefined();
      await expect(readFile(canaryLog, "utf8")).resolves.toMatch(/sandbox[\s\S]*scholarloom-evidence/);
    } finally { process.env.PATH = originalPath; }
  });

  it("cleans the Attempt run directory when the Codex executable is unavailable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scholarloom-missing-codex-"));
    const workspace = join(directory, "workspace");
    const runtimeRoot = join(directory, "runtime");
    await Promise.all([mkdir(workspace), mkdir(runtimeRoot)]);
    const originalPath = process.env.PATH;
    process.env.PATH = "";
    try {
      await expect(new CodexCliRunner({ canaries: false, runtimeRoot }).run({
        attemptId: "job:missing", runEpoch: 1, workspaceRoot: workspace, question: "question",
        signal: new AbortController().signal, onActivity() {},
      })).rejects.toThrow("discussion-capability-executable-unavailable:codex");
      await expect(readdir(runtimeRoot)).resolves.toEqual([]);
    } finally { process.env.PATH = originalPath; }
  });

  it("fails closed when the private runtime root is accessible by another account", async () => {
    const runtimeRoot = await mkdtemp(join(process.cwd(), ".scholarloom-shared-runtime-"));
    await chmod(runtimeRoot, 0o750);
    try {
      await expect(new CodexCliRunner({ runtimeRoot }).run({
        attemptId: "job:shared", runEpoch: 1, workspaceRoot: process.cwd(), question: "question",
        signal: new AbortController().signal, onActivity() {},
      })).rejects.toThrow("discussion-runtime-root-permissions");
    } finally { await rm(runtimeRoot, { recursive: true, force: true }); }
  });
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
