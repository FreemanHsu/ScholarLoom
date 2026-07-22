export function NewConversationButton({ onCreate }: { onCreate(): void }) {
  return <button className="new-conversation-button" type="button" onClick={onCreate}>独立新对话</button>;
}

export function conversationListStatus(input: { archived: boolean; legacy: boolean; successor: boolean }): string {
  if (input.archived) return input.successor ? "关联后继 · 已归档" : "已归档";
  if (input.legacy) return "Legacy · 只读";
  return input.successor ? "关联后继 · 上下文已冻结" : "上下文已冻结";
}

export function ConversationHeaderActions({ repositorySnapshotCount, isSuccessor, archived, onRename, onToggleArchive }: {
  repositorySnapshotCount: number;
  isSuccessor: boolean;
  archived: boolean;
  onRename(): void;
  onToggleArchive(): void;
}) {
  return <div className="conversation-actions">
    <div className="conversation-context-chips" role="group" aria-label="冻结上下文状态">
      {isSuccessor && <span className="conversation-context-chip successor">关联后继</span>}
      <span className="conversation-context-chip">{repositorySnapshotCount} 个代码快照</span>
    </div>
    <div className="conversation-action-buttons" role="group" aria-label="Conversation 管理">
      <button type="button" onClick={onRename}>重命名</button>
      <button type="button" onClick={onToggleArchive}>{archived ? "恢复" : "归档"}</button>
    </div>
  </div>;
}

export function ContinueConversationAction({ legacy, onContinue }: { legacy: boolean; onContinue(): void }) {
  return <section className="continue-conversation" aria-label="创建关联后继 Conversation">
    <div><span className="eyebrow">REFRESH FROZEN CONTEXT</span>
      <strong>{legacy ? "迁移到最新上下文" : "在新快照中继续"}</strong>
      <small>{legacy
        ? "创建可继续讨论的关联 Conversation，并冻结当前最新材料。"
        : "重新冻结最新 Paper、Summary、代码与已确认知识；当前对话及其证据保持冻结。"}</small></div>
    <button type="button" onClick={onContinue}>{legacy ? "使用最新上下文继续" : "创建关联后继"}</button>
  </section>;
}
