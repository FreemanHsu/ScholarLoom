import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  isRetryableImportJobState,
  isTerminalImportJobState,
  type ImportJobError,
  type ImportJobState,
} from "../domain/import-job.js";
import { paperHref, readBrowserRoute, type BrowserRoute } from "./browser-navigation.js";
import { importMonitor } from "./import-monitor.js";
import "./styles.css";

type Paper = {
  id: string;
  title: string;
  arxivId: string;
  version: number;
  updatedAt?: string;
  processing?: { state: ImportJobState; progress: number; needsAttention: boolean } | null;
  summaryStatus?: "ready" | "processing" | "failed";
  codeStatus?: "ready" | "failed" | "not-linked";
  pendingReviewCount?: number;
};
type Workspace = {
  paper: Paper & { versionId: string };
  pdf: { pageCount: number } | null;
  summary: null | {
    status: string;
    sections: Array<{ key: string; title: string; body: string }>;
    claims: Array<{ claim: string; evidence: { id?: string; page: number; verified: boolean } }>;
  };
  processing: null | { jobId: string; state: ImportJobState; progress: number; attempt: number; error: ImportJobError | null };
  repository: null | { url: string; commitSha: string | null; status: "ready" | "failed"; files: Array<{ path: string }> };
};
type Proposal = { id: string; claim: string; oneClickEligible: boolean; sourceHandles: string[] };
type ReviewProposal = {
  id: string;
  proposalType: string;
  paperId: string | null;
  reviewStatus: string;
  oneClickEligible: boolean;
  createdAt: string;
  archivedAt: string | null;
  payload: { claim?: string; currentVersion?: number; latestVersion?: number; error?: string };
};
type EntryAnswer = {
  answer: string;
  sources: Array<{ sourceType: string; title: string; paperId: string; href?: string }>;
  projection: { stale: boolean; notice?: string; lastSuccessfulAt: string | null };
};
type OpenedPdfSource = { href: string; anchor: string; page: number };

