import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { createSnapshot, restoreSnapshot, verifySnapshot } from "../src/storage/data-operations.js";
import { acquireRuntimeLock } from "../src/storage/runtime-lock.js";
import { initializeDataRoot, openDataRoot } from "../src/storage/layout.js";
import { ImportStore } from "../src/storage/import-store.js";

describe("ScholarLoom data snapshots", () => {
  it("backs up authoritative files and a consistent SQLite snapshot while excluding rebuildable data", async () => {
    const parent = await mkdtemp(join(tmpdir(), "scholarloom-backup-"));
    const layout = initializeDataRoot(join(parent, "data"), new Date("2026-07-19T12:00:00.000Z"));
    await writeFile(join(layout.vaultRoot, "HOME.md"), "# Durable knowledge\n");
    await writeFile(join(layout.originalsRoot, "papers", "paper.pdf"), "fixed pdf bytes");
    await writeFile(join(layout.derivedRoot, "rebuildable.json"), "{}\n");
    const database = new Database(layout.databasePath);
    database.pragma("journal_mode = WAL");
    database.exec("CREATE TABLE durable(value TEXT NOT NULL); INSERT INTO durable VALUES ('kept');");
    database.close();
    const snapshotRoot = join(parent, "snapshot");

    await createSnapshot(layout, snapshotRoot, { now: new Date("2026-07-20T03:00:00.000Z") });
    const report = verifySnapshot(snapshotRoot);

    expect(report).toMatchObject({ healthy: true, sqliteIntegrity: ["ok"] });
    expect(verifySnapshot(snapshotRoot)).toMatchObject({ healthy: true, errors: [] });
    expect(await readFile(join(snapshotRoot, "vault", "HOME.md"), "utf8")).toBe("# Durable knowledge\n");
    await expect(readFile(join(snapshotRoot, "derived", "rebuildable.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(snapshotRoot, "state", "scholarloom.sqlite3-wal"))).rejects.toMatchObject({ code: "ENOENT" });
    const restoredDatabase = new Database(join(snapshotRoot, "state", "scholarloom.sqlite3"), { readonly: true });
    expect(restoredDatabase.prepare("SELECT value FROM durable").pluck().get()).toBe("kept");
    restoredDatabase.close();
  });

  it("optionally includes derived artifacts for faster recovery", async () => {
    const parent = await mkdtemp(join(tmpdir(), "scholarloom-derived-backup-"));
    const layout = initializeDataRoot(join(parent, "data"));
    await writeFile(join(layout.derivedRoot, "extraction.json"), "{}\n");
    const database = new Database(layout.databasePath);
    database.exec("CREATE TABLE durable(value TEXT NOT NULL)");
    database.close();
    const snapshotRoot = join(parent, "snapshot");

    await createSnapshot(layout, snapshotRoot, { includeDerived: true });
    const restored = restoreSnapshot(snapshotRoot, join(parent, "restored"));

    expect(await readFile(join(snapshotRoot, "derived", "extraction.json"), "utf8")).toBe("{}\n");
    expect(await readFile(join(restored.derivedRoot, "extraction.json"), "utf8")).toBe("{}\n");
    expect(verifySnapshot(snapshotRoot).healthy).toBe(true);
  });

  it("restores only into a new data root and leaves the snapshot reusable", async () => {
    const parent = await mkdtemp(join(tmpdir(), "scholarloom-restore-"));
    const layout = initializeDataRoot(join(parent, "data"));
    await writeFile(join(layout.vaultRoot, "HOME.md"), "# Restored\n");
    const database = new Database(layout.databasePath);
    database.exec("CREATE TABLE durable(value TEXT NOT NULL); INSERT INTO durable VALUES ('restored');");
    database.close();
    const snapshotRoot = join(parent, "snapshot");
    await createSnapshot(layout, snapshotRoot);
    const restoredRoot = join(parent, "restored-data");

    const restored = restoreSnapshot(snapshotRoot, restoredRoot);

    expect(openDataRoot(restoredRoot)).toEqual(restored);
    expect(await readFile(join(restored.vaultRoot, "HOME.md"), "utf8")).toBe("# Restored\n");
    expect(verifySnapshot(snapshotRoot).healthy).toBe(true);
    expect(() => restoreSnapshot(snapshotRoot, restoredRoot)).toThrow(/already exists/);
  });

  it("refuses to snapshot while ScholarLoom holds the data write lock", async () => {
    const parent = await mkdtemp(join(tmpdir(), "scholarloom-locked-backup-"));
    const layout = initializeDataRoot(join(parent, "data"));
    const database = new Database(layout.databasePath);
    database.exec("CREATE TABLE durable(value TEXT NOT NULL)");
    database.close();
    const release = acquireRuntimeLock(layout);

    await expect(createSnapshot(layout, join(parent, "snapshot"))).rejects.toThrow(/still running/);
    release();
  });

  it("keeps a default restore healthy when only rebuildable derived artifacts are absent", async () => {
    const parent = await mkdtemp(join(tmpdir(), "scholarloom-derived-restore-"));
    const layout = initializeDataRoot(join(parent, "data"));
    ImportStore.open(layout).close();
    await writeFile(join(layout.derivedRoot, "fixture.json"), "{}\n");
    const database = new Database(layout.databasePath);
    database.prepare(`INSERT INTO artifacts
      (id,artifact_type,content_hash,storage_ref,media_type,byte_size,created_by_kind,retention_class,integrity_status,created_at)
      VALUES ('artifact:derived','document-extraction','hash','derived/fixture.json','application/json',3,'job-run','rebuildable','verified','2026-07-19T00:00:00.000Z')`).run();
    database.close();
    const snapshotRoot = join(parent, "snapshot");
    await createSnapshot(layout, snapshotRoot);
    const restored = restoreSnapshot(snapshotRoot, join(parent, "restored"));

    const store = ImportStore.open(restored);
    const diagnostics = store.diagnostics();
    store.close();

    expect(diagnostics).toMatchObject({ healthy: true, missingArtifacts: [], missingRebuildableArtifacts: ["derived/fixture.json"] });
  });
});
