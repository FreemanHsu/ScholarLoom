import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const activeMaterializations = new Map<string, Promise<{ commitSha: string }>>();
const commitShaPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

function executeGit(args: string[], timeout: number) {
  return execute("git", args, {
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    timeout,
  });
}

export type RepositoryAdapter = {
  materialize(url: string, destination: string, expectedCommitSha?: string): Promise<{ commitSha: string }>;
};

export class GitRepositoryAdapter implements RepositoryAdapter {
  constructor(private readonly fixtureUrls: Record<string, string> = {}) {}

  async materialize(url: string, destination: string, expectedCommitSha?: string): Promise<{ commitSha: string }> {
    if (expectedCommitSha && !commitShaPattern.test(expectedCommitSha)) {
      throw new Error("repository-commit-invalid");
    }
    const active = activeMaterializations.get(destination);
    if (active) return active;
    const operation = this.#materialize(url, destination, expectedCommitSha);
    activeMaterializations.set(destination, operation);
    try {
      return await operation;
    } finally {
      if (activeMaterializations.get(destination) === operation) activeMaterializations.delete(destination);
    }
  }

  async #materialize(url: string, destination: string, expectedCommitSha?: string): Promise<{ commitSha: string }> {
    const source = this.fixtureUrls[url] ?? url;
    const existingCommit = await inspectMaterializedRepository(source, destination);
    if (existingCommit && (!expectedCommitSha || existingCommit === expectedCommitSha)) {
      await cleanupCrashLeftovers(destination);
      return { commitSha: existingCommit };
    }
    const recoveredCommit = await recoverCrashLeftover(source, destination, expectedCommitSha);
    if (recoveredCommit) {
      await cleanupCrashLeftovers(destination);
      return { commitSha: recoveredCommit };
    }

    const nonce = randomUUID();
    const staging = `${destination}.staging-${nonce}`;
    const replaced = `${destination}.replaced-${nonce}`;
    let movedExisting = false;
    try {
      if (expectedCommitSha) {
        await executeGit(["init", staging], 10_000);
        await executeGit(["-C", staging, "remote", "add", "origin", source], 10_000);
        await executeGit(["-C", staging, "fetch", "--no-tags", "--depth", "1", "--end-of-options",
          "origin", expectedCommitSha], 120_000);
        await executeGit(["-C", staging, "checkout", "--detach", "FETCH_HEAD"], 10_000);
      } else {
        await executeGit(["clone", "--no-tags", "--depth", "1", source, staging], 120_000);
      }
      const commitSha = await inspectMaterializedRepository(source, staging);
      if (!commitSha) throw new Error("repository-clone-invalid");
      if (expectedCommitSha && commitSha !== expectedCommitSha) throw new Error("repository-commit-mismatch");
      try {
        await rename(destination, replaced);
        movedExisting = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      try {
        await rename(staging, destination);
      } catch (error) {
        if (movedExisting) await rename(replaced, destination);
        throw error;
      }
      if (movedExisting) await rm(replaced, { recursive: true, force: true });
      await cleanupCrashLeftovers(destination);
      return { commitSha };
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
}

async function listCrashLeftovers(destination: string): Promise<string[]> {
  const parent = dirname(destination);
  const name = basename(destination);
  let entries: string[];
  try {
    entries = await readdir(parent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const prefixes = [`${name}.staging-`, `${name}.replaced-`];
  return entries.flatMap((entry) => {
    const prefix = prefixes.find((candidate) => entry.startsWith(candidate));
    return prefix && uuidPattern.test(entry.slice(prefix.length)) ? [join(parent, entry)] : [];
  }).sort((left, right) => {
    const leftStaging = basename(left).startsWith(`${name}.staging-`) ? 0 : 1;
    const rightStaging = basename(right).startsWith(`${name}.staging-`) ? 0 : 1;
    return leftStaging - rightStaging || left.localeCompare(right);
  });
}

async function recoverCrashLeftover(
  source: string,
  destination: string,
  expectedCommitSha?: string,
): Promise<string | null> {
  for (const candidate of await listCrashLeftovers(destination)) {
    const commitSha = await inspectMaterializedRepository(source, candidate);
    if (!commitSha || (expectedCommitSha && commitSha !== expectedCommitSha)) continue;
    const replaced = `${destination}.replaced-${randomUUID()}`;
    let movedExisting = false;
    try {
      await rename(destination, replaced);
      movedExisting = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      await rename(candidate, destination);
    } catch (error) {
      if (movedExisting) await rename(replaced, destination);
      throw error;
    }
    if (movedExisting) await rm(replaced, { recursive: true, force: true });
    return commitSha;
  }
  return null;
}

async function cleanupCrashLeftovers(destination: string): Promise<void> {
  await Promise.all((await listCrashLeftovers(destination))
    .map((entry) => rm(entry, { recursive: true, force: true })));
}

async function inspectMaterializedRepository(source: string, destination: string): Promise<string | null> {
  try {
    const [{ stdout: origin }, { stdout: commit }, { stdout: status }] = await Promise.all([
      executeGit(["-C", destination, "config", "--get", "remote.origin.url"], 10_000),
      executeGit(["-C", destination, "rev-parse", "HEAD^{commit}"], 10_000),
      executeGit(["-C", destination, "status", "--porcelain", "--untracked-files=no"], 10_000),
    ]);
    return origin.trim() === source && commitShaPattern.test(commit.trim()) && status.length === 0
      ? commit.trim()
      : null;
  } catch {
    return null;
  }
}
