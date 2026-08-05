import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/icons/ArrowSquareOut";
import { ArrowLeftIcon } from "@phosphor-icons/react/dist/icons/ArrowLeft";
import { CaretDoubleLeftIcon } from "@phosphor-icons/react/dist/icons/CaretDoubleLeft";
import { CaretDoubleRightIcon } from "@phosphor-icons/react/dist/icons/CaretDoubleRight";
import { DotsSixVerticalIcon } from "@phosphor-icons/react/dist/icons/DotsSixVertical";
import { GithubLogoIcon } from "@phosphor-icons/react/dist/icons/GithubLogo";
import { PencilSimpleIcon } from "@phosphor-icons/react/dist/icons/PencilSimple";
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
import { paperHref, paperOrganizationHref, papersHref, readBrowserRoute, type BrowserRoute,
  type PaperLibraryViewState, type PaperOrganizationViewState } from "./browser-navigation.js";
import { importMonitor } from "./import-monitor.js";
import { canConfirmOrganizationAliasDraft, removeOrganizationAliasCandidate }
  from "./organization-alias-draft.js";
import { SummaryMarkdown } from "./summary-markdown.js";
import { ConversationMessageBody, ConversationProposalGroup, TakeawayReviewCard,
  type ConversationProposal, type TakeawayDecisionInput } from "./conversation-message.js";
import { canContinueConversation, conversationActionRequest, filterConversationsByArchive, conversationListStatus, ConversationHeaderActions,
  NewConversationButton, type ConversationLineage }
  from "./conversation-controls.js";
