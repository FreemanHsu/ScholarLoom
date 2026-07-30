import { useState } from "react";

import { SummaryMarkdown } from "./summary-markdown.js";

export function ConversationMessageBody(props: {
  role: "user" | "assistant";
  content: string;
  pageCount: number;
  onOpenEvidence(page: number): void;
}) {
  if (props.role === "user") return <p>{props.content}</p>;
  return <div className="conversation-markdown"><SummaryMarkdown markdown={props.content}
    pageCount={props.pageCount} onOpenEvidence={props.onOpenEvidence} /></div>;
}

export type ConversationProposal = {
  id: string;
  legacySource: boolean;
  title?: string;
  kind?: string;
  claim: string;
  epistemicStatus?: string;
  evidenceRationale?: string;
  caveat?: string | null;
  receiptIds?: string[];
  selectionRationale?: string;
  duplicateHints?: string[];
  liveDuplicateIds?: string[];
  duplicateAcknowledgementRequired?: boolean;
  contractVersion?: string;
  sourceConversationHref?: string | null;
  distillationJobRunId?: string;
  distillationState?: string | null;
};

export type TakeawayDecisionInput = {
  edited?: Partial<{ title: string; claim: string; evidenceRationale: string; caveat: string | null;
    receiptIds: string[]; epistemicStatus: "evidence-backed" | "interpretation" | "hypothesis" }>;
  evidenceReviewed?: boolean;
  duplicateAcknowledged?: boolean;
  rejectReason?: string;
};

const kindLabels: Record<string, string> = {
  correction: "纠正", mechanism: "机制", finding: "发现", limitation: "局限",
  comparison: "比较", "reuse-implication": "复用启示",
};
const epistemicLabels: Record<string, string> = {
  "evidence-backed": "证据支持", interpretation: "解释", hypothesis: "假设",
};

