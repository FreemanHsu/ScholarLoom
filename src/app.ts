import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { parsePaperImportReference } from "./domain/paper-import-reference.js";
import { DirectPdfPreparationError, type DirectPdfSource, type PreparedDirectPdfImport } from "./adapters/direct-pdf.js";
import { PaperSourceError } from "./adapters/safe-pdf-downloader.js";
import type { ImportStage } from "./domain/import-job.js";
import { ImportStore } from "./storage/import-store.js";
import { ConversationCreationConflict } from "./storage/context-snapshot-builder.js";
import type { RepositoryAdapter } from "./adapters/git-repository.js";
import type { StorageLayout } from "./storage/layout.js";
import { assertDataRootWritable } from "./storage/layout.js";
import type { AgenticEvidenceRunner } from "./agent/agentic-evidence-runner.js";
import { AgentRunCoordinator } from "./storage/agent-run-coordinator.js";
import type { TakeawaySelectionRunner } from "./agent/takeaway-distillation.js";
import { TakeawayDistillationCoordinator } from "./storage/takeaway-distillation.js";
import { buildSettingsSnapshot, type SettingsRuntime } from "./settings/settings-snapshot.js";
import type { AgentExecutionMetadataProvider } from "./agent/agent-configuration.js";
import { PaperOrganizationValidationError } from "./domain/paper-organization.js";
import { PaperOrganizationStoreError } from "./storage/paper-organization-store.js";
import type { PaperOrganizationRunner } from "./agent/paper-organization.js";
import { PaperOrganizationCoordinator } from "./storage/paper-organization-coordinator.js";
import type { PaperTaxonomyRunner } from "./agent/paper-taxonomy.js";
import { PaperTaxonomyCoordinator } from "./storage/paper-taxonomy-coordinator.js";
import { PaperOrganizationBatchCoordinator } from "./storage/paper-organization-batch-coordinator.js";
import { DirectionMergeCoordinator } from "./storage/direction-merge-coordinator.js";
import { PaperResolverError, type PaperResolverMode } from "./storage/paper-resolver.js";
import {
  PaperOrganizationAutomation,
  PaperOrganizationAutoAcceptCoordinator,
} from "./storage/paper-organization-automation.js";
import { sendPdfArtifact } from "./pdf-http-response.js";

export type ResolvedPaper = {
  arxivId: string;
  latestVersion: number;
  title: string;
  authors: string[];
  year: number;
};

export type PaperSource = {
  resolve(arxivId: string): Promise<ResolvedPaper>;
  fetchPdf?(arxivId: string, version: number): Promise<Uint8Array>;
};

export type CodexRunner = {
  runSummary(context: { paperId: string; title: string; pages: Array<{ handle: string; page: number; text: string }> }): Promise<import("./storage/import-store.js").SummaryResult>;
  runChat?(context: { paperId: string; conversationId: string; content: string;
    sources: import("./storage/import-store.js").ChatSource[]; signal?: AbortSignal }): Promise<import("./storage/import-store.js").ChatResult>;
  runEntry?(context: { question: string; sources: Array<{ handle: string; sourceType: string; sourceId: string; title: string; body: string }> }): Promise<import("./storage/import-store.js").EntryResult>;
};

export type CreateAppOptions = {
  paperSource: PaperSource;
  directPdfSource?: Pick<DirectPdfSource, "prepare"> & Partial<Pick<DirectPdfSource, "prepareDownloaded">>;
  storageLayout: StorageLayout;
  webRoot?: string;
  codexRunner?: CodexRunner;
  repositoryAdapter?: RepositoryAdapter;
  knowledgeWriteFailurePoint?: "reserved" | "staged" | "renamed" | "metadata-committed" | "indexed";
  clock?: { now(): Date };
  agentMessageTimeoutMs?: number;
  agenticEvidenceRunner?: AgenticEvidenceRunner;
  takeawaySelectionRunner?: TakeawaySelectionRunner;
  paperOrganizationRunner?: PaperOrganizationRunner;
  paperTaxonomyRunner?: PaperTaxonomyRunner;
  settingsRuntime?: SettingsRuntime;
  agentExecutionMetadata?: AgentExecutionMetadataProvider;
  entryResolverMode?: PaperResolverMode;
};

function classifyPaperResolutionError(error: unknown): { status: 404 | 503; code: string; detail: string } {
  const message = error instanceof Error ? error.message : String(error);
  if (message === "paper-source-unavailable:not-found" || message === "paper-source-unavailable:404") {
    return { status: 404, code: "paper-source-not-found", detail: "arXiv 未找到这篇论文，请检查编号是否正确。" };
  }
  const status = message.match(/^paper-source-unavailable:(\d{3})$/)?.[1];
  return {
    status: 503,
    code: "paper-source-unavailable",
    detail: status
      ? `arXiv 暂时不可用（HTTP ${status}），请稍后重试。`
      : "无法连接 arXiv，请检查网络后重试。",
  };
}

const directPdfErrorDetail: Record<string, string> = {
  "unsafe-source-url": "来源 URL 不安全或指向非公网地址。",
  "paper-source-dns-failed": "无法解析 PDF 来源域名，请检查地址或稍后重试。",
  "paper-source-timeout": "PDF 来源响应超时，请稍后重试。",
  "paper-source-http-error": "PDF 来源返回了不可用的 HTTP 状态。",
  "paper-source-transport-error": "无法通过直连或已配置的代理连接 PDF 来源。",
  "paper-source-redirect-invalid": "PDF 来源的重定向不安全、无效或次数过多。",
  "paper-source-too-large": "PDF 超过允许的最大大小。",
  "paper-source-not-pdf": "该地址没有直接返回有效 PDF。",
  "paper-source-invalid-pdf": "下载内容无法解析为有效 PDF。",
  "paper-metadata-incomplete": "PDF metadata 不完整，无法可靠创建 Paper。",
};

function classifyDirectPdfError(error: unknown): { code: string; detail: string; downloaded?: import("./adapters/safe-pdf-downloader.js").DownloadedPdf } {
  const code = error instanceof PaperSourceError ? error.code : "paper-source-http-error";
  const detail = error instanceof PaperSourceError && error.code === "paper-metadata-incomplete" && error.message !== error.code
    ? `${directPdfErrorDetail[code]}${error.message.replace(/^缺少 metadata 字段：/, " 缺少：")}`
    : directPdfErrorDetail[code] ?? "公开 PDF 导入失败。";
  return { code, detail, ...(error instanceof DirectPdfPreparationError ? { downloaded: error.downloaded } : {}) };
}

