import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { RepositoryPanel } from "../src/web/repository-panel.js";

describe("RepositoryPanel", () => {
  it("shows association origin, status, commit, and localized failure recovery", () => {
    const html = renderToStaticMarkup(<RepositoryPanel repositories={[
      {
        id: "link:ready",
        repositoryId: "repository:ready",
        owner: "owner",
        repository: "ready",
        canonicalUrl: "https://github.com/owner/ready",
        origin: "manual",
        associationStatus: "confirmed",
        materializationStatus: "ready",
        commitSha: "a".repeat(40),
        failureReason: null,
      },
      {
        id: "link:failed",
        repositoryId: "repository:failed",
        owner: "owner",
        repository: "failed",
        canonicalUrl: "https://github.com/owner/failed",
        origin: "detected",
        associationStatus: "confirmed",
        materializationStatus: "failed",
        commitSha: null,
        failureReason: "fixture unavailable",
      },
    ]} busy={false} error={null} onClose={() => undefined} onAdd={() => undefined}
      onConfirm={() => undefined} onRetry={() => undefined} onRemove={() => undefined} />);

    expect(html).toContain("owner/ready");
    expect(html).toContain("https://github.com/owner/ready");
    expect(html).toContain("手动添加");
    expect(html).toContain("固定版本");
    expect(html).toContain("aaaaaaaaaaaa");
    expect(html).toContain("论文检测");
    expect(html).toContain("fixture unavailable");
    expect(html).toContain("重试物化");
    expect(html.match(/移除关联/g)).toHaveLength(2);
  });
});
