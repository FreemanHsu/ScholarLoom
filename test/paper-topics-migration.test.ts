import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { ImportStore } from "../src/storage/import-store.js";
import { initializeDataRoot, openDataRoot } from "../src/storage/layout.js";
import {
  createPaperTopicsPlan,
  inventoryPaperTopics,
  migratePaperTopicsCopy,
  paperTopicsSchemas,
} from "../src/storage/paper-topics-migration.js";

const NOW = new Date("2026-07-31T12:00:00.000Z");

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function paperMarkdown(topics: string, canonical = ""): string {
  return `---
id: paper:fixture:2026:legacy-topics
type: paper
title: Legacy Topics Fixture
authors:
  - Ada Fixture
year: 2026
external_identities: {}
${canonical}${topics}
updated: 2026-07-31
---

# Legacy Topics Fixture

## Notes

Preserve this body byte-for-byte.
`;
}

async function legacyRoot(topics: string, withDirection = false) {
  const parent = await mkdtemp(join(tmpdir(), "scholarloom-paper-topics-"));
  const layout = initializeDataRoot(join(parent, "source"), NOW);
  const store = ImportStore.open(layout, null, () => NOW);
  if (withDirection) {
    store.createResearchDirection({
      id: "topic:legacy-direction",
      title: "Legacy Direction",
      aliases: [],
      scope: "Studies explicitly mapped legacy research questions.",
    }, "create-legacy-direction");
  }
  store.close();
  const relativePath = "library/papers/legacy-topics/paper.md";
  const path = join(layout.vaultRoot, relativePath);
  await mkdir(join(layout.vaultRoot, "library", "papers", "legacy-topics"), { recursive: true });
  const markdown = paperMarkdown(topics);
  await writeFile(path, markdown);
  const database = new Database(layout.databasePath);
  database.pragma("foreign_keys = ON");
  database.prepare(`INSERT INTO papers
    (id,title,acquisition_status,origin,lifecycle_status,created_at,updated_at)
    VALUES ('paper:fixture:2026:legacy-topics','Legacy Topics Fixture','ingested',
      'manual-import','active',?,?)`).run(NOW.toISOString(), NOW.toISOString());
  database.prepare(`INSERT INTO paper_manifests(paper_id,markdown_path,markdown_hash,updated_at)
    VALUES ('paper:fixture:2026:legacy-topics',?,?,?)`).run(
      relativePath, hash(markdown), NOW.toISOString(),
    );
  database.close();
  const rebuild = ImportStore.open(layout, null, () => NOW);
  rebuild.rebuildPaperCatalog();
  rebuild.close();
  return { parent, layout, path, relativePath, markdown };
}

