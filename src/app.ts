import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { parsePaperImportReference } from "./domain/paper-import-reference.js";
import { DirectPdfPreparationError, type DirectPdfSource, type PreparedDirectPdfImport } from "./adapters/direct-pdf.js";
import { PaperSourceError } from "./adapters/safe-pdf-downloader.js";
import type { ImportStage } from "./domain/import-job.js";
import { ImportStore } from "./storage/import-store.js";
import type { RepositoryAdapter } from "./adapters/git-repository.js";
import type { StorageLayout } from "./storage/layout.js";
import { assertDataRootWritable } from "./storage/layout.js";

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
  knowledgeWriteFailurePoint?: "staged" | "renamed" | "metadata-committed";
  clock?: { now(): Date };
  agentMessageTimeoutMs?: number;
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
  const app = Fastify({ logger: false, routerOptions: { maxParamLength: 1024 } });
  const now = options.clock ? () => options.clock!.now() : undefined;
  const store = ImportStore.open(options.storageLayout, options.knowledgeWriteFailurePoint ?? null, now);
  const backgroundTasks = new Set<Promise<void>>();
  const chatControllers = new Set<AbortController>();
  app.addHook("onClose", async () => {
    for (const controller of chatControllers) controller.abort(new Error("application-closing"));
    await Promise.allSettled(backgroundTasks);
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
          runSummary: (context) => options.codexRunner!.runSummary(context),
          ...(options.repositoryAdapter ? { repositoryAdapter: options.repositoryAdapter } : {}) });
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

  app.get("/api/papers", async () => ({ papers: store.listPapers() }));

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

  app.get<{ Params: { id: string }; Querystring: { openToken?: string } }>("/api/paper-versions/:id/pdf", async (request, reply) => {
    const pdf = store.getPdf(request.params.id);
    if (!pdf) return reply.code(404).send({ code: "pdf-not-found" });
    if (request.query.openToken) store.consumeSourceOpenToken(request.params.id, request.query.openToken);
    return reply.type("application/pdf").send(Buffer.from(pdf));
  });

  app.post<{ Params: { id: string }; Body: { continuedFromConversationId?: unknown } }>("/api/papers/:id/conversations", async (request, reply) => {
    const continuedFrom = typeof request.body?.continuedFromConversationId === "string" ? request.body.continuedFromConversationId : null;
    const conversation = store.startConversation(request.params.id, continuedFrom);
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
    return conversation ?? reply.code(404).send({ code: "conversation-not-found" });
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

  app.post<{ Params: { id: string } }>("/api/messages/:id/retry", async (request, reply) => {
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || !key) return reply.code(400).send({ code: "idempotency-key-required" });
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

  app.post<{ Params: { id: string }; Body: { action?: unknown; sourceOpened?: unknown; editedClaim?: unknown } }>("/api/proposals/:id/decisions", async (request, reply) => {
    if (request.body?.action !== "accept" && request.body?.action !== "edit-and-accept" && request.body?.action !== "reject") {
      return reply.code(400).send({ code: "decision-action-invalid" });
    }
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || !key) return reply.code(400).send({ code: "idempotency-key-required" });
    if (!options.codexRunner && store.isDirectVersionProposal(request.params.id)) {
      return reply.code(503).send({ code: "import-runner-unavailable" });
    }
    const result = store.decideProposal(request.params.id, key, request.body.action,
      typeof request.body.editedClaim === "string" ? request.body.editedClaim : undefined);
    if (result.execution) {
      startImport(result.execution);
    }
    return reply.code(result.status).send(result.body);
  });
  app.post<{ Params: { id: string } }>("/api/proposals/:id/open-source", async (request, reply) => {
    const source = store.issueProposalSourceOpen(request.params.id);
    return source ? reply.code(201).send(source) : reply.code(404).send({ code: "proposal-source-not-found" });
  });

  app.post<{ Body: { question?: unknown } }>("/api/entry-agent/questions", async (request, reply) => {
    if (typeof request.body?.question !== "string" || !request.body.question.trim()) return reply.code(400).send({ code: "question-required" });
    if (!options.codexRunner?.runEntry) return reply.code(503).send({ code: "codex-runner-unavailable" });
    return store.answerEntry(request.body.question, (context) => options.codexRunner!.runEntry!(context));
  });

  app.get("/api/proposals", async () => ({ proposals: store.listProposals() }));
  app.post<{ Params: { id: string } }>("/api/proposals/:id/reopen", async (request, reply) =>
    store.reopenProposal(request.params.id) ? reply.code(200).send({ status: "pending" }) : reply.code(409).send({ code: "proposal-not-archived" }));
  app.get("/api/diagnostics", async () => store.diagnostics());
  app.post("/api/diagnostics/rebuild-curated", async () => store.rebuildCuratedProjection());

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
