import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import Database from "better-sqlite3";
import { parseDocument } from "yaml";

import {
  validatePaperOrganization,
  type PaperAlias,
  type PaperOrganizationInput,
} from "../domain/paper-organization.js";
import { ImportStore } from "./import-store.js";
import {
  createSnapshot,
  restoreSnapshot,
  verifySnapshot,
} from "./data-operations.js";
import { openDataRoot, type StorageLayout } from "./layout.js";
import { acquireRuntimeLock } from "./runtime-lock.js";

const INVENTORY_SCHEMA = "scholarloom.paper-topics-inventory/v1";
const MAPPING_SCHEMA = "scholarloom.paper-topics-mapping/v1";
const PLAN_SCHEMA = "scholarloom.paper-topics-migration/v1";
const FINGERPRINT_ALGORITHM = "paper-markdown-set/v1";

type TopicItem = {
  ordinal: number;
  type: "string" | "number" | "boolean" | "null" | "sequence" | "map";
  fingerprint: string;
  value?: unknown;
};

type InventoryPaper = {
  relativePath: string;
  markdownHash: string;
  topicsState: "missing" | "empty-sequence" | "non-empty-sequence" | "scalar" | "map" | "null" | "inert";
  topicItems: TopicItem[];
  canonical: { aliasesPresent: boolean; directionsPresent: boolean };
};

export type PaperTopicsInventory = {
  schema: typeof INVENTORY_SCHEMA;
  fingerprintAlgorithm: typeof FINGERPRINT_ALGORITHM;
  createdAt: string;
  runtimeObserved: "active" | "stopped" | "unknown";
  localOnly: true;
  valuesIncluded: boolean;
  dataFormatVersion: number;
  sqliteSchemaVersion: number | null;
  rootFingerprint: string;
  evidenceHash: string;
  counts: Record<InventoryPaper["topicsState"], number>;
  papers: InventoryPaper[];
};

type MappingEntry = {
  relativePath: string;
  itemOrdinal: number;
  itemFingerprint: string;
  decision: "preserve-only" | "direction";
  topicId?: string;
  role?: "primary" | "secondary";
};

type MappingFile = {
  schema: typeof MAPPING_SCHEMA;
  mappings: MappingEntry[];
};

type PlanPaper = {
  relativePath: string;
  sourceMarkdownHash: string;
  sourceItemFingerprints: string[];
  action: "unchanged" | "canonicalize" | "unresolved";
  organization: PaperOrganizationInput | null;
  errors: string[];
};

export type PaperTopicsMigrationPlan = {
  schema: typeof PLAN_SCHEMA;
  createdAt: string;
  localOnly: true;
  sourceRootFingerprint: string;
  sourceEvidenceHash: string;
  mappingHash: string;
  executable: boolean;
  papers: PlanPaper[];
  planHash: string;
};

