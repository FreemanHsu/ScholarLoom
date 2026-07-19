import { access, mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { migrateLegacyData } from "../src/storage/data-operations.js";

describe("legacy repository data migration", () => {
  it("copies personal knowledge and runtime data into the external layout without changing the source", async () => {
    const parent = await mkdtemp(join(tmpdir(), "scholarloom-migrate-"));
    const repository = join(parent, "ScholarLoom");
    await mkdir(join(repository, ".scholarloom", "assets", "papers", "aa"), { recursive: true });
    await mkdir(join(repository, ".scholarloom", "assets", "derived"), { recursive: true });
    await mkdir(join(repository, "library", "papers", "fixture"), { recursive: true });
    await writeFile(join(repository, ".scholarloom", "assets", "papers", "aa", "paper.pdf"), "pdf bytes");
    await writeFile(join(repository, ".scholarloom", "assets", "derived", "result.json"), "{}\n");
    await writeFile(join(repository, "HOME.md"), "# Home\n");
    await writeFile(join(repository, "library", "papers", "fixture", "paper.md"), "# Paper\n");
    await writeFile(join(repository, "AGENTS.md"), "legacy knowledge guide\n");
    const legacyDatabasePath = join(repository, ".scholarloom", "scholarloom.sqlite3");
    const database = new Database(legacyDatabasePath);
    const markdownHash = createHash("sha256").update("# Paper\n").digest("hex");
    database.exec("CREATE TABLE artifacts(storage_ref TEXT NOT NULL); INSERT INTO artifacts VALUES ('papers/aa/paper.pdf');");
    database.exec("CREATE TABLE summary_revisions(markdown_path TEXT NOT NULL,markdown_hash TEXT NOT NULL)");
    database.prepare("INSERT INTO summary_revisions VALUES (?,?)").run("library/papers/fixture/paper.md", markdownHash);
    database.close();
    const target = join(parent, "ScholarLoomData");

    const layout = await migrateLegacyData(repository, target);

    expect(await readFile(join(layout.vaultRoot, "HOME.md"), "utf8")).toBe("# Home\n");
    expect(await readFile(join(layout.vaultRoot, "library", "papers", "fixture", "paper.md"), "utf8")).toBe("# Paper\n");
    const hash = createHash("sha256").update("pdf bytes").digest("hex");
    const storedPdf = join(layout.originalsRoot, "papers", hash.slice(0, 2), `${hash}.pdf`);
    expect(await readFile(storedPdf, "utf8")).toBe("pdf bytes");
    expect((await stat(storedPdf)).mode & 0o222).toBe(0);
    await access(join(layout.vaultRoot, ".git"));
    const migrated = new Database(layout.databasePath, { readonly: true });
    expect(migrated.prepare("SELECT storage_ref FROM artifacts").pluck().get()).toBe(`originals/papers/${hash.slice(0, 2)}/${hash}.pdf`);
    migrated.close();
    expect(await readFile(join(repository, ".scholarloom", "assets", "papers", "aa", "paper.pdf"), "utf8")).toBe("pdf bytes");
    expect((await stat(join(repository, ".scholarloom", "assets", "papers", "aa", "paper.pdf"))).mode & 0o222).toBe(0);
  });

  it.each([
    { kind: "database Markdown path", markdown: "# Paper\n", path: "library/../../outside.md", error: /Unsafe migrated Markdown/ },
    { kind: "Wikilink", markdown: "[[knowledge/../../../outside]]\n", path: null, error: /Unsafe Wikilink/ },
  ])("rejects nested traversal in a migrated $kind", async ({ markdown, path, error }) => {
    const parent = await mkdtemp(join(tmpdir(), "scholarloom-migrate-unsafe-"));
    const repository = join(parent, "ScholarLoom");
    await mkdir(join(repository, ".scholarloom"), { recursive: true });
    await mkdir(join(repository, "library"), { recursive: true });
    await writeFile(join(repository, "library", "note.md"), markdown);
    const database = new Database(join(repository, ".scholarloom", "scholarloom.sqlite3"));
    database.exec("CREATE TABLE artifacts(storage_ref TEXT NOT NULL)");
    if (path) {
      database.exec("CREATE TABLE summary_revisions(markdown_path TEXT NOT NULL,markdown_hash TEXT NOT NULL)");
      database.prepare("INSERT INTO summary_revisions VALUES (?, '')").run(path);
    }
    database.close();

    await expect(migrateLegacyData(repository, join(parent, "data"))).rejects.toThrow(error);
  });
});
