import { useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";

export type ConversationAction = "rename" | "archive" | "restore";

export function conversationActionRequest(action: ConversationAction, title?: string): RequestInit {
  if (action !== "rename") return { method: "POST" };
  return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title }) };
}

export function filterConversationsByArchive<T extends { status: "active" | "archived" }>(
  conversations: T[], showArchived: boolean,
): T[] {
  return conversations.filter((conversation) => (conversation.status === "archived") === showArchived);
}

export function canContinueConversation(input: { archived: boolean; legacy: boolean; messageCount: number }): boolean {
  return input.archived || input.legacy || input.messageCount > 0;
}

export function NewConversationButton({ onCreate }: { onCreate(): void }) {
  return <button className="new-conversation-button" type="button" onClick={onCreate}>独立新对话</button>;
}

export function conversationListStatus(input: { archived: boolean; legacy: boolean; successor: boolean }): string {
  if (input.archived) return input.successor ? "关联后继 · 已归档" : "已归档";
  if (input.legacy) return "Legacy · 只读";
  return input.successor ? "关联后继 · 上下文已冻结" : "上下文已冻结";
}

type ConversationLineageRef = { id: string; title: string; status: string };
type AuditIdentity = { id?: string; contentHash?: string; outputHash?: string | null };
type RepositoryAudit = { repositoryId?: string; name?: string; commitSha?: string };
type ContextComparison = { status: string; identical?: boolean; diff?: {
  paperVersion?: { status: string; before?: AuditIdentity; after?: AuditIdentity };
  summaryRevision?: { status: string; before?: AuditIdentity; after?: AuditIdentity };
  extractionRun?: { status: string; before?: AuditIdentity; after?: AuditIdentity; equalityBasis?: string };
  repositories?: { status: string; added?: RepositoryAudit[]; removed?: RepositoryAudit[];
    changed?: Array<{ repositoryId?: string; before?: RepositoryAudit; after?: RepositoryAudit }>;
    unchanged?: RepositoryAudit[] };
  knowledgeCorpus?: { status: string; reason?: string; before?: { id?: string; hash?: string };
    after?: { id?: string; hash?: string } };
} };
export type ConversationLineage = {
  conversation: ConversationLineageRef;
  parent: ConversationLineageRef | null;
  ancestors: ConversationLineageRef[];
  successors: ConversationLineageRef[];
  contextComparison: ContextComparison;
  integrityWarning?: string;
};

function contextChangeLabels(comparison: ContextComparison): string[] {
  if (comparison.status === "independent") return ["独立新对话，没有父 Context Snapshot"];
  if (comparison.status !== "available" || !comparison.diff) return ["Context Diff 不可用"];
  if (comparison.identical) return ["当前冻结材料与父 Conversation 完全相同"];
  const labels: string[] = [];
  if (comparison.diff.paperVersion?.status === "changed") labels.push("Paper 已变化");
  if (comparison.diff.summaryRevision?.status === "changed") labels.push("Summary 已变化");
  const repositories = comparison.diff.repositories;
  if (repositories?.status === "unavailable") labels.push("Code 比较不可用");
  else if ((repositories?.added?.length ?? 0) + (repositories?.removed?.length ?? 0) +
    (repositories?.changed?.length ?? 0) > 0) labels.push("Code 已变化");
  if (comparison.diff.knowledgeCorpus?.status === "changed") labels.push("Knowledge 已变化");
  if (comparison.diff.knowledgeCorpus?.status === "unavailable") labels.push("Knowledge 比较不可用");
  if (labels.length === 0 && comparison.diff.extractionRun?.status === "changed") labels.push("Extraction 已变化");
  return labels;
}