export function inventoryPaperTopics(
  layout: StorageLayout,
  options: {
    includeValues?: boolean;
    now?: Date;
    runtimeObserved?: PaperTopicsInventory["runtimeObserved"];
  } = {},
): PaperTopicsInventory {
  const includeValues = options.includeValues ?? false;
  const papersRoot = join(layout.vaultRoot, "library", "papers");
  const paths = collectPaperPaths(papersRoot);
  const papers = paths.map((path): InventoryPaper => {
    const markdown = readFileSync(path, "utf8");
    const document = parseFrontmatter(markdown);
    const data = document.toJSON() as Record<string, unknown>;
    const topicsPresent = document.has("topics");
    const directionsPresent = document.has("directions");
    const aliasesPresent = document.has("aliases");
    const topics = topicsPresent ? data.topics : undefined;
    const topicItems = describeTopicItems(topics, includeValues);
    let topicsState: InventoryPaper["topicsState"];
    if (directionsPresent) topicsState = "inert";
    else if (!topicsPresent) topicsState = "missing";
    else if (topics === null) topicsState = "null";
    else if (Array.isArray(topics)) topicsState = topics.length === 0 ? "empty-sequence" : "non-empty-sequence";
    else if (topics && typeof topics === "object") topicsState = "map";
    else topicsState = "scalar";
    return {
      relativePath: slash(relative(layout.vaultRoot, path)),
      markdownHash: sha256(markdown),
      topicsState,
      topicItems,
      canonical: { aliasesPresent, directionsPresent },
    };
  }).sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const manifest = JSON.parse(readFileSync(layout.manifestPath, "utf8")) as { formatVersion: number };
  const rootFingerprint = sha256(canonicalJson({
    algorithm: FINGERPRINT_ALGORITHM,
    dataFormatVersion: manifest.formatVersion,
    files: papers.map(({ relativePath, markdownHash }) => ({ relativePath, markdownHash })),
  }));
  const structuralPapers = papers.map((paper) => ({
    ...paper,
    topicItems: paper.topicItems.map(({ ordinal, type, fingerprint }) => ({ ordinal, type, fingerprint })),
  }));
  const evidenceHash = sha256(canonicalJson({
    rootFingerprint,
    papers: structuralPapers,
  }));
  const states: InventoryPaper["topicsState"][] = [
    "missing", "empty-sequence", "non-empty-sequence", "scalar", "map", "null", "inert",
  ];
  return {
    schema: INVENTORY_SCHEMA,
    fingerprintAlgorithm: FINGERPRINT_ALGORITHM,
    createdAt: (options.now ?? new Date()).toISOString(),
    runtimeObserved: options.runtimeObserved ?? observeRuntime(layout),
    localOnly: true,
    valuesIncluded: includeValues,
    dataFormatVersion: manifest.formatVersion,
    sqliteSchemaVersion: sqliteSchemaVersion(layout.databasePath),
    rootFingerprint,
    evidenceHash,
    counts: Object.fromEntries(states.map((state) =>
      [state, papers.filter((paper) => paper.topicsState === state).length])) as
      Record<InventoryPaper["topicsState"], number>,
    papers,
  };
}

