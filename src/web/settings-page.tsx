import React from "react";

import type { SettingsSnapshot } from "../settings/settings-snapshot.js";

export function SettingsPage({ snapshot, error }: { snapshot: SettingsSnapshot | null; error: string | null }) {
  if (!snapshot && error) {
    return <main className="page-state"><span className="eyebrow">SETTINGS UNAVAILABLE</span>
      <h1>无法读取系统配置</h1><p>{error}</p></main>;
  }
  if (!snapshot) {
    return <main className="page-state loading-state"><span className="eyebrow">READ-ONLY SETTINGS</span>
      <h1>正在读取配置…</h1></main>;
  }

  const { overview, system } = snapshot;
  return <main className="page settings-page">
    <header className="settings-hero">
      <div><span className="eyebrow">READ-ONLY SETTINGS</span><h1>系统配置</h1>
        <p>这里展示 ScholarLoom 实际使用的 Agent 配置、Prompt contract 与运行限制。</p></div>
      <span className="read-only-badge">只读</span>
    </header>

    <section className="settings-section" aria-labelledby="settings-overview">
      <div className="settings-section-heading"><div><span>OVERVIEW</span><h2 id="settings-overview">运行概览</h2></div>
        <small>配置载入于 {formatDate(snapshot.loadedAt)}</small></div>
      <div className="settings-overview-grid">
        <OverviewCard label="ScholarLoom 版本" value={overview.applicationVersion}
          detail="Application package version" />
        <OverviewCard label="Agent 配置版本" value={overview.configurationVersion}
          detail={`服务启动于 ${formatDate(overview.startedAt)}`} />
        <OverviewCard label="Codex CLI" value={overview.codex.installedVersion ?? "未检测到"}
          detail={`最低兼容 ${overview.codex.minimumVersion} · 检查于 ${formatDate(overview.codex.checkedAt)}`}
          status={`${codexStatusLabel(overview.codex.versionStatus, overview.codex.capabilityStatus)} · ` +
            `Structured ${capabilityCheckLabel(overview.codex.capabilityChecks.structured.status)} · ` +
            `Agentic ${capabilityCheckLabel(overview.codex.capabilityChecks.agenticEvidence.status)}`} />
        <OverviewCard label="服务监听" value={`${overview.listener.host}:${overview.listener.port}`}
          detail="仅允许 loopback，由 Tailscale Serve 提供远程入口" />
        <OverviewCard label="数据根目录" value={overview.dataRoot}
          detail={overview.fixture ? "Fixture runtime" : "Production runtime"} mono />
        <OverviewCard label="Feature flags" value="Takeaway Quality V2"
          detail={overview.featureFlags.takeawayQualityV2 ? "已启用" : "未启用"} />
        <OverviewCard label="最近 Agent 活动"
          value={overview.latestAgentActivity?.taskKind ?? "暂无记录"}
          detail={overview.latestAgentActivity
            ? `${formatDate(overview.latestAgentActivity.completedAt)} · ${overview.latestAgentActivity.runId}`
            : "历史未知值不会推断"} />
      </div>
    </section>

    <section className="settings-section" aria-labelledby="settings-agents">
      <div className="settings-section-heading"><div><span>AGENT REGISTRY</span><h2 id="settings-agents">Agents</h2></div>
        <small>配置值与执行值来自同一 Registry</small></div>
      <div className="agent-config-list">{snapshot.agents.map((agent) =>
        <AgentConfigurationCard key={agent.taskKind} agent={agent} />)}</div>
    </section>

    <section className="settings-section" aria-labelledby="settings-system">
      <div className="settings-section-heading"><div><span>SYSTEM LIMITS</span><h2 id="settings-system">系统与安全</h2></div>
        <small>只展示应用白名单内的配置</small></div>
      <div className="system-config-grid">
        <SystemCard title="PDF 获取">
          <ConfigRow label="最大文件" value={formatBytes(system.ingestion.pdf.maxBytes)} />
          <ConfigRow label="最大重定向" value={`${system.ingestion.pdf.maxRedirects} 次`} />
          <ConfigRow label="连接超时" value={formatDuration(system.ingestion.pdf.connectTimeoutMs)} />
          <ConfigRow label="总超时" value={formatDuration(system.ingestion.pdf.totalTimeoutMs)} />
        </SystemCard>
        <SystemCard title="Storage">
          <ConfigRow label="知识事实源" value={system.storage.knowledgeAuthority} />
          <ConfigRow label="运行事实源" value={system.storage.operationalAuthority} />
          <ConfigRow label="原始文件" value={system.storage.originals} />
          <ConfigRow label="可重建目录" value={system.storage.rebuildable.join(" / ")} />
          <ConfigRow label="缺失数据根" value={system.storage.missingRoot} />
        </SystemCard>
        <SystemCard title="Agent execution">
          <ConfigRow label="最大并发" value={String(system.execution.maximumConcurrency)} />
          <ConfigRow label="最长超时" value={formatDuration(system.execution.maximumTimeoutMs)} />
          <ConfigRow label="网络" value={system.execution.network} />
          <ConfigRow label="Shell 环境" value={system.execution.environment} />
          <ConfigRow label="用户配置" value={system.execution.ignoresUserConfig ? "忽略" : "继承"} />
          <ConfigRow label="用户规则" value={system.execution.ignoresUserRules ? "忽略" : "继承"} />
        </SystemCard>
        <SystemCard title="Visual Evidence">
          <ConfigRow label="每次运行页面预算" value={`${system.visualEvidence.pageLimit} 页`} />
          <ConfigRow label="基础设施失败预算" value={`${system.visualEvidence.infrastructureFailureLimit} 次`} />
        </SystemCard>
        <SystemCard title="PDF Renderer">
          <ConfigRow label="DPI" value={String(system.renderer.dpi)} />
          <ConfigRow label="超时" value={formatDuration(system.renderer.timeoutMs)} />
          <ConfigRow label="内存上限" value={`${system.renderer.memoryLimitMiB} MiB`} />
          <ConfigRow label="输出上限" value={formatBytes(system.renderer.outputLimitBytes)} />
        </SystemCard>
        <SystemCard title="Diagnostics">
          <p>完整的数据完整性诊断仍通过 CLI 提供。</p>
          <code>{system.diagnostics.command}</code>
        </SystemCard>
      </div>
    </section>
  </main>;
}

