import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/dm-sans/400.css";
import "@fontsource/dm-sans/500.css";
import "@fontsource/dm-sans/600.css";
import "@fontsource/newsreader/500.css";
import "@fontsource/newsreader/500-italic.css";
import {
  isRetryableImportJobState,
  isTerminalImportJobState,
  type ImportJobError,
  type ImportJobState,
} from "../domain/import-job.js";
import { paperHref, papersHref, readBrowserRoute, type BrowserRoute, type PaperLibraryViewState } from "./browser-navigation.js";
import { importMonitor } from "./import-monitor.js";
import { SummaryMarkdown } from "./summary-markdown.js";
import { ConversationMessageBody, ConversationProposalGroup, TakeawayReviewCard,
  type ConversationProposal, type TakeawayDecisionInput } from "./conversation-message.js";
import { canContinueConversation, conversationActionRequest, filterConversationsByArchive, conversationListStatus, ConversationHeaderActions,
  NewConversationButton, type ConversationLineage }
  from "./conversation-controls.js";
import { EvidenceInspector, type EvidenceInspectorModel } from "./evidence-inspector.js";
import { RepositoryPanel, type RepositoryAssociation } from "./repository-panel.js";
import { SettingsPage } from "./settings-page.js";
import type { SettingsSnapshot } from "../settings/settings-snapshot.js";
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
  aliases: Array<{ name: string; kind: "model-name" | "method-name" | "acronym" | "project-name" | "user-defined"; preferred: boolean }>;
  preferredAlias: string | null;
  directions: Array<{ topicId: string; title: string; role: "primary" | "secondary" }>;
  externalIdentities: string[];
  pendingOrganizationCount: number;
  aliasCollision: boolean;
  matchedBy?: { kind: string; value: string; exact: boolean };
};
type ResearchDirection = {
  id: string;
  title: string;
  aliases: string[];
  scope: string;
  usageLevel: "classification" | "knowledge-ready";
  primaryCount: number;
  secondaryCount: number;
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
  repositories: RepositoryAssociation[];
};
type Proposal = ConversationProposal & { oneClickEligible: boolean };
type ReviewProposal = {
  id: string;
  proposalType: string;
  paperId: string | null;
  reviewStatus: string;
  oneClickEligible: boolean;
  legacySource?: boolean;
  createdAt: string;
  archivedAt: string | null;
  liveDuplicateIds?: string[];
  duplicateAcknowledgementRequired?: boolean;
  sourceConversationHref?: string | null;
  distillationState?: string | null;
  payload: ConversationProposal & { sourceType?: string; currentVersion?: number | string; latestVersion?: number | string;
    candidateVersionId?: string; error?: string; targetKind?: string; targetPath?: string; validationError?: string };
};
type EntryAnswer = {
  answer: string;
  sources: Array<{ sourceType: "summary" | "takeaway"; sourceId: string; title: string; paperId: string; href?: string }>;
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
  capabilities?: { takeawayDistillation: boolean };
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
        cachedInputTokens: number | null; outputTokens: number | null; totalTokens: number | null; elapsedMs: number | null } | null }>;
    distillations: Array<{ id: string; state: string; trigger: string; outcome: string | null; reasonCode: string | null;
      proposalId: string | null; focus: string | null; error: { code?: string } | null }> }>;
};
type KnowledgeModel = { pendingProposals: Array<Proposal & { reviewStatus: string; legacySource: boolean;
  title?: string; kind?: string; epistemicStatus?: string; evidenceRationale?: string; caveat?: string | null;
  receiptIds?: string[]; selectionRationale?: string; duplicateHints?: string[]; liveDuplicateIds?: string[];
  duplicateAcknowledgementRequired?: boolean; contractVersion?: string;
  sourceConversationHref?: string | null; distillationState?: string | null;
  source: { conversationId: string; messageId: string } }>;
  confirmedTakeaways: Array<{ id: string; claim: string; revision: number; source: { conversationId: string; messageId: string } }> };

