export type GitHubRepositoryIdentity = {
  canonicalUrl: string;
  host: "github.com";
  owner: string;
  repository: string;
};

export function parseGitHubRepositoryUrl(input: string): GitHubRepositoryIdentity | null {
  try {
    const trimmed = input.trim();
    const parsed = new URL(trimmed);
    const authority = /^https:\/\/([^/]+)/i.exec(trimmed)?.[1];
    if (parsed.protocol !== "https:" || parsed.hostname !== "github.com" || authority?.toLowerCase() !== "github.com" ||
        parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments.length !== 2) return null;
    const owner = segments[0]!.toLowerCase();
    const repository = segments[1]!.replace(/\.git$/i, "").toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9-]{0,38})$/.test(owner) ||
        !/^[a-z0-9._-]+$/.test(repository) ||
        repository === "." || repository === "..") return null;
    return {
      canonicalUrl: `https://github.com/${owner}/${repository}`,
      host: "github.com",
      owner,
      repository,
    };
  } catch {
    return null;
  }
}
