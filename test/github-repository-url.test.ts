import { describe, expect, it } from "vitest";

import { parseGitHubRepositoryUrl } from "../src/domain/github-repository-url.js";

describe("GitHub repository URL", () => {
  it("normalizes a repository root URL with a .git suffix and trailing slash", () => {
    expect(parseGitHubRepositoryUrl(" https://github.com/Owner/Repository.git/ ")).toEqual({
      canonicalUrl: "https://github.com/owner/repository",
      host: "github.com",
      owner: "owner",
      repository: "repository",
    });
  });

  it.each([
    "http://github.com/owner/repository",
    "https://github.com.evil.test/owner/repository",
    "https://user@github.com/owner/repository",
    "https://github.com:443/owner/repository",
    "https://github.com/owner/repository/issues/1",
    "https://github.com/owner/repository/tree/main",
    "https://github.com/owner/repository/blob/main/README.md",
    "https://github.com/owner/repository?tab=readme",
    "https://github.com/owner/repository#readme",
  ])("rejects a non-root or impersonating URL: %s", (url) => {
    expect(parseGitHubRepositoryUrl(url)).toBeNull();
  });

  it.each([
    "https://github.com/owner/%2Frepository",
    "https://github.com/owner/repo%5Csitory",
    "https://github.com/owner/.git",
    "https://github.com/./repository",
    "https://github.com/../repository",
    "https://github.com/owner/repo@sitory",
  ])("rejects an invalid repository identity: %s", (url) => {
    expect(parseGitHubRepositoryUrl(url)).toBeNull();
  });
});