export function TakeawayReviewCard(props: {
  proposal: ConversationProposal;
  compact?: boolean;
  onDecide(proposal: ConversationProposal, action: "accept" | "edit-and-accept" | "reject",
    input?: TakeawayDecisionInput): void;
}) {
  const proposal = props.proposal;
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(proposal.title ?? proposal.claim);
  const [claim, setClaim] = useState(proposal.claim);
  const [evidenceRationale, setEvidenceRationale] = useState(proposal.evidenceRationale ?? "");
  const [caveat, setCaveat] = useState(proposal.caveat ?? "");
  const [epistemicStatus, setEpistemicStatus] = useState(proposal.epistemicStatus ?? "evidence-backed");
  const [receiptIds, setReceiptIds] = useState(proposal.receiptIds ?? []);
  const [evidenceReviewed, setEvidenceReviewed] = useState(false);
  const [duplicateAcknowledged, setDuplicateAcknowledged] = useState(false);
  const [rejectReason, setRejectReason] = useState("useful-answer-not-knowledge");
  const sensitiveChanged = claim.trim() !== proposal.claim ||
    evidenceRationale.trim() !== (proposal.evidenceRationale ?? "") ||
    epistemicStatus !== (proposal.epistemicStatus ?? "evidence-backed") ||
    JSON.stringify(receiptIds) !== JSON.stringify(proposal.receiptIds ?? []);
  const editPayload = () => {
    const edited: NonNullable<TakeawayDecisionInput["edited"]> = {};
    if (title.trim() !== (proposal.title ?? proposal.claim)) edited.title = title.trim();
    if (claim.trim() !== proposal.claim) edited.claim = claim.trim();
    if (evidenceRationale.trim() !== (proposal.evidenceRationale ?? "")) edited.evidenceRationale = evidenceRationale.trim();
    if ((caveat.trim() || null) !== (proposal.caveat ?? null)) edited.caveat = caveat.trim() || null;
    if (epistemicStatus !== (proposal.epistemicStatus ?? "evidence-backed")) {
      edited.epistemicStatus = epistemicStatus as "evidence-backed" | "interpretation" | "hypothesis";
    }
    if (JSON.stringify(receiptIds) !== JSON.stringify(proposal.receiptIds ?? [])) edited.receiptIds = receiptIds;
    return edited;
  };
  return <article className={`takeaway-review-card ${props.compact ? "compact" : ""}`}>
    <header><div className="takeaway-review-labels">
      <span>{kindLabels[proposal.kind ?? ""] ?? proposal.kind ?? "Takeaway"}</span>
      <span>{epistemicLabels[proposal.epistemicStatus ?? ""] ?? proposal.epistemicStatus}</span>
      {proposal.contractVersion && <span>{proposal.contractVersion}</span>}
    </div><h3>{proposal.title ?? proposal.claim}</h3></header>
    {(proposal.sourceConversationHref || proposal.distillationJobRunId) && <section className="takeaway-provenance">
      <h4>来源与生成状态</h4>
      <p>{proposal.sourceConversationHref
        ? <a href={proposal.sourceConversationHref}>查看来源 Conversation</a> : "来源 Conversation 不可用"}
        {proposal.distillationJobRunId && <> · Selection {proposal.distillationState ?? "unknown"} · <code>{proposal.distillationJobRunId}</code></>}</p>
    </section>}
    <section><h4>独立结论</h4><p>{proposal.claim}</p></section>
    {proposal.evidenceRationale && <section><h4>证据如何支持</h4><p>{proposal.evidenceRationale}</p></section>}
    <section><h4>Evidence Receipts</h4><div className="receipt-review-list">
      {(proposal.receiptIds ?? []).map((id) => <a key={id} href={`/api/evidence/${encodeURIComponent(id)}`}
        target="_blank" rel="noopener noreferrer">{id}</a>)}
    </div></section>
    {proposal.caveat && <section><h4>边界或限制</h4><p>{proposal.caveat}</p></section>}
    {!props.compact && proposal.selectionRationale && <details><summary>为什么达到 Proposal 门槛</summary>
      <p>{proposal.selectionRationale}</p></details>}
    {(proposal.duplicateHints?.length || proposal.liveDuplicateIds?.length) ? <section className="duplicate-warning">
      <h4>可能重复</h4><p>冻结提示：{proposal.duplicateHints?.join("、") || "无"}；当前知识：{proposal.liveDuplicateIds?.join("、") || "无"}。</p>
      <label><input type="checkbox" checked={duplicateAcknowledged}
        onChange={(event) => setDuplicateAcknowledged(event.target.checked)} /> 我已比较，仍要保留这条结论</label>
    </section> : null}
    {editing && <div className="structured-takeaway-editor">
      <label>标题<input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
      <label>独立结论<textarea value={claim} onChange={(event) => setClaim(event.target.value)} /></label>
      <label>证据如何支持<textarea value={evidenceRationale}
        onChange={(event) => setEvidenceRationale(event.target.value)} /></label>
      <label>边界或限制<textarea value={caveat} onChange={(event) => setCaveat(event.target.value)} /></label>
      <label>认识状态<select value={epistemicStatus} onChange={(event) => setEpistemicStatus(event.target.value)}>
        <option value="evidence-backed">证据支持</option><option value="interpretation">解释</option>
        <option value="hypothesis">假设</option></select></label>
      <fieldset><legend>用于确认的 Evidence Receipts</legend>{(proposal.receiptIds ?? []).map((id) =>
        <label key={id}><input type="checkbox" checked={receiptIds.includes(id)} onChange={(event) =>
          setReceiptIds((current) => event.target.checked ? [...current, id] : current.filter((item) => item !== id))} /> {id}</label>)}</fieldset>
      {(sensitiveChanged || epistemicStatus !== "evidence-backed") && <label><input type="checkbox"
        checked={evidenceReviewed} onChange={(event) => setEvidenceReviewed(event.target.checked)} />
        我已重新检查完整证据与所有 Receipt</label>}
    </div>}
    <div className="conversation-proposal-actions">
      {!proposal.legacySource && <button className="primary"
        disabled={Boolean(proposal.duplicateAcknowledgementRequired && !duplicateAcknowledged)}
        onClick={() => props.onDecide(proposal, "accept", { duplicateAcknowledged })}>确认</button>}
      {!proposal.legacySource && <button onClick={() => {
        if (!editing) { setEditing(true); return; }
        props.onDecide(proposal, "edit-and-accept", { edited: editPayload(), evidenceReviewed, duplicateAcknowledged });
      }}>{editing ? "保存并确认" : "结构化编辑"}</button>}
      <select aria-label="拒绝原因" value={rejectReason} onChange={(event) => setRejectReason(event.target.value)}>
        <option value="useful-answer-not-knowledge">有用回答，但不是长期知识</option>
        <option value="context-incomplete">上下文不完整</option>
        <option value="incorrect-or-unsupported">不正确或证据不足</option>
        <option value="duplicate">重复</option><option value="too-broad">过于宽泛</option>
        <option value="too-trivial">过于琐碎</option><option value="other">其他</option>
      </select>
      <button className="danger" onClick={() => props.onDecide(proposal, "reject", { rejectReason })}>拒绝</button>
    </div>
    {proposal.legacySource && <p className="inline-alert">旧 Conversation 来源不完整，只能拒绝，不能确认。</p>}
  </article>;
}

export function ConversationProposalGroup(props: {
  proposals: ConversationProposal[];
  onDecide(proposal: ConversationProposal, action: "accept" | "edit-and-accept" | "reject",
    input?: TakeawayDecisionInput): void;
}) {
  if (props.proposals.length === 0) return null;
  return <details className="conversation-proposals">
    <summary><span>{props.proposals.length} 个 Takeaway 待审核</span></summary>
    <div className="conversation-proposal-list">{props.proposals.map((proposal) =>
      <TakeawayReviewCard compact key={proposal.id} proposal={proposal} onDecide={props.onDecide} />)}</div>
  </details>;
}
