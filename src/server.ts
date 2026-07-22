import { createApp, type PaperSource } from "./app.js";
import { createFixturePdf, fixtureSummary, prepareFixtureRepository } from "./adapters/fixture.js";
import { GitRepositoryAdapter } from "./adapters/git-repository.js";
import { ArxivPaperSource } from "./adapters/arxiv.js";
import { DirectPdfSource } from "./adapters/direct-pdf.js";
import { CodexCliRunner } from "./adapters/codex-cli.js";
import { existsSync } from "node:fs";
import { parsePort, requireLoopbackHost } from "./runtime-config.js";
import { assertDataRootWritable, DATA_MANIFEST_NAME, defaultDataRoot, initializeDataRoot, openDataRoot } from "./storage/layout.js";
import { acquireRuntimeLock } from "./storage/runtime-lock.js";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { PaperSourceError } from "./adapters/safe-pdf-downloader.js";
import type { AgenticEvidenceRunner } from "./agent/agentic-evidence-runner.js";
import Database from "better-sqlite3";
import type { StorageLayout } from "./storage/layout.js";
import { PdfPageRenderer } from "./storage/pdf-page-renderer.js";
import { VisualEvidenceShim } from "./storage/visual-evidence-shim.js";
import { VisualEvidenceStore } from "./storage/visual-evidence-store.js";

const fixture = process.env.SCHOLARLOOM_FIXTURE === "1";
const fixtureChatFailures = new Set<string>();
function fixtureAgenticRunner(layout: StorageLayout): AgenticEvidenceRunner { return {
  async run(input) {
    input.onActivity({ type: "workspace", text: "正在检查冻结 Evidence Workspace" });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 1_200);
      input.signal.addEventListener("abort", () => { clearTimeout(timer); reject(input.signal.reason); }, { once: true });
    });
    if (input.question.includes("FAIL_CHAT_FIXTURE") && !fixtureChatFailures.has(input.question)) {
      fixtureChatFailures.add(input.question);
      throw new Error("fixture-codex-failure");
    }
    const manifest = JSON.parse(readFileSync(join(input.workspaceRoot, "MANIFEST.json"), "utf8")) as {
      sources: Array<{ kind: string; path: string; sourceId: string; revision?: string; contentHash: string; citable: boolean }>;
    };
    if (input.question.includes("VISUAL_FIXTURE")) {
      const sourceId = manifest.sources.find((source) => source.kind === "pdf")!.sourceId;
      const database = new Database(layout.databasePath);
      database.pragma("foreign_keys = ON");
      try {
        const inspected = await new VisualEvidenceShim({ attemptId: input.attemptId, runEpoch: input.runEpoch, layout, database,
          store: new VisualEvidenceStore(layout, database, new PdfPageRenderer()) }).inspectPdfPage({ sourceId, page: 2 });
        return { answer: "## 图表结论\n\n页面图表中橙色柱 B 最高。", groundingStatus: "answered",
          citations: [{ kind: "visual", sourceId, page: 2, imageHash: inspected.imageHash,
            observation: "The orange bar labelled B is the tallest bar on the rendered page." }],
          proposedTakeaways: [{ claim: "图表中橙色柱 B 最高。", receiptOrdinals: [1] }],
          usage: { status: "unavailable" } };
      } finally { database.close(); }
    }
    const candidates = ["pdf", "code", "library", "summary"].flatMap((kind) =>
      manifest.sources.filter((source) => source.kind === kind && source.citable).slice(0, 1));
    const selected = candidates.slice(0, 3);
    const citations = selected.map((source) => {
      const content = readFileSync(join(input.workspaceRoot, source.path), "utf8");
      const lines = content.split("\n");
      const line = Math.max(1, lines.findIndex((value) => value.trim() && !value.startsWith("---") && !value.includes(":")) + 1);
      const quote = lines[line - 1]?.trim() || lines.find((value) => value.trim())!.trim();
      return { kind: "text" as const, path: source.path, lineStart: line, lineEnd: line, quote };
    });
    input.onActivity({ type: "grounding", text: `已验证 ${citations.length} 条最终引用` });
    return { answer: "## 回答\n\n冻结的论文、代码与 curated library 证据支持这一结论。", groundingStatus: "answered",
      citations, proposedTakeaways: citations.length ? [{ claim: "冻结证据连接了论文结论与实现。", receiptOrdinals: [1] }] : [],
      usage: { status: "reported", inputTokens: 38_400, cachedInputTokens: 12_000, outputTokens: 940, totalTokens: 39_340 } };
  },
}; }
const paperSource: PaperSource = fixture ? {
  async resolve(arxivId) { return { arxivId, latestVersion: 2, title: "Fixture Paper", authors: ["Ada Fixture"], year: 2024 }; },
  async fetchPdf() { return createFixturePdf(); },
} : new ArxivPaperSource();
const directPdfSource = fixture ? {
  async prepare(reference: import("./domain/paper-import-reference.js").DirectPdfReference) {
    if (reference.normalizedUrl.includes("not-a-pdf")) throw new PaperSourceError("paper-source-not-pdf");
    const bytes = await createFixturePdf();
    const contentHash = createHash("sha256").update(bytes).digest("hex");
    return { reference, sourceIdentity: reference.normalizedUrl, sourceType: "direct-pdf" as const,
      sourceVersion: `sha256:${contentHash}`, canonicalUrl: reference.normalizedUrl, bytes, contentHash,
      byteSize: bytes.byteLength, mediaType: "application/pdf",
      metadata: { title: "Locate Anything Fixture", authors: ["Ada Fixture"], year: 2025 } };
  },
} : new DirectPdfSource();

