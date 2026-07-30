import type { DistillationSelection } from "../agent/takeaway-distillation.js";
import type { TakeawayQualityFixture } from "./takeaway-quality-fixtures.js";

export type BlindGrade = {
  standalone: boolean;
  evidenceEntails: boolean;
  calibrated: boolean;
  duplicateCorrect: boolean;
};
export type EvaluationObservation = {
  fixture: TakeawayQualityFixture;
  runs: Array<{ selection: DistillationSelection; blindGrade: BlindGrade | null }>;
};

export function evaluateTakeawayQuality(observations: EvaluationObservation[]) {
  const runs = observations.flatMap((observation) => observation.runs.map((run) => ({ ...run, fixture: observation.fixture })));
  const decisionCorrect = runs.filter(({ fixture, selection }) => fixture.gold.decision === selection.decision).length;
  const abstentions = runs.filter(({ fixture }) => fixture.gold.decision === "no-proposal");
  const abstentionCorrect = abstentions.filter(({ fixture, selection }) =>
    selection.decision === "no-proposal" && fixture.gold.decision === "no-proposal" &&
    selection.reasonCode === fixture.gold.reasonCode).length;
  const candidates = runs.filter(({ fixture }) => fixture.gold.decision === "candidate");
  const gradedCandidates = candidates.filter((run) => run.blindGrade !== null);
  const referentialFragments = runs.filter(({ selection }) => selection.decision === "candidate" &&
    /^(?:it|its|this method|this approach|其|该方法|这种方法)(?:\s|，|,)/iu.test(selection.candidate.claim)).length;
  const dangerousMiscalibration = runs.filter(({ fixture, selection }) => fixture.gold.decision === "candidate" &&
    fixture.gold.epistemicStatus !== "evidence-backed" && selection.decision === "candidate" &&
    selection.candidate.epistemicStatus === "evidence-backed").length;
  const ratio = (numerator: number, denominator: number) => denominator === 0 ? null : numerator / denominator;
  const metrics = {
    decisionAccuracy: ratio(decisionCorrect, runs.length),
    abstentionAccuracy: ratio(abstentionCorrect, abstentions.length),
    referentialFragments,
    standaloneQuality: ratio(gradedCandidates.filter((run) => run.blindGrade!.standalone).length, gradedCandidates.length),
    evidenceEntailment: ratio(gradedCandidates.filter((run) => run.blindGrade!.evidenceEntails).length, gradedCandidates.length),
    dangerousMiscalibration,
    blindGradedRuns: gradedCandidates.length,
    totalRuns: runs.length,
  };
  const blindComplete = gradedCandidates.length === candidates.length;
  return { fixtureCount: observations.length, blindComplete, metrics,
    released: observations.length >= 36 && runs.length === observations.length * 3 && blindComplete &&
      (metrics.decisionAccuracy ?? 0) >= .85 && (metrics.abstentionAccuracy ?? 0) >= .90 &&
      metrics.referentialFragments === 0 && (metrics.standaloneQuality ?? 0) >= .90 &&
      (metrics.evidenceEntailment ?? 0) >= .90 && metrics.dangerousMiscalibration === 0 };
}
