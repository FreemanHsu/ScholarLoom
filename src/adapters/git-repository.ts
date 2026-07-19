import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);

export type RepositoryAdapter = {
  materialize(url: string, destination: string): Promise<{ commitSha: string }>;
};

export class GitRepositoryAdapter implements RepositoryAdapter {
  constructor(private readonly fixtureUrls: Record<string, string> = {}) {}

  async materialize(url: string, destination: string): Promise<{ commitSha: string }> {
    const source = this.fixtureUrls[url] ?? url;
    await execute("git", ["clone", "--no-tags", "--depth", "1", source, destination], { timeout: 120_000 });
    const { stdout } = await execute("git", ["-C", destination, "rev-parse", "HEAD"], { timeout: 10_000 });
    if (!/^[a-f0-9]{40,64}$/i.test(stdout.trim())) throw new Error("repository-commit-invalid");
    return { commitSha: stdout.trim() };
  }
}