import { EvidenceInspector, type EvidenceInspectorModel } from "./evidence-inspector.js";
import { RepositoryPanel, type RepositoryAssociation } from "./repository-panel.js";
import { SettingsPage } from "./settings-page.js";
import { pdfViewerUrl } from "./pdf-viewer-url.js";
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
  parentDomainId: string | null;
  revisionId: string;
  markdownHash: string;
  semanticHash: string;
  primaryCount: number;
  secondaryCount: number;
};
type ResearchDomain = {
  id: string; title: string; aliases: string[]; scope: string; revisionId: string;
  markdownHash: string; primaryCount: number; childCount: number;
};
type DirectionHierarchyModel = {
  enabled: boolean; everEnabled: boolean; threshold: number; directionCount: number;
  canEnable: boolean; ungroupedPrimaryCount: number; domains: ResearchDomain[];
};
type TopicKnowledgeModel = {
  topicId: string;
  title: string;
  aliases: string[];
  scope: string;
  parentDomainId: string | null;
  revisionId: string;
  markdownHash: string;
  usageLevel: "classification" | "knowledge-ready";
  eligibilityStatus: string;
  indexed: boolean;
  sections: Record<string, string>;
  provenance: Array<{ sourceType: "summary" | "takeaway"; sourceId: string }>;
  provenanceValid: boolean;
  ownerAttested: boolean;
  drifted: boolean;
  substantiveSections: string[];
};
type OrganizationSuggestion = {
  id: string;
  changeKind: "alias" | "primary-direction" | "secondary-direction";
  after: unknown;
  before: unknown;
  rationale?: string;
  rationales?: Array<{ name?: string; topicId?: string; rationale: string }>;
  alternatives?: Array<{ topicId: string; rationale: string }>;
  conditionedOnPrimaryTopicId?: string;
  ambiguous?: boolean;
  collisionWarnings?: string[];
  reviewStatus: string;
  applicability: "ready" | "blocked" | "stale";
  materialization: "not-started" | "applying" | "succeeded" | "failed" | "conflicted";
  sequence: number | null;
};
type OrganizationSuggestionModel = {
  availability: "ready" | "runner-unavailable";
  runs: Array<{ id: string; state: string; sequence: number; scope: string;
    outcomes: Record<string, unknown> | null; error: { code?: string } | null }>;
  suggestions: OrganizationSuggestion[];
};
type OrganizationQueueItem = {
  paper: {
    id: string;
    title: string;
    authors: string[];
    year: number;
    aliases: Paper["aliases"];
    preferredAlias: string | null;
    directions: Paper["directions"];
    pendingOrganizationCount: number;
  };
  latestRun: OrganizationSuggestionModel["runs"][number] | null;
  sections: {
    alias: OrganizationSuggestion | null;
    primary: OrganizationSuggestion | null;
    secondary: OrganizationSuggestion | null;
  };
  pendingSectionCount: number;
  attention: boolean;
  unclassified: boolean;
  latestSequence: number;
};
type OrganizationQueueModel = {
  items: OrganizationQueueItem[];
  truncated: boolean;
  counts: { pendingPapers: number; attentionPapers: number; unclassifiedPapers: number };
};
type TaxonomyProposal = {
  id: string;
  manifestId: string;
  suggested: {
    topicId: string;
    title: string;
    aliases: string[];
    scope: string;
    exclusions: string[];
  };
  representativePaperIds: string[];
  rationale: string;
  ambiguous: boolean;
  overlaps: Array<{ topicId: string; rationale: string }>;
  reviewStatus: string;
  createdAt: string;
};
type TaxonomyModel = {
  availability: "ready" | "runner-unavailable";
  runs: Array<{
    id: string;
    state: string;
    sequence: number;
    manifestId: string;
    selectionMode: "next" | "regenerate" | "refresh";
    outcome: null | { noNewDirection: boolean; emitted: number; dropped: number; ambiguous: number };
    error: null | { code?: string };
  }>;
  proposals: TaxonomyProposal[];
};
type TaxonomyPreview = {
  eligibleCount: number;
  selectedCount: number;
  remainingCount: number;
  paperIds: string[];
};
type BackfillPreview = {
  eligibleCount: number;
  selectedCount: number;
  remainingCount: number;
  staleOldSummaryCount: number;
  activeCampaign: null | { id: string; state: string };
};
type BackfillModel = {
  campaign: {
    id: string;
    state: string;
    requestedLimit: number;
    eligibleCount: number;
    remainingCount: number;
  };
  counts: { scheduled: number; completed: number; failed: number; skipped: number; remaining: number };
  olderCatalogCount: number;
};
type OrganizationBatchPreview = {
  action: "accept" | "reject";
  selectedProposalCount: number;
  selectedPaperCount: number;
  eligibleProposalCount: number;
  eligiblePaperCount: number;
  sectionCounts: { alias: number; primary: number; secondary: number };
  samples: Array<{ proposalId: string; paperId: string; paperTitle: string; sectionKind: string }>;
  excluded: Array<{ proposalId: string; reason: string }>;
};
type OrganizationBatchModel = {
  batch: { id: string; action: string; state: string };
  counts: Record<string, number>;
  papers: Array<{ paperId: string; sections: Array<{
    proposalId: string; sectionKind: string; state: string; errorCode: string | null;
  }> }>;
};
type AliasAutomationModel = {
  mode: "disabled" | "insufficient-evidence" | "enabled" | "suspended";
  aliasOnly: true;
  gates: { minimumLabels: number; maturityDays: number; wilsonLower: number;
    holdoutRate: number; dailyCap: number };
  labelCount: number;
  latestEvaluation: null | { id: string; labelCount: number; acceptedCount: number;
    excludedCount: number; wilsonLower: number; exclusionRate: number; passed: boolean; reasons: string[] };
  policies: Array<{ id: string; version: number; status: string; suspensionReason: string | null }>;
  eventCounts: Record<string, number>;
  events: Array<{ id: string; paperId: string; policyId: string | null; kind: string;
    state: string; createdAt: string; completedAt: string | null }>;
};
type Workspace = {
  paper: Paper & { versionId: string };
  pdf: { pageCount: number; url: string } | null;
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
  answerStatus: string;
  answer: string;
  sources: Array<{ sourceType: "summary" | "takeaway" | "topic-knowledge"; sourceId: string; title: string; paperId: string; href?: string }>;
  projection: { stale: boolean; notice?: string; lastSuccessfulAt: string | null };
  resolution: { state: "none"; matches: [] } | {
    state: "resolved";
    matches: Array<{ text: string; paperId: string; kind: string; canonicalTitle: string }>;
  } | {
    state: "ambiguous";
    reason: "collision" | "too-many-papers";
    snapshotHash: string;
    groups: Array<{ id: string; matchedText: string; candidates: Array<{
      paperId: string; canonicalTitle: string; matchedText: string; matchKind: string;
      authors: string[]; year: number; primaryDirection: { topicId: string; title: string } | null;
    }> }>;
  };
};
type OpenedPdfSource = { href: string; anchor: string; page: number };

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
  const [hierarchy, setHierarchy] = useState<DirectionHierarchyModel>({ enabled: false, everEnabled: false,
    threshold: 15, directionCount: 0, canEnable: false, ungroupedPrimaryCount: 0, domains: [] });
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
      const [response, hierarchyResponse] = await Promise.all([fetch("/api/directions"), fetch("/api/domains")]);
      if (!response.ok || !hierarchyResponse.ok) throw new Error("方向目录暂时不可用");
      setDirections((await response.json() as { directions: ResearchDirection[] }).directions);
      setHierarchy(await hierarchyResponse.json() as DirectionHierarchyModel);
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
    await submitEntryQuestion({});
  }

  async function submitEntryQuestion(extra: Record<string, unknown>) {
    const response = await fetch("/api/entry-agent/questions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: entryQuestion, ...extra }),
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
        <NavLink href="/papers" active={route.name === "papers" || route.name === "paper-organization"}
          onClick={routeClick}>论文库</NavLink>
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
      onEntryQuestion={setEntryQuestion} onAskEntry={askEntry}
      onResolveEntry={(snapshotHash, groups) => submitEntryQuestion({
        resolutionSelection: { snapshotHash, groups },
      })}
      onBypassEntry={() => submitEntryQuestion({ resolutionMode: "off" })}
      onNavigate={navigate} onImport={() => setImportOpen(true)} />}
    {route.name === "papers" && <PaperLibrary papers={papers} directions={directions} hierarchy={hierarchy} route={route}
      error={papersError} onNavigate={navigate}
      onDirectionsChanged={async () => { await refreshDirections(); await refreshPapers(); }} />}
    {route.name === "paper-organization" &&
      <PaperOrganizationWorkspace route={route} directions={directions} onNavigate={navigate}
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
          onOrganizationChanged={async () => {
            await Promise.all([refreshPapers(), refreshWorkspace(route.paperId), refreshReviews()]);
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
  onResolveEntry(snapshotHash: string, groups: Record<string, string>): Promise<void>;
  onBypassEntry(): Promise<void>;
  onNavigate(href: string): void;
  onImport(): void;
}) {
  const [resolutionSelections, setResolutionSelections] = useState<Record<string, string>>({});
  useEffect(() => { setResolutionSelections({}); }, [props.entryAnswer && "snapshotHash" in props.entryAnswer.resolution
    ? props.entryAnswer.resolution.snapshotHash : null]);
  const ambiguous = props.entryAnswer?.resolution.state === "ambiguous" ? props.entryAnswer.resolution : null;
  const allGroupsSelected = Boolean(ambiguous && ambiguous.groups.length > 0 &&
    ambiguous.groups.every((group) => resolutionSelections[group.id]));
  return <main className="app page home">
    <header className="home-intro"><span className="eyebrow">PRIVATE RESEARCH WORKSPACE</span><h1>今天，从哪里继续？</h1>
      <p>检索已确认知识，继续阅读，或处理需要你判断的事项。</p></header>
    <section className="entry-agent entry-agent-primary"><div className="section-heading"><span>CURATED ONLY</span><h2>向知识库提问</h2></div>
      <form onSubmit={props.onAskEntry}><input aria-label="Knowledge question" value={props.entryQuestion}
        onChange={(event) => props.onEntryQuestion(event.target.value)} /><button>检索已确认知识</button></form>
      {props.entryAnswer && <div className="entry-result">{props.entryAnswer.projection.stale && <div className="stale">
        {props.entryAnswer.projection.notice} · {props.entryAnswer.projection.lastSuccessfulAt ?? "尚无成功索引"}</div>}
        {props.entryAnswer.resolution.state === "resolved" && <div className="entry-resolution-banner">
          <div><b>已按 Paper 身份检索</b>{props.entryAnswer.resolution.matches.map((match) =>
            <span key={`${match.paperId}-${match.text}`}>{match.text} → {match.canonicalTitle}</span>)}</div>
          <button onClick={() => void props.onBypassEntry()}>忽略 Paper 身份，检索全部已确认知识</button>
        </div>}
        <p>{props.entryAnswer.answer}</p><div className="source-list">{props.entryAnswer.sources.map((source) => <button className="source-card"
          key={`${source.sourceType}-${source.sourceId}`} onClick={() => {
            void fetch(`/api/entry-agent/sources/${source.sourceType}/${encodeURIComponent(source.sourceId)}/open`,
              { method: "POST" });
            props.onNavigate(source.href ?? paperHref(source.paperId));
          }}>{source.sourceType === "topic-knowledge" ? "Topic 知识" : source.sourceType} · {source.title}</button>)}</div>
        {ambiguous && ambiguous.groups.length > 0 && <div className="entry-resolution-groups">
          {ambiguous.groups.map((group) => <fieldset key={group.id}><legend>“{group.matchedText}” 指哪篇 Paper？</legend>
            {group.candidates.map((candidate) => <label key={candidate.paperId}>
              <input type="radio" name={group.id} value={candidate.paperId}
                checked={resolutionSelections[group.id] === candidate.paperId}
                onChange={() => setResolutionSelections((current) => ({ ...current,
                  [group.id]: candidate.paperId }))} />
              <span><b>{candidate.canonicalTitle}</b><small>{candidate.authors.join(", ")} · {candidate.year}
                {candidate.primaryDirection ? ` · ${candidate.primaryDirection.title}` : ""}</small>
                <small>匹配 {candidate.matchKind}: {candidate.matchedText}</small></span>
            </label>)}
          </fieldset>)}
          <button disabled={!allGroupsSelected} onClick={() => ambiguous && void props.onResolveEntry(
            ambiguous.snapshotHash, resolutionSelections)}>按所选 Paper 检索</button>
          <button className="text-button" onClick={() => void props.onBypassEntry()}>不选择，检索全部已确认知识</button>
        </div>}
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

function PaperOrganizationWorkspace(props: {
  route: Extract<BrowserRoute, { name: "paper-organization" }>;
  directions: ResearchDirection[];
  onNavigate(href: string): void;
  onDirectionsChanged(): Promise<void>;
}) {
  const [model, setModel] = useState<OrganizationQueueModel | null>(null);
  const [query, setQuery] = useState(props.route.query);
  const [error, setError] = useState<string | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [selectedProposalIds, setSelectedProposalIds] = useState<Set<string>>(new Set());
  const routeKey = paperOrganizationHref(props.route);
  const load = async () => {
    const response = await fetch(`/api/paper-organization/queue${routeKey.slice("/papers/organize".length)}`);
    if (!response.ok) throw new Error("整理建议暂时不可用。");
    setModel(await response.json() as OrganizationQueueModel);
    setError(null);
  };
  useEffect(() => setQuery(props.route.query), [props.route.query]);
  useEffect(() => {
    void load().catch((cause) => setError(cause instanceof Error ? cause.message : "整理建议暂时不可用。"));
  }, [routeKey]);
  useEffect(() => {
    const activeIds = model?.items.flatMap((item) =>
      item.latestRun && ["queued", "running"].includes(item.latestRun.state) ? [item.latestRun.id] : []) ?? [];
    if (activeIds.length === 0) return;
    const started = Date.now();
    let timer: number;
    const poll = async () => {
      if (!document.hidden) {
        const response = await fetch("/api/paper-organization/status", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jobRunIds: activeIds, proposalIds: [] }),
        });
        if (response.ok) {
          const statuses = await response.json() as { jobs: Array<{ id: string; state: string }> };
          if (statuses.jobs.some((job) => !["queued", "running"].includes(job.state))) {
            await load();
            return;
          }
        }
      }
      timer = window.setTimeout(poll, Date.now() - started >= 30_000 ? 2_000 : 750);
    };
    timer = window.setTimeout(poll, 750);
    return () => window.clearTimeout(timer);
  }, [model?.items.map((item) => `${item.latestRun?.id}:${item.latestRun?.state}`).join("|"), routeKey]);
  const navigateWith = (patch: Partial<PaperOrganizationViewState>) => {
    props.onNavigate(paperOrganizationHref({ ...props.route, ...patch }));
    setFiltersOpen(false);
  };
  const views = [
    ["pending", "全部待确认", model?.counts.pendingPapers ?? 0],
    ["attention", "全部需处理", model?.counts.attentionPapers ?? 0],
    ["all", "全部已分析", null],
  ] as const;
  const safeVisibleProposalIds = model?.items.flatMap((item) =>
    Object.values(item.sections).flatMap((suggestion) =>
      suggestion?.reviewStatus === "pending" &&
      suggestion.applicability === "ready" &&
      !suggestion.ambiguous &&
      (suggestion.collisionWarnings?.length ?? 0) === 0
        ? [suggestion.id] : [])) ?? [];
  return <main className="app page organization-workspace">
    <header className="library-header"><div><span className="eyebrow">PAPER ORGANIZATION</span>
      <h1>整理建议</h1><p>逐项确认 Alias、Primary 和 Secondary；每一项都独立写入。</p></div>
      <button className="ghost" onClick={() => props.onNavigate("/papers")}>返回论文库</button></header>
    <AliasAutomationPanel onChanged={load} />
    <TaxonomyBootstrapPanel directionCount={props.directions.length}
      onChanged={async () => { await props.onDirectionsChanged(); await load(); }}
      onNavigate={props.onNavigate} />
    <form className="paper-catalog-search" onSubmit={(event) => {
      event.preventDefault();
      navigateWith({ query: query.trim() });
    }}><input aria-label="搜索待整理 Paper" value={query} onChange={(event) => setQuery(event.target.value)}
        placeholder="搜索标题、alias、作者或方向" /><button>搜索</button>
      {props.route.query && <button type="button" className="ghost"
        onClick={() => { setQuery(""); navigateWith({ query: "" }); }}>清除</button>}
      {safeVisibleProposalIds.length > 0 && <button type="button" className="ghost"
        onClick={() => setSelectedProposalIds(new Set(safeVisibleProposalIds))}>
        选择当前安全建议（{safeVisibleProposalIds.length}）
      </button>}
      {selectedProposalIds.size > 0 && <button type="button" className="ghost"
        onClick={() => setSelectedProposalIds(new Set())}>清除选择</button>}
    </form>
    <button className="direction-drawer-trigger" onClick={() => setFiltersOpen(true)}>筛选整理建议</button>
    {filtersOpen && <button className="direction-drawer-backdrop" aria-label="关闭筛选"
      onClick={() => setFiltersOpen(false)} />}
    <div className="organization-workspace-layout">
      <aside className={`organization-filter-rail ${filtersOpen ? "open" : ""}`} aria-label="整理建议筛选">
        <button className="direction-drawer-close" onClick={() => setFiltersOpen(false)}>完成</button>
        {views.map(([view, label, count]) => <button key={view}
          aria-pressed={props.route.view === view}
          onClick={() => navigateWith({ view })}><span>{label}</span>{count !== null && <b>{count}</b>}</button>)}
        <label>建议类型<select value={props.route.section ?? ""}
          onChange={(event) => navigateWith({ section: (event.target.value || null) as
            PaperOrganizationViewState["section"] })}>
          <option value="">全部类型</option><option value="alias">Alias</option>
          <option value="primary">Primary</option><option value="secondary">Secondary</option>
        </select></label>
        <label>方向<select value={props.route.direction ?? ""}
          onChange={(event) => navigateWith({ direction: event.target.value || null })}>
          <option value="">全部方向</option>{props.directions.map((direction) =>
            <option key={direction.id} value={direction.id}>{direction.title}</option>)}
        </select></label>
        <label className="organization-filter-check"><input type="checkbox"
          checked={props.route.unclassified}
          onChange={(event) => navigateWith({ unclassified: event.target.checked })} />仅看未分类</label>
      </aside>
      <section className="organization-queue">
        {error && <p className="organization-error">{error}</p>}
        {!model && !error && <p className="empty">正在载入整理建议…</p>}
        {model?.truncated && <p className="inline-alert">结果超过 500 篇；已优先显示需处理项，请缩小筛选范围。</p>}
        {model && model.items.length === 0 && <p className="empty">当前筛选下没有需要整理的 Paper。</p>}
        {model?.items.map((item) => <PaperOrganizationQueueCard key={item.paper.id} item={item}
          directions={props.directions} onChanged={load} onNavigate={props.onNavigate}
          selectedProposalIds={selectedProposalIds}
          onToggleProposal={(proposalId, selected) => setSelectedProposalIds((current) => {
            const next = new Set(current);
            if (selected) next.add(proposalId); else next.delete(proposalId);
            return next;
          })} />)}
      </section>
    </div>
    {selectedProposalIds.size > 0 && <OrganizationBatchTray proposalIds={[...selectedProposalIds]}
      onDone={async () => {
        setSelectedProposalIds(new Set());
        await Promise.all([load(), props.onDirectionsChanged()]);
      }} />}
  </main>;
}

function AliasAutomationPanel(props: { onChanged(): Promise<void> }) {
  const [model, setModel] = useState<AliasAutomationModel | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = async () => {
    const response = await fetch("/api/paper-organization/automation");
    if (!response.ok) throw new Error("Alias 自动确认状态暂时不可用。");
    setModel(await response.json() as AliasAutomationModel);
  };
  useEffect(() => { void load().catch((cause) =>
    setError(cause instanceof Error ? cause.message : "Alias 自动确认状态暂时不可用。")); }, []);
  const command = async (path: string, body: unknown = {}) => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(body) });
      const result = await response.json() as { code?: string; id?: string; passed?: boolean };
      if (!response.ok) throw new Error(result.code ?? "Alias 自动确认操作失败。");
      await Promise.all([load(), props.onChanged()]);
      return result;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Alias 自动确认操作失败。");
      return null;
    } finally { setBusy(false); }
  };
  const statusLabel = model?.mode === "enabled" ? "已启用" : model?.mode === "suspended" ? "已暂停"
    : model?.mode === "insufficient-evidence" ? "证据不足" : "未启用";
  const active = model?.policies.find((policy) => policy.status === "enabled");
  const eligible = model?.policies.find((policy) => policy.status === "eligible");
  return <section className="alias-automation">
    <details><summary><div><span className="eyebrow">ALIAS AUTOMATION</span>
      <h2>Alias 自动确认</h2><p>仅 Alias；Primary 与 Secondary 始终需要逐项确认。</p></div>
      <div><strong>{statusLabel}</strong><small>{model?.labelCount ?? 0} 个标签</small></div></summary>
      <div className="alias-automation-body">
        {model && <div className="automation-gates"><span>至少 {model.gates.minimumLabels} 个成熟样本</span>
          <span>{model.gates.maturityDays} 天成熟期</span><span>10% 人工 holdout</span>
          <span>每日最多 {model.gates.dailyCap} 篇</span></div>}
        {model?.latestEvaluation && <div className="automation-evaluation">
          <p><b>最近评估：</b>{model.latestEvaluation.passed ? "通过" : "未通过"} ·
            {model.latestEvaluation.acceptedCount}/{model.latestEvaluation.labelCount} 未编辑接受 ·
            Wilson 下界 {(model.latestEvaluation.wilsonLower * 100).toFixed(1)}% ·
            排除 {model.latestEvaluation.excludedCount}</p>
          {!model.latestEvaluation.passed && <small>{model.latestEvaluation.reasons.join("；")}</small>}
        </div>}
        <div className="taxonomy-actions">
          <button disabled={busy} onClick={() => void command("/api/paper-organization/automation/evaluate")}>重新评估</button>
          {model?.latestEvaluation?.passed && !eligible && !active && <button disabled={busy}
            onClick={() => void command("/api/paper-organization/automation/policies",
              { evaluationId: model.latestEvaluation!.id })}>创建可启用策略</button>}
          {eligible && <button disabled={busy} onClick={() => void command(
            `/api/paper-organization/automation/policies/${encodeURIComponent(eligible.id)}/enable`)}>明确启用 v{eligible.version}</button>}
          {active && <button className="danger" disabled={busy} onClick={() => void command(
            `/api/paper-organization/automation/policies/${encodeURIComponent(active.id)}/suspend`,
            { reason: "owner-request" })}>暂停 v{active.version}</button>}
        </div>
        {error && <p className="organization-error">{error}</p>}
      </div>
    </details>
  </section>;
}

