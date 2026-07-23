import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  isRetryableImportJobState,
  isTerminalImportJobState,
  type ImportJobError,
  type ImportJobState,
} from "../domain/import-job.js";
import { paperHref, readBrowserRoute, type BrowserRoute } from "./browser-navigation.js";
import { importMonitor } from "./import-monitor.js";
import { SummaryMarkdown } from "./summary-markdown.js";
import { ConversationMessageBody, ConversationProposalGroup } from "./conversation-message.js";
import { conversationActionRequest, conversationListStatus, ConversationHeaderActions, NewConversationButton }
  from "./conversation-controls.js";
import { EvidenceInspector, type EvidenceInspectorModel } from "./evidence-inspector.js";
import "./styles.css";

type Paper = {
  id: string;
  title: string;
  authors: string[];
  year: number;
  arxivId?: string;
  version: number;
  versionLabel: string;
  sourceType: "arxiv" | "direct-pdf";
  sourceUrl: string;
  updatedAt?: string;
  processing?: { state: ImportJobState; progress: number; needsAttention: boolean; error: ImportJobError | null } | null;
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
  legacySource?: boolean;
  createdAt: string;
  archivedAt: string | null;
  payload: { claim?: string; sourceType?: string; currentVersion?: number | string; latestVersion?: number | string;
    candidateVersionId?: string; error?: string };
};
type EntryAnswer = {
  answer: string;
  sources: Array<{ sourceType: string; title: string; paperId: string; href?: string }>;
  projection: { stale: boolean; notice?: string; lastSuccessfulAt: string | null };
};
type OpenedPdfSource = { href: string; anchor: string; page: number };