describe("legacy Paper topics migration", () => {
  it("proves an all-empty inventory is a copy-first no-op without adding canonical keys", async () => {
    const fixture = await legacyRoot("topics: []\n");
    const inventory = inventoryPaperTopics(fixture.layout, { now: NOW, runtimeObserved: "stopped" });
    expect(inventory.counts["empty-sequence"]).toBe(1);
    expect(inventory.papers[0]).toMatchObject({
      relativePath: fixture.relativePath,
      canonical: { aliasesPresent: false, directionsPresent: false },
    });
    const plan = createPaperTopicsPlan(fixture.layout, inventory, {
      schema: paperTopicsSchemas().mapping,
      mappings: [],
    }, NOW);
    expect(plan).toMatchObject({ executable: true, papers: [{ action: "unchanged" }] });

    const result = await migratePaperTopicsCopy(
      fixture.layout,
      plan,
      join(fixture.parent, "destination"),
      NOW,
    );

    expect(result).toMatchObject({
      noOp: true,
      counts: { changed: 0, unchanged: 1, succeeded: 0, failed: 0, conflicted: 0 },
      verification: { healthy: true },
      cutoverAuthorized: false,
    });
    expect(await readFile(fixture.path, "utf8")).toBe(fixture.markdown);
    const copied = await readFile(join(fixture.parent, "destination", "vault", fixture.relativePath), "utf8");
    expect(copied).toBe(fixture.markdown);
    expect(copied).not.toContain("directions:");
    expect(copied).not.toContain("aliases:");
  });

  it("requires explicit per-item mapping and preserves legacy topics after KWR migration", async () => {
    const fixture = await legacyRoot("topics:\n  - legacy-vision\n", true);
    const inventory = inventoryPaperTopics(fixture.layout, { now: NOW, runtimeObserved: "stopped" });
    const item = inventory.papers[0]!.topicItems[0]!;
    const unresolved = createPaperTopicsPlan(fixture.layout, inventory, {
      schema: paperTopicsSchemas().mapping,
      mappings: [],
    }, NOW);
    expect(unresolved).toMatchObject({ executable: false, papers: [{ action: "unresolved" }] });

    const plan = createPaperTopicsPlan(fixture.layout, inventory, {
      schema: paperTopicsSchemas().mapping,
      mappings: [{
        relativePath: fixture.relativePath,
        itemOrdinal: item.ordinal,
        itemFingerprint: item.fingerprint,
        decision: "direction",
        topicId: "topic:legacy-direction",
        role: "primary",
      }],
    }, NOW);
    expect(plan).toMatchObject({ executable: true, papers: [{ action: "canonicalize" }] });

    const result = await migratePaperTopicsCopy(
      fixture.layout,
      plan,
      join(fixture.parent, "mapped-destination"),
      NOW,
    );

    expect(result.counts).toMatchObject({ changed: 1, succeeded: 1, failed: 0, conflicted: 0 });
    expect(await readFile(fixture.path, "utf8")).toBe(fixture.markdown);
    const copied = await readFile(
      join(fixture.parent, "mapped-destination", "vault", fixture.relativePath),
      "utf8",
    );
    expect(copied).toContain("topics:\n  - legacy-vision");
    expect(copied).toContain("topic_id: topic:legacy-direction");
    expect(copied).toContain("role: primary");
    const after = inventoryPaperTopics(
      openDataRoot(join(fixture.parent, "mapped-destination")),
      { now: NOW, runtimeObserved: "stopped" },
    );
    expect(after.papers[0]!.topicsState).toBe("inert");
  });

  it("fails stale plans before creating any snapshot or destination", async () => {
    const fixture = await legacyRoot("topics: []\n");
    const inventory = inventoryPaperTopics(fixture.layout, { now: NOW, runtimeObserved: "stopped" });
    const plan = createPaperTopicsPlan(fixture.layout, inventory, {
      schema: paperTopicsSchemas().mapping,
      mappings: [],
    }, NOW);
    await writeFile(fixture.path, fixture.markdown.replace("Preserve this body", "Externally edited body"));
    const destination = join(fixture.parent, "stale-destination");

    await expect(migratePaperTopicsCopy(fixture.layout, plan, destination, NOW))
      .rejects.toThrow("paper-topics-plan-stale");
    await expect(access(destination)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(`${destination}.source-snapshot`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("blocks a copied operational state with a resumable Job", async () => {
    const fixture = await legacyRoot("topics: []\n");
    const inventory = inventoryPaperTopics(fixture.layout, { now: NOW, runtimeObserved: "stopped" });
    const plan = createPaperTopicsPlan(fixture.layout, inventory, {
      schema: paperTopicsSchemas().mapping,
      mappings: [],
    }, NOW);
    const database = new Database(fixture.layout.databasePath);
    database.prepare(`INSERT INTO job_runs
      (id,job_type,paper_id,state,progress,attempt,idempotency_key,input_json,queued_at)
      VALUES ('job:pending-migration','paper-organization','paper:fixture:2026:legacy-topics',
        'queued',0,1,'pending-migration','{}',?)`).run(NOW.toISOString());
    database.close();
    const refreshed = inventoryPaperTopics(fixture.layout, { now: NOW, runtimeObserved: "stopped" });
    const refreshedPlan = createPaperTopicsPlan(fixture.layout, refreshed, {
      schema: paperTopicsSchemas().mapping,
      mappings: [],
    }, NOW);

    await expect(migratePaperTopicsCopy(
      fixture.layout,
      refreshedPlan,
      join(fixture.parent, "active-command-destination"),
      NOW,
    )).rejects.toThrow("paper-topics-source-not-quiescent:job_runs");
    expect(plan.executable).toBe(true);
  });
});