const host = requireLoopbackHost(process.env.SCHOLARLOOM_HOST ?? "127.0.0.1");
const port = parsePort(process.env.SCHOLARLOOM_PORT ?? "3000");

const dataRoot = process.env.SCHOLARLOOM_DATA_ROOT ?? defaultDataRoot();
if (fixture && !existsSync(join(dataRoot, DATA_MANIFEST_NAME))) initializeDataRoot(dataRoot);
const layout = openDataRoot(dataRoot);
assertDataRootWritable(layout);
const releaseRuntimeLock = acquireRuntimeLock(layout);
try {
  const fixtureRepository = fixture ? prepareFixtureRepository(layout.tmpRoot) : null;
  const productionCodex = fixture ? null : new CodexCliRunner({ runtimeRoot: layout.tmpRoot, storageLayout: layout });
  const app = await createApp({ paperSource, directPdfSource, storageLayout: layout, ...(fixture ? {
      repositoryAdapter: new GitRepositoryAdapter({ "https://github.com/example/fixture": fixtureRepository! }),
      codexRunner: {
        async runSummary() { return fixtureSummary; },
        async runChat(context) {
          await new Promise((resolve) => setTimeout(resolve, 1_200));
          if (context.content.includes("FAIL_CHAT_FIXTURE") && !fixtureChatFailures.has(context.content)) {
            fixtureChatFailures.add(context.content);
            throw new Error("fixture-codex-failure");
          }
          const code = context.sources.find((source) => source.type === "code")!;
          const summary = context.sources.find((source) => source.type === "summary")!;
          return { answer: "## 回答\n\n- 固定 commit 中的 `README.md` 说明了证据与实现的连接。\n- PDF 与 Summary 提供论文侧证据。", citations: [
            { sourceHandle: code.handle, locator: code.locator }, { sourceHandle: "pdf-page:2", locator: "p. 2" },
            { sourceHandle: summary.handle, locator: summary.locator }],
            proposedTakeaways: [{ claim: "该论文用可追溯证据连接实验与实现。", sourceHandles: ["pdf-page:2", code.handle], quote: null }] };
        },
        async runEntry(context) { return { answer: "已确认结论与 active Summary 支持可追溯阅读。",
          sourceHandles: context.sources.map((source) => source.handle), uncertainty: null }; },
      },
      agenticEvidenceRunner: fixtureAgenticRunner(layout),
    } : { repositoryAdapter: new GitRepositoryAdapter(), codexRunner: productionCodex!, agenticEvidenceRunner: productionCodex! }) });
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await app.close();
    releaseRuntimeLock();
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  await app.listen({ host, port });
} catch (error) {
  releaseRuntimeLock();
  throw error;
}
