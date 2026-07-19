import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const DATA_FORMAT_VERSION = 1;
export const DATA_MANIFEST_NAME = "scholarloom-data.json";

export type StorageLayout = {
  root: string;
  manifestPath: string;
  vaultRoot: string;
  originalsRoot: string;
  databasePath: string;
  runtimeLockPath: string;
  derivedRoot: string;
  repositoryRoot: string;
  logsRoot: string;
  tmpRoot: string;
};

export function defaultDataRoot(): string {
  return join(homedir(), "ScholarLoomData");
}

export function initializeDataRoot(root = defaultDataRoot(), now = new Date()): StorageLayout {
  const absoluteRoot = resolve(root);
  if (existsSync(absoluteRoot)) throw new Error(`Refusing to initialize an existing path: ${absoluteRoot}`);
  const stagedRoot = `${absoluteRoot}.initializing-${randomUUID()}`;
  mkdirSync(stagedRoot, { recursive: true, mode: 0o700 });
  const directories = [
    "vault/inbox", "vault/library/papers", "vault/knowledge/concepts", "vault/knowledge/topics",
    "vault/knowledge/questions", "vault/syntheses", "vault/assets/images", "originals/papers", "state",
    "derived", "cache/repositories", "logs", "tmp",
  ];
  directories.forEach((directory) => mkdirSync(join(stagedRoot, directory), { recursive: true, mode: 0o700 }));
  writeFileSync(join(stagedRoot, DATA_MANIFEST_NAME), `${JSON.stringify({
    formatVersion: DATA_FORMAT_VERSION,
    createdAt: now.toISOString(),
    authority: { knowledge: "vault", sources: "originals", operational: "state/scholarloom.sqlite3" },
  }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  writeFileSync(join(stagedRoot, "vault", ".gitignore"), ".DS_Store\n*.staged\n", { encoding: "utf8", mode: 0o600 });
  const vaultGuide = join(process.cwd(), "templates", "vault-AGENTS.md");
  if (!existsSync(vaultGuide)) throw new Error(`Vault guide template is missing: ${vaultGuide}`);
  writeFileSync(join(stagedRoot, "vault", "AGENTS.md"), readFileSync(vaultGuide), { mode: 0o600 });
  execFileSync("git", ["init", "--quiet", join(stagedRoot, "vault")]);
  renameSync(stagedRoot, absoluteRoot);
  return openDataRoot(absoluteRoot);
}

export function openDataRoot(root = defaultDataRoot()): StorageLayout {
  const absoluteRoot = resolve(root);
  const manifestPath = join(absoluteRoot, DATA_MANIFEST_NAME);
  if (!existsSync(manifestPath)) {
    throw new Error(`ScholarLoom data root is not initialized: ${absoluteRoot}. Run npm run data:init first.`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { formatVersion?: unknown; authority?: unknown };
  if (manifest.formatVersion !== DATA_FORMAT_VERSION) throw new Error("ScholarLoom data format is unsupported");
  const expectedAuthority = { knowledge: "vault", sources: "originals", operational: "state/scholarloom.sqlite3" };
  if (JSON.stringify(manifest.authority) !== JSON.stringify(expectedAuthority)) {
    throw new Error("ScholarLoom data root has an unsupported authority manifest");
  }
  const layout: StorageLayout = {
    root: absoluteRoot,
    manifestPath,
    vaultRoot: join(absoluteRoot, "vault"),
    originalsRoot: join(absoluteRoot, "originals"),
    databasePath: join(absoluteRoot, "state", "scholarloom.sqlite3"),
    runtimeLockPath: join(absoluteRoot, "state", "runtime.lock"),
    derivedRoot: join(absoluteRoot, "derived"),
    repositoryRoot: join(absoluteRoot, "cache", "repositories"),
    logsRoot: join(absoluteRoot, "logs"),
    tmpRoot: join(absoluteRoot, "tmp"),
  };
  const required = [layout.vaultRoot, join(layout.vaultRoot, ".git"), join(layout.originalsRoot, "papers"),
    join(layout.root, "state"), layout.derivedRoot, layout.repositoryRoot, layout.logsRoot, layout.tmpRoot];
  const missing = required.filter((path) => !existsSync(path) || !statSync(path).isDirectory());
  if (missing.length) throw new Error(`ScholarLoom data root is incomplete: ${missing.join(", ")}`);
  try { execFileSync("git", ["-C", layout.vaultRoot, "rev-parse", "--git-dir"], { stdio: "ignore" }); }
  catch { throw new Error(`ScholarLoom vault Git repository is invalid: ${layout.vaultRoot}`); }
  return layout;
}