function App() {
  const [route, setRoute] = useState<BrowserRoute>(() => readBrowserRoute(window.location));
  const [papers, setPapers] = useState<Paper[]>([]);
  const [papersError, setPapersError] = useState<string | null>(null);
  const [directions, setDirections] = useState<ResearchDirection[]>([]);
  const [reviewProposals, setReviewProposals] = useState<ReviewProposal[]>([]);
  const [reviewsError, setReviewsError] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<ImportJobState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [failedSourceJobId, setFailedSourceJobId] = useState<string | null>(null);
  const [openedPdfSource, setOpenedPdfSource] = useState<OpenedPdfSource | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [entryQuestion, setEntryQuestion] = useState("");
  const [entryAnswer, setEntryAnswer] = useState<EntryAnswer | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversation, setConversation] = useState<ConversationDetail | null>(null);
  const [conversationLineage, setConversationLineage] = useState<ConversationLineage | null>(null);
  const [knowledge, setKnowledge] = useState<KnowledgeModel>({ pendingProposals: [], confirmedTakeaways: [] });
  const [discussionError, setDiscussionError] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<EvidenceInspectorModel | null>(null);
  const [repositoryBusy, setRepositoryBusy] = useState(false);
  const [repositoryError, setRepositoryError] = useState<string | null>(null);
  const [settings, setSettings] = useState<SettingsSnapshot | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);

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

  const refreshDirections = async () => {
    try {
      const response = await fetch("/api/directions");
      if (!response.ok) throw new Error("方向目录暂时不可用");
      setDirections((await response.json() as { directions: ResearchDirection[] }).directions);
    } catch {
      // Paper reading remains available if the organization projection is unavailable.
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
      let lineageWarning: string | null = null;
      if (selectedId) {
        const detailResponse = await fetch(`/api/conversations/${encodeURIComponent(selectedId)}`);
        if (!detailResponse.ok) {
          throw new Error(detailResponse.status === 404 ? "找不到这个 Conversation" : "Conversation 暂时不可用");
        }
        const detail = await detailResponse.json() as ConversationDetail;
        if (detail.conversation.paperId !== paperId) throw new Error("Conversation 不属于 URL 中的 Paper");
        setConversation(detail);
        try {
          const lineageResponse = await fetch(`/api/conversations/${encodeURIComponent(selectedId)}/lineage`);
          if (!lineageResponse.ok) throw new Error("lineage-unavailable");
          setConversationLineage(await lineageResponse.json() as ConversationLineage);
        } catch {
          setConversationLineage(null);
          lineageWarning = "Conversation 消息仍可阅读，但关系与 Context Diff 暂时不可用。";
        }
      } else {
        setConversation(null);
        setConversationLineage(null);
      }
      setDiscussionError(lineageWarning);
    } catch (cause) {
      setConversation(null);
      setConversationLineage(null);
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
    void refreshDirections();
    void refreshReviews();
    const timer = window.setInterval(() => { void refreshPapers(); void refreshDirections(); void refreshReviews(); }, 5_000);
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
    if (route.name !== "paper") return;
    const importRunning = Boolean(workspace?.processing && !isTerminalImportJobState(workspace.processing.state));
    const repositoryRunning = workspace?.repositories.some((repository) =>
      ["queued", "running"].includes(repository.materializationStatus)) ?? false;
    if (!importRunning && !repositoryRunning) return;
    const timer = window.setInterval(() => void refreshWorkspace(route.paperId), repositoryRunning ? 750 : 3_000);
    return () => window.clearInterval(timer);
  }, [route.name === "paper" ? route.paperId : null, workspace?.processing?.state,
    workspace?.repositories.map((repository) => repository.materializationStatus).join("|")]);

  useEffect(() => {
    if (route.name !== "settings") return;
    setSettingsError(null);
    void fetch("/api/settings").then(async (response) => {
      if (!response.ok) throw new Error("系统配置暂时不可用");
      setSettings(await response.json() as SettingsSnapshot);
    }).catch((cause: unknown) => {
      setSettingsError(cause instanceof Error ? cause.message : "系统配置暂时不可用");
    });
  }, [route.name]);

  async function repositoryCommand(path: string, method: "POST", body?: object) {
    if (route.name !== "paper") return;
    setRepositoryBusy(true);
    setRepositoryError(null);
    try {
      const response = await fetch(path, {
        method,
        headers: {
          "idempotency-key": crypto.randomUUID(),
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const result = await response.json() as { code?: string };
      if (!response.ok) {
        const messages: Record<string, string> = {
          "invalid-github-repository-url": "请输入明确的 GitHub repository root URL。",
          "repository-job-not-retryable": "当前状态不能重试，可能已有物化正在进行。",
          "paper-not-active": "此 Paper 当前为只读状态。",
        };
        throw new Error(messages[result.code ?? ""] ?? "代码仓库操作失败。");
      }
      await refreshWorkspace(route.paperId);
    } catch (cause) {
      setRepositoryError(cause instanceof Error ? cause.message : "代码仓库操作失败。");
    } finally {
      setRepositoryBusy(false);
    }
  }

  async function askPaper(event: React.FormEvent) {
    event.preventDefault();
    if (!workspace || !question.trim()) return;
    let id = route.name === "paper" ? route.conversationId : null;
    const initialDraftKey = route.name === "paper" ? `scholarloom:draft:${route.conversationId ?? `paper:${route.paperId}`}` : null;
    if (!id) {
      const response = await fetch(`/api/papers/${encodeURIComponent(workspace.paper.id)}/conversations`, { method: "POST" });
      const created = await response.json();
      if (!response.ok) {
        setDiscussionError(created.code === "conversation-context-unavailable"
          ? "当前固定材料尚不可用；请先在代码仓库面板恢复缺失的 Repository Snapshot。"
          : "无法创建 Conversation。");
        return;
      }
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

  async function distillMessage(messageId: string, focus?: string) {
    if (route.name !== "paper" || !route.conversationId) return;
    const response = await fetch(`/api/messages/${encodeURIComponent(messageId)}/distill`, { method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ ...(focus?.trim() ? { focus: focus.trim() } : {}) }) });
    if (!response.ok) { setDiscussionError("这条回答当前不满足 Takeaway Selection 条件。"); return; }
    await refreshConversationWorkspace(route.paperId, route.conversationId);
  }

  async function retryDistillation(distillationId: string) {
    if (route.name !== "paper" || !route.conversationId) return;
    const response = await fetch(`/api/distillations/${encodeURIComponent(distillationId)}/retry`, { method: "POST",
      headers: { "idempotency-key": crypto.randomUUID() } });
    if (!response.ok) { setDiscussionError("这次 Takeaway Selection 当前无法重试。"); return; }
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
    const previewResponse = await fetch(`/api/conversations/${encodeURIComponent(route.conversationId)}/continuation-preview`);
    if (!previewResponse.ok) { setDiscussionError("无法检查最新材料，请稍后重试。"); return; }
    const preview = await previewResponse.json() as {
      status: string;
      parentStatus: string;
      comparison?: { status: string; diff?: {
        paperVersion?: { status: string }; summaryRevision?: { status: string };
        extractionRun?: { status: string };
        repositories?: { added?: unknown[]; removed?: unknown[]; changed?: unknown[] };
        knowledgeCorpus?: { status: string };
      } };
    };
    if (preview.status === "no-change") {
      setDiscussionError(preview.parentStatus === "archived"
        ? "当前冻结材料没有变化。可先恢复此 Conversation 继续，或开启独立新对话。"
        : "当前冻结材料没有变化，请直接在此 Conversation 继续，或开启独立新对话。");
      return;
    }
    if (preview.status === "unavailable") {
      setDiscussionError("当前材料不足，无法创建新的冻结 Conversation。");
      return;
    }
    const diff = preview.comparison?.diff;
    const changes = [
      diff?.paperVersion?.status === "changed" ? "Paper" : null,
      diff?.summaryRevision?.status === "changed" ? "Summary" : null,
      ((diff?.repositories?.added?.length ?? 0) + (diff?.repositories?.removed?.length ?? 0) +
        (diff?.repositories?.changed?.length ?? 0)) > 0 ? "Code" : null,
      diff?.knowledgeCorpus?.status === "changed" ? "Knowledge" : null,
      diff?.extractionRun?.status === "changed" ? "Extraction（技术上下文）" : null,
    ].filter((item): item is string => item !== null);
    if (!window.confirm(`将基于最新材料创建关联后继。\n变化：${changes.join("、") || "Legacy Context Diff 不可用"}\n旧 Conversation 与旧 Context Snapshot 不会改变。`)) return;
    const response = await fetch(`/api/papers/${encodeURIComponent(route.paperId)}/conversations`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ continuedFromConversationId: route.conversationId }) });
    if (!response.ok) {
      const failure = await response.json() as { code?: string; existingConversationId?: string };
      if (failure.code === "conversation-context-unchanged") {
        setDiscussionError("确认期间材料状态发生变化，目前已没有 Context 差异。");
      } else if (failure.code === "conversation-successor-already-exists" && failure.existingConversationId) {
        setDiscussionError("相同材料的关联后继已经存在，正在打开它。");
        navigate(paperHref(route.paperId, { mode: "discussion", conversationId: failure.existingConversationId,
          pdfOpen: false, page: 1, anchor: null }));
      } else setDiscussionError("当前材料不足，无法创建新的冻结 Conversation。");
      return;
    }
    const created = await response.json();
    navigate(paperHref(route.paperId, { mode: "discussion", conversationId: created.conversation.id,
      pdfOpen: false, page: 1, anchor: null }));
  }

  async function reviewProposal(proposal: Proposal, action: "accept" | "edit-and-accept" | "reject",
    input: TakeawayDecisionInput = {}) {
    const response = await fetch(`/api/proposals/${encodeURIComponent(proposal.id)}/decisions`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ action, ...input }),
    });
    if (!response.ok) {
      const failure = await response.json() as { code?: string };
      setDiscussionError(failure.code === "full-evidence-review-required" ? "修改结论、证据、Receipt 或认识状态后，需要重新检查完整证据。"
        : failure.code === "duplicate-acknowledgement-required" ? "请先比较并确认可能重复的已确认 Takeaway。"
          : "Proposal 状态已变化或来源不可确认。");
      return;
    }
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

  const pendingReviews = reviewProposals.filter((proposal) => proposal.reviewStatus === "pending" &&
    !proposal.archivedAt && !isLightweightOrganizationProposal(proposal));
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
        <a className="secondary-nav-link" href="/settings" aria-current={route.name === "settings" ? "page" : undefined}
          onClick={(event) => routeClick(event, "/settings")}>设置</a>
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
    {route.name === "papers" && <PaperLibrary papers={papers} directions={directions} route={route}
      error={papersError} onNavigate={navigate} onImport={() => setImportOpen(true)}
      onDirectionsChanged={async () => { await refreshDirections(); await refreshPapers(); }} />}
    {route.name === "reviews" && <ReviewCenter proposals={reviewProposals} error={reviewsError} onNavigate={navigate}
      onRefresh={async () => {
        await Promise.all([refreshReviews(), refreshPapers(), refreshDirections()]);
      }} />}
    {route.name === "settings" && <SettingsPage snapshot={settings} error={settingsError} />}
    {route.name === "not-found" && <main className="page-state"><span className="eyebrow">NOT FOUND</span><h1>找不到这个页面</h1>
      <button onClick={() => navigate("/", true)}>返回研究首页</button></main>}
    {route.name === "paper" && (workspaceLoading && !workspace
      ? <main className="page-state loading-state"><span className="eyebrow">PAPER WORKSPACE</span><h1>正在载入 Paper…</h1></main>
      : workspaceError && !workspace
        ? <main className="page-state"><span className="eyebrow">PAPER UNAVAILABLE</span><h1>{workspaceError}</h1><button onClick={() => navigate("/papers")}>返回论文库</button></main>
        : workspace && workspace.paper.id === route.paperId && <PaperWorkspace key={workspace.paper.id} workspace={workspace}
          directions={directions} route={route} busy={busy} progress={progress}
          error={workspaceError ?? discussionError} openedPdfSource={openedPdfSource} conversations={conversations}
          conversation={conversation} lineage={conversationLineage} knowledge={knowledge} question={question} onQuestion={updateQuestion}
          onAskPaper={askPaper} onRetryMessage={retryMessage} onDistillMessage={distillMessage}
          onRetryDistillation={retryDistillation}
          onCancelAttempt={cancelAttempt} evidence={evidence}
          onEvidenceIntegrityFailure={() => route.evidenceReceiptId && void refreshEvidence(route.evidenceReceiptId)}
          onReviewProposal={reviewProposal}
          onManageConversation={manageConversation} onContinueConversation={continueConversation}
          repositoryBusy={repositoryBusy} repositoryError={repositoryError}
          onAddRepository={(repositoryUrl) => repositoryCommand(`/api/papers/${encodeURIComponent(route.paperId)}/repositories`,
            "POST", { url: repositoryUrl })}
          onConfirmRepository={(associationId) => repositoryCommand(
            `/api/papers/${encodeURIComponent(route.paperId)}/repositories/${encodeURIComponent(associationId)}/confirm`, "POST")}
          onRetryRepository={(associationId) => repositoryCommand(
            `/api/papers/${encodeURIComponent(route.paperId)}/repositories/${encodeURIComponent(associationId)}/retry`, "POST")}
          onRemoveRepository={(associationId) => repositoryCommand(
            `/api/papers/${encodeURIComponent(route.paperId)}/repositories/${encodeURIComponent(associationId)}/remove`, "POST")}
          onSaveOrganization={async (organization, idempotencyKey) => {
            const response = await fetch(`/api/papers/${encodeURIComponent(route.paperId)}/organization`, {
              method: "PUT",
              headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
              body: JSON.stringify(organization),
            });
            if (!response.ok) {
              const failure = await response.json() as { code?: string };
              throw new Error(failure.code === "paper-organization-conflicted"
                ? "Paper 已在外部修改；请先到审核中心处理 reconciliation。"
                : failure.code === "paper-organization-retry-review-required"
                  ? "外部修改包含别名或方向；请先确认 reconciliation，再重新打开编辑器。"
                  : "别名与方向保存失败。");
            }
            await refreshPapers();
            await refreshWorkspace(route.paperId);
          }}
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
          key={`${source.sourceType}-${source.sourceId}`} onClick={() => {
            void fetch(`/api/entry-agent/sources/${source.sourceType}/${encodeURIComponent(source.sourceId)}/open`,
              { method: "POST" });
            props.onNavigate(paperHref(source.paperId));
          }}>{source.sourceType} · {source.title}</button>)}</div>
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