function TaxonomyBootstrapPanel(props: {
  directionCount: number;
  onChanged(): Promise<void>;
  onNavigate(href: string): void;
}) {
  const [taxonomy, setTaxonomy] = useState<TaxonomyModel | null>(null);
  const [preview, setPreview] = useState<TaxonomyPreview | null>(null);
  const [backfillPreview, setBackfillPreview] = useState<BackfillPreview | null>(null);
  const [backfill, setBackfill] = useState<BackfillModel | null>(null);
  const [backfillLimit, setBackfillLimit] = useState(50);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const load = async () => {
    const [taxonomyResponse, previewResponse, backfillResponse] = await Promise.all([
      fetch("/api/paper-taxonomy/bootstrap"),
      fetch("/api/paper-taxonomy/bootstrap/preview?mode=next&limit=100"),
      fetch(`/api/paper-organization/backfill/preview?limit=${backfillLimit}`),
    ]);
    if (!taxonomyResponse.ok || !previewResponse.ok || !backfillResponse.ok) {
      throw new Error("方向策展状态暂时不可用。");
    }
    const nextTaxonomy = await taxonomyResponse.json() as TaxonomyModel;
    const nextPreview = await previewResponse.json() as TaxonomyPreview;
    const nextBackfillPreview = await backfillResponse.json() as BackfillPreview;
    setTaxonomy(nextTaxonomy);
    setPreview(nextPreview);
    setBackfillPreview(nextBackfillPreview);
    const campaignId = nextBackfillPreview.activeCampaign?.id ?? backfill?.campaign.id;
    if (campaignId) {
      const campaignResponse = await fetch(
        `/api/paper-organization/backfills/${encodeURIComponent(campaignId)}`,
      );
      if (campaignResponse.ok) setBackfill(await campaignResponse.json() as BackfillModel);
    }
    setError(null);
  };
  useEffect(() => {
    void load().catch((cause) => setError(cause instanceof Error ? cause.message : "方向策展状态暂时不可用。"));
  }, [backfillLimit]);
  const activeTaxonomy = taxonomy?.runs.find((run) => ["queued", "running"].includes(run.state));
  const activeBackfill = backfill && ["reserved", "scheduling", "monitoring"].includes(backfill.campaign.state);
  useEffect(() => {
    if (!activeTaxonomy && !activeBackfill) return;
    let timer: number;
    const started = Date.now();
    const poll = async () => {
      if (!document.hidden) await load().catch(() => undefined);
      timer = window.setTimeout(poll, Date.now() - started >= 30_000 ? 2_000 : 750);
    };
    timer = window.setTimeout(poll, 750);
    return () => window.clearTimeout(timer);
  }, [activeTaxonomy?.id, activeBackfill ? backfill?.campaign.id : null, backfillLimit]);
  const runTaxonomy = async (mode: "next" | "refresh" | "regenerate", priorManifestId?: string) => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/paper-taxonomy/bootstrap", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": `web-taxonomy-${mode}-${crypto.randomUUID()}`,
        },
        body: JSON.stringify({ mode, limit: 100, priorManifestId }),
      });
      const result = await response.json() as { code?: string };
      if (!response.ok) throw new Error(result.code === "paper-taxonomy-cohort-empty"
        ? "当前没有未覆盖的 Paper；如需重新检查，请使用“重新检查全部”。"
        : result.code ?? "生成候选方向失败。");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "生成候选方向失败。");
    } finally {
      setBusy(false);
    }
  };
  const startBackfill = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/paper-organization/backfill", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": `web-backfill-${crypto.randomUUID()}`,
        },
        body: JSON.stringify({ limit: backfillLimit }),
      });
      const result = await response.json() as { campaignId?: string; code?: string };
      if (!response.ok || !result.campaignId) throw new Error(result.code ?? "启动历史论文整理失败。");
      const campaignResponse = await fetch(
        `/api/paper-organization/backfills/${encodeURIComponent(result.campaignId)}`,
      );
      if (campaignResponse.ok) setBackfill(await campaignResponse.json() as BackfillModel);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "启动历史论文整理失败。");
    } finally {
      setBusy(false);
    }
  };
  const abandonBackfill = async () => {
    if (!backfill) return;
    setBusy(true);
    try {
      const response = await fetch(
        `/api/paper-organization/backfills/${encodeURIComponent(backfill.campaign.id)}/abandon`,
        { method: "POST", headers: { "idempotency-key": `web-abandon-${crypto.randomUUID()}` } },
      );
      if (!response.ok) throw new Error("停止 Campaign 失败。");
      setBackfill(await response.json() as BackfillModel);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "停止 Campaign 失败。");
    } finally {
      setBusy(false);
    }
  };
  const pending = taxonomy?.proposals.filter((proposal) => proposal.reviewStatus === "pending") ?? [];
  const latest = taxonomy?.runs[0] ?? null;
  useEffect(() => {
    if (pending.length > 0 || activeTaxonomy || activeBackfill) setExpanded(true);
  }, [pending.length, activeTaxonomy?.id, activeBackfill ? backfill?.campaign.id : null]);
  return <section className="taxonomy-bootstrap">
    <details open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary><div><span className="eyebrow">TAXONOMY &amp; BACKFILL</span>
        <h2>方向策展与历史论文回填</h2></div>
        <div><strong>{props.directionCount}</strong><span>个已确认方向</span></div></summary>
      <div className="taxonomy-bootstrap-body">
        {error && <p className="organization-error">{error}</p>}
        <div className="taxonomy-step">
          <div><span className="eyebrow">STEP 1</span><h3>生成候选方向</h3>
            <p>{preview
              ? `本批将检查 ${preview.selectedCount} / ${preview.eligibleCount} 篇符合条件的 Paper，之后剩余 ${preview.remainingCount} 篇。`
              : "正在计算可检查的 Paper…"}</p></div>
          <div className="taxonomy-actions">
            <button disabled={busy || Boolean(activeTaxonomy) || !preview?.selectedCount ||
              taxonomy?.availability !== "ready"} onClick={() => void runTaxonomy("next")}>
              {activeTaxonomy ? "正在生成…" : "生成候选方向"}
            </button>
            {preview?.eligibleCount === 0 && <button className="ghost" disabled={busy || Boolean(activeTaxonomy)}
              onClick={() => void runTaxonomy("refresh")}>重新检查全部</button>}
          </div>
        </div>
        {latest?.state === "succeeded" && latest.outcome?.noNewDirection && pending.length === 0 &&
          <p className="taxonomy-zero-result">已检查此批 Paper，未发现需新增的方向。</p>}
        {latest && ["failed", "timed_out", "interrupted"].includes(latest.state) &&
          <p className="organization-error">方向生成未完成：{latest.error?.code ?? latest.state}</p>}
        {pending.length > 0 && <div className="taxonomy-candidates">
          <header><div><span className="eyebrow">CANDIDATES</span><h3>逐项确认候选方向</h3></div>
            <button className="ghost" disabled={busy || Boolean(activeTaxonomy)}
              onClick={() => void runTaxonomy("regenerate", pending[0]?.manifestId)}>
              重新生成这一批
            </button></header>
          {pending.map((proposal) => <TaxonomyCandidateCard key={proposal.id} proposal={proposal}
            onChanged={async () => { await props.onChanged(); await load(); }} />)}
        </div>}
        <div className="taxonomy-step">
          <div><span className="eyebrow">STEP 2</span><h3>回填历史论文</h3>
            <p>{backfillPreview
              ? `${backfillPreview.selectedCount} / ${backfillPreview.eligibleCount} 篇将进入普通整理流程，之后剩余 ${backfillPreview.remainingCount} 篇。`
              : "正在计算可回填 Paper…"}</p>
            {backfillPreview && backfillPreview.staleOldSummaryCount > 0 &&
              <p className="inline-alert">{backfillPreview.staleOldSummaryCount} 篇仅有旧 Summary 的历史建议；
                新建议成功后才会替代旧建议。</p>}</div>
          <div className="taxonomy-actions">
            <label>批次<select value={backfillLimit} disabled={Boolean(activeBackfill)}
              onChange={(event) => setBackfillLimit(Number(event.target.value))}>
              {[25, 50, 100, 250, 500].map((limit) => <option key={limit} value={limit}>{limit} 篇</option>)}
            </select></label>
            <button disabled={busy || Boolean(activeBackfill) || !backfillPreview?.selectedCount}
              onClick={() => void startBackfill()}>开始回填</button>
          </div>
        </div>
        {backfill && <div className="backfill-progress">
          <div><span className="eyebrow">CAMPAIGN · {backfill.campaign.state}</span>
            <h3>{backfill.counts.completed} 完成 · {backfill.counts.scheduled} 处理中 ·
              {backfill.counts.failed} 失败 · {backfill.counts.skipped} 跳过</h3>
            {backfill.olderCatalogCount > 0 &&
              <p>{backfill.olderCatalogCount} 篇使用了较早的方向目录快照，可稍后重新检查。</p>}</div>
          <div className="taxonomy-actions">
            <button className="ghost" onClick={() => props.onNavigate("/papers/organize?view=pending")}>
              查看待确认建议
            </button>
            {activeBackfill && <button className="danger" disabled={busy}
              onClick={() => void abandonBackfill()}>停止后续调度</button>}
          </div>
        </div>}
      </div>
    </details>
  </section>;
}