function App() {
  const [route, setRoute] = useState<BrowserRoute>(() => readBrowserRoute(window.location));
  const [papers, setPapers] = useState<Paper[]>([]);
  const [papersError, setPapersError] = useState<string | null>(null);
  const [reviewProposals, setReviewProposals] = useState<ReviewProposal[]>([]);
  const [reviewsError, setReviewsError] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [url, setUrl] = useState("https://arxiv.org/abs/2401.12345v2");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<ImportJobState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openedPdfSource, setOpenedPdfSource] = useState<OpenedPdfSource | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [entryQuestion, setEntryQuestion] = useState("fixture 可追溯证据");
  const [entryAnswer, setEntryAnswer] = useState<EntryAnswer | null>(null);

  function navigate(href: string, replace = false) {
    window.history[replace ? "replaceState" : "pushState"](null, "", href);
    setRoute(readBrowserRoute(window.location));
  }

  function routeClick(event: React.MouseEvent<HTMLAnchorElement>, href: string) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(href);
  }

  const refreshPapers = async () => {
    try {
      const response = await fetch("/api/papers");
      if (!response.ok) throw new Error("论文库暂时不可用");
      setPapers((await response.json() as { papers: Paper[] }).papers);
      setPapersError(null);
    } catch (cause) {
      setPapersError(cause instanceof Error ? cause.message : "论文库暂时不可用");
    }
  };

  const refreshReviews = async () => {
    try {
      const response = await fetch("/api/proposals");
      if (!response.ok) throw new Error("审核队列暂时不可用");
      setReviewProposals((await response.json() as { proposals: ReviewProposal[] }).proposals);
      setReviewsError(null);
    } catch (cause) {
      setReviewsError(cause instanceof Error ? cause.message : "审核队列暂时不可用");
    }
  };

  const refreshWorkspace = async (paperId: string, initial = false) => {
    if (initial) setWorkspaceLoading(true);
    try {
      const response = await fetch(`/api/papers/${encodeURIComponent(paperId)}`);
      if (!response.ok) throw new Error(response.status === 404 ? "找不到这个 Paper" : "Paper Workspace 暂时不可用");
      const nextWorkspace = await response.json() as Workspace;
      const currentRoute = readBrowserRoute(window.location);
      if (currentRoute.name === "paper" && currentRoute.paperId === paperId) {
        setWorkspace(nextWorkspace);
        setWorkspaceError(null);
      }
    } catch (cause) {
      const currentRoute = readBrowserRoute(window.location);
      if (currentRoute.name === "paper" && currentRoute.paperId === paperId) {
        setWorkspaceError(cause instanceof Error ? cause.message : "Paper Workspace 暂时不可用");
      }
    } finally {
      const currentRoute = readBrowserRoute(window.location);
      if (initial && currentRoute.name === "paper" && currentRoute.paperId === paperId) setWorkspaceLoading(false);
    }
  };

  useEffect(() => {
    const onPopState = () => setRoute(readBrowserRoute(window.location));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    void refreshPapers();
    void refreshReviews();
    const timer = window.setInterval(() => { void refreshPapers(); void refreshReviews(); }, 5_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (route.name !== "paper") return;
    if (workspace?.paper.id !== route.paperId) setWorkspace(null);
    setOpenedPdfSource(null);
    setConversationId(null);
    setAnswer(null);
    setProposals([]);
    void refreshWorkspace(route.paperId, true);
  }, [route.name === "paper" ? route.paperId : null]);

  useEffect(() => {
    if (route.name !== "paper" || !workspace?.processing || isTerminalImportJobState(workspace.processing.state)) return;
    const timer = window.setInterval(() => void refreshWorkspace(route.paperId), 3_000);
    return () => window.clearInterval(timer);
  }, [route.name === "paper" ? route.paperId : null, workspace?.processing?.state]);

  async function askPaper(event: React.FormEvent) {
    event.preventDefault();
    if (!workspace || !question.trim()) return;
    let id = conversationId;
    if (!id) {
      const created = await fetch(`/api/papers/${encodeURIComponent(workspace.paper.id)}/conversations`, { method: "POST" }).then((response) => response.json());
      id = created.conversation.id;
      setConversationId(id);
    }
    const result = await fetch(`/api/conversations/${encodeURIComponent(id!)}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: question }),
    }).then((response) => response.json());
    setAnswer(result.message.content);
    setProposals(result.proposals);
    setQuestion("");
    void refreshReviews();
  }

  async function acceptProposal(proposal: Proposal) {
    if (!proposal.oneClickEligible) {
      const opened = await fetch(`/api/proposals/${encodeURIComponent(proposal.id)}/open-source`, { method: "POST" });
      if (opened.ok && workspace) {
        const source = await opened.json() as { pdfUrl: string; page: number };
        setOpenedPdfSource({ href: source.pdfUrl, anchor: proposal.id, page: source.page });
        navigate(paperHref(workspace.paper.id, { pdfOpen: true, page: source.page, anchor: proposal.id }));
        setProposals((items) => items.map((item) => item.id === proposal.id ? { ...item, oneClickEligible: true } : item));
      }
      return;
    }
    const response = await fetch(`/api/proposals/${encodeURIComponent(proposal.id)}/decisions`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": `web-${proposal.id}` },
      body: JSON.stringify({ action: "accept" }),
    });
    if (response.ok) {
      setProposals((items) => items.filter((item) => item.id !== proposal.id));
      void refreshReviews();
      void refreshPapers();
    }
  }

  async function askEntry(event: React.FormEvent) {
    event.preventDefault();
    if (!entryQuestion.trim()) return;
    const response = await fetch("/api/entry-agent/questions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: entryQuestion }),
    });
    if (response.ok) setEntryAnswer(await response.json() as EntryAnswer);
  }

  async function importPaper(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setProgress("queued");
    setError(null);
    try {
      const response = await fetch("/api/imports", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ arxivUrl: url }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.detail ?? body.code ?? "导入失败");
      setImportOpen(false);
      navigate(paperHref(body.paper.id));
      await refreshPapers();
      void importMonitor.wait(body.importRequest.id, setProgress)
        .then(async () => { await refreshPapers(); await refreshWorkspace(body.paper.id); })
        .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "导入失败"))
        .finally(() => setProgress(null));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "导入失败");
    } finally {
      setBusy(false);
    }
  }

  async function retryImport() {
    if (!workspace?.processing) return;
    setBusy(true);
    setError(null);
    setProgress("queued");
    try {
      const response = await fetch(`/api/jobs/${encodeURIComponent(workspace.processing.jobId)}/retry`, {
        method: "POST",
        headers: { "idempotency-key": `web-retry-${workspace.processing.jobId}` },
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.detail ?? body.code ?? "重试失败");
      await refreshWorkspace(workspace.paper.id);
      void importMonitor.wait(body.importRequest.id, setProgress)
        .then(async () => { await refreshPapers(); await refreshWorkspace(workspace.paper.id); })
        .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "重试失败"))
        .finally(() => setProgress(null));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "重试失败");
    } finally {
      setBusy(false);
    }
  }

  const pendingReviews = reviewProposals.filter((proposal) => proposal.reviewStatus === "pending" && !proposal.archivedAt);
  const processingPapers = papers.filter((paper) => paper.processing && !isTerminalImportJobState(paper.processing.state));
  const attentionPapers = papers.filter((paper) => paper.processing?.needsAttention);

  return <div className="app-shell">
    <header className="app-nav">
      <a className="brand" href="/" onClick={(event) => routeClick(event, "/")}>ScholarLoom</a>
      <nav aria-label="主要导航">
        <NavLink href="/" active={route.name === "home"} onClick={routeClick}>研究首页</NavLink>
        <NavLink href="/papers" active={route.name === "papers"} onClick={routeClick}>论文库</NavLink>
        <NavLink href="/reviews" active={route.name === "reviews"} onClick={routeClick}>
          审核中心{pendingReviews.length > 0 ? ` · ${pendingReviews.length}` : ""}
        </NavLink>
      </nav>
      <div className="nav-actions">
        {(processingPapers.length > 0 || progress) && <span className="nav-status">处理中 · {Math.max(processingPapers.length, 1)}</span>}
        <button onClick={() => setImportOpen((value) => !value)}>导入 Paper</button>
      </div>
    </header>

    {importOpen && <form className="global-import" onSubmit={importPaper}>
      <label htmlFor="global-arxiv">导入 arXiv Paper</label>
      <div><input id="global-arxiv" value={url} onChange={(event) => setUrl(event.target.value)} />
        <button disabled={busy}>{busy ? "正在识别…" : "导入并阅读"}</button></div>
      {error && <p className="error">{error}</p>}
    </form>}

    {route.name === "home" && <ResearchHome papers={papers} papersError={papersError} processingPapers={processingPapers}
      attentionPapers={attentionPapers} pendingReviews={pendingReviews} entryQuestion={entryQuestion} entryAnswer={entryAnswer}
      onEntryQuestion={setEntryQuestion} onAskEntry={askEntry} onNavigate={navigate} onImport={() => setImportOpen(true)} />}
    {route.name === "papers" && <PaperLibrary papers={papers} error={papersError} onNavigate={navigate} onImport={() => setImportOpen(true)} />}
    {route.name === "reviews" && <ReviewCenter proposals={reviewProposals} error={reviewsError} onNavigate={navigate} />}
    {route.name === "not-found" && <main className="page-state"><span className="eyebrow">NOT FOUND</span><h1>找不到这个页面</h1>
      <button onClick={() => navigate("/", true)}>返回研究首页</button></main>}
    {route.name === "paper" && (workspaceLoading && !workspace
      ? <main className="page-state loading-state"><span className="eyebrow">PAPER WORKSPACE</span><h1>正在载入 Paper…</h1></main>
      : workspaceError && !workspace
        ? <main className="page-state"><span className="eyebrow">PAPER UNAVAILABLE</span><h1>{workspaceError}</h1><button onClick={() => navigate("/papers")}>返回论文库</button></main>
        : workspace && workspace.paper.id === route.paperId && <PaperWorkspace workspace={workspace} route={route} busy={busy} progress={progress} error={workspaceError ?? error}
          openedPdfSource={openedPdfSource} answer={answer} proposals={proposals} question={question} onQuestion={setQuestion}
          onAskPaper={askPaper} onAcceptProposal={acceptProposal} onRetry={retryImport} onNavigate={navigate} />)}
  </div>;
}

function NavLink({ href, active, onClick, children }: { href: string; active: boolean;
  onClick(event: React.MouseEvent<HTMLAnchorElement>, href: string): void; children: React.ReactNode }) {
  return <a href={href} aria-current={active ? "page" : undefined} onClick={(event) => onClick(event, href)}>{children}</a>;
}

function ResearchHome(props: {
  papers: Paper[];
  papersError: string | null;
  processingPapers: Paper[];
  attentionPapers: Paper[];
  pendingReviews: ReviewProposal[];
  entryQuestion: string;
  entryAnswer: EntryAnswer | null;
  onEntryQuestion(value: string): void;
  onAskEntry(event: React.FormEvent): void;
  onNavigate(href: string): void;
  onImport(): void;
}) {
  return <main className="app page home">
    <header className="home-intro"><span className="eyebrow">PRIVATE RESEARCH WORKSPACE</span><h1>今天，从哪里继续？</h1>
      <p>检索已确认知识，继续阅读，或处理需要你判断的事项。</p></header>
    <section className="entry-agent entry-agent-primary"><div className="section-heading"><span>CURATED ONLY</span><h2>向知识库提问</h2></div>
      <form onSubmit={props.onAskEntry}><input aria-label="Knowledge question" value={props.entryQuestion}
        onChange={(event) => props.onEntryQuestion(event.target.value)} /><button>检索已确认知识</button></form>
      {props.entryAnswer && <div className="entry-result">{props.entryAnswer.projection.stale && <div className="stale">
        {props.entryAnswer.projection.notice} · {props.entryAnswer.projection.lastSuccessfulAt ?? "尚无成功索引"}</div>}
        <p>{props.entryAnswer.answer}</p><div className="source-list">{props.entryAnswer.sources.map((source) => <button className="source-card"
          key={`${source.sourceType}-${source.title}`} onClick={() => props.onNavigate(paperHref(source.paperId))}>{source.sourceType} · {source.title}</button>)}</div>
      </div>}
    </section>

    <div className="home-grid">
      <section><div className="section-heading"><span>CONTINUE</span><h2>继续阅读</h2></div>
        {props.papersError && props.papers.length > 0 && <p className="inline-alert">{props.papersError}，正在显示上次成功载入的列表。</p>}
        {props.papersError && props.papers.length === 0 ? <p className="error-block">{props.papersError}</p>
          : props.papers.length === 0 ? <div className="empty"><p>还没有 Paper。</p><button onClick={props.onImport}>导入第一篇</button></div>
            : props.papers.slice(0, 3).map((paper) => <PaperCard key={paper.id} paper={paper} onNavigate={props.onNavigate} />)}
        {props.papers.length > 3 && <button className="text-button" onClick={() => props.onNavigate("/papers")}>查看全部 Paper →</button>}
      </section>
      <aside className="home-status">
        <StatusSummary label="BACKGROUND" title="后台处理中" count={props.processingPapers.length}
          empty="当前没有后台任务" onOpen={() => props.onNavigate("/papers")} />
        <StatusSummary label="REVIEW" title="待审核" count={props.pendingReviews.length}
          empty="当前没有待审核 Proposal" onOpen={() => props.onNavigate("/reviews")} />
        <StatusSummary label="RECOVERY" title="需要恢复" count={props.attentionPapers.length}
          empty="当前没有失败或中断的任务" onOpen={() => props.onNavigate("/papers")} />
      </aside>
    </div>
  </main>;
}

function StatusSummary({ label, title, count, empty, onOpen }: { label: string; title: string; count: number; empty: string; onOpen(): void }) {
  return <section className="status-summary"><span className="eyebrow">{label}</span><div><h3>{title}</h3><strong>{count}</strong></div>
    <p>{count > 0 ? `${count} 项等待查看` : empty}</p>{count > 0 && <button className="text-button" onClick={onOpen}>查看 →</button>}</section>;
}

function PaperLibrary({ papers, error, onNavigate, onImport }: { papers: Paper[]; error: string | null;
  onNavigate(href: string): void; onImport(): void }) {
  return <main className="app page library-page"><header className="page-header"><span className="eyebrow">LIBRARY</span><h1>论文库</h1>
    <p>所有 Ready、Processing 和需要恢复的 Paper 都在这里。</p></header>
    <section className="library">{error && papers.length > 0 && <p className="inline-alert">{error}，正在显示上次成功载入的列表。</p>}
      {error && papers.length === 0 ? <p className="error-block">{error}</p>
      : papers.length === 0 ? <div className="empty"><p>还没有论文。粘贴一个 arXiv 链接开始。</p><button onClick={onImport}>导入 Paper</button></div>
        : papers.map((paper) => <PaperCard key={paper.id} paper={paper} onNavigate={onNavigate} />)}</section>
  </main>;
}

function PaperCard({ paper, onNavigate }: { paper: Paper; onNavigate(href: string): void }) {
  const processingLabel = paperSummaryLabel(paper);
  const codeLabel = paper.codeStatus === "ready" ? "代码可用" : paper.codeStatus === "failed" ? "代码失败" : "未发现明确代码链接";
  const href = paperHref(paper.id);
  return <a className="paper-card" href={href} onClick={(event) => { if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
    event.preventDefault(); onNavigate(href); } }}><span>v{paper.version}</span><div><h3>{paper.title}</h3><p>arXiv:{paper.arxivId}</p>
      <div className="paper-badges"><small>{processingLabel}</small><small>{codeLabel}</small>{Boolean(paper.pendingReviewCount) && <small>待审核 {paper.pendingReviewCount}</small>}</div>
    </div><b>→</b></a>;
}

function paperSummaryLabel(paper: Paper): string {
  if (paper.summaryStatus === "ready") return "Summary Ready";
  if (paper.processing?.state === "cancelled") return "处理已取消";
  if (paper.processing?.needsAttention) return "需要恢复";
  if (paper.processing && !isTerminalImportJobState(paper.processing.state)) return "处理中";
  return paper.summaryStatus === "failed" ? "Summary 失败" : "Summary 不可用";
}

function ReviewCenter({ proposals, error, onNavigate }: { proposals: ReviewProposal[]; error: string | null; onNavigate(href: string): void }) {
  const pending = proposals.filter((proposal) => proposal.reviewStatus === "pending" && !proposal.archivedAt);
  return <main className="app page reviews-page"><header className="page-header"><span className="eyebrow">REVIEW CENTER</span><h1>审核中心</h1>
    <p>Proposal 在确认前不会成为长期知识。</p></header>
    {error && pending.length > 0 && <p className="inline-alert">{error}，正在显示上次成功载入的审核队列。</p>}
    {error && proposals.length === 0 ? <p className="error-block">{error}</p>
      : pending.length === 0 ? <div className="empty"><p>当前没有待审核 Proposal。</p><button onClick={() => onNavigate("/papers")}>返回阅读</button></div>
      : <div className="review-list">{pending.map((proposal) => <article className="review-card" key={proposal.id}>
        <span className="eyebrow">{proposal.proposalType.replaceAll("-", " ")}</span>
        <h2>{proposal.payload.claim ?? (proposal.proposalType === "paper-version-update" ? `Paper Version v${proposal.payload.latestVersion} 可用` : "需要你的判断")}</h2>
        <p>{proposal.oneClickEligible ? "证据已满足快速确认条件" : "确认前需要查看完整来源"}</p>
        {proposal.paperId && <button className="text-button" onClick={() => onNavigate(paperHref(proposal.paperId!))}>打开相关 Paper →</button>}
      </article>)}</div>}
  </main>;
}

function PaperWorkspace(props: {
  workspace: Workspace;
  route: Extract<BrowserRoute, { name: "paper" }>;
  busy: boolean;
  progress: ImportJobState | null;
  error: string | null;
  openedPdfSource: OpenedPdfSource | null;
  answer: string | null;
  proposals: Proposal[];
  question: string;
  onQuestion(value: string): void;
  onAskPaper(event: React.FormEvent): void;
  onAcceptProposal(proposal: Proposal): void;
  onRetry(): void;
  onNavigate(href: string): void;
}) {
  const { workspace, route } = props;
  const codeStatus = workspace.repository?.status === "ready" ? "代码可用于讨论"
    : workspace.repository?.status === "failed" ? "代码关联失败"
      : workspace.processing && !isTerminalImportJobState(workspace.processing.state) ? "正在检查代码关联" : "未发现明确代码链接";
  const setPdf = (pdfOpen: boolean, page = route.page, anchor = route.anchor) => {
    props.onNavigate(paperHref(workspace.paper.id, { pdfOpen, page, anchor }));
  };
  return <main className="app workspace">
    <header className="topbar"><a className="ghost" href="/papers" onClick={(event) => { event.preventDefault(); props.onNavigate("/papers"); }}>← 论文库</a>
      <div><span className="eyebrow">PAPER WORKSPACE</span><h1>{workspace.paper.title}</h1></div>
      <div className="workspace-badges"><span className="version">arXiv v{workspace.paper.version}</span><span className="code-status" title={workspace.repository?.url}>{codeStatus}</span></div>
    </header>
    {props.error && <div className="inline-alert">{props.error}</div>}
    <div className={`reading-grid ${route.pdfOpen ? "split" : ""}`}>
      <article className="summary-pane">
        <div className="pane-title"><div><span className="status">{workspace.summary ? "Summary Ready"
          : workspace.processing?.state === "cancelled" ? "Import Cancelled"
            : isRetryableImportJobState(workspace.processing?.state) ? "Import Failed" : "Processing"}</span><h2>技术精读</h2></div>
          <button disabled={!workspace.pdf} onClick={() => setPdf(!route.pdfOpen, route.pdfOpen ? 1 : route.page, route.pdfOpen ? null : route.anchor)}>{route.pdfOpen ? "隐藏原文" : "打开原文"}</button></div>
        {!workspace.summary && <section className="import-state"><span className="section-no">IMPORT STATUS</span>
          <h3>{workspace.processing?.state === "cancelled" ? "论文处理已取消" : isRetryableImportJobState(workspace.processing?.state) ? "论文处理未完成" : "正在生成 Paper Summary"}</h3>
          {workspace.processing && <p>{workspace.processing.state} · {Math.round(workspace.processing.progress * 100)}% · attempt {workspace.processing.attempt}</p>}
          {workspace.processing?.error && <><p>{workspace.processing.error.stage} · {workspace.processing.error.code}</p><p>{workspace.processing.error.message}</p></>}
          {isRetryableImportJobState(workspace.processing?.state) && <button disabled={props.busy} onClick={() => void props.onRetry()}>
            {props.busy ? `重试中 · ${props.progress ?? "queued"}` : workspace.processing?.error?.action === "repair-data-root-permissions" ? "修复存储权限后重试" : "重试 Paper Summary 流程"}</button>}
        </section>}
        {workspace.summary?.sections.map((section, index) => <section key={section.key}><span className="section-no">{String(index + 1).padStart(2, "0")}</span>
          <h3>{section.title}</h3><p>{section.body}</p></section>)}
        {workspace.summary && <section><span className="section-no">KEY CLAIMS</span><h3>关键结论与证据</h3>
          {workspace.summary.claims.map((claim) => <button className={`claim ${route.anchor === claim.evidence.id ? "selected" : ""}`} key={claim.claim}
            onClick={() => { props.onNavigate(paperHref(workspace.paper.id, { pdfOpen: true, page: claim.evidence.page,
              anchor: claim.evidence.id ?? `page:${claim.evidence.page}` })); }}>
            <span>{claim.claim}</span><small>p. {claim.evidence.page} · {claim.evidence.verified ? "原文已核验" : "仅定位"}</small></button>)}</section>}
        {workspace.summary && <section className="conversation"><span className="section-no">DISCUSS</span><h3>围绕 Paper 继续追问</h3>
          <p className="source-boundary">当前 Paper、Summary、历史讨论{workspace.repository?.status === "ready" ? "及固定代码快照" : ""}可作为信源。</p>
          {props.answer && <div className="agent-answer"><b>ScholarLoom</b><p>{props.answer}</p></div>}
          {props.proposals.map((proposal) => <div className="proposal" key={proposal.id}><span>建议沉淀为 Takeaway</span><p>{proposal.claim}</p>
            <button onClick={() => void props.onAcceptProposal(proposal)}>{proposal.oneClickEligible ? "确认沉淀" : "打开证据后确认"}</button></div>)}
          <form className="chat-form" onSubmit={props.onAskPaper}><input aria-label="Paper question" value={props.question}
            onChange={(event) => props.onQuestion(event.target.value)} placeholder="论文或代码中的实现细节…"/><button>发送</button></form>
        </section>}
      </article>
      {route.pdfOpen && <aside className="pdf-pane"><div className="pdf-toolbar"><strong>原始 PDF</strong><span>Page {route.page} / {workspace.pdf?.pageCount}</span></div>
        <iframe title="原始 PDF" src={props.openedPdfSource?.anchor === route.anchor && props.openedPdfSource.page === route.page
          ? props.openedPdfSource.href : `/api/paper-versions/${encodeURIComponent(workspace.paper.versionId)}/pdf#page=${route.page}`} /></aside>}
    </div>
  </main>;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
