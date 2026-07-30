import type { AbstentionReason, EpistemicStatus, TakeawayKind } from "../agent/takeaway-distillation.js";

export type TakeawayQualityFixture = {
  id: string;
  category: string;
  question: string;
  answer: string;
  receipts: Array<{ id: string; quote: string }>;
  summary: string;
  confirmedTakeaways: Array<{ revisionId: string; claim: string }>;
  gold: { decision: "no-proposal"; reasonCode: AbstentionReason } | {
    decision: "candidate";
    kind: TakeawayKind;
    epistemicStatus: EpistemicStatus;
    rubric: { standalone: true; singleConclusion: true; evidenceEntails: true; calibrated: true; duplicateCorrect: true };
  };
};

const bases: Array<Omit<TakeawayQualityFixture, "id">> = [
  { category: "factual-lookup", question: "这篇论文用了多少层？", answer: "Appendix A reports 12 layers.",
    receipts: [{ id: "r1", quote: "We use 12 layers." }], summary: "Architecture overview.", confirmedTakeaways: [],
    gold: { decision: "no-proposal", reasonCode: "not-durable" } },
  { category: "procedural-walkthrough", question: "按 Figure 2 逐步解释 pipeline。", answer: "先编码，再路由，最后解码。",
    receipts: [{ id: "r1", quote: "encode, route, decode" }], summary: "Three-stage pipeline.", confirmedTakeaways: [],
    gold: { decision: "no-proposal", reasonCode: "not-durable" } },
  { category: "integrated-mechanism", question: "为什么这个方法能减少 drift？",
    answer: "Method M freezes the source version before deriving an update, so later source changes cannot reinterpret the recorded conclusion.",
    receipts: [{ id: "r1", quote: "the source version is fixed before derivation" }], summary: "Method M prevents drift.",
    confirmedTakeaways: [], gold: { decision: "candidate", kind: "mechanism", epistemicStatus: "evidence-backed",
      rubric: { standalone: true, singleConclusion: true, evidenceEntails: true, calibrated: true, duplicateCorrect: true } } },
  { category: "misconception-correction", question: "所以 ablation 证明模块 X 总是有效？",
    answer: "No. Paper P shows X helps only on the long-context split; the short-context baseline is statistically tied.",
    receipts: [{ id: "r1", quote: "X improves long context; short context differences are not significant" }],
    summary: "X improves the benchmark.", confirmedTakeaways: [],
    gold: { decision: "candidate", kind: "correction", epistemicStatus: "evidence-backed",
      rubric: { standalone: true, singleConclusion: true, evidenceEntails: true, calibrated: true, duplicateCorrect: true } } },
  { category: "missing-baseline", question: "这个 91.2 是否说明方法最好？", answer: "The paper reports 91.2 but does not include the required baseline.",
    receipts: [{ id: "r1", quote: "accuracy is 91.2" }], summary: "Accuracy 91.2.", confirmedTakeaways: [],
    gold: { decision: "no-proposal", reasonCode: "insufficient-evidence" } },
  { category: "dangling-reference", question: "核心机制是什么？", answer: "It improves the result because this method preserves it.",
    receipts: [{ id: "r1", quote: "the method preserves state" }], summary: "State preservation.", confirmedTakeaways: [],
    gold: { decision: "no-proposal", reasonCode: "not-durable" } },
  { category: "unsupported-generalization", question: "能否推广到所有领域？", answer: "The experiment covers one English dataset; broader generalization is a hypothesis.",
    receipts: [{ id: "r1", quote: "evaluated on one English dataset" }], summary: "One-dataset experiment.", confirmedTakeaways: [],
    gold: { decision: "candidate", kind: "limitation", epistemicStatus: "evidence-backed",
      rubric: { standalone: true, singleConclusion: true, evidenceEntails: true, calibrated: true, duplicateCorrect: true } } },
  { category: "conflicting-evidence", question: "X 是否稳定提升？", answer: "Table 2 improves, but Appendix C degrades on the same metric.",
    receipts: [{ id: "r1", quote: "Table 2: +2.1" }, { id: "r2", quote: "Appendix C: -1.4" }],
    summary: "Mixed results.", confirmedTakeaways: [],
    gold: { decision: "no-proposal", reasonCode: "insufficient-evidence" } },
  { category: "summary-duplicate", question: "这个结论值得保存吗？", answer: "The answer repeats the active Summary verbatim.",
    receipts: [{ id: "r1", quote: "Method M freezes source identity." }], summary: "Method M freezes source identity.",
    confirmedTakeaways: [], gold: { decision: "no-proposal", reasonCode: "duplicate" } },
  { category: "takeaway-duplicate", question: "再次保存这个机制。", answer: "Paper P freezes source identity before derivation.",
    receipts: [{ id: "r1", quote: "source identity is frozen before derivation" }], summary: "Mechanism.",
    confirmedTakeaways: [{ revisionId: "takeaway:r1", claim: "Paper P freezes source identity before derivation." }],
    gold: { decision: "no-proposal", reasonCode: "duplicate" } },
  { category: "strong-limitation", question: "最大的适用边界是什么？",
    answer: "Paper P's guarantee assumes an immutable source manifest and does not cover mutable external URLs.",
    receipts: [{ id: "r1", quote: "guarantee requires an immutable source manifest" }], summary: "Guarantee.",
    confirmedTakeaways: [], gold: { decision: "candidate", kind: "limitation", epistemicStatus: "evidence-backed",
      rubric: { standalone: true, singleConclusion: true, evidenceEntails: true, calibrated: true, duplicateCorrect: true } } },
  { category: "explicit-save-high-value", question: "把这条复用启示保存下来。",
    answer: "For future implementations, Paper P suggests freezing provenance inputs before asynchronous derivation; applying that pattern elsewhere is an interpretation.",
    receipts: [{ id: "r1", quote: "provenance inputs are frozen before asynchronous derivation" }], summary: "Provenance pattern.",
    confirmedTakeaways: [], gold: { decision: "candidate", kind: "reuse-implication", epistemicStatus: "interpretation",
      rubric: { standalone: true, singleConclusion: true, evidenceEntails: true, calibrated: true, duplicateCorrect: true } } },
];

export const TAKEAWAY_QUALITY_FIXTURE_VERSION = "takeaway-quality-fixtures.v1";
export const takeawayQualityFixtures: TakeawayQualityFixture[] = bases.flatMap((base, baseIndex) =>
  [1, 2, 3].map((variant) => ({ ...base, id: `tq-${String(baseIndex + 1).padStart(2, "0")}-v${variant}`,
    question: `${base.question} [synthetic variant ${variant}]` })));