function TaxonomyCandidateCard(props: { proposal: TaxonomyProposal; onChanged(): Promise<void> }) {
  const [value, setValue] = useState(props.proposal.suggested);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const decide = async (action: "accept" | "reject") => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/direction-taxonomy/proposals/${encodeURIComponent(props.proposal.id)}/decision`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": `web-taxonomy-decision-${props.proposal.id}-${crypto.randomUUID()}`,
          },
          body: JSON.stringify({ action: action === "accept" ? "accept-with-edit" : "reject",
            ...(action === "accept" ? { value } : {}) }),
        },
      );
      const result = await response.json() as { code?: string };
      if (!response.ok) throw new Error(result.code === "direction-taxonomy-proposal-stale"
        ? "名称、ID 或来源已发生冲突；请修改后重试或拒绝。"
        : result.code ?? "候选方向处理失败。");
      await props.onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "候选方向处理失败。");
    } finally {
      setBusy(false);
    }
  };
  return <article className={`taxonomy-candidate ${props.proposal.ambiguous ? "attention" : ""}`}>
    <div className="taxonomy-candidate-heading"><div><span className="eyebrow">
      {props.proposal.ambiguous ? "OVERLAP NEEDS JUDGMENT" : "DIRECTION CANDIDATE"}</span>
      <h4>{value.title}</h4></div><span>{props.proposal.representativePaperIds.length} 篇代表 Paper</span></div>
    <div className="taxonomy-fields">
      <label>方向名称<input value={value.title}
        onChange={(event) => setValue({ ...value, title: event.target.value })} /></label>
      <label>稳定 ID<input value={value.topicId}
        onChange={(event) => setValue({ ...value, topicId: event.target.value })} /></label>
      <label className="wide">Aliases（逗号分隔）<input value={value.aliases.join(", ")}
        onChange={(event) => setValue({ ...value, aliases: event.target.value.split(/[,，]/)
          .map((item) => item.trim()).filter(Boolean) })} /></label>
      <label className="wide">Scope<textarea value={value.scope}
        onChange={(event) => setValue({ ...value, scope: event.target.value })} /></label>
      <label className="wide">排除边界（每行一项）<textarea value={value.exclusions.join("\n")}
        onChange={(event) => setValue({ ...value, exclusions: event.target.value.split("\n")
          .map((item) => item.trim()).filter(Boolean) })} /></label>
    </div>
    <details className="taxonomy-evidence"><summary>为什么提出这个方向</summary>
      <p>{props.proposal.rationale}</p>
      <p>代表 Paper：{props.proposal.representativePaperIds.join("、")}</p>
      {props.proposal.overlaps.map((overlap) => <p key={overlap.topicId}>
        与 {overlap.topicId} 重叠：{overlap.rationale}</p>)}</details>
    {error && <p className="organization-error">{error}</p>}
    <div className="taxonomy-actions">
      <button disabled={busy || !value.title.trim() || !value.topicId.trim() ||
        !value.scope.trim() || value.exclusions.length === 0} onClick={() => void decide("accept")}>
        确认方向
      </button>
      <button className="ghost" disabled={busy} onClick={() => void decide("reject")}>拒绝</button>
    </div>
  </article>;
}

function PaperOrganizationQueueCard(props: {
  item: OrganizationQueueItem;
  directions: ResearchDirection[];
  onChanged(): Promise<void>;
  onNavigate(href: string): void;
  selectedProposalIds: Set<string>;
  onToggleProposal(proposalId: string, selected: boolean): void;
}) {
  const [activated, setActivated] = useState(false);
  const { item } = props;
  return <details className={`organization-queue-card ${item.attention ? "attention" : ""}`}
    onToggle={(event) => { if (event.currentTarget.open) setActivated(true); }}>
    <summary><div><span className="eyebrow">{item.attention ? "NEEDS ATTENTION"
      : item.pendingSectionCount > 0 ? "PENDING" : "ANALYZED"}</span>
      <h2>{item.paper.preferredAlias ?? item.paper.title}</h2>
      {item.paper.preferredAlias && <p>{item.paper.title}</p>}
      <p className="paper-authors"><span>{item.paper.authors.join(", ")}</span>
        <span className="paper-year"> · {item.paper.year}</span></p></div>
      <div><strong>{item.pendingSectionCount}</strong><span>待确认项</span></div></summary>
    {activated && <div className="organization-queue-detail">
      <PaperOrganizationSuggestions paper={item.paper} directions={props.directions}
        onChanged={props.onChanged} selectedProposalIds={props.selectedProposalIds}
        onToggleProposal={props.onToggleProposal} />
      <button className="text-button" onClick={() => props.onNavigate(paperHref(item.paper.id, {
        pdfOpen: false,
        page: 1,
        anchor: null,
        returnTo: `${window.location.pathname}${window.location.search}`,
      }))}>
        打开 Paper →
      </button>
    </div>}
  </details>;
}

function OrganizationBatchTray(props: { proposalIds: string[]; onDone(): Promise<void> }) {
  const [preview, setPreview] = useState<OrganizationBatchPreview | null>(null);
  const [batch, setBatch] = useState<OrganizationBatchModel | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const previewAction = async (action: "accept" | "reject") => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/paper-organization/batches/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, proposalIds: props.proposalIds }),
      });
      const result = await response.json() as OrganizationBatchPreview & { code?: string };
      if (!response.ok) throw new Error(result.code ?? "批量预览失败。");
      setPreview(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "批量预览失败。");
    } finally {
      setBusy(false);
    }
  };
  const start = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      const response = await fetch("/api/paper-organization/batches", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": `web-organization-batch-${crypto.randomUUID()}`,
        },
        body: JSON.stringify({ action: preview.action, proposalIds: props.proposalIds }),
      });
      const result = await response.json() as { batchId?: string; code?: string };
      if (!response.ok || !result.batchId) throw new Error(result.code ?? "批量操作启动失败。");
      const read = async () => {
        const status = await fetch(
          `/api/paper-organization/batches/${encodeURIComponent(result.batchId!)}`,
        );
        if (!status.ok) throw new Error("批量状态读取失败。");
        return status.json() as Promise<OrganizationBatchModel>;
      };
      let current = await read();
      setBatch(current);
      while (["reserved", "applying"].includes(current.batch.state)) {
        await new Promise((resolve) => window.setTimeout(resolve, 500));
        current = await read();
        setBatch(current);
      }
      await props.onDone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "批量操作失败。");
    } finally {
      setBusy(false);
    }
  };
  return <aside className="organization-batch-tray" aria-label="批量确认">
    <div><span className="eyebrow">BATCH SELECTION</span>
      <strong>已选择 {props.proposalIds.length} 项</strong>
      {batch && <small>{batch.counts.succeeded ?? 0} 成功 ·
        {(batch.counts.failed ?? 0) + (batch.counts.conflicted ?? 0)} 需处理</small>}</div>
    {!preview ? <div className="taxonomy-actions">
      <button disabled={busy} onClick={() => void previewAction("accept")}>预览批量确认</button>
      <button className="ghost" disabled={busy} onClick={() => void previewAction("reject")}>预览批量拒绝</button>
    </div> : <div className="organization-batch-confirm">
      <p>{preview.eligibleProposalCount} 项 / {preview.eligiblePaperCount} 篇可执行；
        Alias {preview.sectionCounts.alias} · Primary {preview.sectionCounts.primary} ·
        Secondary {preview.sectionCounts.secondary}。</p>
      {preview.excluded.length > 0 && <small>{preview.excluded.length} 项因 stale、blocked、
        ambiguous 或 collision 不会执行。</small>}
      <div className="taxonomy-actions"><button disabled={busy || preview.eligibleProposalCount === 0}
        onClick={() => void start()}>{preview.action === "accept" ? "确认批量接受" : "确认批量拒绝"}</button>
      <button className="ghost" disabled={busy} onClick={() => setPreview(null)}>返回</button></div>
    </div>}
    {error && <p className="organization-error">{error}</p>}
  </aside>;
}

function PaperLibrary(props: {
  papers: Paper[];
  directions: ResearchDirection[];
  hierarchy: DirectionHierarchyModel;
  route: Extract<BrowserRoute, { name: "papers" }>;
  error: string | null;
  onNavigate(href: string): void;
  onDirectionsChanged(): Promise<void>;
}) {
  const { route } = props;
  const [query, setQuery] = useState(route.query);
  const [catalogMatches, setCatalogMatches] = useState<Paper[] | null>(null);
  const [directionNavOpen, setDirectionNavOpen] = useState(false);
  const [redirectNotice, setRedirectNotice] = useState<string | null>(null);
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
  const selectedDomain = props.hierarchy.domains.find((domain) => domain.id === route.domain) ?? null;
  const invalidDomain = Boolean(route.domain && (route.direction || !props.hierarchy.enabled ||
    (route.domain !== "ungrouped" && !selectedDomain)));
  const invalidDirection = Boolean((route.direction && !selectedDirection) || invalidDomain);
  useEffect(() => {
    if (!invalidDirection || !route.direction) return;
    let active = true;
    void fetch(`/api/directions/${encodeURIComponent(route.direction)}/resolve`).then(async (response) => {
      if (!response.ok) throw new Error("topic-redirect-unavailable");
      return response.json() as Promise<{ canonicalId: string; lineage: string[] }>;
    }).then((resolved) => {
      if (!active || resolved.canonicalId === route.direction) return;
      setRedirectNotice(`方向已合并：${resolved.lineage.join(" → ")}`);
      props.onNavigate(papersHref({ ...route, direction: resolved.canonicalId }));
    }).catch(() => undefined);
    return () => { active = false; };
  }, [invalidDirection, route.direction]);
  const normalizedQuery = route.query.trim().normalize("NFKC").toLocaleLowerCase();
  const domainChildIds = route.domain === "ungrouped"
    ? new Set(props.directions.filter((direction) => !direction.parentDomainId).map((direction) => direction.id))
    : selectedDomain ? new Set(props.directions.filter((direction) => direction.parentDomainId === selectedDomain.id)
      .map((direction) => direction.id)) : null;
  const visible = (catalogMatches ?? props.papers).filter((paper) => {
    if (route.view === "unclassified" && paper.directions.some((direction) => direction.role === "primary")) return false;
    if (route.pending && !paper.pendingOrganizationCount) return false;
    if (route.direction && !paper.directions.some((direction) =>
      direction.topicId === route.direction && (route.relation !== "primary" || direction.role === "primary"))) return false;
    if (domainChildIds && !paper.directions.some((direction) => domainChildIds.has(direction.topicId) &&
      (route.relation !== "primary" || direction.role === "primary"))) return false;
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
      <button className="ghost" onClick={() => props.onNavigate("/papers/organize")}>整理建议</button></header>
    <form className="paper-catalog-search" onSubmit={(event) => {
      event.preventDefault();
      props.onNavigate(href({ query }));
    }}>
      <input aria-label="搜索论文标题、别名、作者或方向" value={query}
        onChange={(event) => setQuery(event.target.value)} placeholder="搜索标题、alias、作者或方向" />
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
        <a href={href({ view: "all", direction: null, domain: null, relation: "all", pending: false })}
          aria-current={route.view === "all" && !route.direction && !route.domain && !route.pending ? "page" : undefined}
          onClick={(event) => { event.preventDefault(); navigateLibrary(event.currentTarget.href.replace(window.location.origin, "")); }}>
          <span>全部</span><b>{props.papers.length}</b></a>
        <a href={href({ view: "unclassified", direction: null, domain: null, relation: "all", pending: false })}
          aria-current={route.view === "unclassified" && !route.pending ? "page" : undefined}
          onClick={(event) => { event.preventDefault(); navigateLibrary(event.currentTarget.href.replace(window.location.origin, "")); }}>
          <span>未分类</span><b>{props.papers.filter((paper) => !paper.directions.some((direction) => direction.role === "primary")).length}</b></a>
        <a href={href({ view: "all", direction: null, domain: null, relation: "all", pending: true })}
          aria-current={route.pending ? "page" : undefined}
          onClick={(event) => { event.preventDefault(); navigateLibrary(event.currentTarget.href.replace(window.location.origin, "")); }}>
          <span>待确认</span><b>{props.papers.filter((paper) => paper.pendingOrganizationCount > 0).length}</b></a>
        <div className="direction-sidebar-heading"><span>研究方向</span><small>Primary</small></div>
        {props.hierarchy.enabled ? <>
          {props.hierarchy.domains.map((domain) => <details className="domain-nav-group" open key={domain.id}>
            <summary><a href={href({ view: "all", direction: null, domain: domain.id, relation: "all", pending: false })}
              aria-current={route.domain === domain.id ? "page" : undefined}
              onClick={(event) => { event.preventDefault(); navigateLibrary(event.currentTarget.href.replace(window.location.origin, "")); }}>
              <span>{domain.title}</span><b>{domain.primaryCount}</b></a></summary>
            {props.directions.filter((direction) => direction.parentDomainId === domain.id).map((direction) => <a key={direction.id}
              href={href({ view: "all", direction: direction.id, domain: null, relation: "all", pending: false })}
              aria-current={route.direction === direction.id ? "page" : undefined}
              onClick={(event) => { event.preventDefault(); navigateLibrary(event.currentTarget.href.replace(window.location.origin, "")); }}>
              <span>{direction.title}</span><b>{direction.primaryCount}</b></a>)}</details>)}
          <details className="domain-nav-group" open><summary><a
            href={href({ view: "all", direction: null, domain: "ungrouped", relation: "all", pending: false })}
            aria-current={route.domain === "ungrouped" ? "page" : undefined}
            onClick={(event) => { event.preventDefault(); navigateLibrary(event.currentTarget.href.replace(window.location.origin, "")); }}>
            <span>Ungrouped</span><b>{props.hierarchy.ungroupedPrimaryCount}</b></a></summary>
            {props.directions.filter((direction) => !direction.parentDomainId).map((direction) => <a key={direction.id}
              href={href({ view: "all", direction: direction.id, domain: null, relation: "all", pending: false })}
              onClick={(event) => { event.preventDefault(); navigateLibrary(event.currentTarget.href.replace(window.location.origin, "")); }}>
              <span>{direction.title}</span><b>{direction.primaryCount}</b></a>)}</details>
        </> : props.directions.map((direction) => <a key={direction.id}
          href={href({ view: "all", direction: direction.id, domain: null, relation: "all", pending: false })}
          aria-current={route.direction === direction.id ? "page" : undefined}
          onClick={(event) => { event.preventDefault(); navigateLibrary(event.currentTarget.href.replace(window.location.origin, "")); }}>
          <span>{direction.title}</span><b>{direction.primaryCount}</b></a>)}
        <DirectionCreator directions={props.directions} hierarchy={props.hierarchy} onCreated={props.onDirectionsChanged} />
      </aside>
      <section className="library">
        {redirectNotice && <p className="inline-alert">{redirectNotice}</p>}
        {props.error && props.papers.length > 0 && <p className="inline-alert">{props.error}，正在显示上次成功载入的列表。</p>}
        {invalidDirection ? <div className="error-block"><p>这个方向或 Domain 过滤条件无效、已停用，或层级尚未启用。</p>
          <button onClick={() => props.onNavigate(papersHref({ ...route, direction: null, domain: null }))}>返回全部论文</button></div>
          : props.error && props.papers.length === 0 ? <p className="error-block">{props.error}</p>
          : props.papers.length === 0 ? <div className="empty"><p>还没有论文。使用顶部的“导入论文”粘贴 arXiv 链接或公开 PDF 直链。</p></div>
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

function DirectionCreator({ directions, hierarchy, onCreated }: {
  directions: ResearchDirection[];
  hierarchy: DirectionHierarchyModel;
  onCreated(): Promise<void>;
}) {
  const idempotencyKey = useRef(crypto.randomUUID());
  const [id, setId] = useState("");
  const [title, setTitle] = useState("");
  const [scope, setScope] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [editTitle, setEditTitle] = useState("");
  const [editAliases, setEditAliases] = useState("");
  const [editScope, setEditScope] = useState("");
  const [mergeTargetId, setMergeTargetId] = useState("");
  const [mergePreview, setMergePreview] = useState<{ affectedPaperCount: number } | null>(null);
  const [knowledgeOpen, setKnowledgeOpen] = useState(false);
  const [domainId, setDomainId] = useState("");
  const [domainTitle, setDomainTitle] = useState("");
  const [domainScope, setDomainScope] = useState("");
  const [selectedDomainId, setSelectedDomainId] = useState("");
  const selectedDomain = hierarchy.domains.find((domain) => domain.id === selectedDomainId) ?? null;
  const selected = directions.find((direction) => direction.id === selectedId) ?? null;
  useEffect(() => {
    if (!selected) return;
    setEditTitle(selected.title);
    setEditAliases(selected.aliases.join(", "));
    setEditScope(selected.scope);
    setMergeTargetId("");
    setMergePreview(null);
    setKnowledgeOpen(false);
  }, [selectedId, selected?.revisionId]);
  return <details className="direction-creator"><summary>＋ 管理方向</summary>
    <section className="hierarchy-manager"><div><b>Domain → Direction</b><small>
      {hierarchy.enabled ? "已启用" : `未启用 · ${hierarchy.directionCount}/${hierarchy.threshold} 个方向`}</small></div>
      <button type="button" className="ghost" disabled={!hierarchy.enabled && !hierarchy.canEnable} onClick={async () => {
        const response = await fetch(`/api/taxonomy-hierarchy/${hierarchy.enabled ? "disable" : "enable"}`, {
          method: "POST", headers: { "idempotency-key": crypto.randomUUID() },
        });
        const result = await response.json() as { code?: string };
        setStatus(response.ok ? (hierarchy.enabled ? "层级已关闭，父子关系仍保留。" : "层级已启用。")
          : result.code ?? "层级状态更新失败。");
        if (response.ok) await onCreated();
      }}>{hierarchy.enabled ? "关闭层级" : "启用层级"}</button>
      {!hierarchy.enabled && !hierarchy.canEnable && <small>达到 15 个 active Direction 后可由你手动启用。</small>}
      {hierarchy.enabled && <>
        <form onSubmit={async (event) => {
          event.preventDefault();
          const response = await fetch("/api/domains", { method: "POST",
            headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
            body: JSON.stringify({ id: domainId, title: domainTitle, scope: domainScope }) });
          const result = await response.json() as { code?: string };
          setStatus(response.ok ? "Domain 已创建" : result.code ?? "Domain 创建失败");
          if (response.ok) { setDomainId(""); setDomainTitle(""); setDomainScope(""); await onCreated(); }
        }}>
          <label>Domain 名称<input value={domainTitle} onChange={(event) => setDomainTitle(event.target.value)} required /></label>
          <label>稳定 ID<input value={domainId} onChange={(event) => setDomainId(event.target.value)}
            placeholder="topic:computer-vision" required /></label>
          <label>Scope<textarea value={domainScope} onChange={(event) => setDomainScope(event.target.value)} required /></label>
          <button>创建 Domain</button>
        </form>
        {hierarchy.domains.length > 0 && <><label>编辑 Domain<select value={selectedDomainId}
          onChange={(event) => setSelectedDomainId(event.target.value)}><option value="">请选择 Domain</option>
          {hierarchy.domains.map((domain) => <option value={domain.id} key={domain.id}>{domain.title}</option>)}</select></label>
          {selectedDomain && <form onSubmit={async (event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const response = await fetch(`/api/domains/${encodeURIComponent(selectedDomain.id)}/rename`, { method: "POST",
              headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({
                title: String(form.get("title") ?? ""), aliases: String(form.get("aliases") ?? "").split(/[,，]/).map((x) => x.trim()).filter(Boolean),
                scope: String(form.get("scope") ?? ""), scopeMeaningUnchanged: String(form.get("scope") ?? "") === selectedDomain.scope,
                expectedRevisionId: selectedDomain.revisionId, expectedMarkdownHash: selectedDomain.markdownHash,
              }) });
            const result = await response.json() as { code?: string };
            setStatus(response.ok ? "Domain revision 已更新" : result.code ?? "Domain 更新失败");
            if (response.ok) await onCreated();
          }}><label>名称<input name="title" defaultValue={selectedDomain.title} required /></label>
            <label>Aliases<input name="aliases" defaultValue={selectedDomain.aliases.join(", ")} /></label>
            <label>Scope<textarea name="scope" defaultValue={selectedDomain.scope} required /></label>
            <button>保存 Domain revision</button></form>}</>}
      </>}
    </section>
    <form className="direction-create-form" onSubmit={async (event) => {
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
    {directions.length > 0 && <div className="direction-lifecycle">
      <label>编辑已有方向<select value={selectedId} onChange={(event) => setSelectedId(event.target.value)}>
        <option value="">请选择方向</option>
        {directions.map((direction) => <option key={direction.id} value={direction.id}>
          {direction.title}</option>)}
      </select></label>
      {selected && <>
        {selected.usageLevel === "knowledge-ready" ? <p className="inline-alert">
          该方向已进入 Curated。名称、Alias、Scope 与知识正文必须在 Topic 知识编辑器中作为同一个 revision 确认。
        </p> : <form onSubmit={async (event) => {
          event.preventDefault();
          setStatus("正在保存新 revision…");
          const response = await fetch(`/api/directions/${encodeURIComponent(selected.id)}/rename`, {
            method: "POST",
            headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
            body: JSON.stringify({
              title: editTitle,
              aliases: editAliases.split(/[,，]/).map((item) => item.trim()).filter(Boolean),
              scope: editScope,
              scopeMeaningUnchanged: editScope === selected.scope,
              expectedRevisionId: selected.revisionId,
              expectedMarkdownHash: selected.markdownHash,
            }),
          });
          const result = await response.json() as { code?: string };
          if (!response.ok) {
            setStatus(result.code === "direction-rename-attestation-required"
              ? "请确认 Scope 含义未改变，或明确编辑 Scope。" : result.code ?? "方向更新失败。");
            return;
          }
          setStatus("方向 revision 已更新");
          await onCreated();
        }}>
          <label>新名称<input value={editTitle}
            onChange={(event) => setEditTitle(event.target.value)} required /></label>
          <label>Aliases<input value={editAliases}
            onChange={(event) => setEditAliases(event.target.value)} /></label>
          <label>Scope<textarea value={editScope}
            onChange={(event) => setEditScope(event.target.value)} required /></label>
          <small>{editScope === selected.scope
            ? "提交即确认：本次仅调整显示名称，Scope 含义不变。"
            : "Scope 已变化；相关待确认分类建议会变为 stale。"}</small>
          <button>保存新 revision</button>
        </form>}
        {hierarchy.enabled && (selected.usageLevel === "knowledge-ready"
          ? <p className="inline-alert">当前 Domain：{hierarchy.domains.find((domain) => domain.id === selected.parentDomainId)?.title ?? "Ungrouped"}。
            请在 Topic 知识编辑器中与新 revision 一起修改。</p>
          : <label>Parent Domain<select value={selected.parentDomainId ?? ""} onChange={async (event) => {
            const parentDomainId = event.target.value || null;
            const parent = hierarchy.domains.find((domain) => domain.id === parentDomainId);
            const response = await fetch(`/api/directions/${encodeURIComponent(selected.id)}/domain`, { method: "POST",
              headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
              body: JSON.stringify({ parentDomainId, expectedRevisionId: selected.revisionId,
                expectedMarkdownHash: selected.markdownHash, expectedParentRevisionId: parent?.revisionId,
                expectedParentMarkdownHash: parent?.markdownHash }) });
            const result = await response.json() as { code?: string };
            setStatus(response.ok ? "Parent Domain 已更新" : result.code ?? "Parent Domain 更新失败");
            if (response.ok) await onCreated();
          }}><option value="">Ungrouped</option>{hierarchy.domains.map((domain) =>
            <option value={domain.id} key={domain.id}>{domain.title}</option>)}</select></label>)}
        <button type="button" className="direction-knowledge-open" onClick={() => setKnowledgeOpen(true)}>
          编辑 Topic 知识
        </button>
        {knowledgeOpen && <TopicKnowledgeEditor direction={selected} domains={hierarchy.domains} onChanged={onCreated}
          onClose={() => setKnowledgeOpen(false)} />}
        <form className="direction-merge-form" onSubmit={async (event) => {
          event.preventDefault();
          if (!mergeTargetId) return;
          if (!mergePreview) {
            const response = await fetch(`/api/directions/${encodeURIComponent(selected.id)}/merge/preview`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ targetTopicId: mergeTargetId }),
            });
            const result = await response.json() as { affectedPaperCount?: number; code?: string };
            if (!response.ok || result.affectedPaperCount === undefined) {
              setStatus(result.code ?? "Merge 预览失败。");
              return;
            }
            setMergePreview({ affectedPaperCount: result.affectedPaperCount });
            return;
          }
          const response = await fetch(`/api/directions/${encodeURIComponent(selected.id)}/merge`, {
            method: "POST",
            headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
            body: JSON.stringify({ targetTopicId: mergeTargetId }),
          });
          const result = await response.json() as { mergeId?: string; code?: string };
          if (!response.ok || !result.mergeId) {
            setStatus(result.code ?? "Merge 启动失败。");
            return;
          }
          setStatus("Merge 已启动；旧方向会先建立 redirect，再逐篇迁移。");
          let state = "reserved";
          while (["reserved", "superseding", "migrating"].includes(state)) {
            await new Promise((resolve) => window.setTimeout(resolve, 500));
            const current = await fetch(`/api/direction-merges/${encodeURIComponent(result.mergeId)}`);
            if (!current.ok) break;
            state = ((await current.json()) as { merge: { state: string } }).merge.state;
          }
          setStatus(state === "complete" ? "Merge 已完成"
            : state === "complete-with-exceptions" ? "Merge 完成，但有 Paper 需要 reconciliation。"
              : `Merge 状态：${state}`);
          await onCreated();
        }}>
          <label>Merge 到<select value={mergeTargetId} onChange={(event) => {
            setMergeTargetId(event.target.value);
            setMergePreview(null);
          }} required>
            <option value="">选择目标方向</option>
            {directions.filter((direction) => direction.id !== selected.id).map((direction) =>
              <option key={direction.id} value={direction.id}>{direction.title}</option>)}
          </select></label>
          {mergePreview && <p className="inline-alert">将影响 {mergePreview.affectedPaperCount} 篇 Paper。
            Merge 提交后 forward-only，不合并 Scope 或知识正文。</p>}
          <button className={mergePreview ? "danger" : ""}>
            {mergePreview ? "确认 forward-only Merge" : "预览 Merge"}
          </button>
        </form>
      </>}
    </div>}
  </details>;
}

const topicKnowledgeLabels: Record<string, string> = {
  "Map of concepts": "概念图",
  "Schools of thought and disagreements": "流派与分歧",
  "Open questions": "开放问题",
  "Syntheses": "综合认识",
  "Suggested reading path": "建议阅读路径",
};

function TopicKnowledgeEditor({ direction, domains, onChanged, onClose }: {
  direction: ResearchDirection;
  domains: ResearchDomain[];
  onChanged(): Promise<void>;
  onClose(): void;
}) {
  const [model, setModel] = useState<TopicKnowledgeModel | null>(null);
  const [sources, setSources] = useState<Array<{
    sourceType: "summary" | "takeaway"; sourceId: string; paperId: string; title: string;
  }>>([]);
  const [sections, setSections] = useState<Record<string, string>>({});
  const [title, setTitle] = useState(direction.title);
  const [aliases, setAliases] = useState(direction.aliases.join(", "));
  const [scope, setScope] = useState(direction.scope);
  const [parentDomainId, setParentDomainId] = useState<string | null>(direction.parentDomainId);
  const [selectedSources, setSelectedSources] = useState<Set<string>>(new Set());
  const [knowledgeReady, setKnowledgeReady] = useState(false);
  const [attested, setAttested] = useState(false);
  const [preview, setPreview] = useState<null | { eligible: boolean; errors: string[];
    indexedSections: string[]; projectionOperation: string }>(null);
  const [status, setStatus] = useState<string | null>(null);
  const load = async () => {
    const [knowledgeResponse, sourceResponse] = await Promise.all([
      fetch(`/api/directions/${encodeURIComponent(direction.id)}/knowledge`),
      fetch(`/api/directions/${encodeURIComponent(direction.id)}/knowledge/provenance-options`),
    ]);
    if (!knowledgeResponse.ok || !sourceResponse.ok) throw new Error("Topic 知识暂时不可用。");
    const knowledge = await knowledgeResponse.json() as TopicKnowledgeModel;
    const options = await sourceResponse.json() as { sources: typeof sources };
    setModel(knowledge);
    setTitle(knowledge.title);
    setAliases(knowledge.aliases.join(", "));
    setScope(knowledge.scope);
    setParentDomainId(knowledge.parentDomainId);
    setSources(options.sources);
    setSections(knowledge.sections);
    setSelectedSources(new Set(knowledge.provenance.map((item) => `${item.sourceType}:${item.sourceId}`)));
    setKnowledgeReady(knowledge.usageLevel === "knowledge-ready");
    setAttested(knowledge.ownerAttested);
    setPreview(null);
  };
  useEffect(() => { void load().catch((error) => setStatus(error instanceof Error ? error.message : "载入失败")); },
    [direction.id, direction.revisionId]);
  if (!model) return createPortal(<><button className="topic-knowledge-backdrop" aria-label="关闭 Topic 知识编辑器" onClick={onClose} />
    <section className="topic-knowledge-editor"><button className="topic-knowledge-close" onClick={onClose}>×</button>
      <p>{status ?? "正在载入 Topic 知识…"}</p></section></>, document.body);
  const body = {
    title,
    aliases: aliases.split(/[,，]/).map((item) => item.trim()).filter(Boolean),
    scope,
    parentDomainId,
    ...(parentDomainId ? {
      expectedParentRevisionId: domains.find((domain) => domain.id === parentDomainId)?.revisionId,
      expectedParentMarkdownHash: domains.find((domain) => domain.id === parentDomainId)?.markdownHash,
    } : {}),
    usageLevel: knowledgeReady ? "knowledge-ready" : "classification",
    sections,
    provenance: [...selectedSources].map((key) => {
      const separator = key.indexOf(":");
      return { sourceType: key.slice(0, separator), sourceId: key.slice(separator + 1) };
    }),
    ownerAttested: knowledgeReady && attested,
    expectedRevisionId: model.revisionId,
    expectedMarkdownHash: model.markdownHash,
  };
  const previewAction = async () => {
    setStatus("正在校验…");
    const response = await fetch(`/api/directions/${encodeURIComponent(direction.id)}/knowledge/preview`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const result = await response.json() as { eligible?: boolean; errors?: string[];
      indexedSections?: string[]; projectionOperation?: string; code?: string };
    if (!response.ok || result.eligible === undefined) {
      setStatus(result.code ?? "预览失败。"); return;
    }
    setPreview({ eligible: result.eligible, errors: result.errors ?? [],
      indexedSections: result.indexedSections ?? [], projectionOperation: result.projectionOperation ?? "delete" });
    setStatus(result.eligible ? "校验通过；请确认写入新 revision。" : "还不能标记为可检索知识。");
  };
  const save = async () => {
    setStatus("正在写入新 revision…");
    const response = await fetch(`/api/directions/${encodeURIComponent(direction.id)}/knowledge/revisions`, {
      method: "POST", headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify(body),
    });
    const result = await response.json() as { code?: string };
    if (!response.ok) { setStatus(result.code ?? "Topic 知识写入失败。"); return; }
    setStatus("Topic 知识 revision 已确认");
    await Promise.all([load(), onChanged()]);
  };
  return createPortal(<><button className="topic-knowledge-backdrop" aria-label="关闭 Topic 知识编辑器" onClick={onClose} />
  <section className="topic-knowledge-editor" id="topic-knowledge" role="dialog" aria-label="编辑 Topic 知识">
    <button className="topic-knowledge-close" aria-label="关闭" onClick={onClose}>×</button>
    <div className="topic-knowledge-heading"><div><span className="eyebrow">TOPIC KNOWLEDGE</span>
      <h4>Topic 知识</h4></div><small>R{model.revisionId.split(":r").at(-1)} ·
        {model.indexed ? " 已进入 Curated" : " 未进入 Curated"}</small></div>
    {model.drifted && <p className="inline-alert">检测到外部编辑；知识正文需重新确认后才能检索。</p>}
    <div className="topic-knowledge-identity">
      <label>方向名称<input value={title} onChange={(event) => { setTitle(event.target.value); setPreview(null); }} required /></label>
      <label>Aliases<input value={aliases} onChange={(event) => { setAliases(event.target.value); setPreview(null); }}
        placeholder="以逗号分隔" /></label>
      <label>Scope<textarea value={scope} onChange={(event) => { setScope(event.target.value); setPreview(null); }}
        placeholder="这个方向包含什么、不包含什么？" required /></label>
      {domains.length > 0 && <label>Parent Domain<select value={parentDomainId ?? ""}
        onChange={(event) => { setParentDomainId(event.target.value || null); setPreview(null); }}>
        <option value="">Ungrouped</option>{domains.map((domain) =>
          <option value={domain.id} key={domain.id}>{domain.title}</option>)}</select></label>}
    </div>
    {Object.entries(topicKnowledgeLabels).map(([heading, label]) => <label key={heading}>{label}
      <textarea value={sections[heading] ?? ""} onChange={(event) => {
        setSections((current) => ({ ...current, [heading]: event.target.value })); setPreview(null);
      }} placeholder={`${label}（空白不会进入检索）`} /></label>)}
    <fieldset><legend>Provenance（来自该方向已分类 Paper 的已确认内容）</legend>
      {sources.length === 0 ? <small>当前没有可用的 active Summary 或 confirmed Takeaway。</small>
        : sources.map((source) => {
          const key = `${source.sourceType}:${source.sourceId}`;
          return <label className="topic-provenance-option" key={key}><input type="checkbox"
            checked={selectedSources.has(key)} onChange={(event) => {
              setSelectedSources((current) => { const next = new Set(current);
                if (event.target.checked) next.add(key); else next.delete(key); return next; });
              setPreview(null);
            }} /><span><b>{source.title}</b><small>{source.sourceType} · {source.paperId}</small></span></label>;
        })}
    </fieldset>
    <label className="organization-filter-check"><input type="checkbox" checked={knowledgeReady}
      onChange={(event) => { setKnowledgeReady(event.target.checked); setAttested(false); setPreview(null); }} />
      作为可复用 Topic 知识进入 Curated 检索</label>
    {knowledgeReady && <label className="organization-filter-check"><input type="checkbox" checked={attested}
      onChange={(event) => { setAttested(event.target.checked); setPreview(null); }} />
      我确认以上内容不只是分类元数据，并且可作为回答依据</label>}
    {preview && <div className={preview.eligible ? "topic-knowledge-preview" : "inline-alert"}>
      {preview.eligible ? <p>将索引：{preview.indexedSections.map((item) => topicKnowledgeLabels[item]).join("、") || "无（classification）"}</p>
        : <p>校验未通过：{preview.errors.join("、")}</p>}</div>}
    <div className="taxonomy-actions"><button type="button" className="ghost" onClick={() => void previewAction()}>预览与校验</button>
      <button type="button" disabled={!preview?.eligible} onClick={() => void save()}>确认新 revision</button></div>
    {status && <small role="status">{status}</small>}
  </section></>, document.body);
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
      <p className="paper-authors" title={`${paper.authors.join(", ")} · ${paper.year}`}>
        <span>{paper.authors.join(", ")}</span><span className="paper-year"> · {paper.year}</span></p>
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

function PaperOrganizationSuggestions(props: {
  paper: { id: string };
  directions: ResearchDirection[];
  onChanged(): Promise<void>;
  selectedProposalIds?: Set<string>;
  onToggleProposal?(proposalId: string, selected: boolean): void;
}) {
  const [model, setModel] = useState<OrganizationSuggestionModel | null>(null);
  const [drafts, setDrafts] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = async () => {
    const response = await fetch(`/api/papers/${encodeURIComponent(props.paper.id)}/organization-suggestions`);
    if (!response.ok) throw new Error("组织建议暂时不可用。");
    const next = await response.json() as OrganizationSuggestionModel;
    setModel(next);
    setDrafts((current) => {
      const updated = { ...current };
      for (const suggestion of next.suggestions) {
        if (!(suggestion.id in updated)) updated[suggestion.id] = suggestion.after;
      }
      return updated;
    });
  };
  useEffect(() => {
    void load().catch((cause) => setError(cause instanceof Error ? cause.message : "组织建议暂时不可用。"));
  }, [props.paper.id]);
  useEffect(() => {
    const activeIds = model?.runs.filter((run) => ["queued", "running"].includes(run.state))
      .map((run) => run.id) ?? [];
    if (activeIds.length === 0) return;
    const started = Date.now();
    let timer: number;
    const poll = async () => {
      if (!document.hidden) {
        const response = await fetch("/api/paper-organization/status", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jobRunIds: activeIds, proposalIds: [] }),
        });
        if (response.ok) {
          const statuses = await response.json() as { jobs: Array<{ id: string; state: string }> };
          if (statuses.jobs.some((job) => !["queued", "running"].includes(job.state))) {
            await load();
            await props.onChanged();
            return;
          }
        }
      }
      timer = window.setTimeout(poll, Date.now() - started >= 30_000 ? 2_000 : 750);
    };
    timer = window.setTimeout(poll, 750);
    return () => window.clearTimeout(timer);
  }, [model?.runs.map((run) => `${run.id}:${run.state}`).join("|")]);
  const command = async (path: string, body: unknown, key: string) => {
    setBusy(key); setError(null);
    try {
      const response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const failure = await response.json() as { code?: string };
        if (response.status === 409 && failure.code === "paper-organization-proposal-decided") {
          await Promise.all([load(), props.onChanged()]);
          return;
        }
        const messages: Record<string, string> = {
          "paper-organization-proposal-blocked": "请先确认 Primary Research Direction。",
          "paper-organization-proposal-stale": "这条建议的依据已变化，请重新生成。",
          "paper-organization-conflicted": "Paper Markdown 已在外部修改，请先处理 reconciliation。",
        };
        throw new Error(messages[failure.code ?? ""] ?? "操作失败，请重试。");
      }
      await Promise.all([load(), props.onChanged()]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作失败，请重试。");
    } finally {
      setBusy(null);
    }
  };
  const regenerate = (scope: "alias" | "primary" | "secondary") =>
    command(`/api/papers/${encodeURIComponent(props.paper.id)}/organization-suggestions`, { scope }, `regen:${scope}`);
  if (!model) return <div className="organization-suggestions"><p className="empty">正在载入组织建议…</p></div>;
  const latest = new Map<string, OrganizationSuggestion>();
  for (const suggestion of model.suggestions) {
    if (!latest.has(suggestion.changeKind)) latest.set(suggestion.changeKind, suggestion);
  }
  const sections = [
    ["alias", "Paper Aliases", "alias"],
    ["primary-direction", "Primary Research Direction", "primary"],
    ["secondary-direction", "Secondary Research Directions", "secondary"],
  ] as const;
  const directionTitle = (id: string) => props.directions.find((direction) => direction.id === id)?.title ?? id;
  return <div className="organization-suggestions">
    {model.availability === "runner-unavailable" &&
      <p className="inline-alert">Paper Organization Agent 当前未启用；仍可使用“当前组织”手动编辑。</p>}
    {model.runs[0] && <p className={`organization-run ${model.runs[0].state}`}>
      最近分析：{model.runs[0].state === "running" ? "正在分析"
        : model.runs[0].state === "queued" ? "等待运行"
          : model.runs[0].state === "succeeded" ? "已完成"
            : `需要处理 · ${model.runs[0].error?.code ?? model.runs[0].state}`}
    </p>}
    {model.runs[0] && ["failed", "timed_out", "interrupted"].includes(model.runs[0].state) &&
      model.runs[0].error?.code !== "direction-catalog-too-large" &&
      <button type="button" className="text-button" disabled={busy !== null}
        onClick={() => void command(
          `/api/paper-organization/jobs/${encodeURIComponent(model.runs[0]!.id)}/retry`,
          {},
          `retry:${model.runs[0]!.id}`,
        )}>重试这次分析</button>}
    {sections.map(([kind, label, scope]) => {
      const suggestion = latest.get(kind);
      const draft = suggestion ? drafts[suggestion.id] : undefined;
      const aliasDraft = kind === "alias" && Array.isArray(draft) ? draft as Array<{ name?: string }> : [];
      const retainedAliasNames = new Set(aliasDraft.map((value) => String(value.name ?? "")));
      return <section className="organization-suggestion-card" key={kind}>
        <header><div>{suggestion?.reviewStatus === "pending" && props.onToggleProposal &&
          <input type="checkbox" aria-label={`选择 ${label}`} checked={props.selectedProposalIds?.has(suggestion.id) ?? false}
            onChange={(event) => props.onToggleProposal?.(suggestion.id, event.target.checked)} />}
          <span>{label}</span>
          {suggestion?.ambiguous && <small>需要判断</small>}
          {suggestion && <small>{suggestion.reviewStatus === "pending"
            ? `${suggestion.reviewStatus} · ${suggestion.applicability} · ${suggestion.materialization}`
            : `${suggestion.reviewStatus} · ${suggestion.materialization}`}</small>}</div>
          <button type="button" className="text-button" disabled={busy !== null}
            onClick={() => void regenerate(scope)}>重新生成</button></header>
        {!suggestion && <p className="empty">当前没有待确认建议。</p>}
        {suggestion?.reviewStatus === "pending" && kind === "alias" &&
          <div className="suggestion-values">{aliasDraft.map((value, index) =>
            <div className="suggestion-alias-row" key={index}>
              <label>Alias {index + 1}<input value={String(value.name ?? "")}
                onChange={(event) => setDrafts((current) => ({
                  ...current,
                  [suggestion.id]: (current[suggestion.id] as any[]).map((item, itemIndex) =>
                    itemIndex === index ? { ...item, name: event.target.value } : item),
                }))} /></label>
              <button type="button" className="remove-alias-candidate" disabled={busy !== null}
                aria-label={`移除 Alias ${index + 1}`}
                onClick={() => {
                  setDrafts((current) => ({
                    ...current,
                    [suggestion.id]: removeOrganizationAliasCandidate(
                      Array.isArray(current[suggestion.id]) ? current[suggestion.id] as unknown[] : [], index,
                    ),
                  }));
                  props.onToggleProposal?.(suggestion.id, false);
                }}>移除</button>
            </div>)}
            {!canConfirmOrganizationAliasDraft(aliasDraft) &&
              <p className="empty alias-draft-empty">已移除全部 Alias 候选；如不接受任何 Alias，请点击“拒绝”。</p>}
          </div>}
        {suggestion?.reviewStatus === "pending" && kind === "primary-direction" &&
          <label className="suggestion-primary">建议方向<select value={String((draft as any)?.topicId ?? "")}
            onChange={(event) => setDrafts((current) => ({
              ...current,
              [suggestion.id]: { topicId: event.target.value, role: "primary" },
            }))}>
            <option value="">请选择</option>
            {props.directions.map((direction) =>
              <option key={direction.id} value={direction.id}>{direction.title}</option>)}
          </select></label>}
        {suggestion?.reviewStatus === "pending" && kind === "secondary-direction" &&
          <div className="secondary-direction-options">{props.directions.map((direction) => {
            const values = Array.isArray(draft) ? draft as Array<{ topicId: string }> : [];
            const checked = values.some((value) => value.topicId === direction.id);
            return <label key={direction.id}><input type="checkbox" checked={checked}
              disabled={!checked && values.length >= 3}
              onChange={(event) => setDrafts((current) => {
                const currentValues = current[suggestion.id] as Array<{ topicId: string; role: "secondary" }>;
                return { ...current, [suggestion.id]: event.target.checked
                  ? [...currentValues, { topicId: direction.id, role: "secondary" }]
                  : currentValues.filter((value) => value.topicId !== direction.id) };
              })} />{direction.title}</label>;
          })}</div>}
        {suggestion?.rationale && <p className="suggestion-rationale">{suggestion.rationale}</p>}
        {suggestion?.rationales?.filter((item) => kind !== "alias" ||
          (item.name !== undefined && retainedAliasNames.has(item.name))).map((item, index) =>
          <p className="suggestion-rationale" key={index}>
            {item.name ?? (item.topicId ? directionTitle(item.topicId) : "")}：{item.rationale}
          </p>)}
        {suggestion?.alternatives?.map((item) =>
          <p className="suggestion-rationale" key={item.topicId}>备选 {directionTitle(item.topicId)}：{item.rationale}</p>)}
        {suggestion?.collisionWarnings && suggestion.collisionWarnings
          .filter((name) => kind !== "alias" || retainedAliasNames.has(name)).length > 0 &&
          <p className="alias-collision">同名提示：{suggestion.collisionWarnings
            .filter((name) => kind !== "alias" || retainedAliasNames.has(name)).join("、")}</p>}
        {suggestion?.reviewStatus === "pending" && <footer>
          <button type="button" className="ghost" disabled={busy !== null}
            onClick={() => void command(
              `/api/paper-organization/proposals/${encodeURIComponent(suggestion.id)}/decision`,
              { action: "reject" }, `reject:${suggestion.id}`)}>拒绝</button>
          <button type="button" disabled={busy !== null || suggestion.applicability !== "ready" ||
            (kind === "alias" && !canConfirmOrganizationAliasDraft(aliasDraft))}
            onClick={() => void command(
              `/api/paper-organization/proposals/${encodeURIComponent(suggestion.id)}/decision`,
              { action: "accept", value: draft }, `accept:${suggestion.id}`)}>确认此项</button>
        </footer>}
      </section>;
    })}
    {model.suggestions.some((suggestion) => suggestion.reviewStatus !== "pending") &&
      <details className="organization-history"><summary>历史</summary>
        <ol>{model.suggestions.filter((suggestion) => suggestion.reviewStatus !== "pending")
          .map((suggestion) => <li key={suggestion.id}>
            <span>{suggestion.changeKind}</span>
            <b>{suggestion.reviewStatus}</b>
            <small>{suggestion.materialization}</small>
          </li>)}</ol>
      </details>}
    {error && <p className="organization-error">{error}</p>}
  </div>;
}

function PaperOrganizationEditor(props: {
  paper: Paper;
  directions: ResearchDirection[];
  onClose(): void;
  onChanged(): Promise<void>;
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
  const [mode, setMode] = useState<"suggestions" | "current">("suggestions");
  const organizationSignature = JSON.stringify({
    aliases: props.paper.aliases,
    directions: props.paper.directions.map((direction) => ({
      topicId: direction.topicId,
      role: direction.role,
    })),
  });
  useEffect(() => {
    setAliases(props.paper.aliases.map((alias) => ({ ...alias })));
    setPrimary(props.paper.directions.find((direction) => direction.role === "primary")?.topicId ?? "");
    setSecondary(new Set(props.paper.directions.filter((direction) => direction.role === "secondary")
      .map((direction) => direction.topicId)));
  }, [organizationSignature]);
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
      <nav className="organization-modes" aria-label="Paper organization mode">
        <button type="button" aria-pressed={mode === "suggestions"}
          onClick={() => setMode("suggestions")}>Agent 建议</button>
        <button type="button" aria-pressed={mode === "current"}
          onClick={() => setMode("current")}>当前组织</button>
      </nav>
      {mode === "suggestions"
        ? <PaperOrganizationSuggestions paper={props.paper} directions={props.directions}
          onChanged={props.onChanged} />
        : <form onSubmit={async (event) => {
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
      </form>}
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
  onOrganizationChanged(): Promise<void>;
}) {
  const { workspace, route } = props;
  const [showArchivedConversations, setShowArchivedConversations] = useState(false);
  const [organizationOpen, setOrganizationOpen] = useState(false);
  const [organizationStatus, setOrganizationStatus] = useState<string | null>(null);
  const [outlineCollapsed, setOutlineCollapsed] = useState(true);
  const [activeSummarySection, setActiveSummarySection] = useState(0);
  const [summaryWidth, setSummaryWidth] = useState(50);
  const workbenchRef = useRef<HTMLDivElement>(null);
  const summaryPaneRef = useRef<HTMLElement>(null);
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
  const pdfPageCount = route.conversationId
    ? props.conversation?.contextSnapshot?.pageCount ?? workspace.pdf?.pageCount ?? 0
    : workspace.pdf?.pageCount ?? 0;
  const modeHref = (mode: "reading" | "discussion" | "knowledge") => paperHref(workspace.paper.id,
    { mode, conversationId: null, pdfOpen: mode === "reading", page: mode === "reading" ? route.page : 1,
      anchor: mode === "reading" ? route.anchor : null });
  const panelKind = route.mode === "knowledge" ? "knowledge"
    : route.mode === "discussion" && !route.pdfOpen ? "discussion" : "source";
  const pdfVersionId = props.conversation?.contextSnapshot?.paperVersionId ?? workspace.paper.versionId;
  const defaultPdfUrl = pdfVersionId === workspace.paper.versionId && workspace.pdf
    ? workspace.pdf.url
    : `/api/paper-versions/${encodeURIComponent(pdfVersionId)}/pdf`;
  const openedPdfUrl = props.openedPdfSource?.anchor === route.anchor && props.openedPdfSource.page === route.page
    ? props.openedPdfSource.href : defaultPdfUrl;
  const pdfSrc = pdfViewerUrl(openedPdfUrl, route.page);
  const sourceHref = route.conversationId
    ? paperHref(workspace.paper.id, { mode: "discussion", conversationId: route.conversationId,
      pdfOpen: true, page: route.page, anchor: route.anchor })
    : paperHref(workspace.paper.id, { mode: "reading", conversationId: null,
      pdfOpen: true, page: route.page, anchor: route.anchor });
  const discussionHref = paperHref(workspace.paper.id, { mode: "discussion", conversationId: route.conversationId,
    pdfOpen: false, page: 1, anchor: null });
  const knowledgeHref = paperHref(workspace.paper.id, { mode: "knowledge", conversationId: null,
    pdfOpen: false, page: 1, anchor: null });
  const openSummaryEvidence = (page: number, anchor: string) => props.onNavigate(route.conversationId
    ? paperHref(workspace.paper.id, { mode: "discussion", conversationId: route.conversationId,
      pdfOpen: true, page, anchor })
    : paperHref(workspace.paper.id, { mode: "reading", conversationId: null,
      pdfOpen: true, page, anchor }));
  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    const workbench = workbenchRef.current;
    if (!workbench) return;
    event.preventDefault();
    const bounds = workbench.getBoundingClientRect();
    const move = (pointerEvent: PointerEvent) => {
      const next = ((pointerEvent.clientX - bounds.left) / bounds.width) * 100;
      setSummaryWidth(Math.min(62, Math.max(38, next)));
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  };
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
    <header className="topbar"><a className="ghost back-link" href={route.returnTo ?? "/papers"}
      onClick={(event) => { event.preventDefault(); props.onNavigate(route.returnTo ?? "/papers"); }}>
      <ArrowLeftIcon aria-hidden="true" size={16} weight="bold" />{route.returnTo ? "整理建议" : "论文库"}</a>
      <div className="workspace-paper-identity">
        <h1 title={workspace.paper.preferredAlias ? `${workspace.paper.preferredAlias} · ${workspace.paper.title}` : workspace.paper.title}>
          {workspace.paper.preferredAlias ?? workspace.paper.title}</h1>
        <p className="paper-metadata">{workspace.paper.year}</p></div>
      <div className="workspace-badges"><a className="source-link source-action" href={workspace.paper.sourceUrl}
        target="_blank" rel="noopener noreferrer">
        {workspace.paper.sourceType === "arxiv" ? `arXiv v${workspace.paper.version}` : "公开 PDF"} · 打开来源
        <ArrowSquareOutIcon aria-hidden="true" size={15} weight="bold" /></a>
        <button type="button" className="code-status repository-summary" onClick={() => setOrganizationOpen(true)}>
          <PencilSimpleIcon aria-hidden="true" size={15} weight="bold" />编辑别名与方向</button>
        <button type="button" className="code-status repository-summary"
          aria-expanded={route.repositoriesOpen}
          onClick={() => props.onNavigate(repositoryHref(!route.repositoriesOpen))}>
          <GithubLogoIcon aria-hidden="true" size={16} weight="fill" />{codeStatus}</button></div>
    </header>
    {organizationOpen && <PaperOrganizationEditor paper={workspace.paper} directions={props.directions}
      onClose={() => setOrganizationOpen(false)} onChanged={props.onOrganizationChanged}
      onSave={async (input, idempotencyKey) => {
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
    <div className="paper-workbench" ref={workbenchRef}
      style={{ gridTemplateColumns: `${summaryWidth}% 10px minmax(0, ${100 - summaryWidth}%)` }}>
      <section className={`summary-workbench ${outlineCollapsed ? "outline-collapsed" : "outline-expanded"}`}>
        <aside className="summary-outline">
          <button type="button" className="outline-toggle" aria-label={outlineCollapsed ? "展开 Summary 目录" : "收拢 Summary 目录"}
            aria-expanded={!outlineCollapsed} onClick={() => setOutlineCollapsed((current) => !current)}>
            {outlineCollapsed ? <CaretDoubleRightIcon aria-hidden="true" size={18} weight="bold" />
              : <CaretDoubleLeftIcon aria-hidden="true" size={18} weight="bold" />}
          </button>
          <nav aria-label="Summary 目录">
            {workspace.summary?.sections.map((section, index) => <a key={section.key}
              className={activeSummarySection === index ? "active" : undefined}
              href={`#summary-section-${index + 1}`}
              aria-current={activeSummarySection === index ? "location" : undefined}
              title={outlineCollapsed ? section.title : undefined}
              onClick={(event) => {
                event.preventDefault();
                setActiveSummarySection(index);
                const pane = summaryPaneRef.current;
                const target = pane?.querySelector<HTMLElement>(`#summary-section-${index + 1}`);
                if (pane && target) pane.scrollTo({
                  top: Math.max(0, target.offsetTop - pane.offsetTop - 18), behavior: "smooth",
                });
              }}>
              <span>{String(index + 1).padStart(2, "0")}</span>{!outlineCollapsed && <b>{section.title}</b>}
            </a>)}
          </nav>
        </aside>
        <article className="summary-pane" ref={summaryPaneRef} onScroll={(event) => {
          const sections = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[data-summary-section]"));
          const threshold = event.currentTarget.scrollTop + 120;
          const next = sections.reduce((selected, section, index) =>
            section.offsetTop - event.currentTarget.offsetTop <= threshold ? index : selected, 0);
          setActiveSummarySection(next);
        }}>
          <div className="pane-title"><div><span className="status">{workspace.summary ? "Summary Ready"
            : workspace.processing?.state === "cancelled" ? "Import Cancelled"
              : isRetryableImportJobState(workspace.processing?.state) ? "Import Failed" : "Processing"}</span>
            <h2>技术精读</h2></div></div>
          {!workspace.summary && <section className="import-state"><span className="section-no">IMPORT STATUS</span>
            <h3>{workspace.processing?.state === "cancelled" ? "论文处理已取消" : isRetryableImportJobState(workspace.processing?.state) ? "论文处理未完成" : "正在生成 Paper Summary"}</h3>
            {workspace.processing && <p>{workspace.processing.state} · {Math.round(workspace.processing.progress * 100)}% · attempt {workspace.processing.attempt}</p>}
            {workspace.processing?.error && <><p>{workspace.processing.error.stage} · {workspace.processing.error.code}</p><p>{workspace.processing.error.message}</p></>}
            {isRetryableImportJobState(workspace.processing?.state) && <button disabled={props.busy} onClick={() => void props.onRetry()}>
              {props.busy ? `重试中 · ${props.progress ?? "queued"}` : workspace.processing?.error?.action === "repair-data-root-permissions" ? "修复存储权限后重试" : "重试 Paper Summary 流程"}</button>}
          </section>}
          {workspace.summary?.sections.map((section, index) => <section key={section.key}
            id={`summary-section-${index + 1}`} data-summary-section><span className="section-no">{String(index + 1).padStart(2, "0")}</span>
            <h3>{section.title}</h3><SummaryMarkdown markdown={section.body} pageCount={workspace.pdf?.pageCount ?? 0}
              onOpenEvidence={(page) => openSummaryEvidence(page, `page:${page}`)} /></section>)}
          {workspace.summary && <section className="summary-claims-section"><span className="section-no">KEY CLAIMS</span><h3>关键结论与证据</h3>
            {workspace.summary.claims.map((claim) => <button className={`claim ${route.anchor === claim.evidence.id ? "selected" : ""}`} key={claim.claim}
              onClick={() => openSummaryEvidence(claim.evidence.page, claim.evidence.id ?? `page:${claim.evidence.page}`)}>
              <span>{claim.claim}</span><small>p. {claim.evidence.page} · {claim.evidence.verified ? "原文已核验" : "仅定位"}</small></button>)}</section>}
        </article>
      </section>
      <div className="workbench-divider" role="separator" aria-label="调整 Summary 与工作区宽度" aria-orientation="vertical"
        aria-valuemin={38} aria-valuemax={62} aria-valuenow={Math.round(summaryWidth)} tabIndex={0}
        onPointerDown={startResize} onKeyDown={(event) => {
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            event.preventDefault();
            setSummaryWidth((current) => Math.min(62, Math.max(38, current + (event.key === "ArrowLeft" ? -2 : 2))));
          }
        }}><DotsSixVerticalIcon aria-hidden="true" size={17} weight="bold" /></div>
      <section className="workspace-side">
        <nav className="workspace-tabs" aria-label="Paper 工作区">
          <a href={sourceHref} aria-current={panelKind === "source" ? "page" : undefined}
            onClick={(event) => { event.preventDefault(); props.onNavigate(sourceHref); }}>原文</a>
          <a href={discussionHref} aria-current={panelKind === "discussion" ? "page" : undefined}
            onClick={(event) => { event.preventDefault(); props.onNavigate(discussionHref); }}>讨论</a>
          <a href={knowledgeHref} aria-current={panelKind === "knowledge" ? "page" : undefined}
            onClick={(event) => { event.preventDefault(); props.onNavigate(knowledgeHref); }}>Knowledge</a>
        </nav>
        <div className="workspace-panel-body">
    {panelKind === "discussion" && <div className="discussion-layout">
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
      {route.evidenceReceiptId && props.evidence && <EvidenceInspector evidence={props.evidence}
        onIntegrityFailure={props.onEvidenceIntegrityFailure} onClose={() => props.onNavigate(
        paperHref(workspace.paper.id, { mode: "discussion", conversationId: route.conversationId, pdfOpen: false,
          page: 1, anchor: null, evidenceReceiptId: null }))} />}
    </div>}
    {panelKind === "knowledge" && <section className="knowledge-workspace"><header><span className="eyebrow">PAPER KNOWLEDGE</span><h2>已审核知识</h2></header>
      <div className="knowledge-columns"><div><h3>Pending Proposals</h3>{props.knowledge.pendingProposals.length === 0 && <p className="empty">没有待审核 Proposal。</p>}
        {props.knowledge.pendingProposals.map((proposal) => <TakeawayReviewCard key={proposal.id} proposal={proposal}
          onDecide={(candidate, action, input) => void props.onReviewProposal(proposal, action, input)} />)}</div>
        <div><h3>Confirmed Takeaways</h3>{props.knowledge.confirmedTakeaways.length === 0 && <p className="empty">尚无 confirmed Takeaway。</p>}
          {props.knowledge.confirmedTakeaways.map((takeaway) => <article className="takeaway" key={takeaway.id}><span className="eyebrow">CONFIRMED · R{takeaway.revision}</span>
            <p>{takeaway.claim}</p><a href={paperHref(workspace.paper.id, { mode: "discussion", conversationId: takeaway.source.conversationId,
              pdfOpen: false, page: 1, anchor: null })} onClick={(event) => { event.preventDefault(); props.onNavigate(paperHref(workspace.paper.id,
                { mode: "discussion", conversationId: takeaway.source.conversationId, pdfOpen: false, page: 1, anchor: null })); }}>查看来源 Conversation →</a></article>)}</div></div>
    </section>}
    {panelKind === "source" && <aside className="pdf-pane workbench-source">
        <div className="pdf-toolbar"><span>PDF · p. {route.page}</span>
          <a href={pdfSrc} target="_blank" rel="noreferrer">新窗口打开原文</a></div>
        <iframe key={pdfSrc} title="原始 PDF" src={pdfSrc} data-viewer-engine="native" /></aside>}
        </div>
      </section>
    </div>
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
