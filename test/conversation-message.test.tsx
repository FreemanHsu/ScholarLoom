import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ConversationMessageBody, ConversationProposalGroup } from "../src/web/conversation-message.js";

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
      onAccept={() => undefined} onEdit={() => undefined} onReject={() => undefined} />);

    expect(html).toContain("2 个 Takeaway 待审核");
    expect(html).toContain("<details");
    expect(html).not.toContain("open=\"\"");
    expect(html.match(/>确认<\/button>/g)).toHaveLength(2);
    expect(html.match(/>编辑<\/button>/g)).toHaveLength(2);
    expect(html.match(/>拒绝<\/button>/g)).toHaveLength(2);
  });
});
