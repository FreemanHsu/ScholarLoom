import { describe, expect, it } from "vitest";

import type { KnowledgeAnswer } from "../src/agent/knowledge-answer.js";
import { preflightCuratedKnowledgeAnswer } from "../src/agent/curated-knowledge-answer-preflight.js";
import { CuratedKnowledgeToolAuthority } from "../src/storage/curated-knowledge-tools.js";
import { curatedKnowledgeFixture } from "./helpers/curated-knowledge-fixture.js";

describe("curated knowledge answer preflight", () => {
  it("accepts only invocation-verified receipts and uses the authority retrieval summary", async () => {
    const fixture = await curatedKnowledgeFixture([{ sourceId: "summary-1", title: "Diffusion",
      body: "反向过程逐步去噪。" }, { sourceId: "summary-2", title: "Diffusion Alternative",
      body: "反向过程逐步去噪。" }]);
    const authority = new CuratedKnowledgeToolAuthority(fixture.reader);
    const results = authority.search({ query: "反向过程" }).results;
    const found = results[0]!;
    authority.open(found.handle);
    const receipt = authority.verify({ handle: found.handle, locator: { lineStart: 3, lineEnd: 3 },
      quote: "反向过程逐步去噪。", whySelected: "直接支持生成过程。" });
    const answer = groundedAnswer(receipt);
    authority.open(results[1]!.handle);
    authority.verify({ handle: results[1]!.handle, locator: { lineStart: 3, lineEnd: 3 },
      quote: "反向过程逐步去噪。", whySelected: "另一个未被最终采用的来源。" });

    const accepted = preflightCuratedKnowledgeAnswer(answer, authority.snapshot(), fixture.reader);

    expect(accepted.citations).toEqual([receipt]);
    expect(accepted.retrievalSummary).toMatchObject({ searched: true, queryCount: 1,
      candidateCount: 2, openedSourceCount: 2, usedSourceCount: 1 });
    expect(() => preflightCuratedKnowledgeAnswer({ ...answer,
      citations: [{ ...receipt, quote: "伪造引文" }] }, authority.snapshot(), fixture.reader))
      .toThrow("knowledge-answer-citation-not-verified");
    fixture.close();
  });
});

function groundedAnswer(citation: KnowledgeAnswer["citations"][number]): KnowledgeAnswer {
  return { answerBasis: "curated-evidence", coverage: "supported", directAnswer: "反向过程逐步去噪。",
    claims: [{ text: "反向过程逐步去噪。", status: "source-supported", citationOrdinals: [1] }],
    disagreements: [], unknowns: [], citations: [citation],
    retrievalSummary: { searched: false, queryCount: 0, candidateCount: 0, openedSourceCount: 0,
      usedSourceCount: 0, budgetExhausted: false, projectionStale: false, lastSuccessfulAt: null } };
}
