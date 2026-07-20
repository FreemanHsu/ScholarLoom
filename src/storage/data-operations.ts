import { randomUUID, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync,
  unlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import Database from "better-sqlite3";

import { assertDataRootWritable, DATA_FORMAT_VERSION, DATA_MANIFEST_NAME, initializeDataRoot, openDataRoot, type StorageLayout } from "./layout.js";
import { acquireRuntimeLock, assertRuntimeStopped } from "./runtime-lock.js";

const SNAPSHOT_FORMAT_VERSION = 1;
const SNAPSHOT_MANIFEST_NAME = "snapshot-manifest.json";

type SnapshotFile = { path: string; sha256: string; bytes: number };
type SnapshotManifest = {
  snapshotFormatVersion: number;
  dataFormatVersion: number;
  createdAt: string;
  files: SnapshotFile[];
};

type SnapshotOptions = { now?: Date; includeDerived?: boolean };

export type SnapshotVerification = {
  healthy: boolean;
  filesChecked: number;
  errors: string[];
  sqliteIntegrity: string[];
  foreignKeyViolations: unknown[];
};

export async function createSnapshot(layout: StorageLayout, target: string, options: SnapshotOptions = {}): Promise<void> {
  const now = options.now ?? new Date();
  let releaseSnapshotLock: (() => void) | undefined;
  try { releaseSnapshotLock = acquireRuntimeLock(layout); }
  catch (error) { throw new Error(`ScholarLoom is still running; stop it before creating a data snapshot: ${(error as Error).message}`); }
  const absoluteTarget = resolve(target);
  let staged: string | undefined;
  try {
    if (existsSync(absoluteTarget)) throw new Error(`Snapshot target already exists: ${absoluteTarget}`);
    if (isInside(layout.root, absoluteTarget)) throw new Error("Snapshot target must be outside the ScholarLoom data root");
    if (!existsSync(layout.databasePath)) throw new Error("ScholarLoom database is missing; initialize and start the application first");
    mkdirSync(dirname(absoluteTarget), { recursive: true });
    staged = `${absoluteTarget}.staging-${randomUUID()}`;
    mkdirSync(staged, { mode: 0o700 });
    cpSync(layout.manifestPath, join(staged, DATA_MANIFEST_NAME));
    cpSync(layout.vaultRoot, join(staged, "vault"), { recursive: true, errorOnExist: true });
    cpSync(layout.originalsRoot, join(staged, "originals"), { recursive: true, errorOnExist: true });
    if (options.includeDerived) cpSync(layout.derivedRoot, join(staged, "derived"), { recursive: true, errorOnExist: true });
    mkdirSync(join(staged, "state"), { recursive: true, mode: 0o700 });
    const source = new Database(layout.databasePath, { readonly: true, fileMustExist: true });
    try { await source.backup(join(staged, "state", "scholarloom.sqlite3")); }
    finally { source.close(); }
    const manifest: SnapshotManifest = {
      snapshotFormatVersion: SNAPSHOT_FORMAT_VERSION,
      dataFormatVersion: DATA_FORMAT_VERSION,
      createdAt: now.toISOString(),
      files: collectFiles(staged),
    };
    writeFileSync(join(staged, SNAPSHOT_MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(staged, absoluteTarget);
    staged = undefined;
  } finally {
    if (staged) rmSync(staged, { recursive: true, force: true });
    releaseSnapshotLock();
  }
}

export function verifySnapshot(snapshotRoot: string): SnapshotVerification {
  const root = resolve(snapshotRoot);
  const errors: string[] = [];
  const manifestPath = join(root, SNAPSHOT_MANIFEST_NAME);
  let manifest: SnapshotManifest;
  try { manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as SnapshotManifest; }
  catch { return { healthy: false, filesChecked: 0, errors: ["snapshot-manifest-invalid"], sqliteIntegrity: [], foreignKeyViolations: [] }; }
  if (manifest.snapshotFormatVersion !== SNAPSHOT_FORMAT_VERSION || manifest.dataFormatVersion !== DATA_FORMAT_VERSION) {
    errors.push("snapshot-format-unsupported");
  }
  for (const file of manifest.files) {
    if (!safeRelativePath(file.path)) { errors.push(`unsafe-path:${file.path}`); continue; }
    const absolute = join(root, file.path);
    if (!existsSync(absolute)) { errors.push(`missing:${file.path}`); continue; }
    const bytes = statSync(absolute).size;
    const sha256 = createHash("sha256").update(readFileSync(absolute)).digest("hex");
    if (bytes !== file.bytes) errors.push(`size-mismatch:${file.path}`);
    if (sha256 !== file.sha256) errors.push(`hash-mismatch:${file.path}`);
  }
  const expected = new Set(manifest.files.map((file) => file.path));
  for (const file of collectFiles(root)) if (!expected.has(file.path)) errors.push(`untracked:${file.path}`);
  const databasePath = join(root, "state", "scholarloom.sqlite3");
  let sqliteIntegrity: string[] = [];
  let foreignKeyViolations: unknown[] = [];
  const verificationRoot = mkdtempSync(join(tmpdir(), "scholarloom-snapshot-verify-"));
  try {
    const verificationDatabasePath = join(verificationRoot, "scholarloom.sqlite3");
    cpSync(databasePath, verificationDatabasePath, { errorOnExist: true });
    const database = new Database(verificationDatabasePath, { readonly: true, fileMustExist: true });
    sqliteIntegrity = (database.pragma("integrity_check") as Array<{ integrity_check: string }>).map((row) => row.integrity_check);
    foreignKeyViolations = database.pragma("foreign_key_check") as unknown[];
    database.close();
  } catch { errors.push("sqlite-invalid"); }
  finally { rmSync(verificationRoot, { recursive: true, force: true }); }
  if (!sqliteIntegrity.length || sqliteIntegrity.some((value) => value !== "ok")) errors.push("sqlite-integrity-failed");
  if (foreignKeyViolations.length) errors.push("sqlite-foreign-key-violations");
  return { healthy: errors.length === 0, filesChecked: manifest.files.length, errors, sqliteIntegrity, foreignKeyViolations };
}

export function restoreSnapshot(snapshotRoot: string, targetRoot: string): StorageLayout {
  const source = resolve(snapshotRoot);
  const target = resolve(targetRoot);
  if (existsSync(target)) throw new Error(`Restore target already exists: ${target}`);
  const verification = verifySnapshot(source);
  if (!verification.healthy) throw new Error(`Snapshot verification failed: ${verification.errors.join(", ")}`);
  mkdirSync(dirname(target), { recursive: true });
  const staged = `${target}.restoring-${randomUUID()}`;
  mkdirSync(staged, { mode: 0o700 });
  for (const entry of [DATA_MANIFEST_NAME, "vault", "originals", "state"]) {
    cpSync(join(source, entry), join(staged, entry), { recursive: true, errorOnExist: true });
  }
  if (existsSync(join(source, "derived"))) cpSync(join(source, "derived"), join(staged, "derived"), { recursive: true, errorOnExist: true });
  cpSync(join(source, SNAPSHOT_MANIFEST_NAME), join(staged, SNAPSHOT_MANIFEST_NAME));
  const materializedVerification = verifySnapshot(staged);
  if (!materializedVerification.healthy) {
    rmSync(staged, { recursive: true, force: true });
    throw new Error(`Restored data verification failed: ${materializedVerification.errors.join(", ")}`);
  }
  unlinkSync(join(staged, SNAPSHOT_MANIFEST_NAME));
  for (const directory of ["derived", "cache/repositories", "logs", "tmp"]) {
    mkdirSync(join(staged, directory), { recursive: true, mode: 0o700 });
  }
  normalizeDataRootPermissions(staged);
  assertDataRootWritable(openDataRoot(staged));
  renameSync(staged, target);
  return openDataRoot(target);
}

function normalizeDataRootPermissions(root: string): void {
  const normalizeTree = (path: string, fileMode: number) => {
    const details = lstatSync(path);
    if (details.isDirectory()) {
      for (const name of readdirSync(path)) normalizeTree(join(path, name), fileMode);
      chmodSync(path, 0o700);
    } else if (details.isFile()) chmodSync(path, fileMode);
  };
  chmodSync(join(root, DATA_MANIFEST_NAME), 0o600);
  normalizeTree(join(root, "vault"), 0o600);
  normalizeTree(join(root, "originals"), 0o400);
  normalizeTree(join(root, "state"), 0o600);
  for (const directory of ["derived", "cache", "logs", "tmp"]) normalizeTree(join(root, directory), 0o600);
}

export function repairDataRootPermissions(layout: StorageLayout): void {
  assertRuntimeStopped(layout);
  normalizeDataRootPermissions(layout.root);
  assertDataRootWritable(layout);
}

export async function migrateLegacyData(repositoryRoot: string, targetRoot: string, now = new Date()): Promise<StorageLayout> {
  const repository = resolve(repositoryRoot);
  const target = resolve(targetRoot);
  if (existsSync(target)) throw new Error(`Migration target already exists: ${target}`);
  const legacyRuntime = join(repository, ".scholarloom");
  const legacyDatabase = join(legacyRuntime, "scholarloom.sqlite3");
  if (!existsSync(legacyDatabase)) throw new Error(`Legacy ScholarLoom database is missing: ${legacyDatabase}`);
  assertLegacyServiceStopped(legacyDatabase);
  const staged = `${target}.migrating-${randomUUID()}`;
  const layout = initializeDataRoot(staged, now);
  for (const entry of ["HOME.md", "inbox", "library", "knowledge", "syntheses"]) {
    copyIfPresent(join(repository, entry), join(layout.vaultRoot, entry));
  }
  copyIfPresent(join(repository, "assets", "images"), join(layout.vaultRoot, "assets", "images"));
  const artifactRefs = copyLegacyOriginals(join(legacyRuntime, "assets", "papers"), join(layout.originalsRoot, "papers"));
  copyDirectoryContents(join(legacyRuntime, "assets", "derived"), layout.derivedRoot);
  copyDirectoryContents(join(legacyRuntime, "repositories"), layout.repositoryRoot);
  const source = new Database(legacyDatabase, { readonly: true, fileMustExist: true });
  try { await source.backup(layout.databasePath); }
  finally { source.close(); }
  const migrated = new Database(layout.databasePath);
  try {
    const artifactsExist = migrated.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='artifacts'").get();
    if (artifactsExist) {
      const update = migrated.prepare("UPDATE artifacts SET storage_ref=? WHERE storage_ref=?");
      migrated.transaction(() => artifactRefs.forEach((storageRef, legacyRef) => update.run(storageRef, legacyRef)))();
      const legacyRefs = migrated.prepare("SELECT storage_ref FROM artifacts WHERE storage_ref LIKE 'papers/%'").pluck().all();
      if (legacyRefs.length) throw new Error(`Unresolved legacy artifact references: ${legacyRefs.join(", ")}`);
    }
    const integrity = (migrated.pragma("integrity_check") as Array<{ integrity_check: string }>).map((row) => row.integrity_check);
    const foreignKeys = migrated.pragma("foreign_key_check") as unknown[];
    if (integrity.some((result) => result !== "ok") || foreignKeys.length) throw new Error("Migrated SQLite validation failed");
    if (artifactsExist) {
      const refs = migrated.prepare("SELECT storage_ref FROM artifacts WHERE storage_ref LIKE 'originals/%'").pluck().all() as string[];
      for (const ref of refs) if (!existsSync(join(layout.root, ref))) throw new Error(`Migrated artifact is missing: ${ref}`);
    }
    validateMarkdownReferences(migrated, layout.vaultRoot);
  } finally { migrated.close(); }
  renameSync(staged, target);
  markLegacyDataReadOnly(repository, legacyRuntime);
  return openDataRoot(target);
}

function validateMarkdownReferences(database: Database.Database, vaultRoot: string): void {
  for (const table of ["summary_revisions", "takeaway_revisions"]) {
    const exists = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
    if (!exists) continue;
    const rows = database.prepare(`SELECT markdown_path,markdown_hash FROM ${table}`).all() as
      Array<{ markdown_path: string; markdown_hash: string }>;
    for (const row of rows) {
      if (!safeRelativePath(row.markdown_path)) throw new Error(`Unsafe migrated Markdown reference: ${row.markdown_path}`);
      const path = join(vaultRoot, row.markdown_path);
      if (!existsSync(path)) throw new Error(`Migrated Markdown is missing: ${row.markdown_path}`);
      const hash = createHash("sha256").update(readFileSync(path)).digest("hex");
      if (row.markdown_hash && hash !== row.markdown_hash) throw new Error(`Migrated Markdown hash mismatch: ${row.markdown_path}`);
    }
  }
  for (const file of collectFiles(vaultRoot).filter((entry) => entry.path.endsWith(".md"))) {
    const markdown = readFileSync(join(vaultRoot, file.path), "utf8");
    for (const match of markdown.matchAll(/\[\[([^\]]+)\]\]/g)) {
      const target = match[1]!.split("|")[0]!.split("#")[0]!.trim();
      if (!target) continue;
      if (!safeRelativePath(target)) throw new Error(`Unsafe Wikilink in ${file.path}: ${target}`);
      const markdownTarget = join(vaultRoot, target.endsWith(".md") ? target : `${target}.md`);
      if (!existsSync(markdownTarget)) throw new Error(`Broken Wikilink in ${file.path}: ${target}`);
    }
  }
}

function assertLegacyServiceStopped(databasePath: string): void {
  const result = spawnSync("lsof", ["-t", databasePath], { encoding: "utf8" });
  if (result.error) throw new Error(`Cannot confirm the legacy service is stopped: ${result.error.message}`);
  if (result.status === 0 && result.stdout.trim()) {
    throw new Error(`Legacy ScholarLoom database is still open by process ${result.stdout.trim().split(/\s+/).join(", ")}`);
  }
  if (result.status !== 0 && result.status !== 1) throw new Error("Cannot confirm the legacy service is stopped");
}

function copyLegacyOriginals(source: string, target: string): Map<string, string> {
  const refs = new Map<string, string>();
  if (!existsSync(source)) return refs;
  const visit = (directory: string) => {
    for (const name of readdirSync(directory)) {
      const absolute = join(directory, name);
      const details = lstatSync(absolute);
      if (details.isDirectory()) visit(absolute);
      else if (details.isFile()) {
        const bytes = readFileSync(absolute);
        const hash = createHash("sha256").update(bytes).digest("hex");
        const storageRef = join("originals", "papers", hash.slice(0, 2), `${hash}.pdf`);
        const destination = join(dirname(target), "..", storageRef);
        mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
        if (!existsSync(destination)) cpSync(absolute, destination, { errorOnExist: true });
        chmodSync(destination, 0o400);
        refs.set(join("papers", relative(source, absolute)), storageRef);
      }
    }
  };
  visit(source);
  return refs;
}

function markLegacyDataReadOnly(repository: string, legacyRuntime: string): void {
  const roots = [legacyRuntime, "HOME.md", "inbox", "library", "knowledge", "syntheses", join("assets", "images")]
    .map((entry) => isAbsolute(entry) ? entry : join(repository, entry)).filter(existsSync);
  const visit = (path: string) => {
    const details = lstatSync(path);
    if (details.isDirectory()) {
      readdirSync(path).forEach((entry) => visit(join(path, entry)));
      chmodSync(path, 0o500);
    } else if (details.isFile()) chmodSync(path, 0o400);
  };
  roots.forEach(visit);
}

function collectFiles(root: string): SnapshotFile[] {
  const files: SnapshotFile[] = [];
  const visit = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      if (name === SNAPSHOT_MANIFEST_NAME && directory === root) continue;
      const absolute = join(directory, name);
      const details = lstatSync(absolute);
      if (details.isSymbolicLink()) throw new Error(`Snapshot does not permit symbolic links: ${relative(root, absolute)}`);
      if (details.isDirectory()) visit(absolute);
      else if (details.isFile()) {
        const bytes = readFileSync(absolute);
        files.push({ path: relative(root, absolute), sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.byteLength });
      }
    }
  };
  visit(root);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function safeRelativePath(path: string): boolean {
  return Boolean(path) && !isAbsolute(path) && path !== "." && !path.split(/[\\/]/).some((segment) => segment === "..");
}

function isInside(parent: string, child: string): boolean {
  const path = relative(resolve(parent), resolve(child));
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
}

function copyIfPresent(source: string, target: string): void {
  if (!existsSync(source)) return;
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  cpSync(source, target, { recursive: true, force: false, errorOnExist: true });
}

function copyDirectoryContents(source: string, target: string): void {
  if (!existsSync(source)) return;
  mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const entry of readdirSync(source)) copyIfPresent(join(source, entry), join(target, entry));
}
