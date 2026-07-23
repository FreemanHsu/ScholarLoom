import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { conversationActionRequest, conversationListStatus, ConversationHeaderActions, NewConversationButton }
  from "../src/web/conversation-controls.js";

describe("Conversation controls", () => {
  it("only declares a JSON body for rename commands", () => {
    expect(conversationActionRequest("archive")).toEqual({ method: "POST" });
    expect(conversationActionRequest("restore")).toEqual({ method: "POST" });
    expect(conversationActionRequest("rename", "新标题")).toEqual({ method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "新标题" }) });
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

  it("keeps linked successors identifiable in the conversation list", () => {
    expect(conversationListStatus({ archived: false, legacy: false, successor: true }))
      .toBe("关联后继 · 上下文已冻结");
    expect(conversationListStatus({ archived: false, legacy: false, successor: false })).toBe("上下文已冻结");
    expect(conversationListStatus({ archived: true, legacy: false, successor: true })).toBe("关联后继 · 已归档");
  });
});
