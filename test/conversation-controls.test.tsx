import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { conversationListStatus, ConversationHeaderActions, ContinueConversationAction, NewConversationButton }
  from "../src/web/conversation-controls.js";

describe("Conversation controls", () => {
  it("distinguishes an independent draft from a linked successor", () => {
    const independent = renderToStaticMarkup(<NewConversationButton onCreate={() => undefined} />);
    const successor = renderToStaticMarkup(<ContinueConversationAction legacy={false} onContinue={() => undefined} />);

    expect(independent).toContain("独立新对话");
    expect(successor).toContain("创建关联后继");
    expect(successor).toContain("当前对话及其证据保持冻结");
  });

  it("groups frozen-context status separately from management actions", () => {
    const html = renderToStaticMarkup(<ConversationHeaderActions repositorySnapshotCount={2} isSuccessor={true}
      archived={false} onRename={() => undefined} onToggleArchive={() => undefined} />);

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
