import { describe, expect, it } from "vitest";

import { CuratedKnowledgeToolAuthority } from "../src/storage/curated-knowledge-tools.js";
import { curatedKnowledgeFixture } from "./helpers/curated-knowledge-fixture.js";

describe("invocation-local curated knowledge tools", () => {
  it("supports iterative retrieval beyond eight candidates while enforcing opaque handles and budgets", async () => {
    const fixture = await curatedKnowledgeFixture([
      ...Array.from({ length: 30 }, (_, index) => fixtureDocument(`alpha-${index}`, "alpha shared evidence")),
      ...Array.from({ length: 15 }, (_, index) => fixtureDocument(`beta-${index}`, "beta independent evidence")),
    ]);
    const tools = new CuratedKnowledgeToolAuthority(fixture.reader);

    const alpha = tools.search({ query: "alpha", limit: 30 });
    const beta = tools.search({ query: "beta", limit: 30 });

    expect(alpha.results).toHaveLength(30);
    expect(beta.results).toHaveLength(15);
    expect(new Set([...alpha.results, ...beta.results].map((result) => result.handle)).size).toBe(45);
    expect(tools.summary()).toMatchObject({ searched: true, queryCount: 2, candidateCount: 45,
      openedSourceCount: 0, usedSourceCount: 0, budgetExhausted: false });
    expect(() => tools.open("curated:summary:forged:0000000000000000"))
      .toThrow("curated-tool-handle-foreign");

    const opened = tools.open(alpha.results[0]!.handle);
    const citation = tools.verify({
      handle: opened.handle,
      locator: { lineStart: 3, lineEnd: 3 },
      quote: "alpha shared evidence",
      whySelected: "直接说明 shared evidence。",
    });
    expect(citation).toMatchObject({ sourceId: "alpha-0", quote: "alpha shared evidence",
      whySelected: "直接说明 shared evidence。" });
    expect(tools.summary()).toMatchObject({ openedSourceCount: 1, usedSourceCount: 1 });

    for (let count = 0; count < 6; count += 1) tools.search({ query: "alpha", limit: 30 });
    expect(() => tools.search({ query: "alpha", limit: 30 })).toThrow("curated-search-budget-exhausted");
    expect(tools.summary()).toMatchObject({ queryCount: 8, candidateCount: 45, budgetExhausted: true });
    const configured = new CuratedKnowledgeToolAuthority(fixture.reader, { searchCalls: 2 });
    configured.search({ query: "alpha" });
    configured.search({ query: "alpha" });
    expect(() => configured.search({ query: "alpha" })).toThrow("curated-search-budget-exhausted");
    fixture.close();
  });
});

function fixtureDocument(sourceId: string, body: string) {
  return {
    sourceId,
    title: sourceId,
    body,
  };
}