export async function createApp(options: CreateAppOptions): Promise<FastifyInstance> {
  if (options.agentMessageTimeoutMs !== undefined &&
      (!Number.isFinite(options.agentMessageTimeoutMs) || options.agentMessageTimeoutMs <= 0)) {
    throw new Error("agent-message-timeout-invalid");
  }
  const app = Fastify({ logger: false, routerOptions: { maxParamLength: 1024 } });
  const now = options.clock ? () => options.clock!.now() : undefined;
  const backgroundTasks = new Set<Promise<void>>();
  const store = ImportStore.open(options.storageLayout, options.knowledgeWriteFailurePoint ?? null, now, {
    ...(options.repositoryAdapter ? { adapter: options.repositoryAdapter } : {}),
    schedule(task) {
      backgroundTasks.add(task);
      void task.finally(() => backgroundTasks.delete(task));
    },
    ...(options.agentExecutionMetadata ? { agentExecutionMetadata: options.agentExecutionMetadata } : {}),
  });
  const distillationCoordinator = options.takeawaySelectionRunner ? new TakeawayDistillationCoordinator(options.storageLayout,
    options.takeawaySelectionRunner, { ...(options.agentMessageTimeoutMs !== undefined ? { hardTimeoutMs: options.agentMessageTimeoutMs } : {}),
      ...(options.clock ? { now: () => options.clock!.now() } : {}),
      ...(options.agentExecutionMetadata ? { agentExecutionMetadata: options.agentExecutionMetadata } : {}) }) : null;
  const agentCoordinator = options.agenticEvidenceRunner ? new AgentRunCoordinator(options.storageLayout,
    options.agenticEvidenceRunner, { ...(options.agentMessageTimeoutMs !== undefined ? { hardTimeoutMs: options.agentMessageTimeoutMs } : {}),
      ...(options.clock ? { now: () => options.clock!.now() } : {}),
      automaticDistillation: Boolean(distillationCoordinator),
      ...(options.agentExecutionMetadata ? { agentExecutionMetadata: options.agentExecutionMetadata } : {}) }) : null;
  const paperOrganizationCoordinator = options.paperOrganizationRunner
    ? new PaperOrganizationCoordinator(options.storageLayout, options.paperOrganizationRunner, store, {
      ...(options.agentMessageTimeoutMs !== undefined ? { hardTimeoutMs: options.agentMessageTimeoutMs } : {}),
      ...(options.clock ? { now: () => options.clock!.now() } : {}),
      ...(options.agentExecutionMetadata ? { agentExecutionMetadata: options.agentExecutionMetadata } : {}),
    }) : null;
  const paperTaxonomyCoordinator = options.paperTaxonomyRunner
    ? new PaperTaxonomyCoordinator(options.storageLayout, options.paperTaxonomyRunner, store,
      paperOrganizationCoordinator, {
        ...(options.agentMessageTimeoutMs !== undefined ? { hardTimeoutMs: options.agentMessageTimeoutMs } : {}),
        ...(options.clock ? { now: () => options.clock!.now() } : {}),
        ...(options.agentExecutionMetadata ? { agentExecutionMetadata: options.agentExecutionMetadata } : {}),
      }) : null;
  const paperOrganizationBatchCoordinator = new PaperOrganizationBatchCoordinator(
    options.storageLayout, store, now);
  const directionMergeCoordinator = new DirectionMergeCoordinator(options.storageLayout, store, now);
  const paperOrganizationAutoCoordinator = new PaperOrganizationAutoAcceptCoordinator(
    new PaperOrganizationAutomation(options.storageLayout, store, now),
  );
  const chatControllers = new Set<AbortController>();
  const settingsRuntime: SettingsRuntime = {
    ...(options.settingsRuntime ?? {
    host: "127.0.0.1",
    port: 3000,
    startedAt: new Date().toISOString(),
    fixture: false,
    takeawayQualityReleased: Boolean(options.takeawaySelectionRunner),
    codexRuntimeStatus: () => ({
      installedVersion: null,
      minimumVersion: "0.144.6",
      versionStatus: "unavailable",
      capabilityStatus: "not-run",
      capabilityChecks: {
        structured: { status: "not-run", checkedAt: null },
        agenticEvidence: { status: "not-run", checkedAt: null },
      },
      checkedAt: new Date().toISOString(),
    }),
    }),
    ...(options.agentMessageTimeoutMs !== undefined ? { agentMessageTimeoutMs: options.agentMessageTimeoutMs } : {}),
    entryResolverMode: options.entryResolverMode ?? "enabled",
  };
  app.addHook("onClose", async () => {
    for (const controller of chatControllers) controller.abort(new Error("application-closing"));
    await Promise.allSettled(backgroundTasks);
    await agentCoordinator?.close();
    await distillationCoordinator?.close();
    await paperTaxonomyCoordinator?.close();
    await paperOrganizationCoordinator?.close();
    paperOrganizationBatchCoordinator.close();
    directionMergeCoordinator.close();
    paperOrganizationAutoCoordinator.close();
    store.close();
  });
  const runPaperChat = (context: Parameters<NonNullable<CodexRunner["runChat"]>>[0]) => {
    const controller = new AbortController();
    chatControllers.add(controller);
    const timeoutMs = options.agentMessageTimeoutMs ?? 120_000;
    let timer: ReturnType<typeof setTimeout>;
    const interrupted = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { controller.abort(new Error("agent-timeout")); reject(new Error("agent-timeout")); }, timeoutMs);
      controller.signal.addEventListener("abort", () => reject(controller.signal.reason ?? new Error("agent-aborted")), { once: true });
    });
    return Promise.race([options.codexRunner!.runChat!({ ...context, signal: controller.signal }), interrupted])
      .finally(() => { clearTimeout(timer); chatControllers.delete(controller); });
  };

  app.get("/api/settings", async () => buildSettingsSnapshot(options.storageLayout, settingsRuntime));

  const startImport = (execution: { paper: import("./storage/import-store.js").StoredPaper; arxivId?: string; version: number;
    importRequest: { id: string }; job: { id: string }; pdfBytes?: Uint8Array }) => {
    let stage: ImportStage = "pdf-download";
    let task: Promise<void>;
    task = Promise.resolve().then(async () => {
      try {
        const versionId = execution.paper.versionId;
        let pdfBytes = store.getPdf(versionId) ?? execution.pdfBytes;
        if (!pdfBytes) {
          if (execution.paper.sourceType === "direct-pdf") throw new Error("frozen-direct-pdf-artifact-missing");
          pdfBytes = await options.paperSource.fetchPdf!(execution.arxivId!, execution.version);
        }
        await store.ingestPaper({ paper: execution.paper, pdfBytes,
          onStage(nextStage) { stage = nextStage; },
          runSummary: (context) => options.codexRunner!.runSummary(context) });
        store.finishImport(execution.job.id);
      } catch (error) { store.finishImport(execution.job.id, error, stage); }
    }).finally(() => backgroundTasks.delete(task));
    backgroundTasks.add(task);
  };

  app.post<{ Body: { reference?: unknown; arxivUrl?: unknown } }>("/api/imports", async (request, reply) => {
    const submitted = typeof request.body?.reference === "string" ? request.body.reference : request.body?.arxivUrl;
    if (typeof submitted !== "string") {
      const importRequest = store.recordFailedImport({ originalInput: String(submitted ?? ""), normalizedInput: "",
        code: "unsupported-paper-reference", detail: "请输入 arXiv 链接或公开 HTTPS PDF 直链。" });
      return reply.code(400).send({ code: "unsupported-paper-reference", importRequest });
    }

    const reference = parsePaperImportReference(submitted);
    if (!reference) {
      const importRequest = store.recordFailedImport({ originalInput: submitted, normalizedInput: "",
        code: "unsupported-paper-reference", detail: "仅支持 arXiv 链接或公开 HTTPS PDF 直链。" });
      return reply.code(400).send({ code: "unsupported-paper-reference", detail: "仅支持 arXiv 链接或公开 HTTPS PDF 直链。", importRequest });
    }
    try { assertDataRootWritable(options.storageLayout); }
    catch (error) { return reply.code(503).send({ code: "data-root-not-writable", detail: (error as Error).message }); }
    const pendingImport = store.beginImport({ originalInput: submitted,
      normalizedInput: reference.kind === "direct-pdf" ? reference.normalizedUrl : reference.arxivId, referenceKind: reference.kind });

    if (reference.kind === "direct-pdf") {
      const sourceJob = store.beginDirectSourceJob(pendingImport.id, reference.normalizedUrl);
      if (!options.directPdfSource) {
        const importRequest = store.failImport(pendingImport.id, { code: "paper-source-unavailable", detail: "公开 PDF 导入器当前不可用。", jobId: sourceJob.id });
        return reply.code(503).send({ code: "paper-source-unavailable", importRequest });
      }
      let prepared: PreparedDirectPdfImport;
      try { prepared = await options.directPdfSource.prepare(reference); }
      catch (error) {
        const { code, detail, downloaded } = classifyDirectPdfError(error);
        const importRequest = store.failImport(pendingImport.id, { code, detail, jobId: sourceJob.id, ...(downloaded ? { downloaded } : {}) });
        return reply.code(code === "unsafe-source-url" || code === "paper-source-not-pdf" || code === "paper-metadata-incomplete" ? 422 : 503)
          .send({ code, detail, importRequest, job: sourceJob });
      }
      const processing = Boolean(options.codexRunner);
      const result = store.importDirectPdf({ originalInput: submitted, prepared, processing, importRequestId: pendingImport.id, sourceJobId: sourceJob.id });
      if (processing && result.job.state === "running") startImport({ ...result, version: 1, pdfBytes: prepared.bytes });
      return reply.code(202).send({ importRequest: result.importRequest, paper: result.paper,
        ...(result.versionProposal ? { versionProposal: true } : {}) });
    }

    const frozen = reference.explicitVersion === null ? store.findFrozenArxiv(reference.arxivId) : null;
    let resolved: ResolvedPaper;
    try {
      resolved = frozen ? store.getResolvedMetadata(frozen.id)!
        : await options.paperSource.resolve(reference.arxivId);
    } catch (error) {
      const failure = classifyPaperResolutionError(error);
      const importRequest = store.failImport(pendingImport.id, { code: failure.code, detail: failure.detail });
      return reply.code(failure.status).send({ code: failure.code, detail: failure.detail, importRequest });
    }
    const version = reference.explicitVersion ?? resolved.latestVersion;
    const processing = Boolean(options.paperSource.fetchPdf && options.codexRunner);
    const { paper, importRequest, job } = store.importPaper({
      originalInput: submitted,
      resolved,
      version,
      processing,
      importRequestId: pendingImport.id,
    });
    if (processing) startImport({ paper, arxivId: reference.arxivId, version, importRequest, job });

    return reply.code(202).send({
      importRequest,
      paper: {
        ...paper,
      },
    });
  });

  app.post<{ Params: { id: string } }>("/api/jobs/:id/retry", async (request, reply) => {
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || !key) return reply.code(400).send({ code: "idempotency-key-required" });
    if (store.isPrePaperDirectImportJob(request.params.id)) {
      if (!options.directPdfSource) return reply.code(503).send({ code: "import-runner-unavailable" });
      const retry = store.retryDirectSourceJob(request.params.id, key);
      if (!retry.ok) return reply.code(retry.code === "job-not-found" ? 404 : 409).send({ code: retry.code });
      if (retry.replayed) return reply.code(202).send({ importRequest: { id: retry.importRequestId }, job: retry.job });
      const reference = parsePaperImportReference(retry.sourceIdentity);
      if (!reference || reference.kind !== "direct-pdf") return reply.code(409).send({ code: "job-not-retryable" });
      try {
        const prepared = retry.downloaded && options.directPdfSource.prepareDownloaded
          ? await options.directPdfSource.prepareDownloaded(reference, retry.downloaded)
          : await options.directPdfSource.prepare(reference);
        const result = store.importDirectPdf({ originalInput: retry.originalInput, prepared, processing: Boolean(options.codexRunner),
          importRequestId: retry.importRequestId, sourceJobId: retry.job.id });
        if (options.codexRunner && result.job.state === "running") startImport({ ...result, version: 1, pdfBytes: prepared.bytes });
        return reply.code(202).send({ importRequest: result.importRequest, paper: result.paper, job: result.job });
      } catch (error) {
        const { code, detail, downloaded } = classifyDirectPdfError(error);
        const importRequest = store.failImport(retry.importRequestId, { code, detail, jobId: retry.job.id, ...(downloaded ? { downloaded } : {}) });
        return reply.code(422).send({ code, detail, importRequest, job: retry.job });
      }
    }
    if (!options.codexRunner) return reply.code(503).send({ code: "import-runner-unavailable" });
    if (!options.paperSource.fetchPdf && !store.isDirectPdfImportJob(request.params.id)) {
      return reply.code(503).send({ code: "import-runner-unavailable" });
    }
    try { assertDataRootWritable(options.storageLayout); }
    catch (error) { return reply.code(503).send({ code: "data-root-not-writable", detail: (error as Error).message }); }
    const result = store.retryImportJob(request.params.id, key);
    if (!result.ok) return reply.code(result.code === "job-not-found" ? 404 : 409).send({ code: result.code });
    if (!result.replayed) startImport(result.execution);
    return reply.code(202).send({ importRequest: result.execution.importRequest, job: result.execution.job });
  });

  app.get<{ Querystring: {
    q?: string;
    view?: "all" | "unclassified";
    direction?: string;
    domain?: string;
    relation?: "all" | "primary";
    pending?: string;
  } }>("/api/papers", async (request, reply) => {
    try {
      return {
        papers: store.listPapers({
          ...(request.query.q ? { q: request.query.q } : {}),
          ...(request.query.view ? { view: request.query.view } : {}),
          ...(request.query.direction ? { direction: request.query.direction } : {}),
          ...(request.query.domain ? { domain: request.query.domain } : {}),
          ...(request.query.relation ? { relation: request.query.relation } : {}),
          pending: request.query.pending === "true",
        }),
      };
    } catch (error) {
      if (error instanceof PaperOrganizationStoreError) {
        return reply.code(error.status).send({ code: error.code });
      }
      throw error;
    }
  });

  app.get("/api/directions", async () => ({ directions: store.listResearchDirections() }));
  app.get("/api/domains", async () => store.researchDirectionHierarchy());

  app.post<{ Body: unknown }>("/api/domains", async (request, reply) => {
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || !key.trim()) return reply.code(400).send({ code: "idempotency-key-required" });
    try { return reply.code(201).send(store.createResearchDomain(request.body, key)); }
    catch (error) {
      if (error instanceof PaperOrganizationStoreError) return reply.code(error.status).send({ code: error.code });
      throw error;
    }
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/domains/:id/rename", async (request, reply) => {
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || !key.trim()) return reply.code(400).send({ code: "idempotency-key-required" });
    try { return store.renameResearchDomain(request.params.id, request.body, key); }
    catch (error) {
      if (error instanceof PaperOrganizationStoreError) return reply.code(error.status).send({ code: error.code });
      throw error;
    }
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/directions/:id/domain", async (request, reply) => {
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || !key.trim()) return reply.code(400).send({ code: "idempotency-key-required" });
    try { return store.setResearchDirectionDomain(request.params.id, request.body, key); }
    catch (error) {
      if (error instanceof PaperOrganizationStoreError) return reply.code(error.status).send({ code: error.code });
      throw error;
    }
  });

  for (const enabled of [true, false]) app.post(`/api/taxonomy-hierarchy/${enabled ? "enable" : "disable"}`,
    async (request, reply) => {
      const key = request.headers["idempotency-key"];
      if (typeof key !== "string" || !key.trim()) return reply.code(400).send({ code: "idempotency-key-required" });
      try { return store.setTaxonomyHierarchyEnabled(enabled, key); }
      catch (error) {
        if (error instanceof PaperOrganizationStoreError) return reply.code(error.status).send({ code: error.code });
        throw error;
      }
    });

  app.get<{ Params: { id: string } }>("/api/directions/:id/resolve", async (request, reply) => {
    try {
      return store.resolveResearchDirection(request.params.id);
    } catch (error) {
      if (error instanceof PaperOrganizationStoreError) {
        return reply.code(error.status).send({ code: error.code });
      }
      throw error;
    }
  });

  app.post<{ Body: unknown }>("/api/directions", async (request, reply) => {
    const idempotencyKey = request.headers["idempotency-key"];
    if (typeof idempotencyKey !== "string" || !idempotencyKey.trim()) {
      return reply.code(400).send({ code: "idempotency-key-required" });
    }
    try {
      return reply.code(201).send(store.createResearchDirection(request.body, idempotencyKey));
    } catch (error) {
      if (error instanceof PaperOrganizationStoreError) {
        return reply.code(error.status).send({ code: error.code });
      }
      throw error;
    }
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/directions/:id/rename/preview",
    async (request, reply) => {
      const direction = store.listResearchDirections().find((candidate) => candidate.id === request.params.id);
      if (!direction) return reply.code(404).send({ code: "direction-not-found" });
      return { current: direction, proposed: request.body };
    });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/directions/:id/rename",
    async (request, reply) => {
      const idempotencyKey = request.headers["idempotency-key"];
      if (typeof idempotencyKey !== "string" || !idempotencyKey.trim()) {
        return reply.code(400).send({ code: "idempotency-key-required" });
      }
      try {
        return store.renameResearchDirection(request.params.id, request.body, idempotencyKey);
      } catch (error) {
        if (error instanceof PaperOrganizationStoreError) {
          return reply.code(error.status).send({ code: error.code });
        }
        throw error;
      }
    });

  app.get<{ Params: { id: string } }>("/api/directions/:id/knowledge", async (request, reply) => {
    try {
      return store.getTopicKnowledge(request.params.id);
    } catch (error) {
      if (error instanceof PaperOrganizationStoreError) return reply.code(error.status).send({ code: error.code });
      throw error;
    }
  });

  app.get<{ Params: { id: string } }>("/api/directions/:id/knowledge/provenance-options",
    async (request, reply) => {
      try {
        return { sources: store.listTopicKnowledgeProvenanceOptions(request.params.id) };
      } catch (error) {
        if (error instanceof PaperOrganizationStoreError) return reply.code(error.status).send({ code: error.code });
        throw error;
      }
    });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/directions/:id/knowledge/preview",
    async (request, reply) => {
      try {
        return store.previewTopicKnowledge(request.params.id, request.body);
      } catch (error) {
        if (error instanceof PaperOrganizationStoreError) return reply.code(error.status).send({ code: error.code });
        throw error;
      }
    });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/directions/:id/knowledge/revisions",
    async (request, reply) => {
      const idempotencyKey = request.headers["idempotency-key"];
      if (typeof idempotencyKey !== "string" || !idempotencyKey.trim()) {
        return reply.code(400).send({ code: "idempotency-key-required" });
      }
      try {
        return reply.code(201).send(store.commitTopicKnowledge(request.params.id, request.body, idempotencyKey));
      } catch (error) {
        if (error instanceof PaperOrganizationStoreError) return reply.code(error.status).send({ code: error.code });
        throw error;
      }
    });

  app.post<{ Params: { id: string }; Body: { targetTopicId?: unknown } }>(
    "/api/directions/:id/merge/preview",
    async (request, reply) => {
      if (typeof request.body?.targetTopicId !== "string") {
        return reply.code(400).send({ code: "direction-merge-invalid" });
      }
      try {
        return store.directionMergePreview(request.params.id, request.body.targetTopicId);
      } catch (error) {
        if (error instanceof PaperOrganizationStoreError) {
          return reply.code(error.status).send({ code: error.code });
        }
        throw error;
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { targetTopicId?: unknown } }>(
    "/api/directions/:id/merge",
    async (request, reply) => {
      const idempotencyKey = request.headers["idempotency-key"];
      if (typeof idempotencyKey !== "string" || !idempotencyKey.trim()) {
        return reply.code(400).send({ code: "idempotency-key-required" });
      }
      if (typeof request.body?.targetTopicId !== "string") {
        return reply.code(400).send({ code: "direction-merge-invalid" });
      }
      try {
        const result = store.reserveDirectionMerge(
          request.params.id, request.body.targetTopicId, idempotencyKey);
        directionMergeCoordinator.wake();
        return reply.code(202).send(result);
      } catch (error) {
        if (error instanceof PaperOrganizationStoreError) {
          return reply.code(error.status).send({ code: error.code });
        }
        throw error;
      }
    },
  );

  app.get<{ Params: { id: string } }>("/api/direction-merges/:id", async (request, reply) => {
    try {
      return store.readDirectionMerge(request.params.id);
    } catch (error) {
      if (error instanceof PaperOrganizationStoreError) {
        return reply.code(error.status).send({ code: error.code });
      }
      throw error;
    }
  });

  app.post<{ Params: { id: string } }>("/api/direction-merges/:id/retry", async (request, reply) => {
    const idempotencyKey = request.headers["idempotency-key"];
    if (typeof idempotencyKey !== "string" || !idempotencyKey.trim()) {
      return reply.code(400).send({ code: "idempotency-key-required" });
    }
    try {
      const result = store.retryDirectionMerge(request.params.id);
      directionMergeCoordinator.wake();
      return result;
    } catch (error) {
      if (error instanceof PaperOrganizationStoreError) {
        return reply.code(error.status).send({ code: error.code });
      }
      throw error;
    }
  });

  app.put<{ Params: { id: string }; Body: unknown }>("/api/papers/:id/organization", async (request, reply) => {
    const idempotencyKey = request.headers["idempotency-key"];
    if (typeof idempotencyKey !== "string" || !idempotencyKey.trim()) {
      return reply.code(400).send({ code: "idempotency-key-required" });
    }
    try {
      return store.savePaperOrganization(request.params.id, request.body, idempotencyKey);
    } catch (error) {
      if (error instanceof PaperOrganizationStoreError) {
        return reply.code(error.status).send({ code: error.code });
      }
      if (error instanceof PaperOrganizationValidationError) {
        return reply.code(400).send({ code: error.code });
      }
      throw error;
    }
  });

  app.get<{ Params: { id: string } }>("/api/papers/:id/organization-suggestions", async (request, reply) => {
    if (!store.paperExists(request.params.id)) return reply.code(404).send({ code: "paper-not-found" });
    return {
      ...store.readOrganizationForPaper(request.params.id, true),
      availability: paperOrganizationCoordinator ? "ready" : "runner-unavailable",
    };
  });

  app.get<{ Querystring: {
    view?: string;
    section?: string;
    direction?: string;
    unclassified?: string;
    q?: string;
  } }>("/api/paper-organization/queue", async (request, reply) => {
    const view = request.query.view ?? "pending";
    if (!["pending", "attention", "all"].includes(view) ||
        (request.query.section && !["alias", "primary", "secondary"].includes(request.query.section)) ||
        (request.query.unclassified !== undefined &&
          !["true", "false"].includes(request.query.unclassified)) ||
        (request.query.q?.length ?? 0) > 500) {
      return reply.code(400).send({ code: "paper-organization-queue-query-invalid" });
    }
    try {
      return store.paperOrganizationQueue({
        view: view as "pending" | "attention" | "all",
        ...(request.query.section
          ? { section: request.query.section as "alias" | "primary" | "secondary" } : {}),
        ...(request.query.direction ? { direction: request.query.direction } : {}),
        unclassified: request.query.unclassified === "true",
        ...(request.query.q ? { q: request.query.q } : {}),
      });
    } catch (error) {
      if (error instanceof PaperOrganizationStoreError) {
        return reply.code(error.status).send({ code: error.code });
      }
      throw error;
    }
  });

  app.post<{ Body: { jobRunIds?: unknown; proposalIds?: unknown } }>(
    "/api/paper-organization/status",
    async (request, reply) => {
      if (!Array.isArray(request.body?.jobRunIds) || !Array.isArray(request.body?.proposalIds) ||
          request.body.jobRunIds.some((id) => typeof id !== "string") ||
          request.body.proposalIds.some((id) => typeof id !== "string")) {
        return reply.code(400).send({ code: "paper-organization-status-query-invalid" });
      }
      try {
        return store.paperOrganizationStatuses({
          jobRunIds: request.body.jobRunIds as string[],
          proposalIds: request.body.proposalIds as string[],
        });
      } catch (error) {
        if (error instanceof PaperOrganizationStoreError) {
          return reply.code(error.status).send({ code: error.code });
        }
        throw error;
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { scope?: unknown } }>(
    "/api/papers/:id/organization-suggestions",
    async (request, reply) => {
      const idempotencyKey = request.headers["idempotency-key"];
      if (typeof idempotencyKey !== "string" || !idempotencyKey.trim()) {
        return reply.code(400).send({ code: "idempotency-key-required" });
      }
      if (!paperOrganizationCoordinator) {
        return reply.code(503).send({ code: "paper-organization-runner-unavailable" });
      }
      const scope = request.body?.scope;
      if (!["alias", "primary", "secondary"].includes(String(scope))) {
        return reply.code(400).send({ code: "paper-organization-scope-invalid" });
      }
      try {
        return reply.code(202).send(paperOrganizationCoordinator.request(
          request.params.id,
          scope as "alias" | "primary" | "secondary",
          idempotencyKey,
        ));
      } catch (error) {
        if (error instanceof PaperOrganizationStoreError) {
          return reply.code(error.status).send({ code: error.code });
        }
        throw error;
      }
    },
  );

  app.get<{ Querystring: { mode?: string; limit?: string; priorManifestId?: string } }>(
    "/api/paper-taxonomy/bootstrap/preview",
    async (request, reply) => {
      const mode = request.query.mode ?? "next";
      const limit = Number.parseInt(request.query.limit ?? "100", 10);
      if (!["next", "regenerate", "refresh"].includes(mode)) {
        return reply.code(400).send({ code: "paper-taxonomy-mode-invalid" });
      }
      try {
        return store.paperTaxonomyPreview(mode as "next" | "regenerate" | "refresh",
          limit, request.query.priorManifestId);
      } catch (error) {
        if (error instanceof PaperOrganizationStoreError) {
          return reply.code(error.status).send({ code: error.code });
        }
        throw error;
      }
    },
  );

  app.get("/api/paper-taxonomy/bootstrap", async () => ({
    ...store.readPaperTaxonomy(),
    availability: paperTaxonomyCoordinator ? "ready" : "runner-unavailable",
  }));

  app.post<{ Body: { mode?: unknown; limit?: unknown; priorManifestId?: unknown } }>(
    "/api/paper-taxonomy/bootstrap",
    async (request, reply) => {
      const idempotencyKey = request.headers["idempotency-key"];
      if (typeof idempotencyKey !== "string" || !idempotencyKey.trim()) {
        return reply.code(400).send({ code: "idempotency-key-required" });
      }
      if (!paperTaxonomyCoordinator) {
        return reply.code(503).send({ code: "paper-taxonomy-runner-unavailable" });
      }
      const mode = String(request.body?.mode ?? "next");
      const limit = Number(request.body?.limit ?? 100);
      if (!["next", "regenerate", "refresh"].includes(mode) || !Number.isInteger(limit)) {
        return reply.code(400).send({ code: "paper-taxonomy-request-invalid" });
      }
      try {
        return reply.code(202).send(paperTaxonomyCoordinator.request({
          mode: mode as "next" | "regenerate" | "refresh",
          limit,
          ...(typeof request.body?.priorManifestId === "string"
            ? { priorManifestId: request.body.priorManifestId } : {}),
        }, idempotencyKey));
      } catch (error) {
        if (error instanceof PaperOrganizationStoreError) {
          return reply.code(error.status).send({ code: error.code });
        }
        throw error;
      }
    },
  );

  app.post<{ Params: { id: string } }>("/api/paper-taxonomy/jobs/:id/retry", async (request, reply) => {
    const idempotencyKey = request.headers["idempotency-key"];
    if (typeof idempotencyKey !== "string" || !idempotencyKey.trim()) {
      return reply.code(400).send({ code: "idempotency-key-required" });
    }
    if (!paperTaxonomyCoordinator) {
      return reply.code(503).send({ code: "paper-taxonomy-runner-unavailable" });
    }
    try {
      return reply.code(202).send(paperTaxonomyCoordinator.retry(request.params.id, idempotencyKey));
    } catch (error) {
      if (error instanceof PaperOrganizationStoreError) {
        return reply.code(error.status).send({ code: error.code });
      }
      throw error;
    }
  });

  app.post<{ Params: { id: string }; Body: { action?: unknown; value?: unknown } }>(
    "/api/direction-taxonomy/proposals/:id/decision",
    async (request, reply) => {
      const idempotencyKey = request.headers["idempotency-key"];
      if (typeof idempotencyKey !== "string" || !idempotencyKey.trim()) {
        return reply.code(400).send({ code: "idempotency-key-required" });
      }
      try {
        return store.decideDirectionTaxonomyProposal(request.params.id, request.body, idempotencyKey);
      } catch (error) {
        if (error instanceof PaperOrganizationStoreError) {
          return reply.code(error.status).send({ code: error.code });
        }
        throw error;
      }
    },
  );

  app.get("/api/paper-organization/automation", async () =>
    paperOrganizationAutoCoordinator.automation.automationModel());

  app.post("/api/paper-organization/automation/evaluate", async (_request, reply) => {
    try {
      return paperOrganizationAutoCoordinator.automation.evaluate();
    } catch (error) {
      if (error instanceof PaperOrganizationStoreError) {
        return reply.code(error.status).send({ code: error.code });
      }
      throw error;
    }
  });

  app.post<{ Body: { evaluationId?: unknown } }>(
    "/api/paper-organization/automation/policies",
    async (request, reply) => {
      if (typeof request.body?.evaluationId !== "string") {
        return reply.code(400).send({ code: "alias-automation-evaluation-required" });
      }
      try {
        return paperOrganizationAutoCoordinator.automation.createPolicy(request.body.evaluationId);
      } catch (error) {
        if (error instanceof PaperOrganizationStoreError) {
          return reply.code(error.status).send({ code: error.code });
        }
        throw error;
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/paper-organization/automation/policies/:id/enable",
    async (request, reply) => {
      try {
        const result = paperOrganizationAutoCoordinator.automation.enablePolicy(request.params.id);
        paperOrganizationAutoCoordinator.wake();
        return result;
      } catch (error) {
        if (error instanceof PaperOrganizationStoreError) {
          return reply.code(error.status).send({ code: error.code });
        }
        throw error;
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { reason?: unknown } }>(
    "/api/paper-organization/automation/policies/:id/suspend",
    async (request, reply) => {
      try {
        return paperOrganizationAutoCoordinator.automation.suspendPolicy(request.params.id,
          typeof request.body?.reason === "string" ? request.body.reason : "owner-request");
      } catch (error) {
        if (error instanceof PaperOrganizationStoreError) {
          return reply.code(error.status).send({ code: error.code });
        }
        throw error;
      }
    },
  );

  app.get<{ Querystring: { limit?: string } }>("/api/paper-organization/automation/events",
    async (request) => paperOrganizationAutoCoordinator.automation.listEvents(
      Number.parseInt(request.query.limit ?? "50", 10),
    ));

  app.post<{ Params: { id: string } }>(
    "/api/paper-organization/automation/events/:id/undo/preview",
    async (request, reply) => {
      try {
        return paperOrganizationAutoCoordinator.automation.undoPreview(request.params.id);
      } catch (error) {
        if (error instanceof PaperOrganizationStoreError) {
          return reply.code(error.status).send({ code: error.code });
        }
        throw error;
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/paper-organization/automation/events/:id/undo",
    async (request, reply) => {
      try {
        return paperOrganizationAutoCoordinator.automation.undo(request.params.id);
      } catch (error) {
        if (error instanceof PaperOrganizationStoreError) {
          return reply.code(error.status).send({ code: error.code });
        }
        throw error;
      }
    },
  );

  app.post<{ Body: { action?: unknown; proposalIds?: unknown } }>(
    "/api/paper-organization/batches/preview",
    async (request, reply) => {
      const action = String(request.body?.action ?? "");
      if (!["accept", "reject"].includes(action) || !Array.isArray(request.body?.proposalIds)) {
        return reply.code(400).send({ code: "paper-organization-batch-invalid" });
      }
      try {
        return store.paperOrganizationBatchPreview(action as "accept" | "reject",
          request.body.proposalIds as string[]);
      } catch (error) {
        if (error instanceof PaperOrganizationStoreError) {
          return reply.code(error.status).send({ code: error.code });
        }
        throw error;
      }
    },
  );

  app.post<{ Body: { action?: unknown; proposalIds?: unknown } }>(
    "/api/paper-organization/batches",
    async (request, reply) => {
      const idempotencyKey = request.headers["idempotency-key"];
      if (typeof idempotencyKey !== "string" || !idempotencyKey.trim()) {
        return reply.code(400).send({ code: "idempotency-key-required" });
      }
      const action = String(request.body?.action ?? "");
      if (!["accept", "reject"].includes(action) || !Array.isArray(request.body?.proposalIds)) {
        return reply.code(400).send({ code: "paper-organization-batch-invalid" });
      }
      try {
        const result = store.reservePaperOrganizationBatch(action as "accept" | "reject",
          request.body.proposalIds as string[], idempotencyKey);
        paperOrganizationBatchCoordinator.wake();
        return reply.code(202).send(result);
      } catch (error) {
        if (error instanceof PaperOrganizationStoreError) {
          return reply.code(error.status).send({ code: error.code });
        }
        throw error;
      }
    },
  );

  app.get<{ Params: { id: string } }>("/api/paper-organization/batches/:id",
    async (request, reply) => {
      try {
        return store.readPaperOrganizationBatch(request.params.id);
      } catch (error) {
        if (error instanceof PaperOrganizationStoreError) {
          return reply.code(error.status).send({ code: error.code });
        }
        throw error;
      }
    });

  app.post<{ Params: { id: string } }>("/api/paper-organization/batches/:id/retry",
    async (request, reply) => {
      const idempotencyKey = request.headers["idempotency-key"];
      if (typeof idempotencyKey !== "string" || !idempotencyKey.trim()) {
        return reply.code(400).send({ code: "idempotency-key-required" });
      }
      try {
        const result = store.retryPaperOrganizationBatch(request.params.id);
        paperOrganizationBatchCoordinator.wake();
        return result;
      } catch (error) {
        if (error instanceof PaperOrganizationStoreError) {
          return reply.code(error.status).send({ code: error.code });
        }
        throw error;
      }
    });

  app.post<{ Params: { id: string } }>("/api/paper-organization/batches/:id/abandon",
    async (request, reply) => {
      const idempotencyKey = request.headers["idempotency-key"];
      if (typeof idempotencyKey !== "string" || !idempotencyKey.trim()) {
        return reply.code(400).send({ code: "idempotency-key-required" });
      }
      try {
        return store.abandonPaperOrganizationBatch(request.params.id);
      } catch (error) {
        if (error instanceof PaperOrganizationStoreError) {
          return reply.code(error.status).send({ code: error.code });
        }
        throw error;
      }
    });

  app.get<{ Querystring: { limit?: string } }>("/api/paper-organization/backfill/preview",
    async (request, reply) => {
      const limit = Number.parseInt(request.query.limit ?? "50", 10);
      try {
        return store.paperOrganizationBackfillPreview(limit);
      } catch (error) {
        if (error instanceof PaperOrganizationStoreError) {
          return reply.code(error.status).send({ code: error.code });
        }
        throw error;
      }
    });

  app.post<{ Body: { limit?: unknown } }>("/api/paper-organization/backfill", async (request, reply) => {
    const idempotencyKey = request.headers["idempotency-key"];
    if (typeof idempotencyKey !== "string" || !idempotencyKey.trim()) {
      return reply.code(400).send({ code: "idempotency-key-required" });
    }
    if (!paperOrganizationCoordinator) {
      return reply.code(503).send({ code: "paper-organization-runner-unavailable" });
    }
    try {
      return reply.code(202).send(store.reservePaperOrganizationBackfill(
        Number(request.body?.limit ?? 50), idempotencyKey));
    } catch (error) {
      if (error instanceof PaperOrganizationStoreError) {
        return reply.code(error.status).send({ code: error.code });
      }
      throw error;
    }
  });

  app.get<{ Params: { id: string } }>("/api/paper-organization/backfills/:id",
    async (request, reply) => {
      try {
        return store.readPaperOrganizationBackfill(request.params.id);
      } catch (error) {
        if (error instanceof PaperOrganizationStoreError) {
          return reply.code(error.status).send({ code: error.code });
        }
        throw error;
      }
    });

  app.post<{ Params: { id: string } }>("/api/paper-organization/backfills/:id/abandon",
    async (request, reply) => {
      const idempotencyKey = request.headers["idempotency-key"];
      if (typeof idempotencyKey !== "string" || !idempotencyKey.trim()) {
        return reply.code(400).send({ code: "idempotency-key-required" });
      }
      try {
        return store.abandonPaperOrganizationBackfill(request.params.id);
      } catch (error) {
        if (error instanceof PaperOrganizationStoreError) {
          return reply.code(error.status).send({ code: error.code });
        }
        throw error;
      }
    });

  app.post<{ Params: { id: string } }>("/api/paper-organization/jobs/:id/retry", async (request, reply) => {
    const idempotencyKey = request.headers["idempotency-key"];
    if (typeof idempotencyKey !== "string" || !idempotencyKey.trim()) {
      return reply.code(400).send({ code: "idempotency-key-required" });
    }
    if (!paperOrganizationCoordinator) {
      return reply.code(503).send({ code: "paper-organization-runner-unavailable" });
    }
    try {
      return reply.code(202).send(
        paperOrganizationCoordinator.retryGeneration(request.params.id, idempotencyKey),
      );
    } catch (error) {
      if (error instanceof PaperOrganizationStoreError) {
        return reply.code(error.status).send({ code: error.code });
      }
      throw error;
    }
  });

  app.post<{ Params: { id: string }; Body: { action?: unknown; value?: unknown } }>(
    "/api/paper-organization/proposals/:id/decision",
    async (request, reply) => {
      const idempotencyKey = request.headers["idempotency-key"];
      if (typeof idempotencyKey !== "string" || !idempotencyKey.trim()) {
        return reply.code(400).send({ code: "idempotency-key-required" });
      }
      try {
        return store.decidePaperOrganizationProposal(request.params.id, request.body ?? {}, idempotencyKey);
      } catch (error) {
        if (error instanceof PaperOrganizationStoreError) {
          return reply.code(error.status).send({ code: error.code });
        }
        if (error instanceof PaperOrganizationValidationError) {
          return reply.code(400).send({ code: error.code });
        }
        throw error;
      }
    },
  );

  app.get<{ Params: { id: string } }>("/api/papers/:id/repositories", async (request, reply) => {
    if (!store.paperExists(request.params.id)) return reply.code(404).send({ code: "paper-not-found" });
    return { repositories: store.listRepositoryAssociations(request.params.id) };
  });

  app.post<{ Params: { id: string }; Body: { url?: unknown } }>("/api/papers/:id/repositories", async (request, reply) => {
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || !key) return reply.code(400).send({ code: "idempotency-key-required" });
    if (typeof request.body?.url !== "string") return reply.code(422).send({ code: "invalid-github-repository-url" });
    const result = store.addManualRepositoryAssociation(request.params.id, request.body.url, key) as
      { ok: false; code: string } | { ok: true; replayed: boolean; association: unknown };
    if (!result.ok) {
      const status = result.code === "paper-not-found" ? 404
        : result.code === "paper-not-active" || result.code === "idempotency-key-conflict" ? 409
          : result.code === "repository-runner-unavailable" ? 503 : 422;
      return reply.code(status).send({ code: result.code });
    }
    return reply.code(result.replayed ? 200 : 202).send(result);
  });

  app.post<{ Params: { id: string; associationId: string } }>(
    "/api/papers/:id/repositories/:associationId/confirm",
    async (request, reply) => {
      const key = request.headers["idempotency-key"];
      if (typeof key !== "string" || !key) return reply.code(400).send({ code: "idempotency-key-required" });
      const result = store.confirmRepositoryAssociation(request.params.id, request.params.associationId, key) as
        { ok: false; code: string } | { ok: true; replayed: boolean; association: unknown };
      if (!result.ok) {
        const status = result.code === "paper-not-found" || result.code === "repository-association-not-found" ? 404
          : result.code === "paper-not-active" || result.code === "repository-association-not-confirmable" ||
              result.code === "idempotency-key-conflict" ? 409 : 503;
        return reply.code(status).send({ code: result.code });
      }
      return reply.code(result.replayed ? 200 : 202).send(result);
    });

  app.post<{ Params: { id: string; associationId: string } }>(
    "/api/papers/:id/repositories/:associationId/retry",
    async (request, reply) => {
      const key = request.headers["idempotency-key"];
      if (typeof key !== "string" || !key) return reply.code(400).send({ code: "idempotency-key-required" });
      const result = store.retryRepositoryAssociation(request.params.id, request.params.associationId, key) as
        { ok: false; code: string } | { ok: true; replayed: boolean; association: unknown };
      if (!result.ok) {
        const status = result.code === "paper-not-found" || result.code === "repository-association-not-found" ? 404
          : result.code === "repository-runner-unavailable" ? 503 : 409;
        return reply.code(status).send({ code: result.code });
      }
      return reply.code(result.replayed ? 200 : 202).send(result);
    });

  app.post<{ Params: { id: string; associationId: string } }>(
    "/api/papers/:id/repositories/:associationId/remove",
    async (request, reply) => {
      const key = request.headers["idempotency-key"];
      if (typeof key !== "string" || !key) return reply.code(400).send({ code: "idempotency-key-required" });
      const result = store.removeRepositoryAssociation(request.params.id, request.params.associationId, key) as
        { ok: false; code: string } | { ok: true; replayed: boolean };
      if (!result.ok) {
        const status = result.code === "paper-not-found" || result.code === "repository-association-not-found" ? 404 : 409;
        return reply.code(status).send({ code: result.code });
      }
      return reply.code(200).send(result);
    });

  app.get<{ Params: { id: string } }>("/api/papers/:id", async (request, reply) => {
    const workspace = store.getPaperWorkspace(request.params.id);
    if (!workspace) return reply.code(404).send({ code: "paper-not-found" });
    const workspacePaper = (workspace as { paper: import("./storage/import-store.js").StoredPaper }).paper;
    if (workspacePaper.sourceType !== "arxiv" || !workspacePaper.arxivId) return { ...(workspace as object), updateProposal: null };
    const paper = store.findFrozenArxiv(workspacePaper.arxivId)!;
    let updateProposal: unknown = null;
    try { updateProposal = store.proposePaperUpdate(paper, (await options.paperSource.resolve(workspacePaper.arxivId)).latestVersion); }
    catch { /* Update checks never make a readable workspace unavailable. */ }
    return { ...(workspace as object), updateProposal };
  });

  app.get<{ Params: { id: string } }>("/api/paper-versions/:id/pdf", async (request, reply) => {
    const pdf = await store.getPdfArtifactForVersion(request.params.id);
    if (!pdf) return reply.code(404).send({ code: "pdf-not-found" });
    return reply.code(307).header("location", `/api/artifacts/${pdf.contentHash}/pdf`)
      .header("cache-control", "private, no-cache").send();
  });

  app.get<{ Params: { hash: string } }>("/api/artifacts/:hash/pdf", async (request, reply) => {
    if (!/^[0-9a-f]{64}$/.test(request.params.hash)) return reply.code(404).send({ code: "pdf-not-found" });
    const pdf = await store.getPdfArtifact(request.params.hash);
    if (!pdf) return reply.code(404).send({ code: "pdf-not-found" });
    return sendPdfArtifact(request, reply, pdf);
  });

  app.post<{ Params: { id: string }; Body: { continuedFromConversationId?: unknown } }>("/api/papers/:id/conversations", async (request, reply) => {
    const continuedFrom = typeof request.body?.continuedFromConversationId === "string" ? request.body.continuedFromConversationId : null;
    let conversation: unknown | null;
    try {
      conversation = store.startConversation(request.params.id, continuedFrom);
    } catch (error) {
      if (error instanceof ConversationCreationConflict) {
        return reply.code(409).send({ code: error.code, ...error.details });
      }
      throw error;
    }
    if (conversation) return reply.code(201).send(conversation);
    return store.paperExists(request.params.id)
      ? reply.code(409).send({ code: continuedFrom ? "continued-conversation-invalid" : "conversation-context-unavailable" })
      : reply.code(404).send({ code: "paper-not-found" });
  });

  app.get<{ Params: { id: string } }>("/api/papers/:id/conversations", async (request) => ({
    conversations: store.listConversations(request.params.id),
  }));

  app.post<{ Params: { id: string }; Body: { title?: unknown } }>("/api/conversations/:id/rename", async (request, reply) =>
    typeof request.body?.title === "string" && store.renameConversation(request.params.id, request.body.title)
      ? reply.code(200).send({ status: "renamed" }) : reply.code(400).send({ code: "conversation-title-invalid" }));
  app.post<{ Params: { id: string } }>("/api/conversations/:id/archive", async (request, reply) =>
    store.setConversationArchived(request.params.id, true)
      ? reply.code(200).send({ status: "archived" }) : reply.code(404).send({ code: "conversation-not-found" }));
  app.post<{ Params: { id: string } }>("/api/conversations/:id/restore", async (request, reply) =>
    store.setConversationArchived(request.params.id, false)
      ? reply.code(200).send({ status: "active" }) : reply.code(404).send({ code: "conversation-not-found" }));

  app.get<{ Params: { id: string } }>("/api/conversations/:id", async (request, reply) => {
    const conversation = store.getConversation(request.params.id);
    return conversation ? { ...(conversation as object),
      capabilities: { takeawayDistillation: Boolean(distillationCoordinator) } }
      : reply.code(404).send({ code: "conversation-not-found" });
  });

  app.get<{ Params: { id: string } }>("/api/conversations/:id/lineage", async (request, reply) => {
    const lineage = store.getConversationLineage(request.params.id);
    return lineage ?? reply.code(404).send({ code: "conversation-not-found" });
  });

  app.get<{ Params: { id: string } }>("/api/conversations/:id/continuation-preview", async (request, reply) => {
    const preview = store.previewConversationContinuation(request.params.id);
    return preview ?? reply.code(404).send({ code: "conversation-not-found" });
  });

  app.get<{ Params: { id: string } }>("/api/papers/:id/knowledge", async (request, reply) => {
    const knowledge = store.getPaperKnowledge(request.params.id);
    return knowledge ?? reply.code(404).send({ code: "paper-not-found" });
  });

  app.post<{ Params: { id: string }; Body: { content?: unknown; idempotencyKey?: unknown } }>("/api/conversations/:id/messages", async (request, reply) => {
    if (typeof request.body?.content !== "string" || !request.body.content.trim()) return reply.code(400).send({ code: "message-content-required" });
    const key = typeof request.body.idempotencyKey === "string" && request.body.idempotencyKey
      ? request.body.idempotencyKey
      : typeof request.headers["idempotency-key"] === "string" ? request.headers["idempotency-key"] : `paper-chat:${crypto.randomUUID()}`;
    if (agentCoordinator) {
      try {
        const attempt = agentCoordinator.submit(request.params.id, request.body.content, key);
        return reply.code(202).send({ attempt, conversation: store.getConversation(request.params.id) });
      } catch (error) {
        const code = error instanceof Error ? error.message : "agent-submit-failed";
        return reply.code(code === "conversation-not-found" ? 404 : 409).send({ code });
      }
    }
    if (!options.codexRunner?.runChat) return reply.code(503).send({ code: "codex-runner-unavailable" });
    const blocked = store.conversationTurnBlock(request.params.id, key);
    if (blocked) return reply.code(blocked === "conversation-not-found" ? 404 : 409).send({ code: blocked });
    let task: Promise<void>;
    task = store.sendMessage(request.params.id, request.body.content, key, runPaperChat)
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => backgroundTasks.delete(task));
    backgroundTasks.add(task);
    return reply.code(202).send({ conversation: store.getConversation(request.params.id) });
  });

  app.get<{ Params: { id: string } }>("/api/evidence/:id", async (request, reply) => {
    const evidence = agentCoordinator?.readReceipt(request.params.id);
    return evidence ?? reply.code(404).send({ code: "evidence-receipt-not-found" });
  });
  app.get<{ Params: { id: string } }>("/api/evidence/:id/image", async (request, reply) => {
    const result = await agentCoordinator?.readReceiptImage(request.params.id);
    if (!result) return reply.code(404).send({ code: "visual-evidence-not-found" });
    if (result.status !== "verified") return reply.code(409).send({ code: result.status });
    return reply.type("image/png").header("Cache-Control", "private, no-store").send(result.imageBytes);
  });

  app.post<{ Params: { id: string } }>("/api/messages/:id/retry", async (request, reply) => {
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || !key) return reply.code(400).send({ code: "idempotency-key-required" });
    if (agentCoordinator?.ownsMessage(request.params.id)) {
      try { return reply.code(202).send({ attempt: agentCoordinator.retry(request.params.id, key) }); }
      catch (error) {
        const code = error instanceof Error ? error.message : "message-retry-failed";
        return reply.code(code === "message-not-found" ? 404 : 409).send({ code });
      }
    }
    if (!options.codexRunner?.runChat) return reply.code(503).send({ code: "codex-runner-unavailable" });
    const conversationId = store.getMessageConversationId(request.params.id);
    if (!conversationId) return reply.code(404).send({ code: "message-not-found" });
    const blocked = store.messageRetryBlock(request.params.id, key);
    if (blocked) return reply.code(blocked === "message-not-found" ? 404 : 409).send({ code: blocked });
    let task: Promise<void>;
    task = store.retryMessage(request.params.id, key, runPaperChat)
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => backgroundTasks.delete(task));
    backgroundTasks.add(task);
    return reply.code(202).send({ conversation: store.getConversation(conversationId) });
  });

  app.post<{ Params: { id: string }; Body: { focus?: unknown } }>("/api/messages/:id/distill", async (request, reply) => {
    if (!distillationCoordinator) return reply.code(503).send({ code: "takeaway-distillation-unavailable" });
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || !key) return reply.code(400).send({ code: "idempotency-key-required" });
    if (request.body?.focus !== undefined && typeof request.body.focus !== "string") {
      return reply.code(400).send({ code: "distillation-focus-invalid" });
    }
    try {
      return reply.code(202).send({ distillation: distillationCoordinator.request({
        assistantMessageId: request.params.id, idempotencyKey: key, trigger: "explicit-save",
        ...(typeof request.body?.focus === "string" ? { focus: request.body.focus } : {}),
      }) });
    } catch (error) {
      const code = error instanceof Error ? error.message : "takeaway-distillation-failed";
      return reply.code(409).send({ code });
    }
  });

  app.post<{ Params: { id: string } }>("/api/distillations/:id/retry", async (request, reply) => {
    if (!distillationCoordinator) return reply.code(503).send({ code: "takeaway-distillation-unavailable" });
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || !key) return reply.code(400).send({ code: "idempotency-key-required" });
    try { return reply.code(202).send({ distillation: distillationCoordinator.retry(request.params.id, key) }); }
    catch (error) {
      const code = error instanceof Error ? error.message : "takeaway-distillation-retry-failed";
      return reply.code(409).send({ code });
    }
  });

  app.post<{ Params: { id: string } }>("/api/agent-runs/:id/cancel", async (request, reply) =>
    agentCoordinator?.cancel(request.params.id)
      ? reply.code(202).send({ status: "canceled" })
      : reply.code(409).send({ code: "agent-run-not-cancelable" }));

  app.post<{ Params: { id: string }; Body: { action?: unknown; edited?: unknown; editedClaim?: unknown;
    evidenceReviewed?: unknown; duplicateAcknowledged?: unknown; rejectReason?: unknown } }>("/api/proposals/:id/decisions", async (request, reply) => {
    if (request.body?.action !== "accept" && request.body?.action !== "edit-and-accept" && request.body?.action !== "reject") {
      return reply.code(400).send({ code: "decision-action-invalid" });
    }
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || !key) return reply.code(400).send({ code: "idempotency-key-required" });
    if (!options.codexRunner && store.isDirectVersionProposal(request.params.id)) {
      return reply.code(503).send({ code: "import-runner-unavailable" });
    }
    const compatibilityEdited = typeof request.body.editedClaim === "string" ? { claim: request.body.editedClaim } : undefined;
    const reviewInput: import("./storage/import-store.js").TakeawayReviewInput = {};
    if (request.body.edited && typeof request.body.edited === "object") {
      reviewInput.edited = request.body.edited as NonNullable<import("./storage/import-store.js").TakeawayReviewInput["edited"]>;
    } else if (compatibilityEdited) reviewInput.edited = compatibilityEdited;
    if (request.body.evidenceReviewed === true) reviewInput.evidenceReviewed = true;
    if (request.body.duplicateAcknowledged === true) reviewInput.duplicateAcknowledged = true;
    if (typeof request.body.rejectReason === "string") {
      reviewInput.rejectReason = request.body.rejectReason as NonNullable<import("./storage/import-store.js").TakeawayReviewInput["rejectReason"]>;
    }
    const result = store.decideProposal(request.params.id, key, request.body.action, reviewInput);
    if (result.execution) {
      startImport(result.execution);
    }
    return reply.code(result.status).send(result.body);
  });
  app.post<{ Params: { id: string } }>("/api/proposals/:id/open-source", async (request, reply) => {
    const source = store.issueProposalSourceOpen(request.params.id);
    return source ? reply.code(201).send(source) : reply.code(404).send({ code: "proposal-source-not-found" });
  });

  app.post<{ Body: { question?: unknown; resolutionMode?: unknown; resolutionSelection?: unknown } }>(
    "/api/entry-agent/questions", async (request, reply) => {
    if (typeof request.body?.question !== "string" || !request.body.question.trim()) return reply.code(400).send({ code: "question-required" });
    if (!options.codexRunner?.runEntry) return reply.code(503).send({ code: "codex-runner-unavailable" });
    if (request.body.resolutionMode !== undefined && !["auto", "off"].includes(String(request.body.resolutionMode))) {
      return reply.code(400).send({ code: "entry-resolution-mode-invalid" });
    }
    let resolutionSelection: import("./storage/import-store.js").EntryResolutionRequest["resolutionSelection"];
    if (request.body.resolutionSelection !== undefined) {
      const value = request.body.resolutionSelection as { snapshotHash?: unknown; groups?: unknown };
      if (!value || typeof value !== "object" || typeof value.snapshotHash !== "string" ||
          !value.groups || typeof value.groups !== "object" || Array.isArray(value.groups) ||
          Object.values(value.groups).some((paperId) => typeof paperId !== "string")) {
        return reply.code(400).send({ code: "entry-paper-resolution-invalid" });
      }
      resolutionSelection = { snapshotHash: value.snapshotHash,
        groups: value.groups as Record<string, string> };
    }
    try {
      return await store.answerEntry(request.body.question,
        (context) => options.codexRunner!.runEntry!(context), {
          mode: options.entryResolverMode ?? "enabled",
          ...(request.body.resolutionMode ? {
            resolutionMode: request.body.resolutionMode as "auto" | "off",
          } : {}),
          ...(resolutionSelection ? { resolutionSelection } : {}),
        });
    } catch (error) {
      if (error instanceof PaperResolverError) return reply.code(409).send({ code: error.code });
      throw error;
    }
  });
  app.post<{ Params: { sourceType: "summary" | "takeaway" | "topic-knowledge"; sourceId: string } }>(
    "/api/entry-agent/sources/:sourceType/:sourceId/open", async (request, reply) =>
      store.recordEntrySourceOpen(request.params.sourceType, request.params.sourceId)
        ? reply.code(201).send({ recorded: true }) : reply.code(404).send({ code: "entry-source-not-found" }));

  app.get("/api/proposals", async () => ({ proposals: store.listProposals() }));
  app.post<{ Params: { id: string } }>("/api/proposals/:id/reopen", async (request, reply) =>
    store.reopenProposal(request.params.id) ? reply.code(200).send({ status: "pending" }) : reply.code(409).send({ code: "proposal-not-archived" }));
  app.get("/api/diagnostics", async () => store.diagnostics());
  app.get("/api/metrics/takeaway-distillation", async () =>
    distillationCoordinator?.metrics() ?? { outcomes: [], review: [], timing: null });
  app.post("/api/diagnostics/rebuild-curated", async () => store.rebuildCuratedProjection());
  app.post("/api/diagnostics/rebuild-paper-catalog", async () => store.rebuildPaperCatalog());

  app.get<{ Params: { id: string } }>("/api/imports/:id", async (request, reply) => {
    const status = store.getImport(request.params.id);
    return status ? status : reply.code(404).send({ code: "import-not-found" });
  });

  app.get<{ Querystring: { scope?: string; once?: string } }>("/api/events", async (request, reply) => {
    if (!request.query.scope) return reply.code(400).send({ code: "scope-required" });
    const rawLastId = request.headers["last-event-id"] ?? "0";
    let afterId = Number.parseInt(Array.isArray(rawLastId) ? rawLastId[0] ?? "0" : rawLastId, 10) || 0;
    const format = () => store.listEvents(request.query.scope!, afterId).map((event) => {
      afterId = event.id;
      return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
    }).join("");
    reply.header("content-type", "text/event-stream; charset=utf-8");
    reply.header("cache-control", "no-cache");
    if (request.query.once === "1") return reply.send(format());
    reply.hijack();
    reply.raw.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" });
    reply.raw.write(format());
    const replay = setInterval(() => { const events = format(); if (events) reply.raw.write(events); }, 250);
    const heartbeat = setInterval(() => reply.raw.write(": heartbeat\n\n"), 20_000);
    request.raw.on("close", () => { clearInterval(replay); clearInterval(heartbeat); });
  });

  const webRoot = options.webRoot ?? resolve(process.cwd(), "dist/web");
  if (existsSync(webRoot)) {
    await app.register(fastifyStatic, { root: webRoot, wildcard: false });
    app.setNotFoundHandler((request, reply) => {
      if (request.method === "GET" && !request.url.startsWith("/api/")) {
        return reply.type("text/html; charset=utf-8").sendFile("index.html");
      }
      return reply.code(404).send({ code: "not-found" });
    });
  }

  return app;
}
