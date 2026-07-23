import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rename, rm } from "node:fs/promises";
import { promisify } from "node:util";

const execute = promisify(execFile);
const activeMaterializations = new Map<string, Promise<{ commitSha: string }>>();

export type RepositoryAdapter = {
  materialize(url: string, destination: string, expectedCommitSha?: string): Promise<{ commitSha: string }>;
};

export class GitRepositoryAdapter implements RepositoryAdapter {
  constructor(private readonly fixtureUrls: Record<string, string> = {}) {}

  async materialize(url: string, destination: string, expectedCommitSha?: string): Promise<{ commitSha: string }> {
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
    if (existingCommit && (!expectedCommitSha || existingCommit === expectedCommitSha)) return { commitSha: existingCommit };

    const nonce = randomUUID();
    const staging = `${destination}.staging-${nonce}`;
    const replaced = `${destination}.replaced-${nonce}`;
    let movedExisting = false;
    try {
      if (expectedCommitSha) {
        await execute("git", ["init", staging], { timeout: 10_000 });
        await execute("git", ["-C", staging, "remote", "add", "origin", source], { timeout: 10_000 });
        await execute("git", ["-C", staging, "fetch", "--no-tags", "--depth", "1", "origin", expectedCommitSha],
          { timeout: 120_000 });
        await execute("git", ["-C", staging, "checkout", "--detach", "FETCH_HEAD"], { timeout: 10_000 });
      } else {
        await execute("git", ["clone", "--no-tags", "--depth", "1", source, staging], { timeout: 120_000 });
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
      return { commitSha };
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
}

async function inspectMaterializedRepository(source: string, destination: string): Promise<string | null> {
  try {
    const [{ stdout: origin }, { stdout: commit }, { stdout: status }] = await Promise.all([
      execute("git", ["-C", destination, "config", "--get", "remote.origin.url"], { timeout: 10_000 }),
      execute("git", ["-C", destination, "rev-parse", "HEAD^{commit}"], { timeout: 10_000 }),
      execute("git", ["-C", destination, "status", "--porcelain", "--untracked-files=no"], { timeout: 10_000 }),
    ]);
    return origin.trim() === source && /^[a-f0-9]{40,64}$/i.test(commit.trim()) && status.length === 0
      ? commit.trim()
      : null;
  } catch {
    return null;
  }
}