function PaperLibrary(props: {
  papers: Paper[];
  directions: ResearchDirection[];
  route: Extract<BrowserRoute, { name: "papers" }>;
  error: string | null;
  onNavigate(href: string): void;
  onImport(): void;
  onDirectionsChanged(): Promise<void>;
}) {
  const { route } = props;
  const [query, setQuery] = useState(route.query);
  const [catalogMatches, setCatalogMatches] = useState<Paper[] | null>(null);
  const [directionNavOpen, setDirectionNavOpen] = useState(false);
  useEffect(() => setQuery(route.query), [route.query]);
  useEffect(() => {
    let active = true;
    if (!route.query.trim()) {
      setCatalogMatches(null);
      return () => { active = false; };
    }
    void fetch(`/api/papers?q=${encodeURIComponent(route.query)}`).then(async (response) => {
      if (!response.ok) throw new Error("catalog-search-unavailable");
      return (await response.json() as { papers: Paper[] }).papers;
    }).then((papers) => { if (active) setCatalogMatches(papers); })
      .catch(() => { if (active) setCatalogMatches(null); });
    return () => { active = false; };
  }, [route.query]);
  const selectedDirection = props.directions.find((direction) => direction.id === route.direction) ?? null;
  const invalidDirection = Boolean(route.direction && !selectedDirection);
  const normalizedQuery = route.query.trim().normalize("NFKC").toLocaleLowerCase();
  const visible = (catalogMatches ?? props.papers).filter((paper) => {
    if (route.view === "unclassified" && paper.directions.some((direction) => direction.role === "primary")) return false;
    if (route.pending && !paper.pendingOrganizationCount) return false;
    if (route.direction && !paper.directions.some((direction) =>
      direction.topicId === route.direction && (route.relation !== "primary" || direction.role === "primary"))) return false;
    if (!normalizedQuery || catalogMatches) return true;
    return [paper.title, ...paper.aliases.map((alias) => alias.name), ...paper.authors,
      ...paper.directions.map((direction) => direction.title)].join(" ").normalize("NFKC")
      .toLocaleLowerCase().includes(normalizedQuery);
  });
  const primary = selectedDirection
    ? visible.filter((paper) => paper.directions.some((direction) =>
      direction.topicId === selectedDirection.id && direction.role === "primary"))
    : visible;
  const secondaryOnly = selectedDirection && route.relation === "all"
    ? visible.filter((paper) => paper.directions.some((direction) =>
      direction.topicId === selectedDirection.id && direction.role === "secondary"))
    : [];
  const libraryGroups = route.view === "unclassified"
    ? [{ id: "unclassified", title: "未分类", papers: visible }]
    : [
      ...props.directions.map((direction) => ({
        id: direction.id,
        title: direction.title,
        papers: visible.filter((paper) => paper.directions.some((assignment) =>
          assignment.topicId === direction.id && assignment.role === "primary")),
      })).filter((group) => group.papers.length > 0),
      {
        id: "unclassified",
        title: "未分类",
        papers: visible.filter((paper) => !paper.directions.some((direction) => direction.role === "primary")),
      },
    ].filter((group) => group.papers.length > 0);
  const href = (next: Partial<PaperLibraryViewState>) => papersHref({ ...route, ...next });
  const navigateLibrary = (nextHref: string) => {
    setDirectionNavOpen(false);
    props.onNavigate(nextHref);
  };
  return <main className="app page library-page">
    <header className="page-header library-header"><div><span className="eyebrow">LIBRARY</span><h1>论文库</h1>
      <p>按核心研究问题和贡献组织 Paper，也可以用模型名、方法名或缩写检索。</p></div>
      <button onClick={props.onImport}>导入论文</button></header>
    <form className="paper-catalog-search" onSubmit={(event) => {
      event.preventDefault();
      props.onNavigate(href({ query }));
    }}>
      <input aria-label="搜索论文标题、别名、作者或方向" value={query}
        onChange={(event) => setQuery(event.target.value)} placeholder="搜索标题、GenCeption、作者或方向…" />
      <button>搜索</button>
      {route.query && <button type="button" className="ghost" onClick={() => props.onNavigate(href({ query: "" }))}>清除</button>}
    </form>
    <button type="button" className="direction-drawer-trigger" aria-expanded={directionNavOpen}
      onClick={() => setDirectionNavOpen(true)}>选择论文分组</button>
    <div className="paper-library-layout">
      {directionNavOpen && <button type="button" className="direction-drawer-backdrop" aria-label="关闭论文分组"
        onClick={() => setDirectionNavOpen(false)} />}
      <aside className={`direction-sidebar${directionNavOpen ? " open" : ""}`} aria-label="论文库分类">
        <button type="button" className="direction-drawer-close" onClick={() => setDirectionNavOpen(false)}>关闭</button>
        <a href={href({ view: "all", direction: null, relation: "all", pending: false })}
          aria-current={route.view === "all" && !route.direction && !route.pending ? "page" : undefined}
          onClick={(event) => { event.preventDefault(); navigateLibrary(event.currentTarget.href.replace(window.location.origin, "")); }}>
          <span>全部</span><b>{props.papers.length}</b></a>
        <a href={href({ view: "unclassified", direction: null, relation: "all", pending: false })}
          aria-current={route.view === "unclassified" && !route.pending ? "page" : undefined}
          onClick={(event) => { event.preventDefault(); navigateLibrary(event.currentTarget.href.replace(window.location.origin, "")); }}>
          <span>未分类</span><b>{props.papers.filter((paper) => !paper.directions.some((direction) => direction.role === "primary")).length}</b></a>
        <a href={href({ view: "all", direction: null, relation: "all", pending: true })}
          aria-current={route.pending ? "page" : undefined}
          onClick={(event) => { event.preventDefault(); navigateLibrary(event.currentTarget.href.replace(window.location.origin, "")); }}>
          <span>待确认</span><b>{props.papers.filter((paper) => paper.pendingOrganizationCount > 0).length}</b></a>
        <div className="direction-sidebar-heading"><span>研究方向</span><small>Primary</small></div>
        {props.directions.map((direction) => <a key={direction.id}
          href={href({ view: "all", direction: direction.id, relation: "all", pending: false })}
          aria-current={route.direction === direction.id ? "page" : undefined}
          onClick={(event) => { event.preventDefault(); navigateLibrary(event.currentTarget.href.replace(window.location.origin, "")); }}>
          <span>{direction.title}</span><b>{direction.primaryCount}</b></a>)}
        <DirectionCreator onCreated={props.onDirectionsChanged} />
      </aside>
      <section className="library">
        {props.error && props.papers.length > 0 && <p className="inline-alert">{props.error}，正在显示上次成功载入的列表。</p>}
        {invalidDirection ? <div className="error-block"><p>这个 Research Direction 不存在、已被删除，或尚未完成重定向。</p>
          <button onClick={() => props.onNavigate(papersHref({ ...route, direction: null }))}>返回全部论文</button></div>
          : props.error && props.papers.length === 0 ? <p className="error-block">{props.error}</p>
          : props.papers.length === 0 ? <div className="empty"><p>还没有论文。粘贴 arXiv 链接或公开 PDF 直链开始。</p>
            <button onClick={props.onImport}>导入论文</button></div>
            : visible.length === 0 ? <div className="empty"><p>当前筛选条件下没有 Paper。</p></div>
              : selectedDirection ? <>
                <div className="library-section-heading"><div><span className="eyebrow">PRIMARY</span>
                  <h2>{selectedDirection.title}</h2></div><strong>{primary.length}</strong></div>
                {primary.map((paper) => <PaperCard key={paper.id} paper={paper} onNavigate={props.onNavigate} />)}
                {route.relation === "all" && <><div className="library-section-heading secondary"><div>
                  <span className="eyebrow">SECONDARY ONLY</span><h2>相关方向</h2></div><strong>{secondaryOnly.length}</strong></div>
                  {secondaryOnly.length === 0 ? <p className="empty">还没有仅以此方向为 Secondary 的 Paper。</p>
                    : secondaryOnly.map((paper) => <PaperCard key={paper.id} paper={paper} onNavigate={props.onNavigate} />)}</>}
              </> : libraryGroups.map((group) => <section className="paper-direction-group" key={group.id}>
                <div className="library-section-heading"><div><span className="eyebrow">PRIMARY GROUP</span>
                  <h2>{group.title}</h2></div><strong>{group.papers.length}</strong></div>
                {group.papers.map((paper) => <PaperCard key={paper.id} paper={paper} onNavigate={props.onNavigate} />)}
              </section>)}
      </section>
    </div>
  </main>;
}