export function createPaperTopicsPlan(
  layout: StorageLayout,
  inventory: PaperTopicsInventory,
  mapping: MappingFile,
  now = new Date(),
): PaperTopicsMigrationPlan {
  requireInventory(inventory);
  if (mapping.schema !== MAPPING_SCHEMA || !Array.isArray(mapping.mappings)) {
    throw new Error("paper-topics-mapping-invalid");
  }
  const live = inventoryPaperTopics(layout, { now, runtimeObserved: "unknown" });
  if (live.rootFingerprint !== inventory.rootFingerprint || live.evidenceHash !== inventory.evidenceHash) {
    throw new Error("paper-topics-inventory-stale");
  }
  const mappingKeys = new Set<string>();
  for (const item of mapping.mappings) {
    const key = mappingKey(item.relativePath, item.itemOrdinal, item.itemFingerprint);
    if (mappingKeys.has(key)) throw new Error("paper-topics-mapping-duplicate");
    mappingKeys.add(key);
    if (!["preserve-only", "direction"].includes(item.decision)) {
      throw new Error("paper-topics-mapping-invalid");
    }
  }
  const mappingByKey = new Map(mapping.mappings.map((item) =>
    [mappingKey(item.relativePath, item.itemOrdinal, item.itemFingerprint), item] as const));
  const usableDirections = readUsableDirections(layout.databasePath);
  const papers = inventory.papers.map((paper): PlanPaper => {
    if (paper.topicsState === "missing" || paper.topicsState === "empty-sequence" ||
        paper.topicsState === "null" || paper.topicsState === "inert") {
      return {
        relativePath: paper.relativePath,
        sourceMarkdownHash: paper.markdownHash,
        sourceItemFingerprints: paper.topicItems.map((item) => item.fingerprint),
        action: "unchanged",
        organization: null,
        errors: [],
      };
    }
    const current = readOrganization(join(layout.vaultRoot, paper.relativePath));
    const directions = [...current.directions];
    const errors: string[] = [];
    for (const item of paper.topicItems) {
      const selected = mappingByKey.get(mappingKey(paper.relativePath, item.ordinal, item.fingerprint));
      if (!selected) {
        errors.push(`unresolved:${item.ordinal}`);
        continue;
      }
      if (selected.decision === "preserve-only") continue;
      if (!selected.topicId || !selected.role || !usableDirections.has(selected.topicId)) {
        errors.push(`direction-not-usable:${item.ordinal}`);
        continue;
      }
      directions.push({ topicId: selected.topicId, role: selected.role });
    }
    let organization: PaperOrganizationInput | null = null;
    try { organization = validatePaperOrganization({ aliases: current.aliases, directions }); }
    catch (error) { errors.push(error instanceof Error ? error.message : "paper-organization-invalid"); }
    const changed = organization && canonicalJson(organization) !== canonicalJson(current);
    return {
      relativePath: paper.relativePath,
      sourceMarkdownHash: paper.markdownHash,
      sourceItemFingerprints: paper.topicItems.map((item) => item.fingerprint),
      action: errors.length ? "unresolved" : changed ? "canonicalize" : "unchanged",
      organization,
      errors,
    };
  });
  const withoutHash = {
    schema: PLAN_SCHEMA as typeof PLAN_SCHEMA,
    createdAt: now.toISOString(),
    localOnly: true as const,
    sourceRootFingerprint: inventory.rootFingerprint,
    sourceEvidenceHash: inventory.evidenceHash,
    mappingHash: sha256(canonicalJson(mapping)),
    executable: papers.every((paper) => paper.action !== "unresolved"),
    papers,
  };
  return { ...withoutHash, planHash: sha256(canonicalJson(withoutHash)) };
}

