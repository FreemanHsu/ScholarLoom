import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { GitRepositoryAdapter } from "../src/adapters/git-repository.js";

const exec = promisify(execFile);

async function createBareRepository(): Promise<{ bare: string; commitSha: string }> {
  const root = await mkdtemp(join(tmpdir(), "scholarloom-git-adapter-"));
  const working = join(root, "working");
  const bare = join(root, "repository.git");
  await exec("git", ["init", working]);
  await exec("git", ["-C", working, "config", "user.email", "fixture@example.test"]);
  await exec("git", ["-C", working, "config", "user.name", "Fixture"]);
  await writeFile(join(working, "README.md"), "# Repository adapter\n", "utf8");
  await exec("git", ["-C", working, "add", "."]);
  await exec("git", ["-C", working, "commit", "-m", "fixture"]);
  const { stdout } = await exec("git", ["-C", working, "rev-parse", "HEAD"]);
  await exec("git", ["clone", "--bare", working, bare]);
  return { bare, commitSha: stdout.trim() };
}

describe("GitRepositoryAdapter", () => {
  it("rejects an invalid expected commit before passing it to Git", async () => {
    const root = await mkdtemp(join(tmpdir(), "scholarloom-git-adapter-destination-"));
    const destination = join(root, "repository");
    const canonicalUrl = "https://github.com/owner/repository";
    const repository = await createBareRepository();
    const adapter = new GitRepositoryAdapter({ [canonicalUrl]: repository.bare });

    await expect(
      adapter.materialize(canonicalUrl, destination, "--upload-pack=/usr/bin/false"),
    ).rejects.toThrow("repository-commit-invalid");
  });

  it("disables interactive terminal prompts for Git subprocesses", async () => {
    const root = await mkdtemp(join(tmpdir(), "scholarloom-git-environment-"));
    const executable = join(root, "git");
    const captured = join(root, "terminal-prompt");
    await writeFile(
      executable,
      '#!/bin/sh\nprintf "%s" "${GIT_TERMINAL_PROMPT-unset}" > "$SCHOLARLOOM_GIT_ENV_CAPTURE"\nexit 1\n',
      "utf8",
    );
    await chmod(executable, 0o755);
    const previousPath = process.env.PATH;
    const previousCapture = process.env.SCHOLARLOOM_GIT_ENV_CAPTURE;
    process.env.PATH = `${root}:${previousPath ?? ""}`;
    process.env.SCHOLARLOOM_GIT_ENV_CAPTURE = captured;
    try {
      const adapter = new GitRepositoryAdapter();
      await expect(
        adapter.materialize("https://github.com/owner/inaccessible", join(root, "destination")),
      ).rejects.toThrow();
      expect(await readFile(captured, "utf8")).toBe("0");
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousCapture === undefined) delete process.env.SCHOLARLOOM_GIT_ENV_CAPTURE;
      else process.env.SCHOLARLOOM_GIT_ENV_CAPTURE = previousCapture;
    }
  });

  it("cleans crash leftovers for the destination before rematerializing", async () => {
    const root = await mkdtemp(join(tmpdir(), "scholarloom-git-recovery-"));
    const destination = join(root, "repository");
    const staleStaging = `${destination}.staging-00000000-0000-4000-8000-000000000001`;
    const staleReplaced = `${destination}.replaced-00000000-0000-4000-8000-000000000002`;
    await mkdir(staleStaging);
    await mkdir(staleReplaced);
    await writeFile(join(staleStaging, "partial"), "partial", "utf8");
    await writeFile(join(staleReplaced, "previous"), "previous", "utf8");
    const canonicalUrl = "https://github.com/owner/repository";
    const repository = await createBareRepository();
    const adapter = new GitRepositoryAdapter({ [canonicalUrl]: repository.bare });

    await adapter.materialize(canonicalUrl, destination);

    expect(await readdir(root)).toEqual(["repository"]);
  });

  it("recovers a verified crash staging directory before depending on the remote", async () => {
    const root = await mkdtemp(join(tmpdir(), "scholarloom-git-crash-window-"));
    const destination = join(root, "repository");
    const staleStaging = `${destination}.staging-00000000-0000-4000-8000-000000000003`;
    const repository = await createBareRepository();
    await exec("git", ["clone", "--no-tags", "--depth", "1", repository.bare, staleStaging]);
    await rm(repository.bare, { recursive: true, force: true });
    const canonicalUrl = "https://github.com/owner/repository";
    const adapter = new GitRepositoryAdapter({ [canonicalUrl]: repository.bare });

    const recovered = await adapter.materialize(canonicalUrl, destination, repository.commitSha);

    expect(recovered).toEqual({ commitSha: repository.commitSha });
    expect(await readdir(root)).toEqual(["repository"]);
  });

  it("replaces an invalid destination with verified crash staging before using the remote", async () => {
    const root = await mkdtemp(join(tmpdir(), "scholarloom-git-crash-repair-"));
    const destination = join(root, "repository");
    const staleStaging = `${destination}.staging-00000000-0000-4000-8000-000000000004`;
    const repository = await createBareRepository();
    await exec("git", ["clone", "--no-tags", "--depth", "1", repository.bare, destination]);
    await exec("git", ["clone", "--no-tags", "--depth", "1", repository.bare, staleStaging]);
    await writeFile(join(destination, "README.md"), "tampered\n", "utf8");
    await rm(repository.bare, { recursive: true, force: true });
    const canonicalUrl = "https://github.com/owner/repository";
    const adapter = new GitRepositoryAdapter({ [canonicalUrl]: repository.bare });

    const recovered = await adapter.materialize(canonicalUrl, destination, repository.commitSha);

    expect(recovered).toEqual({ commitSha: repository.commitSha });
    expect(await readFile(join(destination, "README.md"), "utf8")).toBe("# Repository adapter\n");
    expect(await readdir(root)).toEqual(["repository"]);
  });
});