function DirectionCreator({ onCreated }: { onCreated(): Promise<void> }) {
  const idempotencyKey = useRef(crypto.randomUUID());
  const [id, setId] = useState("");
  const [title, setTitle] = useState("");
  const [scope, setScope] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  return <details className="direction-creator"><summary>＋ 管理方向</summary>
    <form onSubmit={async (event) => {
      event.preventDefault();
      setStatus("正在保存…");
      const response = await fetch("/api/directions", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": idempotencyKey.current },
        body: JSON.stringify({ id, title, scope }),
      });
      if (!response.ok) {
        setStatus(response.status === 409 ? "方向 ID 已存在或文件发生冲突。" : "方向信息不完整。");
        return;
      }
      setId(""); setTitle(""); setScope(""); setStatus("已保存");
      idempotencyKey.current = crypto.randomUUID();
      await onCreated();
    }}>
      <label>方向名称<input value={title} onChange={(event) => setTitle(event.target.value)} required /></label>
      <label>稳定 ID<input value={id} onChange={(event) => setId(event.target.value)}
        placeholder="topic:video-generation" pattern="topic:[a-z0-9]+(?:-[a-z0-9]+)*" required /></label>
      <label>Scope<textarea value={scope} onChange={(event) => setScope(event.target.value)}
        placeholder="这个方向包含什么、不包含什么？" required /></label>
      <button>创建方向</button>{status && <small role="status">{status}</small>}
    </form>
  </details>;
}

