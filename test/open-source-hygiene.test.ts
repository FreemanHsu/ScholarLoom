import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("open-source repository hygiene", () => {
  it("declares the MIT license", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
      license?: string;
    };

    expect(packageJson.license).toBe("MIT");
    expect(readFileSync("LICENSE", "utf8")).toContain(
      "MIT License\n\nCopyright (c) 2026 FreemanHsu",
    );
  });

  it("does not track operator-specific home or Codex artifact paths", () => {
    const tracked = execFileSync("git", ["ls-files", "-z"])
      .toString("utf8")
      .split("\0")
      .filter(Boolean);
    const macHome = new RegExp(["", "Users", "[^/\\s`]+"].join("/"));
    const codexArtifact = new RegExp(
      ["\\.codex", "(?:attachments|generated_images|worktrees)"].join("/"),
    );
    const violations: string[] = [];

    for (const path of tracked) {
      const lines = readFileSync(path, "utf8").split("\n");
      lines.forEach((line, index) => {
        if (macHome.test(line) || codexArtifact.test(line)) {
          violations.push(`${path}:${index + 1}`);
        }
      });
    }

    expect(violations).toEqual([]);
  });
});
