import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

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
      .filter((path) => Boolean(path) && existsSync(path));
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

  it("keeps durable documentation and browser tests in their canonical directories", () => {
    const tracked = execFileSync("git", ["ls-files", "-z"])
      .toString("utf8")
      .split("\0")
      .filter((path) => Boolean(path) && existsSync(path));
    const trackedMarkdown = tracked.filter((path) => path.endsWith(".md"));
    const ephemeralRootDocs = trackedMarkdown.filter(
      (path) => !path.includes("/") && /^design-qa(?:-papers)?\.md$/.test(path),
    );
    const nonDurableDocumentation = trackedMarkdown.flatMap((path) =>
      readFileSync(path, "utf8")
        .split("\n")
        .flatMap((line, index) =>
          /(?:\.playwright-cli|output\/playwright)\//.test(line) ||
          (path.startsWith("docs/archive/reviews/") &&
            /\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/i.test(line))
            ? [`${path}:${index + 1}`]
            : [],
        ),
    );

    expect(ephemeralRootDocs).toEqual([]);
    expect(tracked).toContain("docs/README.md");
    expect(tracked.some((path) => path.startsWith("browser-test/"))).toBe(false);
    expect(tracked).toContain("test/browser/pdf-native-viewer.pw.mjs");
    expect(nonDurableDocumentation).toEqual([]);
  });

  it("keeps relative Markdown links resolvable", () => {
    const trackedMarkdown = execFileSync("git", ["ls-files", "-z", "*.md"])
      .toString("utf8")
      .split("\0")
      .filter((path) => Boolean(path) && existsSync(path));
    const brokenLinks: string[] = [];

    for (const path of trackedMarkdown) {
      const contents = readFileSync(path, "utf8");
      for (const match of contents.matchAll(/\]\(([^)]+)\)/g)) {
        const rawTarget = match[1]?.trim();
        if (!rawTarget) continue;
        if (/^(?:#|[a-z][a-z0-9+.-]*:|\/\/)/i.test(rawTarget)) continue;
        const target = (rawTarget.split("#", 1)[0] ?? "").replace(/^<|>$/g, "");
        if (!target) continue;
        if (!existsSync(resolve(dirname(path), decodeURIComponent(target)))) {
          const line = contents.slice(0, match.index).split("\n").length;
          brokenLinks.push(`${path}:${line} -> ${target}`);
        }
      }
    }

    expect(brokenLinks).toEqual([]);
  });
});