export async function migratePaperTopicsCopy(
  sourceLayout: StorageLayout,
  plan: PaperTopicsMigrationPlan,
  destinationRoot: string,
  now = new Date(),
) {
  requirePlan(plan);
  if (!plan.executable) throw new Error("paper-topics-plan-unresolved");
  const destination = resolve(destinationRoot);
  const sourceSnapshot = `${destination}.source-snapshot`;
  const destinationSnapshot = `${destination}.verified-snapshot`;
  for (const path of [destination, sourceSnapshot, destinationSnapshot]) {
    if (existsSync(path)) throw new Error(`paper-topics-output-exists:${path}`);
  }
  const release = acquireRuntimeLock(sourceLayout);
  try {
    const stoppedInventory = inventoryPaperTopics(sourceLayout, {
      now,
      runtimeObserved: "stopped",
    });
    if (stoppedInventory.rootFingerprint !== plan.sourceRootFingerprint ||
        stoppedInventory.evidenceHash !== plan.sourceEvidenceHash) {
      throw new Error("paper-topics-plan-stale");
    }
    await createSnapshot(sourceLayout, sourceSnapshot, { now, runtimeLockHeld: true });
    const sourceVerification = verifySnapshot(sourceSnapshot);
    if (!sourceVerification.healthy) throw new Error("paper-topics-source-snapshot-invalid");
    const destinationLayout = restoreSnapshot(sourceSnapshot, destination);
    assertOperationallyQuiescent(destinationLayout.databasePath);

    const store = ImportStore.open(destinationLayout, null, () => now);
    const catalogBefore = catalogHash(destinationLayout.databasePath);
    const ledger = new Database(destinationLayout.databasePath);
    ledger.pragma("foreign_keys = ON");
    ledger.pragma("busy_timeout = 5000");
    const commandId = `paper-topics-migration:${plan.planHash.slice(0, 24)}`;
    const timestamp = now.toISOString();
    ledger.prepare(`INSERT OR IGNORE INTO paper_topics_migration_commands
      (id,plan_hash,source_fingerprint,state,created_at,updated_at)
      VALUES (?,?,?,'applying',?,?)`).run(
      commandId, plan.planHash, plan.sourceRootFingerprint, timestamp, timestamp,
    );
    let succeeded = 0;
    let failed = 0;
    let conflicted = 0;
    try {
      const changed = plan.papers.filter((paper) => paper.action === "canonicalize");
      for (const [ordinal, paper] of changed.entries()) {
        const manifest = ledger.prepare(`SELECT paper_id,markdown_hash FROM paper_manifests
          WHERE markdown_path=?`).get(paper.relativePath) as
          { paper_id: string; markdown_hash: string } | undefined;
        if (!manifest || manifest.markdown_hash !== paper.sourceMarkdownHash || !paper.organization) {
          failed += 1;
          continue;
        }
        for (const direction of paper.organization.directions) {
          if (!readUsableDirections(destinationLayout.databasePath).has(direction.topicId)) {
            throw new Error("paper-topics-direction-not-usable");
          }
        }
        ledger.prepare(`INSERT OR IGNORE INTO paper_topics_migration_members
          (command_id,ordinal,paper_id,relative_path,source_markdown_hash,
           source_item_fingerprints_json,state,created_at,updated_at)
          VALUES (?,?,?,?,?,?,'pending',?,?)`).run(
          commandId, ordinal, manifest.paper_id, paper.relativePath, paper.sourceMarkdownHash,
          JSON.stringify(paper.sourceItemFingerprints), timestamp, timestamp,
        );
        ledger.prepare(`UPDATE paper_topics_migration_members SET state='applying',updated_at=?
          WHERE command_id=? AND ordinal=?`).run(timestamp, commandId, ordinal);
        try {
          store.savePaperOrganization(
            manifest.paper_id,
            paper.organization,
            `paper-topics-migration:${plan.planHash}:${paper.relativePath}`,
          );
          const resultHash = sha256(readFileSync(join(destinationLayout.vaultRoot, paper.relativePath), "utf8"));
          ledger.prepare(`UPDATE paper_topics_migration_members
            SET state='succeeded',result_markdown_hash=?,error_code=NULL,updated_at=?
            WHERE command_id=? AND ordinal=?`).run(resultHash, timestamp, commandId, ordinal);
          succeeded += 1;
        } catch (error) {
          const code = error instanceof Error ? error.message : "paper-topics-migration-failed";
          const state = code.includes("conflict") ? "conflicted" : "failed";
          ledger.prepare(`UPDATE paper_topics_migration_members SET state=?,error_code=?,updated_at=?
            WHERE command_id=? AND ordinal=?`).run(state, code, timestamp, commandId, ordinal);
          if (state === "conflicted") conflicted += 1;
          else failed += 1;
        }
      }
      const state = failed + conflicted > 0 ? "complete-with-issues" : "complete";
      ledger.prepare(`UPDATE paper_topics_migration_commands SET state=?,updated_at=?,completed_at=?
        WHERE id=?`).run(state, timestamp, timestamp, commandId);
    } finally {
      ledger.close();
      store.close();
    }
    const catalogAfter = catalogHash(destinationLayout.databasePath);
    await createSnapshot(destinationLayout, destinationSnapshot, { now });
    const destinationVerification = verifySnapshot(destinationSnapshot);
    if (!destinationVerification.healthy) throw new Error("paper-topics-destination-snapshot-invalid");
    const sourceAfter = inventoryPaperTopics(sourceLayout, { now, runtimeObserved: "stopped" });
    if (sourceAfter.rootFingerprint !== stoppedInventory.rootFingerprint ||
        sourceAfter.evidenceHash !== stoppedInventory.evidenceHash) {
      throw new Error("paper-topics-source-changed");
    }
    return {
      migrated: true,
      noOp: plan.papers.every((paper) => paper.action !== "canonicalize"),
      sourceFingerprint: plan.sourceRootFingerprint,
      destinationRoot: destination,
      sourceSnapshot,
      destinationSnapshot,
      counts: {
        changed: plan.papers.filter((paper) => paper.action === "canonicalize").length,
        unchanged: plan.papers.filter((paper) => paper.action === "unchanged").length,
        succeeded,
        failed,
        conflicted,
      },
      catalog: { before: catalogBefore, after: catalogAfter },
      verification: destinationVerification,
      cutoverAuthorized: false,
    };
  } finally {
    release();
  }
}

