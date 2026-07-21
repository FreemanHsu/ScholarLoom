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
});
