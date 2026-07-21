import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CodexCliRunner } from "../src/adapters/codex-cli.js";

describe("CodexCliRunner Paper Summary contract", () => {
  it("constrains every Key Claim to one exact handle from the context manifest", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scholarloom-fake-codex-"));
    const executable = join(directory, "codex");
    await writeFile(executable, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const schemaPath = args[args.indexOf("--output-schema") + 1];
const outputPath = args[args.indexOf("--output-last-message") + 1];
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

  it("emits a Codex-compatible strict schema for optional Takeaway quotes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scholarloom-fake-chat-codex-"));
    const executable = join(directory, "codex");
    await writeFile(executable, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const schemaPath = args[args.indexOf("--output-schema") + 1];
const outputPath = args[args.indexOf("--output-last-message") + 1];
const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
const proposal = schema.properties.proposedTakeaways.items;
const keys = Object.keys(proposal.properties).sort();
const required = [...proposal.required].sort();
if (JSON.stringify(required) !== JSON.stringify(keys)) {
  process.stderr.write("Invalid schema for response_format: 'required' must include every key in properties. Missing 'quote'.");
  process.exit(44);
}
if (JSON.stringify(proposal.properties.quote.type) !== JSON.stringify(["string", "null"])) process.exit(45);
process.stdin.resume();
process.stdin.on("end", () => fs.writeFileSync(outputPath, JSON.stringify({
  answer: "fixture answer",
  citations: [],
  proposedTakeaways: [{ claim: "fixture claim", sourceHandles: ["pdf-page:1"], quote: null }]
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
    await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));
    const executable = join(directory, "codex");
    await writeFile(executable, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] !== "exec" || !args.includes("--strict-config") || args[args.indexOf("--sandbox") + 1] !== "read-only") process.exit(51);
if (args.includes("resume") || args[args.indexOf("--cd") + 1] !== ${JSON.stringify(workspace)}) process.exit(52);
if (process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.ALL_PROXY || process.env.http_proxy || process.env.https_proxy) process.exit(53);
const output = args[args.indexOf("--output-last-message") + 1];
process.stdout.write(JSON.stringify({ type: "turn.started" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "rg evidence paper" } }) + "\\n");
fs.writeFileSync(output, JSON.stringify({ answer: "grounded", groundingStatus: "answered",
  citations: [{ path: "paper/pages/page-0001.md", lineStart: 10, lineEnd: 10, quote: "evidence" }],
  proposedTakeaways: [], usage: { status: "reported", inputTokens: 10, cachedInputTokens: 2, outputTokens: 3, totalTokens: 13 } }));
`, "utf8");
    await chmod(executable, 0o700);
    const originalPath = process.env.PATH;
    process.env.PATH = `${directory}:${originalPath ?? ""}`;
    process.env.HTTP_PROXY = "http://should-be-scrubbed.invalid";
    const activities: string[] = [];
    try {
      const result = await new CodexCliRunner({ canaries: false, outerSandbox: false }).run({ attemptId: "job:1", runEpoch: 1,
        workspaceRoot: workspace, question: "question", signal: new AbortController().signal,
        onActivity(activity) { activities.push(`${activity.type}:${activity.text}`); } });
      expect(result).toMatchObject({ answer: "grounded", citations: [{ quote: "evidence" }], usage: { totalTokens: 13 } });
      expect(activities).toEqual(expect.arrayContaining([expect.stringMatching(/^started:/), expect.stringMatching(/^command:/)]));
    } finally {
      process.env.PATH = originalPath;
      delete process.env.HTTP_PROXY;
    }
  });
});
