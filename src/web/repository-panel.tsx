import { useState } from "react";

export type RepositoryAssociation = {
  id: string;
  repositoryId: string;
  owner: string;
  repository: string;
  canonicalUrl: string;
  origin: string;
  associationStatus: string;
  materializationStatus: string;
  commitSha: string | null;
  failureReason: string | null;
};

export function RepositoryPanel(props: {
  repositories: RepositoryAssociation[];
  busy: boolean;
  error: string | null;
  onClose(): void;
  onAdd(url: string): void;
  onConfirm(associationId: string): void;
  onRetry(associationId: string): void;
}) {
  const [url, setUrl] = useState("");
  return <div className="repository-panel-backdrop" role="presentation" onMouseDown={(event) => {
    if (event.target === event.currentTarget) props.onClose();
  }}>
    <section className="repository-panel" role="dialog" aria-modal="true" aria-labelledby="repository-panel-title">
      <header><div><span className="eyebrow">REPOSITORY ASSOCIATIONS</span>
        <h2 id="repository-panel-title">代码仓库</h2></div>
        <button type="button" aria-label="关闭代码仓库面板" onClick={props.onClose}>×</button></header>
      <p className="repository-context-note">这里显示 Paper 当前关联；已冻结 Conversation 的 Repository Snapshot 不会随此列表改变。</p>
      <form className="repository-add-form" onSubmit={(event) => {
        event.preventDefault();
        if (url.trim()) props.onAdd(url.trim());
      }}>
        <label htmlFor="github-repository-url">添加 GitHub repository root URL</label>
        <div><input id="github-repository-url" type="url" value={url} disabled={props.busy}
          placeholder="https://github.com/owner/repository"
          onChange={(event) => setUrl(event.target.value)} />
        <button disabled={props.busy || !url.trim()}>{props.busy ? "处理中…" : "添加并固定"}</button></div>
      </form>
      {props.error && <p className="repository-panel-error">{props.error}</p>}
      {props.repositories.length === 0 ? <p className="repository-empty">当前没有 repository association。未关联不表示不存在开源代码。</p>
        : <div className="repository-list">{props.repositories.map((association) =>
          <article key={association.id}>
            <div className="repository-heading"><div><h3>{association.owner}/{association.repository}</h3>
              <a href={association.canonicalUrl} target="_blank" rel="noopener noreferrer">{association.canonicalUrl}</a></div>
              <span>{originLabel(association.origin)}</span></div>
            <dl>
              <dt>关联</dt><dd>{association.associationStatus === "candidate" ? "待确认" : "已确认"}</dd>
              <dt>物化</dt><dd>{materializationLabel(association.materializationStatus)}</dd>
              <dt>固定版本</dt><dd><code>{association.commitSha?.slice(0, 12) ?? "尚未固定"}</code></dd>
            </dl>
            {association.failureReason && <p className="repository-failure">失败原因：{association.failureReason}</p>}
            {association.associationStatus === "candidate" &&
              <button type="button" disabled={props.busy} onClick={() => props.onConfirm(association.id)}>确认并固定</button>}
            {["failed", "interrupted", "materialization-missing"].includes(association.materializationStatus) &&
              <button type="button" disabled={props.busy} onClick={() => props.onRetry(association.id)}>重试物化</button>}
          </article>)}</div>}
    </section>
  </div>;
}

function originLabel(origin: string): string {
  return origin === "manual" ? "手动添加" : origin === "detected" || origin === "paper-explicit" ? "论文检测" : origin;
}

function materializationLabel(status: string): string {
  const labels: Record<string, string> = {
    "not-started": "尚未开始",
    running: "正在物化",
    queued: "等待物化",
    ready: "可用于未来讨论",
    failed: "失败",
    interrupted: "已中断",
    "materialization-missing": "本地物化缺失",
  };
  return labels[status] ?? status;
}
