import { execFileSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { assertNoSymlinkPath } from "./safe-local-path.js";

export function isRepositoryMaterialized(
  repositoryRoot: string,
  localPath: string | null,
  expectedCommitSha: string | null,
): boolean {
  if (!localPath || !expectedCommitSha) return false;
  const absolutePath = join(repositoryRoot, localPath);
  try {
    assertNoSymlinkPath(repositoryRoot, absolutePath, "repository-materialization-path-unsafe");
    const stats = lstatSync(absolutePath);
    if (!stats.isDirectory() || stats.isSymbolicLink()) return false;
    const commit = execFileSync("git", ["-C", absolutePath, "rev-parse", "HEAD^{commit}"], {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const status = execFileSync("git", ["-C", absolutePath, "status", "--porcelain", "--untracked-files=no"], {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return commit === expectedCommitSha && status.length === 0;
  } catch {
    return false;
  }
}
