import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SummaryMarkdown } from "../src/web/summary-markdown.js";

describe("Paper Summary Markdown", () => {
  it("renders emphasis in academic prose", () => {
    const html = renderToStaticMarkup(
      <SummaryMarkdown markdown="基础 **TTT layer** 保持可微。" pageCount={13} onOpenEvidence={() => undefined} />,
    );

    expect(html).toContain("基础 <strong>TTT layer</strong> 保持可微。");
  });

  it("recovers a bold Agent label with whitespace before the closing marker", () => {
    const html = renderToStaticMarkup(
      <SummaryMarkdown markdown="**Agent 评价： **真正的新意更接近接口与训练范式的统一。" pageCount={13}
        onOpenEvidence={() => undefined} />,
    );

    expect(html).toContain('class="summary-inference"');
    expect(html).toContain("<small>Agent 推断</small>");
    expect(html).toContain("<strong>Agent 评价：</strong>");
    expect(html).not.toContain("**Agent 评价");
  });

  it("renders a valid Agent label when Chinese prose immediately follows the closing marker", () => {
    const html = renderToStaticMarkup(
      <SummaryMarkdown markdown="**Agent 评价：**这些缺项会显著影响严格复现。" pageCount={13}
        onOpenEvidence={() => undefined} />,
    );

    expect(html).toContain('class="summary-inference"');
    expect(html).toContain("<strong>Agent 评价：</strong> 这些缺项会显著影响严格复现。");
    expect(html).not.toContain("**Agent 评价");
  });

  it("normalizes Agent labels whose punctuation sits outside the bold marker", () => {
    const html = renderToStaticMarkup(
      <SummaryMarkdown markdown="**Agent 评价**：这些数字需要进一步核验。" pageCount={13}
        onOpenEvidence={() => undefined} />,
    );

    expect(html).toContain('class="summary-inference"');
    expect(html).toContain("<strong>Agent 评价：</strong> 这些数字需要进一步核验。");
  });

  it("recognizes qualified Agent evaluation labels", () => {
    const html = renderToStaticMarkup(
      <SummaryMarkdown markdown="**Agent 评价——证据不足之处**：缺少方差和显著性检验。" pageCount={13}
        onOpenEvidence={() => undefined} />,
    );

    expect(html).toContain('class="summary-inference"');
    expect(html).toContain("<strong>Agent 评价——证据不足之处：</strong>");
  });

  it("turns a valid PDF page marker into inline Evidence", () => {
    const html = renderToStaticMarkup(
      <SummaryMarkdown markdown="该更新对 outer loop 可微。[pdf-page:3]" pageCount={13} onOpenEvidence={() => undefined} />,
    );

    expect(html).toContain('class="summary-evidence"');
    expect(html).toContain('data-page="3"');
    expect(html).toContain("p. 3");
  });

  it("renders the agreed inline and display LaTeX delimiters", () => {
    const html = renderToStaticMarkup(
      <SummaryMarkdown markdown={"混合导数 $\\partial G / \\partial W_V$。\n\n$$\n\\hat{V}=F_W(K)\n$$"}
        pageCount={13} onOpenEvidence={() => undefined} />,
    );

    expect(html).toContain('class="katex"');
    expect(html).toContain('class="katex-display"');
  });

  it("renders GFM tables and read-only task lists", () => {
    const html = renderToStaticMarkup(
      <SummaryMarkdown markdown={"| Loss | Top-1 |\n|---|---:|\n| MSE | 79.2% |\n\n- [x] 核验主实验"}
        pageCount={13} onOpenEvidence={() => undefined} />,
    );

    expect(html).toContain('class="summary-table-scroll"');
    expect(html).toContain("<table>");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('checked=""');
    expect(html).toContain('disabled=""');
  });

  it("keeps untrusted links, HTML, and images inert", () => {
    const html = renderToStaticMarkup(
      <SummaryMarkdown markdown={"[论文](https://example.test/paper) [危险](javascript:alert(1)) ![结果图](https://tracker.test/pixel) <script>alert(1)</script>"}
        pageCount={13} onOpenEvidence={() => undefined} />,
    );

    expect(html).toContain('href="https://example.test/paper"');
    expect(html).toContain('target="_blank"');
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("<img");
    expect(html).toContain("结果图 · 图片暂不支持");
    expect(html).not.toContain("<script>");
  });

  it("does not let authored links invoke the internal Evidence protocol", () => {
    const html = renderToStaticMarkup(
      <SummaryMarkdown markdown="[伪造 Evidence](scholarloom-evidence:2)"
        pageCount={13} onOpenEvidence={() => undefined} />,
    );

    expect(html).toContain("伪造 Evidence");
    expect(html).not.toContain("summary-evidence");
    expect(html).not.toContain('data-page="2"');
    expect(html).not.toContain("scholarloom-evidence:");
    expect(html).not.toContain("href=");
  });

  it("leaves code markers untouched and flags unresolved Evidence", () => {
    const html = renderToStaticMarkup(
      <SummaryMarkdown markdown={"`[pdf-page:3]` [pdf-page:99] [pdf-page:nope] [pdf-page:3"}
        pageCount={13} onOpenEvidence={() => undefined} />,
    );

    expect(html).toContain("<code>[pdf-page:3]</code>");
    expect(html).not.toContain('data-page="3"');
    expect(html.match(/summary-evidence-unresolved/g)).toHaveLength(3);
    expect(html).toContain("[pdf-page:99]");
    expect(html).toContain("[pdf-page:nope]");
    expect(html).toContain("[pdf-page:3");
  });

  it("keeps generated headings below the structured section title", () => {
    const html = renderToStaticMarkup(
      <SummaryMarkdown markdown={"# 重复顶层\n\n### Inner update\n\n###### 细节"}
        pageCount={13} onOpenEvidence={() => undefined} />,
    );

    expect(html).toContain("<h4>重复顶层</h4>");
    expect(html).toContain("<h4>Inner update</h4>");
    expect(html).toContain("<h6>细节</h6>");
    expect(html).not.toMatch(/<h[123]>/);
  });

  it("gives fenced code a language label and copy affordance", () => {
    const html = renderToStaticMarkup(
      <SummaryMarkdown markdown={"```text\nW* = W₀ − η ∂L/∂W\n```"}
        pageCount={13} onOpenEvidence={() => undefined} />,
    );

    expect(html).toContain('class="summary-code-block"');
    expect(html).toContain('class="summary-code-language">text</span>');
    expect(html).toContain('aria-label="复制代码块"');
    expect(html).toContain("W* = W₀ − η ∂L/∂W");
  });

  it("keeps the rest of the Summary readable when LaTeX is malformed", () => {
    const html = renderToStaticMarkup(
      <SummaryMarkdown markdown={"前文 $\\frac{$ 后文仍然可读。"}
        pageCount={13} onOpenEvidence={() => undefined} />,
    );

    expect(html).toContain('class="katex-error"');
    expect(html).toContain("\\frac{");
    expect(html).toContain("公式无法渲染");
    expect(html).toContain("后文仍然可读");
  });

  it("flags an unclosed LaTeX delimiter without swallowing later prose", () => {
    const html = renderToStaticMarkup(
      <SummaryMarkdown markdown={"前文 $\\frac{1。后文仍然可读。"}
        pageCount={13} onOpenEvidence={() => undefined} />,
    );

    expect(html).toContain('class="summary-math-unresolved"');
    expect(html).toContain("$\\frac{1");
    expect(html).toContain("公式无法渲染");
    expect(html).toContain("后文仍然可读");
  });
});
