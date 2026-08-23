import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("Knowledge Question UI", () => {
  const main = readFileSync(join(process.cwd(), "src", "web", "main.tsx"), "utf8");
  const styles = readFileSync(join(process.cwd(), "src", "web", "styles.css"), "utf8");

  it("keeps a new conversation visually empty until the user submits", () => {
    expect(main).not.toContain("从一个具体问题开始");
    expect(main).not.toContain("可以继续追问；只有成功完成的问答才会保存到会话历史。");
    expect(main).not.toContain("Codex 会根据问题决定如何回答；成功后会进入可继续的独立问答会话。");
  });

  it("gives enabled Knowledge Question submit controls a pointer affordance", () => {
    expect(styles).toContain(".entry-agent-primary button:not(:disabled){cursor:pointer}");
    expect(styles).toContain(".knowledge-question-composer button:not(:disabled){cursor:pointer}");
  });
});
