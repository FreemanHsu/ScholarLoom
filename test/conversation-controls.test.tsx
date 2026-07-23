import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { canContinueConversation, conversationActionRequest, filterConversationsByArchive, conversationListStatus,
  ConversationHeaderActions, NewConversationButton }
  from "../src/web/conversation-controls.js";

describe("Conversation controls", () => {
  it("selects active or archived Conversations for the list filter", () => {
    const conversations = [{ id: "active", status: "active" as const }, { id: "archived", status: "archived" as const }];

    expect(filterConversationsByArchive(conversations, false).map((item) => item.id)).toEqual(["active"]);
    expect(filterConversationsByArchive(conversations, true).map((item) => item.id)).toEqual(["archived"]);
  });

  it("only declares a JSON body for rename commands", () => {
    expect(conversationActionRequest("archive")).toEqual({ method: "POST" });
    expect(conversationActionRequest("restore")).toEqual({ method: "POST" });
    expect(conversationActionRequest("rename", "新标题")).toEqual({ method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "新标题" }) });
  });

  it("keeps continuation available for an archived Conversation without Messages", () => {
    expect(canContinueConversation({ archived: true, legacy: false, messageCount: 0 })).toBe(true);
    expect(canContinueConversation({ archived: false, legacy: true, messageCount: 0 })).toBe(true);
    expect(canContinueConversation({ archived: false, legacy: false, messageCount: 0 })).toBe(false);
    expect(canContinueConversation({ archived: false, legacy: false, messageCount: 1 })).toBe(true);
  });

  it("distinguishes an independent draft from a linked successor", () => {
    const independent = renderToStaticMarkup(<NewConversationButton onCreate={() => undefined} />);
    const successor = renderToStaticMarkup(<ConversationHeaderActions repositorySnapshotCount={1} isSuccessor={false}
      archived={false} canContinue={true} legacy={false} onContinue={() => undefined}
      onRename={() => undefined} onToggleArchive={() => undefined} />);
    const legacy = renderToStaticMarkup(<ConversationHeaderActions repositorySnapshotCount={0} isSuccessor={false}
      archived={false} canContinue={true} legacy={true} onContinue={() => undefined}
      onRename={() => undefined} onToggleArchive={() => undefined} />);

    expect(independent).toContain("独立新对话");
    expect(successor).toContain("创建关联后继");
    expect(successor).toContain("当前对话及其证据保持冻结");
    expect(successor).toContain('role="tooltip"');
    expect(legacy).toContain("使用最新上下文继续");
    expect(legacy).toContain("创建可继续讨论的关联 Conversation");
  });

  it("groups frozen-context status separately from management actions", () => {
    const html = renderToStaticMarkup(<ConversationHeaderActions repositorySnapshotCount={2} isSuccessor={true}
      archived={false} canContinue={false} legacy={false} onContinue={() => undefined}
      onRename={() => undefined} onToggleArchive={() => undefined} />);

    expect(html).toContain("2 个代码快照");
    expect(html).toContain("关联后继");
    expect(html).toContain("重命名");
    expect(html).toContain("归档");
  });

  it("renders parent, direct successors, ancestor breadcrumb, and readable context changes", () => {
    const html = renderToStaticMarkup(<ConversationHeaderActions repositorySnapshotCount={2} isSuccessor={true}
      archived={true} canContinue={true} legacy={false} onContinue={() => undefined}
      onRename={() => undefined} onToggleArchive={() => undefined}
      lineage={{
        conversation: { id: "child", title: "当前", status: "archived" },
        parent: { id: "parent", title: "父对话", status: "active" },
        ancestors: [{ id: "root", title: "根对话", status: "active" },
          { id: "parent", title: "父对话", status: "active" }],
        successors: [{ id: "next", title: "后继", status: "active" }],
        contextComparison: { status: "available", identical: false, diff: {
          paperVersion: { status: "unchanged" },
          summaryRevision: { status: "changed" },
          extractionRun: { status: "unchanged", equalityBasis: "output-hash",
            before: { id: "run:1", outputHash: "hash:one" },
            after: { id: "run:2", outputHash: "hash:one" } },
          repositories: { status: "available", added: [], removed: [], changed: [{}], unchanged: [] },
          knowledgeCorpus: { status: "changed",
            before: { id: "manifest:1", hash: "manifest-hash:1" },
            after: { id: "manifest:2", hash: "manifest-hash:2" } },
        } },
      }}
      conversationHref={(id) => `/papers/paper/conversations/${id}`}
      onNavigate={() => undefined} />);

    expect(html).toContain("关系与上下文");
    expect(html).toContain("根对话");
    expect(html).toContain("父对话");
    expect(html).toContain("后继");
    expect(html).toContain("Summary 已变化");
    expect(html).toContain("Code 已变化");
    expect(html).toContain("Knowledge 已变化");
    expect(html).toContain("基于最新材料继续");
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain("run:1");
    expect(html).toContain("hash:one");
    expect(html).toContain("manifest-hash:2");
  });

  it("keeps linked successors identifiable in the conversation list", () => {
    expect(conversationListStatus({ archived: false, legacy: false, successor: true }))
      .toBe("关联后继 · 上下文已冻结");
    expect(conversationListStatus({ archived: false, legacy: false, successor: false })).toBe("上下文已冻结");
    expect(conversationListStatus({ archived: true, legacy: false, successor: true })).toBe("关联后继 · 已归档");
  });
});