export function writeExclusiveJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

export function readInventory(path: string): PaperTopicsInventory {
  return JSON.parse(readFileSync(path, "utf8")) as PaperTopicsInventory;
}

export function readMapping(path: string): MappingFile {
  return JSON.parse(readFileSync(path, "utf8")) as MappingFile;
}

export function readPlan(path: string): PaperTopicsMigrationPlan {
  return JSON.parse(readFileSync(path, "utf8")) as PaperTopicsMigrationPlan;
}

export function paperTopicsSchemas() {
  return { inventory: INVENTORY_SCHEMA, mapping: MAPPING_SCHEMA, plan: PLAN_SCHEMA } as const;
}

function requireInventory(value: PaperTopicsInventory): void {
  if (value.schema !== INVENTORY_SCHEMA || value.fingerprintAlgorithm !== FINGERPRINT_ALGORITHM ||
      !Array.isArray(value.papers) || typeof value.rootFingerprint !== "string" ||
      typeof value.evidenceHash !== "string") {
    throw new Error("paper-topics-inventory-invalid");
  }
}

function requirePlan(value: PaperTopicsMigrationPlan): void {
  if (value.schema !== PLAN_SCHEMA || !Array.isArray(value.papers) ||
      value.planHash !== sha256(canonicalJson({
        schema: value.schema,
        createdAt: value.createdAt,
        localOnly: value.localOnly,
        sourceRootFingerprint: value.sourceRootFingerprint,
        sourceEvidenceHash: value.sourceEvidenceHash,
        mappingHash: value.mappingHash,
        executable: value.executable,
        papers: value.papers,
      }))) {
    throw new Error("paper-topics-plan-invalid");
  }
}

function collectPaperPaths(root: string): string[] {
  if (!existsSync(root)) return [];
  const paths: string[] = [];
  const visit = (directory: string) => {
    const rootDetails = lstatSync(directory);
    if (rootDetails.isSymbolicLink()) throw new Error("paper-topics-symlink-blocked");
    if (!rootDetails.isDirectory()) throw new Error("paper-topics-path-invalid");
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const details = lstatSync(path);
      if (details.isSymbolicLink()) throw new Error("paper-topics-symlink-blocked");
      if (details.isDirectory()) visit(path);
      else if (details.isFile() && name === "paper.md") paths.push(path);
    }
  };
  visit(root);
  return paths;
}

function parseFrontmatter(markdown: string) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(markdown);
  if (!match) throw new Error("paper-topics-frontmatter-invalid");
  const document = parseDocument(match[1]!);
  if (document.errors.length) throw new Error("paper-topics-frontmatter-invalid");
  return document;
}

function describeTopicItems(value: unknown, includeValues: boolean): TopicItem[] {
  const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return values.map((item, ordinal) => ({
    ordinal,
    type: valueType(item),
    fingerprint: sha256(canonicalJson(item)),
    ...(includeValues ? { value: item } : {}),
  }));
}

function valueType(value: unknown): TopicItem["type"] {
  if (value === null) return "null";
  if (Array.isArray(value)) return "sequence";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return "map";
}

