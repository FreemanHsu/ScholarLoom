import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { importMonitor } from "./import-monitor.js";
import "./styles.css";

type Paper = { id: string; title: string; arxivId: string; version: number };
type Workspace = {
  paper: Paper & { versionId: string };
  pdf: { pageCount: number } | null;
  summary: null | { status: string; sections: Array<{ key: string; title: string; body: string }>;
    claims: Array<{ claim: string; evidence: { page: number; verified: boolean } }> };
  processing: null | { jobId: string; state: string; progress: number; attempt: number;
    error: null | { code: string; message: string; stage: string; retryable: boolean; action: string | null } };
};
type Proposal = { id: string; claim: string; oneClickEligible: boolean; sourceHandles: string[] };

function App() {
  const [papers, setPapers] = useState<Paper[]>([]);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [url, setUrl] = useState("https://arxiv.org/abs/2401.12345v2");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [pdfOpen, setPdfOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [pdfSrc, setPdfSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [entryQuestion, setEntryQuestion] = useState("fixture 可追溯证据");
  const [entryAnswer, setEntryAnswer] = useState<{ answer: string; sources: Array<{ sourceType: string; title: string; paperId: string }>;
    projection: { stale: boolean; notice?: string; lastSuccessfulAt: string | null } } | null>(null);

  const refresh = async () => setPapers((await fetch("/api/papers").then((r) => r.json())).papers);
  useEffect(() => { void refresh(); }, []);

  async function openPaper(id: string) {
    const response = await fetch(`/api/papers/${encodeURIComponent(id)}`);
    if (!response.ok) throw new Error("无法打开 Paper workspace");
    setWorkspace(await response.json());
    setPdfOpen(false);
    setPdfSrc(null);
    setConversationId(null); setAnswer(null); setProposals([]);
  }

  async function askPaper(event: React.FormEvent) {
    event.preventDefault(); if (!workspace || !question.trim()) return;
    let id = conversationId;
    if (!id) {
      const created = await fetch(`/api/papers/${encodeURIComponent(workspace.paper.id)}/conversations`, { method: "POST" }).then((r) => r.json());
      id = created.conversation.id; setConversationId(id);
    }
    const result = await fetch(`/api/conversations/${encodeURIComponent(id!)}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: question }) }).then((r) => r.json());
    setAnswer(result.message.content); setProposals(result.proposals); setQuestion("");
  }

  async function acceptProposal(proposal: Proposal) {
    if (!proposal.oneClickEligible) {
      const opened = await fetch(`/api/proposals/${encodeURIComponent(proposal.id)}/open-source`, { method: "POST" });
      if (opened.ok) {
        const source = await opened.json() as { pdfUrl: string; page: number };
        setPage(source.page); setPdfSrc(source.pdfUrl);
        setPdfOpen(true);
        setProposals((items) => items.map((item) => item.id === proposal.id ? { ...item, oneClickEligible: true } : item));
      }
      return;
    }
    const response = await fetch(`/api/proposals/${encodeURIComponent(proposal.id)}/decisions`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": `web-${proposal.id}` }, body: JSON.stringify({ action: "accept" }) });
    if (response.ok) setProposals((items) => items.filter((item) => item.id !== proposal.id));
  }

  async function askEntry(event: React.FormEvent) {
    event.preventDefault();
    const response = await fetch("/api/entry-agent/questions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: entryQuestion }) });
    if (response.ok) setEntryAnswer(await response.json());
  }

  async function importPaper(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setProgress("queued"); setError(null);
    try {
      const response = await fetch("/api/imports", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ arxivUrl: url }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.code ?? "导入失败");
      await importMonitor.wait(body.importRequest.id, setProgress);
      await refresh(); await openPaper(body.paper.id);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "导入失败"); }
    finally { setBusy(false); setProgress(null); }
  }

  async function retryImport() {
    if (!workspace?.processing) return;
    setBusy(true); setError(null); setProgress("queued");
    try {
      const response = await fetch(`/api/jobs/${encodeURIComponent(workspace.processing.jobId)}/retry`, {
        method: "POST", headers: { "idempotency-key": `web-retry-${workspace.processing.jobId}` },
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.detail ?? body.code ?? "重试失败");
      await importMonitor.wait(body.importRequest.id, setProgress);
      await refresh(); await openPaper(workspace.paper.id);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "重试失败"); }
    finally { setBusy(false); setProgress(null); }
  }

  if (workspace) return <main className="app workspace">
    <header className="topbar"><button className="ghost" onClick={() => setWorkspace(null)}>← 论文库</button><div><span className="eyebrow">PAPER WORKSPACE</span><h1>{workspace.paper.title}</h1></div><span className="version">arXiv v{workspace.paper.version}</span></header>
    <div className={`reading-grid ${pdfOpen ? "split" : ""}`}>
      <article className="summary-pane">
        <div className="pane-title"><div><span className="status">{workspace.summary ? "Summary Ready" : ["failed", "interrupted"].includes(workspace.processing?.state ?? "") ? "Import Failed" : "Processing"}</span><h2>技术精读</h2></div>
          <button disabled={!workspace.pdf} onClick={() => setPdfOpen((value) => !value)}>{pdfOpen ? "隐藏原文" : "打开原文"}</button></div>
        {!workspace.summary && <section className="import-state"><span className="section-no">IMPORT STATUS</span>
          <h3>{["failed", "interrupted"].includes(workspace.processing?.state ?? "") ? "论文处理未完成" : "正在生成 Paper Summary"}</h3>
          {workspace.processing?.error && <><p>{workspace.processing.error.stage} · {workspace.processing.error.code}</p>
            <p>{workspace.processing.error.message}</p></>}
          {workspace.processing && ["failed", "interrupted"].includes(workspace.processing.state) && <button disabled={busy} onClick={() => void retryImport()}>
            {busy ? `重试中 · ${progress ?? "queued"}` : workspace.processing.error?.action === "repair-data-root-permissions" ? "修复存储权限后重试" : "重试 Paper Summary 流程"}
          </button>}
          {error && <p className="error">{error}</p>}
        </section>}
        {workspace.summary?.sections.map((section, index) => <section key={section.key}><span className="section-no">0{index + 1}</span><h3>{section.title}</h3><p>{section.body}</p></section>)}
        <section><span className="section-no">KEY CLAIMS</span><h3>关键结论与证据</h3>
          {workspace.summary?.claims.map((claim) => <button className="claim" key={claim.claim} onClick={() => { setPage(claim.evidence.page); setPdfSrc(null); setPdfOpen(true); }}>
            <span>{claim.claim}</span><small>p. {claim.evidence.page} · {claim.evidence.verified ? "原文已核验" : "仅定位"}</small></button>)}</section>
        {workspace.summary && <section className="conversation"><span className="section-no">DISCUSS</span><h3>围绕 Paper 继续追问</h3>
          {answer && <div className="agent-answer"><b>ScholarLoom</b><p>{answer}</p></div>}
          {proposals.map((proposal) => <div className="proposal" key={proposal.id}><span>建议沉淀为 Takeaway</span><p>{proposal.claim}</p><button onClick={() => void acceptProposal(proposal)}>{proposal.oneClickEligible ? "确认沉淀" : "打开证据后确认"}</button></div>)}
          <form className="chat-form" onSubmit={askPaper}><input aria-label="Paper question" value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="论文或代码中的实现细节…"/><button>发送</button></form>
        </section>}
      </article>
      {pdfOpen && <aside className="pdf-pane"><div className="pdf-toolbar"><strong>原始 PDF</strong><span>Page {page} / {workspace.pdf?.pageCount}</span></div>
        <iframe title="原始 PDF" src={pdfSrc ?? `/api/paper-versions/${encodeURIComponent(workspace.paper.versionId)}/pdf#page=${page}`} /></aside>}
    </div>
  </main>;

  return <main className="app home"><header className="hero"><span className="eyebrow">PRIVATE RESEARCH WORKSPACE</span><h1>把阅读织成<br/><em>可追溯的知识。</em></h1><p>从一篇论文开始，保留每个结论的证据与来路。</p></header>
    <form className="import-card" onSubmit={importPaper}><label htmlFor="arxiv">导入 arXiv Paper</label><div><input id="arxiv" value={url} onChange={(e) => setUrl(e.target.value)} /><button disabled={busy}>{busy ? `处理中 · ${progress ?? "queued"}` : "导入并阅读"}</button></div>{error && <p className="error">{error}</p>}</form>
    <section className="entry-agent"><div className="section-heading"><span>CURATED ONLY</span><h2>向知识库提问</h2></div><form onSubmit={askEntry}><input aria-label="Knowledge question" value={entryQuestion} onChange={(e) => setEntryQuestion(e.target.value)}/><button>检索已确认知识</button></form>
      {entryAnswer && <div className="entry-result">{entryAnswer.projection.stale && <div className="stale">{entryAnswer.projection.notice} · {entryAnswer.projection.lastSuccessfulAt ?? "尚无成功索引"}</div>}<p>{entryAnswer.answer}</p>
        {entryAnswer.sources.map((source) => <button className="source-card" key={`${source.sourceType}-${source.title}`} onClick={() => void openPaper(source.paperId)}>{source.sourceType} · {source.title}</button>)}</div>}</section>
    <section className="library"><div className="section-heading"><span>LIBRARY</span><h2>论文库</h2></div>{papers.length === 0 ? <p className="empty">还没有论文。粘贴一个 arXiv 链接开始。</p> : papers.map((paper) => <button className="paper-card" key={paper.id} onClick={() => void openPaper(paper.id)}><span>v{paper.version}</span><div><h3>{paper.title}</h3><p>arXiv:{paper.arxivId}</p></div><b>→</b></button>)}</section>
  </main>;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