function PaperCard({ paper, onNavigate }: { paper: Paper; onNavigate(href: string): void }) {
  const processingLabel = paperSummaryLabel(paper);
  const codeLabel = paper.codeStatus === "ready" ? "代码可用" : paper.codeStatus === "failed" ? "代码失败" : "未发现明确代码链接";
  const href = paperHref(paper.id);
  const sourceLabel = paper.sourceType === "arxiv" ? `arXiv:${paper.arxivId}` : `公开 PDF · ${safeSourceHost(paper.sourceUrl)}`;
  return <a className="paper-card" href={href} onClick={(event) => { if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
    event.preventDefault(); onNavigate(href); } }}><span>{paper.sourceType === "arxiv" ? `v${paper.version}` : "PDF"}</span><div>
      <h3>{paper.preferredAlias ?? paper.title}</h3>
      {paper.preferredAlias && <p className="paper-canonical-title">{paper.title}</p>}
      <p className="paper-authors">{paper.authors.join(", ")} · {paper.year}</p>
      <p className="paper-source">{sourceLabel}</p>
      {paper.directions.length > 0 && <div className="direction-chips">{paper.directions.map((direction) =>
        <small key={direction.topicId} className={direction.role}>{direction.title}</small>)}</div>}
      {paper.matchedBy && <p className="paper-match">匹配：{paper.matchedBy.value}</p>}
      {paper.aliasCollision && <p className="alias-collision">同名 Alias：请结合作者、年份和 Primary 方向确认。</p>}
      <div className="paper-badges"><small>{processingLabel}</small><small>{codeLabel}</small>
        {Boolean(paper.pendingOrganizationCount) && <small>方向待确认 {paper.pendingOrganizationCount}</small>}
        {Boolean(paper.pendingReviewCount) && <small>待审核 {paper.pendingReviewCount}</small>}</div>
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
  const pending = proposals.filter((proposal) => proposal.reviewStatus === "pending" &&
    !proposal.archivedAt && !isLightweightOrganizationProposal(proposal));
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
  const decideTakeaway = async (proposal: ReviewProposal, action: "accept" | "edit-and-accept" | "reject",
    input: TakeawayDecisionInput = {}) => {
    const response = await fetch(`/api/proposals/${encodeURIComponent(proposal.id)}/decisions`, { method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ action, ...input }) });
    if (!response.ok) {
      const failure = await response.json() as { code?: string };
      setActionError(failure.code === "full-evidence-review-required" ? "这些编辑会改变证据判断；请勾选已重新检查完整证据。"
        : failure.code === "duplicate-acknowledgement-required" ? "请先比较并确认可能重复的 Takeaway。"
          : "Proposal 已变化，或固定来源尚未完成核验。");
      return;
    }
    setActionError(null);
    await onRefresh();
  };
  const decideReconciliation = async (proposal: ReviewProposal, action: "accept" | "reject") => {
    const response = await fetch(`/api/proposals/${encodeURIComponent(proposal.id)}/decisions`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ action }),
    });
    if (!response.ok) {
      const failure = await response.json() as { code?: string };
      setActionError(failure.code === "reconciliation-target-changed"
        ? "Markdown 在审核期间再次变化，请重新检查。"
        : "该 Markdown 目前无法安全激活，请先修复格式或引用。");
      return;
    }
    setActionError(action === "reject"
      ? "已拒绝外部版本；恢复原文件后 Catalog 才能解除阻塞。"
      : null);
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
        {proposal.proposalType === "takeaway" && <TakeawayReviewCard proposal={{
          ...proposal.payload, id: proposal.id, claim: proposal.payload.claim ?? "", legacySource: Boolean(proposal.legacySource),
          ...(proposal.liveDuplicateIds ? { liveDuplicateIds: proposal.liveDuplicateIds } : {}),
          ...(proposal.duplicateAcknowledgementRequired !== undefined
            ? { duplicateAcknowledgementRequired: proposal.duplicateAcknowledgementRequired } : {}),
          ...(proposal.sourceConversationHref !== undefined
            ? { sourceConversationHref: proposal.sourceConversationHref } : {}),
          ...(proposal.distillationState !== undefined ? { distillationState: proposal.distillationState } : {}),
        }} onDecide={(candidate, action, input) => void decideTakeaway(proposal, action, input)} />}
        {proposal.proposalType === "reconciliation" && <div className="review-actions">
          <p>检测到外部 Markdown 变化：{String(proposal.payload.targetPath ?? "未知路径")}</p>
          {proposal.payload.validationError && <p className="inline-alert">
            当前文件未通过校验：{String(proposal.payload.validationError)}
          </p>}
          {(proposal.payload.targetKind === "paper" || proposal.payload.targetKind === "topic") &&
            <button disabled={Boolean(proposal.payload.validationError)}
              onClick={() => void decideReconciliation(proposal, "accept")}>确认采用外部版本</button>}
          {proposal.payload.targetKind !== "paper" && proposal.payload.targetKind !== "topic" &&
            <p>此类写入冲突暂不支持直接采用外部版本；可拒绝后恢复原文件，或从对应工作流重试。</p>}
          <button className="ghost" onClick={() => void decideReconciliation(proposal, "reject")}>拒绝并保留当前投影</button>
        </div>}
        {proposal.legacySource && <p className="inline-alert">旧 Conversation 来源不完整，只能查看或拒绝，不能确认。</p>}
        {proposal.paperId && <button className="text-button" onClick={() => onNavigate(paperHref(proposal.paperId!))}>打开相关 Paper →</button>}
      </article>)}</div>}
  </main>;
}

