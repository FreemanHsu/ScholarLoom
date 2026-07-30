import { describe, expect, it } from "vitest";

import type { DistillationSelection } from "../src/agent/takeaway-distillation.js";
import { evaluateTakeawayQuality } from "../src/evaluation/takeaway-quality-evaluator.js";
import { takeawayQualityFixtures } from "../src/evaluation/takeaway-quality-fixtures.js";

function goldSelection(index: number): DistillationSelection {
  const fixture = takeawayQualityFixtures[index]!;
  if (fixture.gold.decision === "no-proposal") return { decision: "no-proposal",
    reasonCode: fixture.gold.reasonCode, rationale: "Blind fixture output matches the durable abstention category." };
  return { decision: "candidate", candidate: {
    kind: fixture.gold.kind,
    claim: `Paper P 在 synthetic fixture ${fixture.id} 中形成一条具备明确主体、条件、结论与适用边界的完整 durable conclusion。`,
    epistemicStatus: fixture.gold.epistemicStatus,
    evidenceRationale: "冻结的 synthetic Evidence Receipt 直接支持这条有边界的结论。",
    caveat: "只适用于该 synthetic fixture 的明确条件。",
    receiptIds: fixture.receipts.map((receipt) => receipt.id),
    selectionRationale: "该结论脱离原问题后仍完整可读，并具有长期复用价值。",
    duplicateHints: [],
  } };
}

describe("Takeaway quality release evaluator", () => {
  it("keeps a versioned 36-case corpus with three variants in every required category", () => {
    expect(takeawayQualityFixtures).toHaveLength(36);
    const categories = new Map<string, number>();
    for (const fixture of takeawayQualityFixtures) categories.set(fixture.category,
      (categories.get(fixture.category) ?? 0) + 1);
    expect(categories.size).toBe(12);
    expect([...categories.values()]).toEqual(new Array(12).fill(3));
  });

  it("requires three runs, complete blind grading, hard thresholds, and zero dangerous miscalibration", () => {
    const observations = takeawayQualityFixtures.map((fixture, index) => ({ fixture,
      runs: [1, 2, 3].map(() => ({ selection: goldSelection(index),
        blindGrade: fixture.gold.decision === "candidate" ? {
          standalone: true, evidenceEntails: true, calibrated: true, duplicateCorrect: true,
        } : null })) }));
    expect(evaluateTakeawayQuality(observations)).toMatchObject({ fixtureCount: 36, blindComplete: true,
      released: true, metrics: { decisionAccuracy: 1, abstentionAccuracy: 1, referentialFragments: 0,
        standaloneQuality: 1, evidenceEntailment: 1, dangerousMiscalibration: 0, totalRuns: 108 } });
    observations.find((item) => item.fixture.gold.decision === "candidate")!.runs[0]!.blindGrade = null;
    expect(evaluateTakeawayQuality(observations)).toMatchObject({ blindComplete: false, released: false });
  });
});
