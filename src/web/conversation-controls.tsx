import { useId, useState } from "react";

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

export function NewConversationButton({ onCreate }: { onCreate(): void }) {
  return <button className="new-conversation-button" type="button" onClick={onCreate}>独立新对话</button>;
}

export function conversationListStatus(input: { archived: boolean; legacy: boolean; successor: boolean }): string {
  if (input.archived) return input.successor ? "关联后继 · 已归档" : "已归档";
  if (input.legacy) return "Legacy · 只读";
  return input.successor ? "关联后继 · 上下文已冻结" : "上下文已冻结";
}

export function ConversationHeaderActions({ repositorySnapshotCount, isSuccessor, archived, canContinue, legacy,
  onContinue, onRename, onToggleArchive }: {
  repositorySnapshotCount: number;
  isSuccessor: boolean;
  archived: boolean;
  canContinue: boolean;
  legacy: boolean;
  onContinue(): void;
  onRename(): void;
  onToggleArchive(): void;
}) {
  const tooltipId = useId();
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const continuationHelp = legacy
    ? "创建可继续讨论的关联 Conversation，并冻结当前最新材料。"
    : "重新冻结最新 Paper、Summary、代码与已确认知识；当前对话及其证据保持冻结。";
  return <div className="conversation-actions">
    <div className="conversation-context-chips" role="group" aria-label="冻结上下文状态">
      {isSuccessor && <span className="conversation-context-chip successor">关联后继</span>}
      <span className="conversation-context-chip">{repositorySnapshotCount} 个代码快照</span>
    </div>
    <div className="conversation-action-buttons" role="group" aria-label="Conversation 操作">
      {canContinue && <span className="conversation-action-tooltip"
        onMouseEnter={() => setTooltipOpen(true)} onMouseLeave={() => setTooltipOpen(false)}>
        <button type="button" aria-describedby={tooltipId} onFocus={() => setTooltipOpen(true)}
          onBlur={() => setTooltipOpen(false)} onKeyDown={(event) => {
            if (event.key === "Escape") { event.preventDefault(); setTooltipOpen(false); }
          }} onClick={onContinue}>
          {legacy ? "使用最新上下文继续" : "创建关联后继"}</button>
        <span id={tooltipId} className={`conversation-tooltip${tooltipOpen ? " open" : ""}`} role="tooltip">
          {continuationHelp}</span>
      </span>}
      <button type="button" onClick={onRename}>重命名</button>
      <button type="button" onClick={onToggleArchive}>{archived ? "恢复" : "归档"}</button>
    </div>
  </div>;
}
