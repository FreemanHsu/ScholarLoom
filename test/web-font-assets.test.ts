import { readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";

import { describe, expect, it } from "vitest";

const webRoot = join(process.cwd(), "src", "web");

function webSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return webSourceFiles(path);
    return [".css", ".ts", ".tsx"].includes(extname(entry.name)) ? [path] : [];
  });
}

describe("self-hosted web fonts", () => {
  it("does not depend on Google Fonts at runtime", () => {
    const source = webSourceFiles(webRoot)
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");

    expect(source).not.toMatch(/fonts\.(?:googleapis|gstatic)\.com/);
  });

  it("loads every production font face from build-managed assets", () => {
    const entrypoint = readFileSync(join(webRoot, "main.tsx"), "utf8");

    expect(entrypoint).toContain('import "@fontsource/dm-sans/400.css";');
    expect(entrypoint).toContain('import "@fontsource/dm-sans/500.css";');
    expect(entrypoint).toContain('import "@fontsource/dm-sans/600.css";');
    expect(entrypoint).toContain('import "@fontsource/newsreader/500.css";');
    expect(entrypoint).toContain('import "@fontsource/newsreader/500-italic.css";');
  });
});