function readOrganization(path: string): PaperOrganizationInput {
  const data = parseFrontmatter(readFileSync(path, "utf8")).toJSON() as {
    aliases?: unknown;
    directions?: unknown;
  };
  const aliases = Array.isArray(data.aliases) ? data.aliases.map((value) => {
    const alias = value as { name?: unknown; kind?: unknown; preferred?: unknown };
    return { name: alias.name, kind: alias.kind, preferred: alias.preferred };
  }) : [];
  const directions = Array.isArray(data.directions) ? data.directions.map((value) => {
    const direction = value as { topic_id?: unknown; role?: unknown };
    return { topicId: direction.topic_id, role: direction.role };
  }) : [];
  return validatePaperOrganization({ aliases, directions }) as {
    aliases: PaperAlias[];
    directions: PaperOrganizationInput["directions"];
  };
}

function readUsableDirections(databasePath: string): Set<string> {
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    if (!tableExists(database, "direction_catalog")) return new Set();
    return new Set((database.prepare(`SELECT topic_id FROM direction_catalog
      WHERE lifecycle_status='active' AND review_status='confirmed'
        AND length(trim(title))>0 AND length(trim(scope))>0`).pluck().all() as string[]));
  } finally { database.close(); }
}

function assertOperationallyQuiescent(databasePath: string): void {
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const activeChecks: Array<[string, string]> = [
      ["knowledge_write_requests", "phase NOT IN ('complete','failed','conflicted')"],
      ["paper_organization_batches", "state IN ('reserved','applying')"],
      ["direction_merge_commands", "state IN ('reserved','superseding','migrating')"],
      ["paper_organization_backfills", "state IN ('reserved','scheduling','monitoring')"],
      ["job_runs", "state IN ('queued','running')"],
    ];
    for (const [table, where] of activeChecks) {
      if (tableExists(database, table) &&
          Number(database.prepare(`SELECT count(*) FROM ${table} WHERE ${where}`).pluck().get()) > 0) {
        throw new Error(`paper-topics-source-not-quiescent:${table}`);
      }
    }
    if (tableExists(database, "knowledge_write_requests")) {
      const rows = database.prepare("SELECT target_path,staged_path FROM knowledge_write_requests").all() as
        Array<{ target_path: string; staged_path: string }>;
      if (rows.some((row) => isAbsolute(row.target_path) || isAbsolute(row.staged_path) ||
          row.target_path.split(/[\\/]/).includes("..") || row.staged_path.split(/[\\/]/).includes(".."))) {
        throw new Error("paper-topics-absolute-operational-path");
      }
    }
  } finally { database.close(); }
}

function catalogHash(databasePath: string): string {
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const tables = ["paper_catalog", "paper_alias_catalog", "paper_direction_catalog", "direction_catalog"];
    const logical = tables.filter((table) => tableExists(database, table)).map((table) => ({
      table,
      rows: database.prepare(`SELECT * FROM ${table}`).all()
        .map((row) => row as Record<string, unknown>)
        .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right))),
    }));
    return sha256(canonicalJson(logical));
  } finally { database.close(); }
}

function tableExists(database: Database.Database, table: string): boolean {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function sqliteSchemaVersion(databasePath: string): number | null {
  if (!existsSync(databasePath)) return null;
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    if (!tableExists(database, "schema_migrations")) return null;
    return Number(database.prepare("SELECT max(version) FROM schema_migrations").pluck().get() ?? 0);
  } finally { database.close(); }
}

function observeRuntime(layout: StorageLayout): PaperTopicsInventory["runtimeObserved"] {
  try {
    const release = acquireRuntimeLock(layout);
    release();
    return "stopped";
  } catch {
    return "active";
  }
}

function mappingKey(relativePath: string, ordinal: number, fingerprint: string): string {
  return `${relativePath}\u0000${ordinal}\u0000${fingerprint}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function slash(path: string): string {
  return path.replaceAll("\\", "/");
}

export function openPaperTopicsDataRoot(path: string): StorageLayout {
  return openDataRoot(path);
}
