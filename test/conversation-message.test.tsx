import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ConversationMessageBody, ConversationProposalGroup, TakeawayReviewCard } from "../src/web/conversation-message.js";

describe("Discussion message presentation", () => {
  it("renders assistant answers as safe Markdown", () => {
    const html = renderToStaticMarkup(<ConversationMessageBody role="assistant"
      content={"## 输入\n\n- RGB image\n- object mask\n\n`N=25`"}
      pageCount={16} onOpenEvidence={() => undefined} />);

    expect(html).toContain("<h4>输入</h4>");
    expect(html).toContain("<li>RGB image</li>");
    expect(html).toContain("<code>N=25</code>");
  });

  it("keeps multiple Takeaway Proposals in one compact collapsed review group", () => {
    const proposals = [
      { id: "proposal:1", claim: "第一条结论", legacySource: false },
      { id: "proposal:2", claim: "第二条结论", legacySource: false },
    ];
    const html = renderToStaticMarkup(<ConversationProposalGroup proposals={proposals}
      onDecide={() => undefined} />);

    expect(html).toContain("2 个 Takeaway 待审核");
    expect(html).toContain("<details");
    expect(html).not.toContain("open=\"\"");
    expect(html.match(/>确认<\/button>/g)).toHaveLength(2);
    expect(html.match(/>结构化编辑<\/button>/g)).toHaveLength(2);
    expect(html.match(/>拒绝<\/button>/g)).toHaveLength(2);
  });

  it("shows the source Conversation and durable Selection state on a complete review card", () => {
    const html = renderToStaticMarkup(<TakeawayReviewCard proposal={{
      id: "proposal:1", claim: "Fixture Paper 形成一条可独立审核、带来源与 durable state 的完整结论。",
      legacySource: false, sourceConversationHref: "/papers/paper:1/conversations/conversation:1",
      distillationJobRunId: "job:selection:1", distillationState: "succeeded",
    }} onDecide={() => undefined} />);
    expect(html).toContain("查看来源 Conversation");
    expect(html).toContain("Selection succeeded");
    expect(html).toContain("job:selection:1");
  });
});
