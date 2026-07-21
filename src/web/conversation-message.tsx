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

export type ConversationProposal = { id: string; claim: string; legacySource: boolean };

export function ConversationProposalGroup(props: {
  proposals: ConversationProposal[];
  onAccept(proposal: ConversationProposal): void;
  onEdit(proposal: ConversationProposal): void;
  onReject(proposal: ConversationProposal): void;
}) {
  if (props.proposals.length === 0) return null;
  return <details className="conversation-proposals">
    <summary><span>{props.proposals.length} 个 Takeaway 待审核</span></summary>
    <div className="conversation-proposal-list">{props.proposals.map((proposal) => <article key={proposal.id}>
      <p>{proposal.claim}</p>
      <div className="conversation-proposal-actions">
        {!proposal.legacySource && <>
          <button className="primary" onClick={() => props.onAccept(proposal)}>确认</button>
          <button onClick={() => props.onEdit(proposal)}>编辑</button>
        </>}
        <button className="danger" onClick={() => props.onReject(proposal)}>拒绝</button>
      </div>
    </article>)}</div>
  </details>;
}