function AgentConfigurationCard({ agent }: { agent: SettingsSnapshot["agents"][number] }) {
  return <article className="agent-config-card">
    <header><div><span className="agent-task-kind">{agent.taskKind}</span><h3>{agent.displayName}</h3></div>
      <span className={`agent-status status-${agent.status}`}>{agentStatusLabel(agent.status)}</span></header>
    <div className="agent-config-primary">
      <div><span>MODEL</span><strong>{agent.effective.model}</strong></div>
      <div><span>THINKING BUDGET</span><strong>{agent.effective.reasoningEffort}</strong></div>
      <div><span>TIMEOUT</span><strong>{formatDuration(agent.execution.timeoutMs)}</strong></div>
      <div><span>CONCURRENCY</span><strong>{agent.execution.concurrency ?? "按调用"}</strong></div>
    </div>
    <div className="agent-policy-row">
      <span>网络禁用</span><span>{agent.execution.workspace === "frozen-evidence" ? "冻结 Evidence Workspace" : "临时只读 Workspace"}</span>
      <span>环境变量最小化</span><span>忽略用户 Codex 配置</span>
      {agent.execution.tools.map((tool) => <span key={tool}>{tool}</span>)}
    </div>
    <div className="agent-observed">
      <span>最近运行</span>{agent.observed
        ? <p><strong>{agent.observed.model ?? "模型未记录"} · {agent.observed.reasoningEffort ?? "thinking 未记录"}</strong>
          <small>{formatDate(agent.observed.completedAt)} · {agent.observed.codexVersion} ·
            {agent.observed.configurationVersion ?? "配置版本未记录"} · {agent.observed.runId}</small></p>
        : <p><strong>运行时未记录</strong><small>历史数据不会被推断或回填</small></p>}
    </div>
    <details className="agent-contract"><summary>Prompt 与输出契约</summary>
      <ContractBlock title="Prompt template" sourcePath={agent.contract.prompt.sourcePath}
        content={agent.contract.prompt.template} />
      {agent.contract.skill && <ContractBlock title="Skill" sourcePath={agent.contract.skill.sourcePath}
        content={agent.contract.skill.content} />}
      <ContractBlock title="JSON Schema" sourcePath={agent.contract.outputSchema.sourcePath}
        content={JSON.stringify(agent.contract.outputSchema.schema, null, 2)} />
    </details>
  </article>;
}

function ContractBlock({ title, sourcePath, content }: { title: string; sourcePath: string; content: string }) {
  return <section className="contract-block"><header><strong>{title}</strong><code>{sourcePath}</code></header>
    <pre>{content}</pre></section>;
}

function OverviewCard({ label, value, detail, status, mono = false }: {
  label: string; value: string; detail: string; status?: string; mono?: boolean;
}) {
  return <article className="settings-overview-card"><span>{label}</span>
    <strong className={mono ? "mono-value" : undefined}>{value}</strong><small>{detail}</small>
    {status && <em>{status}</em>}</article>;
}

function SystemCard({ title, children }: { title: string; children: React.ReactNode }) {
  return <article className="system-config-card"><h3>{title}</h3>{children}</article>;
}

function ConfigRow({ label, value }: { label: string; value: string }) {
  return <div className="config-row"><span>{label}</span><strong>{value}</strong></div>;
}

function agentStatusLabel(status: string): string {
  if (status === "legacy") return "遗留";
  if (status === "feature-disabled") return "Feature 关闭";
  return "启用";
}

function codexStatusLabel(versionStatus: string, capabilityStatus: string): string {
  if (versionStatus === "below-minimum") return "版本低于兼容基线";
  if (versionStatus === "unavailable") return "运行时未检测";
  if (capabilityStatus === "passed") return "能力检查通过";
  if (capabilityStatus === "failed") return "能力检查失败";
  if (capabilityStatus === "partial") return "能力检查部分通过";
  return "版本兼容 · 能力检查待运行";
}

function capabilityCheckLabel(status: string): string {
  if (status === "passed") return "通过";
  if (status === "failed") return "失败";
  return "待运行";
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function formatDuration(milliseconds: number): string {
  return milliseconds >= 60_000 ? `${milliseconds / 60_000} 分钟` : `${milliseconds / 1000} 秒`;
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${Math.round(bytes / 1024 / 1024)} MiB` : `${bytes} B`;
}
