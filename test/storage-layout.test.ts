import { access, chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { assertDataRootWritable, initializeDataRoot, inspectDataRootAccess, openDataRoot } from "../src/storage/layout.js";

describe("ScholarLoom data layout", () => {
  it("fails closed when the production data root has not been initialized", async () => {
    const parent = await mkdtemp(join(tmpdir(), "scholarloom-layout-"));

    expect(() => openDataRoot(join(parent, "missing"))).toThrow(/data:init/);
  });

  it("initializes the complete data layout and an independent vault Git repository", async () => {
    const parent = await mkdtemp(join(tmpdir(), "scholarloom-layout-"));
    const root = join(parent, "data");

    const layout = initializeDataRoot(root, new Date("2026-07-19T12:00:00.000Z"));

    expect(openDataRoot(root)).toEqual(layout);
    expect(JSON.parse(await readFile(layout.manifestPath, "utf8"))).toMatchObject({
      formatVersion: 1,
      createdAt: "2026-07-19T12:00:00.000Z",
    });
    await Promise.all([
      access(join(layout.vaultRoot, ".git")),
      access(join(layout.vaultRoot, "AGENTS.md")),
      access(join(layout.originalsRoot, "papers")),
      access(join(root, "state")),
      access(layout.derivedRoot),
      access(layout.repositoryRoot),
      access(layout.logsRoot),
      access(layout.tmpRoot),
    ]);
  });

  it("fails closed when an initialized root loses a required directory", async () => {
    const parent = await mkdtemp(join(tmpdir(), "scholarloom-layout-"));
    const root = join(parent, "data");
    const layout = initializeDataRoot(root);
    await rm(layout.vaultRoot, { recursive: true });

    expect(() => openDataRoot(root)).toThrow(/incomplete/);
  });

  it("fails the write preflight when an authoritative directory is read-only", async () => {
    const parent = await mkdtemp(join(tmpdir(), "scholarloom-layout-readonly-"));
    const layout = initializeDataRoot(join(parent, "data"));
    await chmod(join(layout.originalsRoot, "papers"), 0o500);

    expect(inspectDataRootAccess(layout)).toMatchObject({
      writable: false,
      unwritablePaths: ["originals/papers"],
    });
    expect(() => assertDataRootWritable(layout)).toThrow(/originals\/papers/);
  });
});
