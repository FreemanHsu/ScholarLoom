import { Children, isValidElement, useState, type ReactNode } from "react";
import Markdown from "react-markdown";
import type { Link, Parent, Root, Text } from "mdast";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";

export type SummaryMarkdownProps = {
  markdown: string;
  pageCount: number;
  onOpenEvidence(page: number): void;
};

const evidenceProtocol = "scholarloom-evidence:";
const unresolvedEvidenceProtocol = "scholarloom-evidence-unresolved:";
const unresolvedMathProtocol = "scholarloom-math-unresolved:";

function normalizeSummaryMarkdown(markdown: string): string {
  return markdown
    .replace(/^([ \t]*)\*\*(Agent\s*(?:评价|评估)(?:[^*\n]{0,32}?))[：:]?\s*\*\*[：:]?[ \t]*/gmu,
      (_match, indentation: string, label: string) =>
        `${indentation}**${label.trim().replace(/[：:]$/u, "")}：** `)
    .replace(/\*\*([^*\n]*?\S)[ \t]+\*\*(?=[\p{L}\p{N}])/gu, "**$1** ")
    .replace(/\*\*([^*\n]*?\S)[ \t]+\*\*/gu, "**$1**");
}

function safeSummaryUrl(url: string): string | undefined {
  if (url.startsWith(evidenceProtocol) || url.startsWith(unresolvedEvidenceProtocol) || url.startsWith(unresolvedMathProtocol)) return url;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

function remarkUnclosedMath() {
  return () => (tree: Root) => {
    const visit = (node: Root | Parent) => {
      node.children.forEach((child, index) => {
        if (child.type === "text" && node.type !== "link") {
          const start = child.value.search(/\${1,2}(?=\\|[A-Za-z{^_])/);
          if (start === -1) return;
          const sentenceEnd = child.value.slice(start).search(/[。！？；\n]/);
          const end = sentenceEnd === -1 ? child.value.length : start + sentenceEnd;
          const source = child.value.slice(start, end);
          const parts: Array<Text | Link> = [];
          if (start > 0) parts.push({ type: "text", value: child.value.slice(0, start) });
          parts.push({ type: "link", url: `${unresolvedMathProtocol}${encodeURIComponent(source)}`,
            data: { hProperties: { dataMathMarker: "unresolved" } }, children: [{ type: "text", value: source }] });
          if (end < child.value.length) parts.push({ type: "text", value: child.value.slice(end) });
          node.children.splice(index, 1, ...parts);
          return;
        }
        if ("children" in child && child.type !== "link") visit(child);
      });
    };
    visit(tree);
  };
}

function remarkPdfEvidence(pageCount: number) {
  return () => (tree: Root) => {
    const visit = (node: Root | Parent) => {
      node.children.forEach((child, index) => {
        if (child.type === "text" && node.type !== "link") {
          const parts: Array<Text | Link> = [];
          let cursor = 0;
          for (const match of child.value.matchAll(/\[pdf-page:([^\]]*)]|\[pdf-page:([^\s\]，。；、！？)]*)(?=\s|$|[，。；、！？)])/g)) {
            const complete = match[1] !== undefined;
            const locator = match[1] ?? match[2] ?? "";
            const page = /^\d+$/.test(locator) ? Number(locator) : Number.NaN;
            const start = match.index;
            if (start > cursor) parts.push({ type: "text", value: child.value.slice(cursor, start) });
            if (complete && page >= 1 && page <= pageCount) {
              parts.push({ type: "link", url: `${evidenceProtocol}${page}`, data: { hProperties: { dataEvidenceMarker: "valid" } },
                children: [{ type: "text", value: `p. ${page}` }] });
            } else {
              parts.push({ type: "link", url: `${unresolvedEvidenceProtocol}${encodeURIComponent(match[0])}`,
                data: { hProperties: { dataEvidenceMarker: "unresolved" } },
                children: [{ type: "text", value: match[0] }] });
            }
            cursor = start + match[0].length;
          }
          if (cursor === 0) return;
          if (cursor < child.value.length) parts.push({ type: "text", value: child.value.slice(cursor) });
          node.children.splice(index, 1, ...parts);
          return;
        }
        if ("children" in child && child.type !== "link") visit(child);
      });
    };
    visit(tree);
  };
}

function nodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return nodeText(node.props.children);
  return "";
}

function SummaryCodeBlock({ children }: { children?: ReactNode }) {
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");
  const code = Children.only(children);
  const className = isValidElement<{ className?: string }>(code) ? code.props.className : undefined;
  const language = className?.match(/(?:^|\s)language-([^\s]+)/)?.[1] ?? "text";
  const source = nodeText(code);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(source);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("failed");
    }
  };

  return <div className="summary-code-block">
    <div className="summary-code-toolbar"><span className="summary-code-language">{language}</span>
      <button type="button" aria-label="复制代码块" onClick={() => void copy()}>
        {copyStatus === "copied" ? "已复制" : copyStatus === "failed" ? "复制失败" : "复制"}
      </button></div>
    <pre>{code}</pre>
  </div>;
}

export function SummaryMarkdown(props: SummaryMarkdownProps) {
  return <div className="summary-markdown"><Markdown
    remarkPlugins={[remarkGfm, remarkMath, remarkPdfEvidence(props.pageCount), remarkUnclosedMath()]}
    rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: "warn" }]]}
    urlTransform={(url, key) => key === "src" ? undefined : safeSummaryUrl(url)}
    components={{
      h1({ children }) { return <h4>{children}</h4>; },
      h2({ children }) { return <h4>{children}</h4>; },
      h3({ children }) { return <h4>{children}</h4>; },
      h4({ children }) { return <h5>{children}</h5>; },
      h5({ children }) { return <h6>{children}</h6>; },
      h6({ children }) { return <h6>{children}</h6>; },
      p({ children }) {
        if (/^Agent\s*(?:评价|评估)(?:[^：:\n]{0,32})?[:：]/.test(nodeText(children).trimStart())) {
          return <aside className="summary-inference"><small>Agent 推断</small><p>{children}</p></aside>;
        }
        return <p>{children}</p>;
      },
      pre({ children }) { return <SummaryCodeBlock>{children}</SummaryCodeBlock>; },
      table({ node: _node, children, ...attributes }) {
        return <div className="summary-table-scroll"><table {...attributes}>{children}</table></div>;
      },
      span({ node: _node, className, children, ...attributes }) {
        if (className?.split(" ").includes("katex-error")) {
          return <span {...attributes} className={className}>{children}<small>公式无法渲染</small></span>;
        }
        return <span {...attributes} className={className}>{children}</span>;
      },
      a({ node, href, children }) {
        const marker = node?.properties.dataEvidenceMarker;
        if (node?.properties.dataMathMarker === "unresolved" && href?.startsWith(unresolvedMathProtocol)) {
          return <span className="summary-math-unresolved"><code>{children}</code><small>公式无法渲染</small></span>;
        }
        if (marker === "unresolved" && href?.startsWith(unresolvedEvidenceProtocol)) {
          return <span className="summary-evidence-unresolved" title="无法定位到当前 PDF 页面">{children}</span>;
        }
        if (marker === "valid" && href?.startsWith(evidenceProtocol)) {
          const page = Number(href.slice(evidenceProtocol.length));
          return <button type="button" className="summary-evidence" data-page={page}
            onClick={() => props.onOpenEvidence(page)}>{children}</button>;
        }
        if (href?.startsWith(evidenceProtocol) || href?.startsWith(unresolvedEvidenceProtocol) || href?.startsWith(unresolvedMathProtocol)) {
          return <>{children}</>;
        }
        if (!href) return <>{children}</>;
        return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
      },
      img({ alt }) {
        return <span className="summary-image-fallback">{alt || "图片"} · 图片暂不支持</span>;
      },
    }}
  >{normalizeSummaryMarkdown(props.markdown)}</Markdown></div>;
}