function PdfFrame({ src }: { src: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const initialSrc = useRef(src);
  useEffect(() => {
    if (src === initialSrc.current) return;
    frame.current?.contentWindow?.location.replace(src);
    initialSrc.current = src;
  }, [src]);
  return <iframe ref={frame} title="原始 PDF" src={initialSrc.current} />;
}
type ConversationSummary = { id: string; paperId: string; title: string; status: "active" | "archived";
  snapshotIntegrity: "frozen" | "legacy"; continuedFromConversationId: string | null; updatedAt: string };
type ConversationDetail = {
  conversation: ConversationSummary & { contextSnapshotId: string };
  contextSnapshot: { id: string; paperVersionId: string; summaryRevisionId: string; extractionRunId: string;
    pageCount: number; repositorySnapshots: Array<{ id: string; commitSha: string }> } | null;
  messages: Array<{ id: string; role: "user" | "assistant"; content: string; inReplyToMessageId: string | null;
    groundingStatus?: string | null;
    citations: Array<{ id?: string; evidenceKind?: string; quote?: string | null; visualObservation?: string | null;
      page?: number | null; kind?: string; sourceHandle?: string;
      verificationStatus: string; locator: Record<string, unknown> }>;
    attempts: Array<{ id: string; attemptNo: number; state: string; runnerKind?: string | null; error: { code?: string } | null;
      receiptCounts?: Record<string, number> & { total: number };
      activities?: Array<{ type: string; text: string; createdAt: string }>; usage?: { status: string; inputTokens: number | null;
        cachedInputTokens: number | null; outputTokens: number | null; totalTokens: number | null; elapsedMs: number | null } | null }> }>;
};
type KnowledgeModel = { pendingProposals: Array<Proposal & { reviewStatus: string; legacySource: boolean;
  source: { conversationId: string; messageId: string } }>;
  confirmedTakeaways: Array<{ id: string; claim: string; revision: number; source: { conversationId: string; messageId: string } }> };

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
  const [failedSourceJobId, setFailedSourceJobId] = useState<string | null>(null);
  const [openedPdfSource, setOpenedPdfSource] = useState<OpenedPdfSource | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [entryQuestion, setEntryQuestion] = useState("fixture 可追溯证据");
  const [entryAnswer, setEntryAnswer] = useState<EntryAnswer | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversation, setConversation] = useState<ConversationDetail | null>(null);
  const [knowledge, setKnowledge] = useState<KnowledgeModel>({ pendingProposals: [], confirmedTakeaways: [] });
  const [discussionError, setDiscussionError] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<EvidenceInspectorModel | null>(null);

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

  const refreshConversationWorkspace = async (paperId: string, selectedId: string | null) => {
    try {
      const [listResponse, knowledgeResponse] = await Promise.all([
        fetch(`/api/papers/${encodeURIComponent(paperId)}/conversations`),
        fetch(`/api/papers/${encodeURIComponent(paperId)}/knowledge`),
      ]);
      if (!listResponse.ok || !knowledgeResponse.ok) throw new Error("Discussion / Knowledge 暂时不可用");
      setConversations((await listResponse.json() as { conversations: ConversationSummary[] }).conversations);
      setKnowledge(await knowledgeResponse.json() as KnowledgeModel);
      if (selectedId) {
        const detailResponse = await fetch(`/api/conversations/${encodeURIComponent(selectedId)}`);
        if (!detailResponse.ok) throw new Error(detailResponse.status === 404 ? "找不到这个 Conversation" : "Conversation 暂时不可用");
        const detail = await detailResponse.json() as ConversationDetail;
        if (detail.conversation.paperId !== paperId) throw new Error("Conversation 不属于 URL 中的 Paper");
        setConversation(detail);
      } else setConversation(null);
      setDiscussionError(null);
    } catch (cause) {
      setConversation(null);
      setDiscussionError(cause instanceof Error ? cause.message : "Discussion / Knowledge 暂时不可用");
    }
  };

  const refreshEvidence = async (receiptId: string) => {
    try {
      const response = await fetch(`/api/evidence/${encodeURIComponent(receiptId)}`);
      if (!response.ok) throw new Error("引用证据不可用");
      setEvidence(await response.json() as EvidenceInspectorModel);
    } catch (cause) {
      setDiscussionError(cause instanceof Error ? cause.message : "引用证据不可用");
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
    if (route.name !== "paper") return;
    void refreshConversationWorkspace(route.paperId, route.conversationId);
  }, [route.name === "paper" ? `${route.paperId}:${route.mode}:${route.conversationId ?? ""}` : null]);

  useEffect(() => {
    if (route.name !== "paper" || !route.evidenceReceiptId) { setEvidence(null); return; }
    void refreshEvidence(route.evidenceReceiptId);
  }, [route.name === "paper" ? route.evidenceReceiptId : null]);

  useEffect(() => {
    if (route.name !== "paper" || !route.conversationId) return;
    const running = conversation?.messages.some((message) => message.attempts.some((attempt) => ["queued", "running", "canceling"].includes(attempt.state)));
    if (!running) return;
    const timer = window.setInterval(() => void refreshConversationWorkspace(route.paperId, route.conversationId), 500);
    return () => window.clearInterval(timer);
  }, [route.name === "paper" ? route.conversationId : null, conversation?.messages.map((message) => message.attempts.map((attempt) => attempt.state).join(",")).join("|")]);

  useEffect(() => {
    if (route.name !== "paper") return;
    const key = `scholarloom:draft:${route.conversationId ?? `paper:${route.paperId}`}`;
    setQuestion(window.localStorage.getItem(key) ?? "");
  }, [route.name === "paper" ? `${route.paperId}:${route.conversationId ?? "new"}` : null]);

  useEffect(() => {
    if (route.name !== "paper" || !workspace?.processing || isTerminalImportJobState(workspace.processing.state)) return;
    const timer = window.setInterval(() => void refreshWorkspace(route.paperId), 3_000);
    return () => window.clearInterval(timer);
  }, [route.name === "paper" ? route.paperId : null, workspace?.processing?.state]);

  async function askPaper(event: React.FormEvent) {
    event.preventDefault();
    if (!workspace || !question.trim()) return;
    let id = route.name === "paper" ? route.conversationId : null;
    const initialDraftKey = route.name === "paper" ? `scholarloom:draft:${route.conversationId ?? `paper:${route.paperId}`}` : null;
    if (!id) {
      const created = await fetch(`/api/papers/${encodeURIComponent(workspace.paper.id)}/conversations`, { method: "POST" }).then((response) => response.json());
      id = created.conversation.id;
      setConversationId(id);
      navigate(paperHref(workspace.paper.id, { mode: "discussion", conversationId: id, pdfOpen: false, page: 1, anchor: null }));
    }
    const draftKey = `scholarloom:draft:${id}`;
    const response = await fetch(`/api/conversations/${encodeURIComponent(id!)}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: question, idempotencyKey: crypto.randomUUID() }),
    });
    if (!response.ok) { setDiscussionError("消息未能持久化，请重试。"); return; }
    window.localStorage.removeItem(draftKey);
    if (initialDraftKey) window.localStorage.removeItem(initialDraftKey);
    setQuestion("");
    await refreshConversationWorkspace(workspace.paper.id, id);
    void refreshReviews();
  }

  function updateQuestion(value: string) {
    setQuestion(value);
    if (route.name === "paper") window.localStorage.setItem(`scholarloom:draft:${route.conversationId ?? `paper:${route.paperId}`}`, value);
  }

  async function retryMessage(messageId: string) {
    if (route.name !== "paper" || !route.conversationId) return;
    const response = await fetch(`/api/messages/${encodeURIComponent(messageId)}/retry`, { method: "POST",
      headers: { "idempotency-key": crypto.randomUUID() } });
    if (!response.ok) { setDiscussionError("这条消息当前无法重试。"); return; }
    await refreshConversationWorkspace(route.paperId, route.conversationId);
  }

  async function cancelAttempt(attemptId: string) {
    const response = await fetch(`/api/agent-runs/${encodeURIComponent(attemptId)}/cancel`, { method: "POST" });
    if (!response.ok) { setDiscussionError("该 Attempt 已结束，无法取消。"); return; }
    if (route.name === "paper") await refreshConversationWorkspace(route.paperId, route.conversationId);
  }

  async function manageConversation(action: "rename" | "archive" | "restore", title?: string) {
    if (route.name !== "paper" || !route.conversationId) return;
    const response = await fetch(`/api/conversations/${encodeURIComponent(route.conversationId)}/${action}`,
      conversationActionRequest(action, title));
    if (!response.ok) { setDiscussionError("Conversation 状态更新失败。"); return; }
    await refreshConversationWorkspace(route.paperId, route.conversationId);
  }

  async function continueConversation() {
    if (route.name !== "paper" || !route.conversationId) return;
    const response = await fetch(`/api/papers/${encodeURIComponent(route.paperId)}/conversations`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ continuedFromConversationId: route.conversationId }) });
    if (!response.ok) { setDiscussionError("当前材料不足，无法创建新的冻结 Conversation。"); return; }
    const created = await response.json();
    navigate(paperHref(route.paperId, { mode: "discussion", conversationId: created.conversation.id,
      pdfOpen: false, page: 1, anchor: null }));
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
      if (route.name === "paper") void refreshConversationWorkspace(route.paperId, route.conversationId);
    }
  }

  async function reviewProposal(proposal: Proposal, action: "accept" | "edit-and-accept" | "reject", editedClaim?: string) {
    if (action === "accept") { await acceptProposal(proposal); return; }
    const response = await fetch(`/api/proposals/${encodeURIComponent(proposal.id)}/decisions`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ action, ...(editedClaim ? { editedClaim } : {}) }),
    });
    if (!response.ok) { setDiscussionError("Proposal 状态已变化或来源不可确认。"); return; }
    if (route.name === "paper") await refreshConversationWorkspace(route.paperId, route.conversationId);
    void refreshReviews();
    void refreshPapers();
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
        body: JSON.stringify({ reference: url }),
      });
      const body = await response.json();
      if (!response.ok) { setFailedSourceJobId(body.job?.id ?? null); throw new Error(body.detail ?? body.code ?? "导入失败"); }
      setFailedSourceJobId(null);
      setImportOpen(false);
      navigate(paperHref(body.paper.id));
      await refreshPapers();
      void importMonitor.wait(body.importRequest.id, setProgress)
        .then(async () => { await refreshPapers(); await refreshWorkspace(body.paper.id); })
        .catch(async (cause: unknown) => {
          await refreshPapers();
          await refreshWorkspace(body.paper.id);
          setError(cause instanceof Error ? cause.message : "导入失败");
        })
        .finally(() => setProgress(null));
    } catch (cause) {
      setProgress(null);
      setError(cause instanceof Error ? cause.message : "导入失败");
    } finally {
      setBusy(false);
    }
  }

  async function retrySourceImport() {
    if (!failedSourceJobId) return;
    setBusy(true); setError(null);
    try {
      const response = await fetch(`/api/jobs/${encodeURIComponent(failedSourceJobId)}/retry`, { method: "POST",
        headers: { "idempotency-key": `web-source-retry-${failedSourceJobId}-${Date.now()}` } });
      const body = await response.json();
      if (!response.ok) { setFailedSourceJobId(body.job?.id ?? failedSourceJobId); throw new Error(body.detail ?? body.code ?? "重试失败"); }
      setFailedSourceJobId(null); setImportOpen(false); navigate(paperHref(body.paper.id)); await refreshPapers();
      void importMonitor.wait(body.importRequest.id, setProgress).then(() => refreshWorkspace(body.paper.id)).finally(() => setProgress(null));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "重试失败"); }
    finally { setBusy(false); }
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
        .catch(async (cause: unknown) => {
          await refreshPapers();
          await refreshWorkspace(workspace.paper.id);
          setError(cause instanceof Error ? cause.message : "重试失败");
        })
        .finally(() => setProgress(null));
    } catch (cause) {
      setProgress(null);
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
        <button onClick={() => setImportOpen((value) => !value)}>导入论文</button>
      </div>
    </header>

    {importOpen && <form className="global-import" onSubmit={importPaper}>
      <label htmlFor="global-paper-reference">arXiv 或 PDF 直链</label>
      <div><input id="global-paper-reference" value={url} onChange={(event) => setUrl(event.target.value)}
        placeholder="https://arxiv.org/abs/… 或 https://example.org/paper.pdf" />
        <button disabled={busy}>{busy ? "正在识别…" : "导入并阅读"}</button></div>
      {error && <p className="error">{error}</p>}
      {failedSourceJobId && <button type="button" disabled={busy} onClick={() => void retrySourceImport()}>重试此来源</button>}
    </form>}

    {route.name === "home" && <ResearchHome papers={papers} papersError={papersError} processingPapers={processingPapers}
      attentionPapers={attentionPapers} pendingReviews={pendingReviews} entryQuestion={entryQuestion} entryAnswer={entryAnswer}
      onEntryQuestion={setEntryQuestion} onAskEntry={askEntry} onNavigate={navigate} onImport={() => setImportOpen(true)} />}
    {route.name === "papers" && <PaperLibrary papers={papers} error={papersError} onNavigate={navigate} onImport={() => setImportOpen(true)} />}
    {route.name === "reviews" && <ReviewCenter proposals={reviewProposals} error={reviewsError} onNavigate={navigate}
      onRefresh={refreshReviews} />}
    {route.name === "not-found" && <main className="page-state"><span className="eyebrow">NOT FOUND</span><h1>找不到这个页面</h1>
      <button onClick={() => navigate("/", true)}>返回研究首页</button></main>}
    {route.name === "paper" && (workspaceLoading && !workspace
      ? <main className="page-state loading-state"><span className="eyebrow">PAPER WORKSPACE</span><h1>正在载入 Paper…</h1></main>
      : workspaceError && !workspace
        ? <main className="page-state"><span className="eyebrow">PAPER UNAVAILABLE</span><h1>{workspaceError}</h1><button onClick={() => navigate("/papers")}>返回论文库</button></main>
        : workspace && workspace.paper.id === route.paperId && <PaperWorkspace workspace={workspace} route={route} busy={busy} progress={progress}
          error={workspaceError ?? discussionError} openedPdfSource={openedPdfSource} conversations={conversations}
          conversation={conversation} knowledge={knowledge} question={question} onQuestion={updateQuestion}
          onAskPaper={askPaper} onRetryMessage={retryMessage} onAcceptProposal={acceptProposal}
          onCancelAttempt={cancelAttempt} evidence={evidence}
          onEvidenceIntegrityFailure={() => route.evidenceReceiptId && void refreshEvidence(route.evidenceReceiptId)}
          onReviewProposal={reviewProposal}
          onManageConversation={manageConversation} onContinueConversation={continueConversation}
          onRetry={retryImport} onNavigate={navigate} />)}
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
      : papers.length === 0 ? <div className="empty"><p>还没有论文。粘贴 arXiv 链接或公开 PDF 直链开始。</p><button onClick={onImport}>导入论文</button></div>
        : papers.map((paper) => <PaperCard key={paper.id} paper={paper} onNavigate={onNavigate} />)}</section>
  </main>;
}

function PaperCard({ paper, onNavigate }: { paper: Paper; onNavigate(href: string): void }) {
  const processingLabel = paperSummaryLabel(paper);
  const codeLabel = paper.codeStatus === "ready" ? "代码可用" : paper.codeStatus === "failed" ? "代码失败" : "未发现明确代码链接";
  const href = paperHref(paper.id);
  const sourceLabel = paper.sourceType === "arxiv" ? `arXiv:${paper.arxivId}` : `公开 PDF · ${safeSourceHost(paper.sourceUrl)}`;
  return <a className="paper-card" href={href} onClick={(event) => { if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
    event.preventDefault(); onNavigate(href); } }}><span>{paper.sourceType === "arxiv" ? `v${paper.version}` : "PDF"}</span><div><h3>{paper.title}</h3><p className="paper-source">{sourceLabel}</p>
      <div className="paper-badges"><small>{processingLabel}</small><small>{codeLabel}</small>{Boolean(paper.pendingReviewCount) && <small>待审核 {paper.pendingReviewCount}</small>}</div>
      {paper.processing?.error && <p className="paper-error">失败原因：{paper.processing.error.message}</p>}
    </div><b>→</b></a>;
}

function safeSourceHost(value: string): string {
  try { return new URL(value).host; } catch { return "来源不可用"; }
}

function paperSummaryLabel(paper: Paper): string {
  if (paper.summaryStatus === "ready") return "Summary Ready";
  if (paper.processing?.state === "cancelled") return "处理已取消";
  if (paper.processing?.needsAttention) return "需要恢复";
  if (paper.processing && !isTerminalImportJobState(paper.processing.state)) return "处理中";
  return paper.summaryStatus === "failed" ? "Summary 失败" : "Summary 不可用";
}

function ReviewCenter({ proposals, error, onNavigate, onRefresh }: { proposals: ReviewProposal[]; error: string | null;
  onNavigate(href: string): void; onRefresh(): Promise<void> }) {
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const [actionError, setActionError] = useState<string | null>(null);
  const pending = proposals.filter((proposal) => proposal.reviewStatus === "pending" && !proposal.archivedAt);
  const openCandidate = async (proposal: ReviewProposal) => {
    const response = await fetch(`/api/proposals/${encodeURIComponent(proposal.id)}/open-source`, { method: "POST" });
    if (!response.ok) { setActionError("无法打开候选 PDF，请稍后重试。"); return; }
    const source = await response.json() as { pdfUrl: string };
    window.open(source.pdfUrl, "_blank", "noopener,noreferrer");
    setOpened((current) => new Set(current).add(proposal.id));
    setActionError(null);
  };
  const acceptCandidate = async (proposal: ReviewProposal) => {
    const response = await fetch(`/api/proposals/${encodeURIComponent(proposal.id)}/decisions`, { method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": `web-version-${proposal.id}` }, body: JSON.stringify({ action: "accept" }) });
    if (!response.ok) { setActionError("候选版本尚未通过来源核验，无法确认。"); return; }
    setActionError(null);
    await onRefresh();
  };
  const decideTakeaway = async (proposal: ReviewProposal, action: "accept" | "edit-and-accept" | "reject", editedClaim?: string) => {
    const response = await fetch(`/api/proposals/${encodeURIComponent(proposal.id)}/decisions`, { method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ action, ...(editedClaim ? { editedClaim } : {}) }) });
    if (!response.ok) { setActionError("Proposal 已变化，或固定来源尚未完成核验。"); return; }
    setActionError(null);
    await onRefresh();
  };
  return <main className="app page reviews-page"><header className="page-header"><span className="eyebrow">REVIEW CENTER</span><h1>审核中心</h1>
    <p>Proposal 在确认前不会成为长期知识。</p></header>
    {actionError && <p className="error-block">{actionError}</p>}
    {error && pending.length > 0 && <p className="inline-alert">{error}，正在显示上次成功载入的审核队列。</p>}
    {error && proposals.length === 0 ? <p className="error-block">{error}</p>
      : pending.length === 0 ? <div className="empty"><p>当前没有待审核 Proposal。</p><button onClick={() => onNavigate("/papers")}>返回阅读</button></div>
      : <div className="review-list">{pending.map((proposal) => <article className="review-card" key={proposal.id}>
        <span className="eyebrow">{proposal.proposalType.replaceAll("-", " ")}</span>
        <h2>{proposal.payload.claim ?? (proposal.proposalType === "paper-version-update"
          ? proposal.payload.sourceType === "direct-pdf" ? "检测到新的 PDF 内容版本" : `Paper Version v${proposal.payload.latestVersion} 可用`
          : "需要你的判断")}</h2>
        <p>{proposal.oneClickEligible ? "证据已满足快速确认条件" : "确认前需要查看完整来源"}</p>
        {proposal.proposalType === "paper-version-update" && proposal.payload.sourceType === "direct-pdf" && <div className="review-actions">
          <button onClick={() => void openCandidate(proposal)}>打开候选 PDF</button>
          <button disabled={!opened.has(proposal.id)} onClick={() => void acceptCandidate(proposal)}>确认采用此版本</button>
        </div>}
        {proposal.proposalType === "takeaway" && <div className="review-actions">
          {!proposal.oneClickEligible && <button onClick={() => void openCandidate(proposal)}>查看固定来源</button>}
          {!proposal.legacySource && <button disabled={!proposal.oneClickEligible && !opened.has(proposal.id)}
            onClick={() => void decideTakeaway(proposal, "accept")}>确认</button>}
          {!proposal.legacySource && <button disabled={!proposal.oneClickEligible && !opened.has(proposal.id)} onClick={() => {
            const edited = window.prompt("编辑确认后的 Takeaway", proposal.payload.claim ?? "");
            if (edited) void decideTakeaway(proposal, "edit-and-accept", edited); }}>编辑后确认</button>}
          <button onClick={() => void decideTakeaway(proposal, "reject")}>拒绝</button>
        </div>}
        {proposal.legacySource && <p className="inline-alert">旧 Conversation 来源不完整，只能查看或拒绝，不能确认。</p>}
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
  conversations: ConversationSummary[];
  conversation: ConversationDetail | null;
  knowledge: KnowledgeModel;
  question: string;
  onQuestion(value: string): void;
  onAskPaper(event: React.FormEvent): void;
  onRetryMessage(messageId: string): void;
  onCancelAttempt(attemptId: string): void;
  onAcceptProposal(proposal: Proposal): void;
  onReviewProposal(proposal: Proposal, action: "accept" | "edit-and-accept" | "reject", editedClaim?: string): void;
  onManageConversation(action: "rename" | "archive" | "restore", title?: string): void;
  onContinueConversation(): void;
  onRetry(): void;
  onNavigate(href: string, replace?: boolean): void;
  evidence: EvidenceInspectorModel | null;
  onEvidenceIntegrityFailure(): void;
}) {
  const { workspace, route } = props;
  const codeStatus = workspace.repository?.status === "ready" ? "代码可用于讨论"
    : workspace.repository?.status === "failed" ? "代码关联失败"
      : workspace.processing && !isTerminalImportJobState(workspace.processing.state) ? "正在检查代码关联" : "未发现明确代码链接";
  const setPdf = (pdfOpen: boolean, page = route.page, anchor = route.anchor) => {
    props.onNavigate(paperHref(workspace.paper.id, { mode: route.mode, conversationId: route.conversationId, pdfOpen, page, anchor }));
  };
  const pdfPageCount = route.mode === "discussion"
    ? props.conversation?.contextSnapshot?.pageCount ?? 0
    : workspace.pdf?.pageCount ?? 0;
  const changePdfPage = (offset: number) => {
    const page = Math.min(pdfPageCount || route.page, Math.max(1, route.page + offset));
    props.onNavigate(paperHref(workspace.paper.id, { mode: route.mode, conversationId: route.conversationId,
      pdfOpen: true, page, anchor: null }), true);
  };
  const modeHref = (mode: "reading" | "discussion" | "knowledge") => paperHref(workspace.paper.id,
    { mode, conversationId: null, pdfOpen: false, page: 1, anchor: null });
  const running = props.conversation?.messages.some((message) => message.attempts.some((attempt) => attempt.state === "running")) ?? false;
  const discussionProposals = props.knowledge.pendingProposals.filter((proposal) =>
    proposal.source.conversationId === props.conversation?.conversation.id);
  return <main className="app workspace">
    <header className="topbar"><a className="ghost" href="/papers" onClick={(event) => { event.preventDefault(); props.onNavigate("/papers"); }}>← 论文库</a>
      <div><span className="eyebrow">PAPER WORKSPACE</span><h1>{workspace.paper.title}</h1>
        <p className="paper-metadata">{workspace.paper.authors.join(", ")} · {workspace.paper.year}</p></div>
      <div className="workspace-badges"><span className="version">{workspace.paper.sourceType === "arxiv" ? `arXiv v${workspace.paper.version}` : "公开 PDF"}</span>
        <a className="source-link" href={workspace.paper.sourceUrl} target="_blank" rel="noopener noreferrer">打开来源</a>
        <span className="code-status" title={workspace.repository?.url}>{codeStatus}</span></div>
    </header>
    {props.error && <div className="inline-alert">{props.error}</div>}
    <nav className="workspace-modes" aria-label="Paper workspace mode">
      {(["reading", "discussion", "knowledge"] as const).map((mode) => <a key={mode} href={modeHref(mode)}
        aria-current={route.mode === mode ? "page" : undefined}
        onClick={(event) => { event.preventDefault(); props.onNavigate(modeHref(mode)); }}>{mode === "reading" ? "Reading" : mode === "discussion" ? "Discussion" : "Knowledge"}</a>)}
    </nav>
    {route.mode === "discussion" && <div className="discussion-layout">
      <aside className="conversation-list"><div className="conversation-list-heading"><div><span className="eyebrow">CONVERSATIONS</span><h2>论文讨论</h2></div>
        <NewConversationButton onCreate={() => props.onNavigate(modeHref("discussion"))} /></div>
        {props.conversations.length === 0 && <p className="empty">还没有 Conversation。</p>}
        {props.conversations.map((item) => <a key={item.id}
          className={route.conversationId === item.id ? "selected" : ""}
          href={paperHref(workspace.paper.id, { mode: "discussion", conversationId: item.id, pdfOpen: false, page: 1, anchor: null })}
          onClick={(event) => { event.preventDefault(); props.onNavigate(paperHref(workspace.paper.id,
            { mode: "discussion", conversationId: item.id, pdfOpen: false, page: 1, anchor: null })); }}>
          <strong>{item.title}</strong><small className={item.continuedFromConversationId ? "successor" : undefined}>
            {conversationListStatus({ archived: item.status === "archived", legacy: item.snapshotIntegrity === "legacy",
              successor: item.continuedFromConversationId !== null })}</small></a>)}
      </aside>
      <section className="discussion-pane">
        {!route.conversationId && <div className="discussion-empty"><span className="eyebrow">INDEPENDENT CONVERSATION</span><h2>开启独立新对话</h2>
          <p>不关联现有 Conversation；发送第一条消息时，将冻结当前 Paper、Summary、Extraction 与 Repository Snapshots。</p></div>}
        {route.conversationId && !props.conversation && <div className="discussion-empty"><h2>正在恢复 Conversation…</h2></div>}
        {props.conversation && <><header className="conversation-header"><div><span className="eyebrow">{props.conversation.conversation.snapshotIntegrity === "legacy" ? "LEGACY · READ ONLY" : "FROZEN CONTEXT"}</span>
          <h2>{props.conversation.conversation.title}</h2></div><ConversationHeaderActions
            repositorySnapshotCount={props.conversation.contextSnapshot?.repositorySnapshots.length ?? 0}
            isSuccessor={props.conversation.conversation.continuedFromConversationId !== null}
            archived={props.conversation.conversation.status === "archived"}
            canContinue={props.conversation.messages.length > 0}
            legacy={props.conversation.conversation.snapshotIntegrity === "legacy"}
            onContinue={() => void props.onContinueConversation()}
            onRename={() => { const title = window.prompt("Conversation 标题", props.conversation!.conversation.title);
              if (title) void props.onManageConversation("rename", title); }}
            onToggleArchive={() => void props.onManageConversation(
              props.conversation!.conversation.status === "archived" ? "restore" : "archive")} /></header>
          <div className="message-timeline">{props.conversation.messages.map((message) => {
            const messageProposals = discussionProposals.filter((proposal) => proposal.source.messageId === message.id);
            const openInlineEvidence = (page: number) => props.onNavigate(paperHref(workspace.paper.id, { mode: "discussion",
              conversationId: route.conversationId, pdfOpen: true, page,
              anchor: props.conversation?.contextSnapshot
                ? `evidence:${props.conversation.contextSnapshot.paperVersionId}:page:${page}:source` : null }));
            return <article key={message.id} className={`message ${message.role}`}>
            <b>{message.role === "user" ? "你" : "ScholarLoom"}</b>
            <ConversationMessageBody role={message.role} content={message.content} pageCount={pdfPageCount}
              onOpenEvidence={openInlineEvidence} />
            {message.citations.length > 0 && <div className="citation-list verified-citations">{message.citations.map((citation, index) => {
              const locator = citation.locator;
              if (citation.id && citation.evidenceKind) {
                const receiptHref = paperHref(workspace.paper.id, { mode: "discussion", conversationId: route.conversationId,
                  pdfOpen: false, page: 1, anchor: null, evidenceReceiptId: citation.id });
                return <a key={citation.id} className={`citation receipt ${citation.evidenceKind}`} href={receiptHref}
                  onClick={(event) => { event.preventDefault(); props.onNavigate(receiptHref); }}>
                  {citation.evidenceKind === "visual" ? `Visual · p. ${String(citation.page ?? citation.locator.page ?? "?")}`
                    : `${citation.evidenceKind.toUpperCase()} · ${citation.quote?.slice(0, 48)}`}</a>;
              }
              const label = locator.type === "pdf" ? `PDF · p. ${String(locator.page)}`
                : locator.type === "code" ? `${String(locator.path)} · ${String(locator.commitSha).slice(0, 8)}`
                  : locator.type === "summary" ? `Summary · ${String(locator.sectionKey)}` : "历史消息";
              const href = locator.type === "pdf" ? paperHref(workspace.paper.id, { mode: "discussion", conversationId: route.conversationId,
                pdfOpen: true, page: Number(locator.page), anchor: String(locator.evidenceAnchorId) }) : "#";
              if (locator.type === "code") return <details key={`${message.id}-${index}`} className="citation-detail">
                <summary className="citation">{label}</summary><code>{String(locator.commitSha)} · {String(locator.path)}:{String(locator.startLine)}-{String(locator.endLine)}</code>
              </details>;
              if (locator.type === "summary" || locator.type === "message") return <details key={`${message.id}-${index}`} className="citation-detail">
                <summary className="citation">{label}</summary><code>{JSON.stringify(locator)}</code>
              </details>;
              return <a key={`${message.id}-${index}`} className="citation" href={href}
                onClick={(event) => { event.preventDefault(); props.onNavigate(href); }}>{label}</a>;
            })}</div>}
            <ConversationProposalGroup proposals={messageProposals}
              onAccept={(proposal) => { const source = messageProposals.find((candidate) => candidate.id === proposal.id);
                if (source) void props.onReviewProposal(source, "accept"); }}
              onEdit={(proposal) => { const edited = window.prompt("编辑确认后的 Takeaway", proposal.claim);
                const source = messageProposals.find((candidate) => candidate.id === proposal.id);
                if (edited && source) void props.onReviewProposal(source, "edit-and-accept", edited); }}
              onReject={(proposal) => { const source = messageProposals.find((candidate) => candidate.id === proposal.id);
                if (source) void props.onReviewProposal(source, "reject"); }} />
            {message.attempts.slice(-1).map((attempt) => <div key={attempt.id} className={`attempt ${attempt.state}`}>
              <div><span>{attempt.state === "queued" ? "排队中" : attempt.state === "running" ? "正在处理…"
                : attempt.state === "interrupted" ? "服务中断，回答未完成" : attempt.state === "succeeded"
                  ? `${formatReceiptCounts(attempt.receiptCounts)} · ${formatUsage(attempt.usage)}` : `${attempt.state} · ${attempt.error?.code ?? "未保存回答"}`}</span>
                {attempt.runnerKind === "legacy_one_shot" && <small>Legacy one-shot</small>}
                {attempt.activities && attempt.activities.length > 0 && <details className="activity-timeline"><summary>Agent Activity · {attempt.activities.length}</summary>
                  <ol>{attempt.activities.map((activity, activityIndex) => <li key={`${activity.type}-${activityIndex}`}><b>{activity.type}</b> {activity.text}</li>)}</ol></details>}</div>
              {(attempt.state === "queued" || attempt.state === "running") && attempt.runnerKind === "agentic_evidence" &&
                <button onClick={() => void props.onCancelAttempt(attempt.id)}>取消</button>}
              {(attempt.state === "failed" || attempt.state === "interrupted") && <button onClick={() => void props.onRetryMessage(message.id)}>重试</button>}
              {(attempt.state === "timed_out" || attempt.state === "canceled") && <button onClick={() => void props.onRetryMessage(message.id)}>重试</button>}
            </div>)}</article>})}</div></>}
        {(!props.conversation || (props.conversation.conversation.status === "active" && props.conversation.conversation.snapshotIntegrity === "frozen")) &&
          <form className="chat-form discussion-composer" onSubmit={props.onAskPaper}><input aria-label="Paper question" value={props.question}
            onChange={(event) => props.onQuestion(event.target.value)} placeholder="论文、Summary 或固定代码快照中的问题…" disabled={running}/>
            <button disabled={running || !props.question.trim()}>{running ? "处理中" : "发送"}</button></form>}
      </section>
      {route.pdfOpen && <aside className="pdf-pane source-view"><div className="pdf-toolbar"><strong>固定 PDF 证据</strong>
        <button aria-label="上一页" disabled={route.page <= 1} onClick={() => changePdfPage(-1)}>←</button>
        <span>Page {route.page} / {pdfPageCount}</span>
        <button aria-label="下一页" disabled={route.page >= pdfPageCount} onClick={() => changePdfPage(1)}>→</button></div>
        <PdfFrame src={`/api/paper-versions/${encodeURIComponent(props.conversation?.contextSnapshot?.paperVersionId ?? workspace.paper.versionId)}/pdf#page=${route.page}`} /></aside>}
      {route.evidenceReceiptId && props.evidence && <EvidenceInspector evidence={props.evidence}
        onIntegrityFailure={props.onEvidenceIntegrityFailure} onClose={() => props.onNavigate(
        paperHref(workspace.paper.id, { mode: "discussion", conversationId: route.conversationId, pdfOpen: false,
          page: 1, anchor: null, evidenceReceiptId: null }))} />}
    </div>}
    {route.mode === "knowledge" && <section className="knowledge-workspace"><header><span className="eyebrow">PAPER KNOWLEDGE</span><h2>已审核知识</h2></header>
      <div className="knowledge-columns"><div><h3>Pending Proposals</h3>{props.knowledge.pendingProposals.length === 0 && <p className="empty">没有待审核 Proposal。</p>}
        {props.knowledge.pendingProposals.map((proposal) => <article className="proposal" key={proposal.id}><span>{proposal.legacySource ? "LEGACY · REJECT ONLY" : "TAKEAWAY PROPOSAL"}</span>
          <p>{proposal.claim}</p><small>来源：{proposal.source.conversationId}</small><div className="review-actions">
            {!proposal.legacySource && <><button onClick={() => void props.onReviewProposal(proposal, "accept")}>确认</button>
              <button onClick={() => { const edited = window.prompt("编辑确认后的 Takeaway", proposal.claim); if (edited) void props.onReviewProposal(proposal, "edit-and-accept", edited); }}>编辑后确认</button></>}
            <button onClick={() => void props.onReviewProposal(proposal, "reject")}>拒绝</button></div></article>)}</div>
        <div><h3>Confirmed Takeaways</h3>{props.knowledge.confirmedTakeaways.length === 0 && <p className="empty">尚无 confirmed Takeaway。</p>}
          {props.knowledge.confirmedTakeaways.map((takeaway) => <article className="takeaway" key={takeaway.id}><span className="eyebrow">CONFIRMED · R{takeaway.revision}</span>
            <p>{takeaway.claim}</p><a href={paperHref(workspace.paper.id, { mode: "discussion", conversationId: takeaway.source.conversationId,
              pdfOpen: false, page: 1, anchor: null })} onClick={(event) => { event.preventDefault(); props.onNavigate(paperHref(workspace.paper.id,
                { mode: "discussion", conversationId: takeaway.source.conversationId, pdfOpen: false, page: 1, anchor: null })); }}>查看来源 Conversation →</a></article>)}</div></div>
    </section>}
    {route.mode === "reading" && <div className={`reading-grid ${route.pdfOpen ? "split" : ""}`}>
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
          <h3>{section.title}</h3><SummaryMarkdown markdown={section.body} pageCount={workspace.pdf?.pageCount ?? 0}
            onOpenEvidence={(page) => props.onNavigate(paperHref(workspace.paper.id, {
              mode: "reading", pdfOpen: true, page, anchor: `page:${page}`,
            }))} /></section>)}
        {workspace.summary && <section><span className="section-no">KEY CLAIMS</span><h3>关键结论与证据</h3>
          {workspace.summary.claims.map((claim) => <button className={`claim ${route.anchor === claim.evidence.id ? "selected" : ""}`} key={claim.claim}
            onClick={() => { props.onNavigate(paperHref(workspace.paper.id, { mode: "reading", pdfOpen: true, page: claim.evidence.page,
              anchor: claim.evidence.id ?? `page:${claim.evidence.page}` })); }}>
            <span>{claim.claim}</span><small>p. {claim.evidence.page} · {claim.evidence.verified ? "原文已核验" : "仅定位"}</small></button>)}</section>}
      </article>
      {route.pdfOpen && <aside className="pdf-pane"><div className="pdf-toolbar"><strong>原始 PDF</strong>
        <button aria-label="上一页" disabled={route.page <= 1} onClick={() => changePdfPage(-1)}>←</button>
        <span>Page {route.page} / {pdfPageCount}</span>
        <button aria-label="下一页" disabled={route.page >= pdfPageCount} onClick={() => changePdfPage(1)}>→</button></div>
        <PdfFrame src={props.openedPdfSource?.anchor === route.anchor && props.openedPdfSource.page === route.page
          ? props.openedPdfSource.href : `/api/paper-versions/${encodeURIComponent(workspace.paper.versionId)}/pdf#page=${route.page}`} /></aside>}
    </div>}
  </main>;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);

function formatUsage(usage: ConversationDetail["messages"][number]["attempts"][number]["usage"]): string {
  if (!usage || usage.status === "unavailable") return "tokens unavailable";
  const tokens = usage.totalTokens === null ? "tokens unavailable" : `${(usage.totalTokens / 1000).toFixed(1)}k tokens`;
  const elapsed = usage.elapsedMs === null ? "" : ` · ${Math.max(1, Math.round(usage.elapsedMs / 1000))}秒`;
  return `${tokens}${elapsed}`;
}

function formatReceiptCounts(counts: (Record<string, number> & { total: number }) | undefined): string {
  if (!counts) return "证据 0";
  const parts = [`证据 ${counts.total}`];
  for (const [kind, label] of [["pdf", "PDF"], ["code", "代码"], ["summary", "Summary"], ["library", "Library"], ["visual", "Visual"]] as const) {
    if (counts[kind]) parts.push(`${label} ${counts[kind]}`);
  }
  return parts.join(" · ");
}
