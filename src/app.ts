import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { parseArxivReference } from "./domain/arxiv.js";
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
  runChat?(context: { paperId: string; conversationId: string; content: string; sources: Array<{ handle: string; type: "pdf" | "code"; text: string; locator: string }> }): Promise<import("./storage/import-store.js").ChatResult>;
  runEntry?(context: { question: string; sources: Array<{ handle: string; sourceType: string; sourceId: string; title: string; body: string }> }): Promise<import("./storage/import-store.js").EntryResult>;
};

export type CreateAppOptions = {
  paperSource: PaperSource;
  storageLayout: StorageLayout;
  webRoot?: string;
  codexRunner?: CodexRunner;
  repositoryAdapter?: RepositoryAdapter;
  knowledgeWriteFailurePoint?: "staged" | "renamed" | "metadata-committed";
  clock?: { now(): Date };
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

export async function createApp(options: CreateAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, routerOptions: { maxParamLength: 1024 } });
  const now = options.clock ? () => options.clock!.now() : undefined;
  const store = ImportStore.open(options.storageLayout, options.knowledgeWriteFailurePoint ?? null, now);
  const backgroundTasks = new Set<Promise<void>>();
  app.addHook("onClose", async () => { await Promise.allSettled(backgroundTasks); store.close(); });

  const startImport = (execution: { paper: import("./storage/import-store.js").StoredPaper; arxivId: string; version: number;
    importRequest: { id: string }; job: { id: string } }) => {
    let stage: ImportStage = "pdf-download";
    let task: Promise<void>;
    task = Promise.resolve().then(async () => {
      try {
        const versionId = `paper-version:${execution.paper.id}:arxiv:v${execution.version}`;
        const pdfBytes = store.getPdf(versionId) ?? await options.paperSource.fetchPdf!(execution.arxivId, execution.version);
        await store.ingestPaper({ paper: execution.paper, pdfBytes,
          onStage(nextStage) { stage = nextStage; },
          runSummary: (context) => options.codexRunner!.runSummary(context),
          ...(options.repositoryAdapter ? { repositoryAdapter: options.repositoryAdapter } : {}) });
        store.finishImport(execution.job.id);
      } catch (error) { store.finishImport(execution.job.id, error, stage); }
    }).finally(() => backgroundTasks.delete(task));
    backgroundTasks.add(task);
  };

  app.post<{ Body: { arxivUrl?: unknown } }>("/api/imports", async (request, reply) => {
    if (typeof request.body?.arxivUrl !== "string") {
      return reply.code(400).send({ code: "invalid-arxiv-reference" });
    }

    const reference = parseArxivReference(request.body.arxivUrl);
    if (!reference) {
      return reply.code(400).send({ code: "invalid-arxiv-reference" });
    }
    try { assertDataRootWritable(options.storageLayout); }
    catch (error) { return reply.code(503).send({ code: "data-root-not-writable", detail: (error as Error).message }); }

    const frozen = reference.explicitVersion === null ? store.findFrozenArxiv(reference.arxivId) : null;
    let resolved: ResolvedPaper;
    try {
      resolved = frozen ? store.getResolvedMetadata(frozen.id)!
        : await options.paperSource.resolve(reference.arxivId);
    } catch (error) {
      const failure = classifyPaperResolutionError(error);
      const importRequest = store.recordFailedImport({ originalInput: request.body.arxivUrl,
        normalizedInput: reference.arxivId, code: failure.code, detail: failure.detail });
      return reply.code(failure.status).send({ code: failure.code, detail: failure.detail, importRequest });
    }
    const version = reference.explicitVersion ?? resolved.latestVersion;
    const processing = Boolean(options.paperSource.fetchPdf && options.codexRunner);
    const { paper, importRequest, job } = store.importPaper({
      originalInput: request.body.arxivUrl,
      resolved,
      version,
      processing,
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
    if (!options.paperSource.fetchPdf || !options.codexRunner) return reply.code(503).send({ code: "import-runner-unavailable" });
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || !key) return reply.code(400).send({ code: "idempotency-key-required" });
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
    const paper = store.findFrozenArxiv((workspace as { paper: { arxivId: string } }).paper.arxivId)!;
    let updateProposal: unknown = null;
    try { updateProposal = store.proposePaperUpdate(paper, (await options.paperSource.resolve(paper.arxivId)).latestVersion); }
    catch { /* Update checks never make a readable workspace unavailable. */ }
    return { ...(workspace as object), updateProposal };
  });

  app.get<{ Params: { id: string }; Querystring: { openToken?: string } }>("/api/paper-versions/:id/pdf", async (request, reply) => {
    const pdf = store.getPdf(request.params.id);
    if (!pdf) return reply.code(404).send({ code: "pdf-not-found" });
    if (request.query.openToken) store.consumeSourceOpenToken(request.params.id, request.query.openToken);
    return reply.type("application/pdf").send(Buffer.from(pdf));
  });

  app.post<{ Params: { id: string } }>("/api/papers/:id/conversations", async (request, reply) => {
    const conversation = store.startConversation(request.params.id);
    return conversation ? reply.code(201).send(conversation) : reply.code(404).send({ code: "paper-not-found" });
  });

  app.post<{ Params: { id: string }; Body: { content?: unknown } }>("/api/conversations/:id/messages", async (request, reply) => {
    if (typeof request.body?.content !== "string" || !request.body.content.trim()) return reply.code(400).send({ code: "message-content-required" });
    if (!options.codexRunner?.runChat) return reply.code(503).send({ code: "codex-runner-unavailable" });
    const result = await store.sendMessage(request.params.id, request.body.content, (context) => options.codexRunner!.runChat!(context));
    return result ? reply.code(201).send(result) : reply.code(404).send({ code: "conversation-not-found" });
  });

  app.post<{ Params: { id: string }; Body: { action?: unknown; sourceOpened?: unknown } }>("/api/proposals/:id/decisions", async (request, reply) => {
    if (request.body?.action !== "accept") return reply.code(400).send({ code: "decision-action-invalid" });
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || !key) return reply.code(400).send({ code: "idempotency-key-required" });
    const result = store.decideProposal(request.params.id, key);
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
