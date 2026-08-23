import { describe, expect, it } from "vitest";

import { FixtureCuratedKnowledgeRunner } from "../src/agent/fixture-curated-knowledge-runner.js";
import { curatedKnowledgeFixture } from "./helpers/curated-knowledge-fixture.js";

describe("FixtureCuratedKnowledgeRunner", () => {
  it("models iterative broad retrieval beyond eight candidates and skips search for a context-only turn", async () => {
    const fixture = await curatedKnowledgeFixture(Array.from({ length: 12 }, (_, index) => ({
      sourceId: `summary-${index}`, title: `WorldModel ${index}`,
      body: `WorldModel evidence ${index} supports planning.`,
    })));
    const runner = new FixtureCuratedKnowledgeRunner(fixture.reader);
    const grounded = await runner.answer({ question: "WorldModel planning 有哪些证据？", conversation: [],
      attemptId: "a", jobRunId: "j", runEpoch: 1, signal: new AbortController().signal });
    expect(grounded).toMatchObject({ answerBasis: "curated-evidence", coverage: "supported",
      retrievalSummary: { searched: true, candidateCount: 12 } });
    expect(grounded.retrievalSummary.queryCount).toBeGreaterThan(1);
    expect(grounded.citations).toHaveLength(3);

    const context = await runner.answer({ question: "这里是什么意思？",
      conversation: [{ role: "assistant", content: grounded.directAnswer }],
      attemptId: "b", jobRunId: "k", runEpoch: 1, signal: new AbortController().signal });
    expect(context).toMatchObject({ answerBasis: "conversation-context",
      retrievalSummary: { searched: false, queryCount: 0 } });
    expect(context.citations).toEqual([]);
    fixture.close();
  });

  it("models bilingual query reformulation for a dexterous manipulation RL question", async () => {
    const fixture = await curatedKnowledgeFixture([
      { sourceId: "summary-adept",
        title: "ADEPT: Accelerating Dexterity via Pre-Training and Post-Training using Reinforcement Learning",
        body: "ADEPT combines dexterous manipulation pre-training with reinforcement learning post-training." },
      { sourceId: "summary-dexterity", title: "Visual Dexterity",
        body: "Visual dexterous manipulation uses imitation learning without policy post-training." },
    ]);
    const runner = new FixtureCuratedKnowledgeRunner(fixture.reader);

    const answer = await runner.answer({ question: "灵巧手操作的工作，有哪些使用 RL 的方向的参考？",
      conversation: [], attemptId: "adept", jobRunId: "job-adept", runEpoch: 1,
      signal: new AbortController().signal });

    expect(answer).toMatchObject({ answerBasis: "curated-evidence", retrievalSummary: { searched: true } });
    expect(answer.citations.some((citation) => citation.title.startsWith("ADEPT:"))).toBe(true);
    fixture.close();
  });
});
