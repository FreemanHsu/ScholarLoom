import type { KnowledgeAnswer, KnowledgeAnswerRunner } from "./knowledge-answer.js";
import { CuratedKnowledgeToolAuthority } from "../storage/curated-knowledge-tools.js";
import type { CuratedKnowledgeReader } from "../storage/curated-knowledge-reader.js";

export class FixtureCuratedKnowledgeRunner implements KnowledgeAnswerRunner {
  readonly #reader: CuratedKnowledgeReader;
  readonly #delayMs: number;

  constructor(reader: CuratedKnowledgeReader, delayMs = 0) {
    this.#reader = reader;
    this.#delayMs = delayMs;
  }

  async answer(input: Parameters<KnowledgeAnswerRunner["answer"]>[0]): Promise<KnowledgeAnswer> {
    await delay(this.#delayMs, input.signal);
    if (input.conversation.length > 0 && /^(这里|上面|换句话|也就是说|继续|为什么|什么意思)/u.test(input.question.trim())) {
      return fallback("conversation-context", "这是结合当前成功对话给出的进一步说明。", false);
    }
    const authority = new CuratedKnowledgeToolAuthority(this.#reader);
    const queries = fixtureQueries(input.question);
    const candidates = new Map<string, ReturnType<typeof authority.search>["results"][number]>();
    for (const query of queries) {
      for (const result of authority.search({ query, limit: 30 }).results) candidates.set(result.handle, result);
    }
    if (candidates.size === 0) {
      return { ...fallback("model-knowledge",
        `知识库检索没有找到可用证据。关于“${input.question}”，这是 Codex 的通用回答。`, true),
        retrievalSummary: authority.summary() };
    }
    const citations = [...candidates.values()].slice(0, 3).flatMap((candidate) => {
      const opened = authority.open(candidate.handle);
      const located = firstCitableLine(opened.sections);
      return located ? [authority.verify({ handle: candidate.handle, locator: located.locator,
        quote: located.quote, whySelected: "该段是与问题直接相关的 curated knowledge 原文。" })] : [];
    });
    if (citations.length === 0) {
      return { ...fallback("model-knowledge",
        `知识库检索没有找到可引用的有效段落。关于“${input.question}”，这是 Codex 的通用回答。`, true),
        retrievalSummary: authority.summary() };
    }
    return {
      answerBasis: "curated-evidence", coverage: "supported",
      directAnswer: citations.map((citation) => citation.quote).join("\n\n"),
      claims: citations.map((citation, index) => ({ text: citation.quote, status: "source-supported" as const,
        citationOrdinals: [index + 1] })),
      disagreements: [], unknowns: [], citations, retrievalSummary: authority.summary(),
    };
  }
}

function fixtureQueries(question: string): string[] {
  const normalized = question.trim();
  const expansions = [
    ...(/灵巧手|灵巧操作|dexter/iu.test(normalized) ? ["dexterous manipulation"] : []),
    ...(/\bRL\b|强化学习/iu.test(normalized) ? ["reinforcement learning"] : []),
  ];
  const terms = normalized.match(/[A-Za-z][A-Za-z0-9_.-]{2,}|[\p{Script=Han}]{2,8}/gu) ?? [];
  const distinct = [...new Set([normalized, ...expansions, ...terms].filter(Boolean))];
  return distinct.slice(0, Math.max(2, Math.min(8, distinct.length)));
}

function firstCitableLine(sections: Array<{ locator: { lineStart: number }; text: string }>):
  { locator: { lineStart: number; lineEnd: number }; quote: string } | null {
  for (const section of sections) {
    const lines = section.text.split("\n");
    const index = lines.findIndex((line) => {
      const value = line.trim();
      return value.length >= 8 && !value.startsWith("#") && value !== "---" && !/^[\w-]+:\s/u.test(value);
    });
    if (index >= 0) {
      const line = section.locator.lineStart + index;
      return { locator: { lineStart: line, lineEnd: line }, quote: lines[index]!.trim() };
    }
  }
  return null;
}

function fallback(answerBasis: "model-knowledge" | "conversation-context", directAnswer: string,
  searched: boolean): KnowledgeAnswer {
  return { answerBasis, coverage: "none", directAnswer, claims: [], disagreements: [], unknowns: [], citations: [],
    retrievalSummary: { searched, queryCount: searched ? 1 : 0, candidateCount: 0, openedSourceCount: 0,
      usedSourceCount: 0, budgetExhausted: false, projectionStale: false, lastSuccessfulAt: null } };
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  });
}