function isLightweightOrganizationProposal(proposal: Pick<ReviewProposal, "proposalType">): boolean {
  return proposal.proposalType === "paper-organization" || proposal.proposalType === "direction-taxonomy";
}

function PaperOrganizationEditor(props: {
  paper: Paper;
  directions: ResearchDirection[];
  onClose(): void;
  onSave(input: {
    aliases: Paper["aliases"];
    directions: Array<{ topicId: string; role: "primary" | "secondary" }>;
  }, idempotencyKey: string): Promise<void>;
}) {
  const idempotencyKey = useRef(crypto.randomUUID());
  const [aliases, setAliases] = useState<Paper["aliases"]>(() => props.paper.aliases.map((alias) => ({ ...alias })));
  const [primary, setPrimary] = useState(() =>
    props.paper.directions.find((direction) => direction.role === "primary")?.topicId ?? "");
  const [secondary, setSecondary] = useState<Set<string>>(() => new Set(props.paper.directions
    .filter((direction) => direction.role === "secondary").map((direction) => direction.topicId)));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const aliasKinds: Array<{ value: Paper["aliases"][number]["kind"]; label: string }> = [
    { value: "model-name", label: "模型名" },
    { value: "method-name", label: "方法名" },
    { value: "acronym", label: "缩写" },
    { value: "project-name", label: "项目名" },
    { value: "user-defined", label: "自定义" },
  ];
  return <div className="organization-panel-backdrop" role="presentation" onMouseDown={(event) => {
    if (event.target === event.currentTarget) props.onClose();
  }}>
    <section className="organization-panel" role="dialog" aria-modal="true" aria-label="编辑 Paper 别名与方向">
      <header><div><span className="eyebrow">PAPER ORGANIZATION</span><h2>编辑别名与方向</h2>
        <p>Canonical title 保持不变；Primary 决定论文库中的唯一归组。</p></div>
        <button type="button" aria-label="关闭" onClick={props.onClose}>×</button></header>
      <form onSubmit={async (event) => {
        event.preventDefault();
        const cleanAliases = aliases.filter((alias) => alias.name.trim()).map((alias) => ({ ...alias, name: alias.name.trim() }));
        if (new Set(cleanAliases.map((alias) => alias.name.normalize("NFKC").toLocaleLowerCase())).size !== cleanAliases.length) {
          setError("同一 Paper 内不能保存重复别名。"); return;
        }
        setSaving(true); setError(null);
        try {
          await props.onSave({
            aliases: cleanAliases,
            directions: [
              ...(primary ? [{ topicId: primary, role: "primary" as const }] : []),
              ...[...secondary].filter((topicId) => topicId !== primary)
                .map((topicId) => ({ topicId, role: "secondary" as const })),
            ],
          }, idempotencyKey.current);
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : "保存失败。");
        } finally {
          setSaving(false);
        }
      }}>
        <fieldset><legend>Paper Aliases</legend>
          {aliases.length === 0 && <p className="empty">还没有别名。模型名、方法名或缩写必须能指代整篇 Paper。</p>}
          {aliases.map((alias, index) => <div className="alias-editor-row" key={index}>
            <input aria-label={`别名 ${index + 1}`} value={alias.name}
              onChange={(event) => setAliases((current) => current.map((item, itemIndex) =>
                itemIndex === index ? { ...item, name: event.target.value } : item))} />
            <select aria-label={`别名类型 ${index + 1}`} value={alias.kind}
              onChange={(event) => setAliases((current) => current.map((item, itemIndex) =>
                itemIndex === index ? { ...item, kind: event.target.value as Paper["aliases"][number]["kind"] } : item))}>
              {aliasKinds.map((kind) => <option key={kind.value} value={kind.value}>{kind.label}</option>)}
            </select>
            <label className="preferred-alias"><input type="radio" name="preferred-alias" checked={alias.preferred}
              onChange={() => setAliases((current) => current.map((item, itemIndex) =>
                ({ ...item, preferred: itemIndex === index })))} />首选</label>
            <button type="button" className="remove-alias" onClick={() => setAliases((current) => {
              const removedPreferred = current[index]?.preferred;
              const next = current.filter((_, itemIndex) => itemIndex !== index);
              if (removedPreferred && next[0]) next[0] = { ...next[0], preferred: true };
              return next;
            })}>移除</button>
          </div>)}
          <button type="button" className="text-button" onClick={() => setAliases((current) =>
            [...current, { name: "", kind: "user-defined", preferred: current.length === 0 }])}>＋ 添加别名</button>
        </fieldset>
        <fieldset><legend>Primary Research Direction</legend>
          <select aria-label="Primary Research Direction" value={primary} onChange={(event) => {
            const next = event.target.value;
            setPrimary(next);
            setSecondary((current) => {
              if (!next) return new Set();
              const copy = new Set(current); copy.delete(next); return copy;
            });
          }}>
            <option value="">未分类</option>
            {props.directions.map((direction) => <option key={direction.id} value={direction.id}>{direction.title}</option>)}
          </select>
          <small>按 Paper 的核心研究问题或贡献选择。</small>
        </fieldset>
        <fieldset><legend>Secondary Research Directions · {secondary.size}/3</legend>
          <div className="secondary-direction-options">{props.directions.filter((direction) => direction.id !== primary)
            .map((direction) => <label key={direction.id}><input type="checkbox"
              checked={secondary.has(direction.id)} disabled={!secondary.has(direction.id) && secondary.size >= 3}
              onChange={(event) => setSecondary((current) => {
                const next = new Set(current);
                if (event.target.checked) next.add(direction.id); else next.delete(direction.id);
                return next;
              })} />{direction.title}</label>)}</div>
          <small>仅“使用了该技术”不足以成为 Secondary；该 Paper 必须对方向有实质贡献。</small>
        </fieldset>
        {error && <p className="organization-error">{error}</p>}
        <footer><button type="button" className="ghost" onClick={props.onClose}>取消</button>
          <button disabled={saving}>{saving ? "正在保存…" : "保存"}</button></footer>
      </form>
    </section>
  </div>;
}