export function ConversationHeaderActions({ repositorySnapshotCount, isSuccessor, archived, canContinue, legacy,
  lineage, conversationHref, onNavigate, onContinue, onRename, onToggleArchive }: {
  repositorySnapshotCount: number;
  isSuccessor: boolean;
  archived: boolean;
  canContinue: boolean;
  legacy: boolean;
  lineage?: ConversationLineage | null;
  conversationHref?(conversationId: string): string;
  onNavigate?(href: string): void;
  onContinue(): void;
  onRename(): void;
  onToggleArchive(): void;
}) {
  const tooltipId = useId();
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const [lineageOpen, setLineageOpen] = useState(false);
  const lineageTrigger = useRef<HTMLButtonElement>(null);
  const lineagePanel = useRef<HTMLElement>(null);
  const lineageClose = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (lineageOpen) lineageClose.current?.focus();
  }, [lineageOpen]);
  const continuationHelp = legacy
    ? "创建可继续讨论的关联 Conversation，并冻结当前最新材料。"
    : "重新冻结最新 Paper、Summary、代码与已确认知识；当前对话及其证据保持冻结。";
  const navigateLink = (event: MouseEvent<HTMLAnchorElement>, id: string) => {
    if (!conversationHref || !onNavigate) return;
    event.preventDefault();
    onNavigate(conversationHref(id));
    setLineageOpen(false);
  };
  const reference = (item: ConversationLineageRef) => {
    const href = conversationHref?.(item.id) ?? "#";
    return <a key={item.id} href={href} onClick={(event) => navigateLink(event, item.id)}>
      {item.title}<small>{item.status === "archived" ? "已归档" : "进行中"}</small></a>;
  };
  const closeLineage = () => {
    setLineageOpen(false);
    window.setTimeout(() => lineageTrigger.current?.focus(), 0);
  };
  const handleLineageKeys = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeLineage();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(lineagePanel.current?.querySelectorAll<HTMLElement>(
      "a[href],button:not([disabled]),details>summary,[tabindex]:not([tabindex='-1'])",
    ) ?? []);
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  const audit = lineage?.contextComparison.diff;
  return <div className="conversation-actions">
    <div className="conversation-context-chips" role="group" aria-label="冻结上下文状态">
      {isSuccessor && <span className="conversation-context-chip successor">关联后继</span>}
      <span className="conversation-context-chip">{repositorySnapshotCount} 个代码快照</span>
    </div>
    <div className="conversation-action-buttons" role="group" aria-label="Conversation 操作">
      {lineage && <span className="conversation-lineage-control">
        <button ref={lineageTrigger} type="button" aria-expanded={lineageOpen} aria-controls={`${tooltipId}-lineage`}
          onClick={() => setLineageOpen((open) => !open)}>关系与上下文</button>
        {lineageOpen && <button type="button" className="conversation-lineage-backdrop"
          aria-label="关闭关系与上下文" tabIndex={-1} onClick={closeLineage} />}
        <section ref={lineagePanel} id={`${tooltipId}-lineage`} className="conversation-lineage-panel"
          hidden={!lineageOpen} role="dialog" aria-modal="true"
          aria-label="Conversation 关系与 Context Diff" onKeyDown={handleLineageKeys}>
          <header><strong>Conversation Lineage</strong>
            <button ref={lineageClose} type="button" aria-label="关闭关系与上下文"
              onClick={closeLineage}>×</button></header>
          {lineage.ancestors.length > 0 && <div className="lineage-ancestors"><span>祖先</span>
            <nav aria-label="祖先 Conversation">{lineage.ancestors.map((item, index) =>
              <span key={item.id}>{index > 0 && "›"}{reference(item)}</span>)}</nav></div>}
          <div className="lineage-relatives"><div><span>父 Conversation</span>
            {lineage.parent ? reference(lineage.parent) : <p>无（独立新对话）</p>}</div>
            <div><span>直接后继</span>{lineage.successors.length > 0
              ? lineage.successors.map(reference) : <p>暂无</p>}</div></div>
          <div className="lineage-context"><span>相对父 Conversation 的材料变化</span>
            <ul>{contextChangeLabels(lineage.contextComparison).map((label) => <li key={label}>{label}</li>)}</ul>
            {lineage.contextComparison.status === "available" && audit &&
              <details><summary>技术详情</summary><dl className="lineage-audit">
                <dt>Paper Version</dt><dd>{audit.paperVersion?.before?.id ?? "—"} → {audit.paperVersion?.after?.id ?? "—"}</dd>
                <dt>Summary Revision</dt><dd>{audit.summaryRevision?.before?.id ?? "—"} → {audit.summaryRevision?.after?.id ?? "—"}</dd>
                <dt>Extraction Run</dt><dd>{audit.extractionRun?.before?.id ?? "—"} → {audit.extractionRun?.after?.id ?? "—"}
                  {audit.extractionRun?.equalityBasis && ` · ${audit.extractionRun.equalityBasis}`}
                  {(audit.extractionRun?.before?.outputHash || audit.extractionRun?.after?.outputHash) &&
                    ` · ${audit.extractionRun.before?.outputHash ?? "no hash"} → ${audit.extractionRun.after?.outputHash ?? "no hash"}`}</dd>
                <dt>Repository commits</dt><dd>{[
                  ...(audit.repositories?.added ?? []).map((item) => `+ ${item.name ?? item.repositoryId}: ${item.commitSha}`),
                  ...(audit.repositories?.removed ?? []).map((item) => `− ${item.name ?? item.repositoryId}: ${item.commitSha}`),
                  ...(audit.repositories?.changed ?? []).map((item) =>
                    `~ ${item.after?.name ?? item.repositoryId}: ${item.before?.commitSha} → ${item.after?.commitSha}`),
                  ...(audit.repositories?.unchanged ?? []).map((item) => `= ${item.name ?? item.repositoryId}: ${item.commitSha}`),
                ].join("\n") || "无 Repository Snapshot"}</dd>
                <dt>Knowledge manifest</dt><dd>{audit.knowledgeCorpus?.status === "unavailable"
                  ? audit.knowledgeCorpus.reason ?? "unavailable"
                  : `${audit.knowledgeCorpus?.before?.id ?? "—"} (${audit.knowledgeCorpus?.before?.hash ?? "—"}) → ${audit.knowledgeCorpus?.after?.id ?? "—"} (${audit.knowledgeCorpus?.after?.hash ?? "—"})`}</dd>
              </dl>
              </details>}
            {lineage.integrityWarning && <p className="lineage-warning">部分 lineage 数据不完整，已安全截断。</p>}
          </div>
        </section>
      </span>}
      {canContinue && <span className="conversation-action-tooltip"
        onMouseEnter={() => setTooltipOpen(true)} onMouseLeave={() => setTooltipOpen(false)}>
        <button type="button" aria-describedby={tooltipId} onFocus={() => setTooltipOpen(true)}
          onBlur={() => setTooltipOpen(false)} onKeyDown={(event) => {
            if (event.key === "Escape") { event.preventDefault(); setTooltipOpen(false); }
          }} onClick={onContinue}>
          {archived ? "基于最新材料继续" : legacy ? "使用最新上下文继续" : "创建关联后继"}</button>
        <span id={tooltipId} className={`conversation-tooltip${tooltipOpen ? " open" : ""}`} role="tooltip">
          {continuationHelp}</span>
      </span>}
      <button type="button" onClick={onRename}>重命名</button>
      <button type="button" onClick={onToggleArchive}>{archived ? "恢复" : "归档"}</button>
    </div>
  </div>;
}