function PaperWorkspace(props: {
  workspace: Workspace;
  directions: ResearchDirection[];
  route: Extract<BrowserRoute, { name: "paper" }>;
  busy: boolean;
  progress: ImportJobState | null;
  error: string | null;
  openedPdfSource: OpenedPdfSource | null;
  conversations: ConversationSummary[];
  conversation: ConversationDetail | null;
  lineage: ConversationLineage | null;
  knowledge: KnowledgeModel;
  question: string;
  onQuestion(value: string): void;
  onAskPaper(event: React.FormEvent): void;
  onRetryMessage(messageId: string): void;
  onDistillMessage(messageId: string, focus?: string): void;
  onRetryDistillation(distillationId: string): void;
  onCancelAttempt(attemptId: string): void;
  onReviewProposal(proposal: Proposal, action: "accept" | "edit-and-accept" | "reject",
    input?: TakeawayDecisionInput): void;
  onManageConversation(action: "rename" | "archive" | "restore", title?: string): void;
  onContinueConversation(): void;
  onRetry(): void;
  onNavigate(href: string, replace?: boolean): void;
  evidence: EvidenceInspectorModel | null;
  onEvidenceIntegrityFailure(): void;
  repositoryBusy: boolean;
  repositoryError: string | null;
  onAddRepository(url: string): void;
  onConfirmRepository(associationId: string): void;
  onRetryRepository(associationId: string): void;
  onRemoveRepository(associationId: string): void;
  onSaveOrganization(input: {
    aliases: Paper["aliases"];
    directions: Array<{ topicId: string; role: "primary" | "secondary" }>;
  }, idempotencyKey: string): Promise<void>;
}) {
  const { workspace, route } = props;
  const [showArchivedConversations, setShowArchivedConversations] = useState(false);
  const [organizationOpen, setOrganizationOpen] = useState(false);
  const [organizationStatus, setOrganizationStatus] = useState<string | null>(null);
  const readyRepositories = workspace.repositories.filter((repository) => repository.materializationStatus === "ready").length;
  const hasRepositoryCandidates = workspace.repositories.some((repository) =>
    repository.associationStatus === "candidate");
  const repositoryAttention = workspace.repositories.some((repository) =>
    ["failed", "interrupted"].includes(repository.materializationStatus));
  const codeStatus = workspace.repositories.length === 0 ? "代码仓库 · 0"
    : hasRepositoryCandidates ? `代码仓库 · ${workspace.repositories.length} · 待确认`
      : repositoryAttention ? `代码仓库 · ${workspace.repositories.length} · 需处理`
        : readyRepositories === workspace.repositories.length ? `代码仓库 · ${workspace.repositories.length}`
          : `代码仓库 · ${workspace.repositories.length} · 处理中`;
  const repositoryHref = (open: boolean) => paperHref(workspace.paper.id, {
    mode: route.mode,
    conversationId: route.conversationId,
    pdfOpen: route.pdfOpen,
    page: route.page,
    anchor: route.anchor,
    evidenceReceiptId: route.evidenceReceiptId,
    repositoriesOpen: open,
  });
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
  const visibleConversations = filterConversationsByArchive(props.conversations, showArchivedConversations);
  const archivedConversationCount = props.conversations.filter((item) => item.status === "archived").length;
  const activeConversationCount = props.conversations.length - archivedConversationCount;
  const currentConversationHidden = props.conversation
    ? (props.conversation.conversation.status === "archived") !== showArchivedConversations
    : false;
  return <main className="app workspace">
    <header className="topbar"><a className="ghost" href="/papers" onClick={(event) => { event.preventDefault(); props.onNavigate("/papers"); }}>← 论文库</a>
      <div className="workspace-paper-identity"><span className="eyebrow">PAPER WORKSPACE</span>
        <h1 title={workspace.paper.title}>{workspace.paper.preferredAlias ?? workspace.paper.title}</h1>
        {workspace.paper.preferredAlias && <p className="workspace-canonical-title">{workspace.paper.title}</p>}
        <p className="paper-metadata" title={`${workspace.paper.authors.join(", ")} · ${workspace.paper.year}`}>
          {workspace.paper.authors.join(", ")} · {workspace.paper.year}</p></div>
      <div className="workspace-badges"><span className="version">{workspace.paper.sourceType === "arxiv" ? `arXiv v${workspace.paper.version}` : "公开 PDF"}</span>
        <a className="source-link" href={workspace.paper.sourceUrl} target="_blank" rel="noopener noreferrer">打开来源</a>
        <button type="button" className="code-status repository-summary" onClick={() => setOrganizationOpen(true)}>
          编辑别名与方向</button>
        <button type="button" className="code-status repository-summary"
          aria-expanded={route.repositoriesOpen}
          onClick={() => props.onNavigate(repositoryHref(!route.repositoriesOpen))}>{codeStatus}</button></div>
    </header>
    {organizationOpen && <PaperOrganizationEditor paper={workspace.paper} directions={props.directions}
      onClose={() => setOrganizationOpen(false)} onSave={async (input, idempotencyKey) => {
        await props.onSaveOrganization(input, idempotencyKey);
        setOrganizationStatus("别名与方向已保存。");
        setOrganizationOpen(false);
      }} />}
    {route.repositoriesOpen && <RepositoryPanel repositories={workspace.repositories} busy={props.repositoryBusy}
      error={props.repositoryError} onClose={() => props.onNavigate(repositoryHref(false))}
      onAdd={props.onAddRepository} onConfirm={props.onConfirmRepository} onRetry={props.onRetryRepository}
      onRemove={props.onRemoveRepository} />}
    {organizationStatus && <div className="inline-alert" role="status">{organizationStatus}</div>}
    {props.error && <div className="inline-alert">{props.error}</div>}
    <nav className="workspace-modes" aria-label="Paper workspace mode">
      {(["reading", "discussion", "knowledge"] as const).map((mode) => <a key={mode} href={modeHref(mode)}
        aria-current={route.mode === mode ? "page" : undefined}
        onClick={(event) => { event.preventDefault(); props.onNavigate(modeHref(mode)); }}>{mode === "reading" ? "Reading" : mode === "discussion" ? "Discussion" : "Knowledge"}</a>)}
    </nav>
    {route.mode === "discussion" && <div className="discussion-layout">
      <aside className="conversation-list"><div className="conversation-list-heading"><div><span className="eyebrow">CONVERSATIONS</span><h2>论文讨论</h2></div>
        <NewConversationButton onCreate={() => { setShowArchivedConversations(false); props.onNavigate(modeHref("discussion")); }} /></div>
        <button className="conversation-archive-filter" type="button" aria-label="显示已归档 Conversation"
          aria-pressed={showArchivedConversations}
          onClick={() => setShowArchivedConversations((current) => !current)}>
          {showArchivedConversations ? `查看进行中 · ${activeConversationCount}` : `查看已归档 · ${archivedConversationCount}`}
        </button>
        {currentConversationHidden && <p className="conversation-filter-note">
          当前 Conversation {props.conversation!.conversation.status === "archived" ? "已归档" : "正在进行中"}，已从此列表隐藏。</p>}
        {visibleConversations.length === 0 && <p className="empty">
          {showArchivedConversations ? "还没有已归档 Conversation。" : "还没有进行中的 Conversation。"}</p>}
        {visibleConversations.map((item) => <a key={item.id}
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
            canContinue={canContinueConversation({
              archived: props.conversation.conversation.status === "archived",
              legacy: props.conversation.conversation.snapshotIntegrity === "legacy",
              messageCount: props.conversation.messages.length,
            })}
            legacy={props.conversation.conversation.snapshotIntegrity === "legacy"}
            lineage={props.lineage}
            conversationHref={(conversationId) => paperHref(workspace.paper.id,
              { mode: "discussion", conversationId, pdfOpen: false, page: 1, anchor: null })}
            onNavigate={props.onNavigate}
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
            const latestDistillation = message.distillations?.at(-1);
            const eligibleForExplicitSave = props.conversation?.capabilities?.takeawayDistillation === true &&
              message.role === "assistant" &&
              ["answered", "partially_answered"].includes(message.groundingStatus ?? "") && message.citations.length > 0;
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
              onDecide={(proposal, action, input) => {
                const source = messageProposals.find((candidate) => candidate.id === proposal.id);
                if (source) void props.onReviewProposal(source, action, input);
              }} />
            {message.role === "assistant" && (props.conversation?.capabilities?.takeawayDistillation || latestDistillation) &&
              <div className={`distillation-state ${latestDistillation?.state ?? "idle"}`}>
              <span>{!latestDistillation ? "尚未运行 Takeaway Selection"
                : latestDistillation.state === "queued" || latestDistillation.state === "running" ? "正在判断是否值得沉淀…"
                  : latestDistillation.outcome === "candidate" ? "已生成 1 个 Takeaway Proposal"
                    : latestDistillation.outcome === "no-proposal" ? `未建议沉淀 · ${distillationReasonLabel(latestDistillation.reasonCode)}`
                      : `Selection ${latestDistillation.state}`}</span>
              {latestDistillation?.reasonCode === "multiple-claims" && <button onClick={() => {
                const focus = window.prompt("选择一个要提炼的结论方向");
                if (focus) void props.onDistillMessage(message.id, focus);
              }}>选择一个方向</button>}
              {eligibleForExplicitSave && latestDistillation?.reasonCode !== "multiple-claims" &&
                <button onClick={() => void props.onDistillMessage(message.id)}>保存为 Takeaway…</button>}
              {latestDistillation && ["failed", "timed_out", "interrupted"].includes(latestDistillation.state) &&
                <button onClick={() => void props.onRetryDistillation(latestDistillation.id)}>重试 Selection</button>}
            </div>}
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
        {props.knowledge.pendingProposals.map((proposal) => <TakeawayReviewCard key={proposal.id} proposal={proposal}
          onDecide={(candidate, action, input) => void props.onReviewProposal(proposal, action, input)} />)}</div>
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

function distillationReasonLabel(reason: string | null): string {
  return ({ "not-durable": "不属于长期知识", duplicate: "可能重复", "insufficient-evidence": "证据不足",
    "multiple-claims": "包含多个结论" } as Record<string, string>)[reason ?? ""] ?? "未达到门槛";
}
