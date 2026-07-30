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
import type { TakeawaySelectionRunner } from "./agent/takeaway-distillation.js";
import Database from "better-sqlite3";
import type { StorageLayout } from "./storage/layout.js";
import { PdfPageRenderer } from "./storage/pdf-page-renderer.js";
import { VisualEvidenceShim } from "./storage/visual-evidence-shim.js";
import { VisualEvidenceStore } from "./storage/visual-evidence-store.js";
import { MINIMUM_CODEX_VERSION } from "./agent/agent-configuration.js";

const fixture = process.env.SCHOLARLOOM_FIXTURE === "1";
const takeawayQualityReleased = process.env.SCHOLARLOOM_TAKEAWAY_V2_RELEASED === "1";
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
      citations,
      usage: { status: "reported", inputTokens: 38_400, cachedInputTokens: 12_000, outputTokens: 940, totalTokens: 39_340 } };
  },
}; }
const fixtureSelectionRunner: TakeawaySelectionRunner = {
  async select(input) {
    input.onActivity({ type: "selection", text: "正在运行 fixture Takeaway Selection" });
    if (input.material.question.includes("FACT_ONLY")) return { selection: { decision: "no-proposal",
      reasonCode: "not-durable", rationale: "这是一次局部事实查找，不具有独立的长期知识价值。" },
      usage: { status: "unavailable" } };
    if (input.material.question.includes("MULTIPLE_CLAIMS")) return { selection: { decision: "no-proposal",
      reasonCode: "multiple-claims", rationale: "回答包含多个不能合并为同一结论的候选方向。" },
      usage: { status: "unavailable" } };
    const receipt = input.material.receipts[0]!;
    return { selection: { decision: "candidate", candidate: {
      kind: input.material.question.includes("误解") ? "correction" : "mechanism",
      claim: "Fixture Paper 通过固定 Paper Version、verified Evidence Receipt 与不可变 revision 连接回答和长期知识，从而让结论在脱离原 Conversation 后仍可追溯。",
      epistemicStatus: "evidence-backed",
      evidenceRationale: `Receipt ${receipt.id} 固定了支持该结论的来源、locator 与 content hash。`,
      caveat: "该 fixture 只验证 ScholarLoom 的流程契约，不代表真实论文模型质量。",
      receiptIds: [receipt.id],
      selectionRationale: "该结论整合了方法、作用和适用边界，具有脱离当前问答后的复用价值。",
      duplicateHints: [],
    } }, usage: { status: "reported", inputTokens: 1200, outputTokens: 180, totalTokens: 1380 } };
  },
};
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
const startedAt = new Date().toISOString();

const dataRoot = process.env.SCHOLARLOOM_DATA_ROOT ?? defaultDataRoot();
if (fixture && !existsSync(join(dataRoot, DATA_MANIFEST_NAME))) initializeDataRoot(dataRoot);
const layout = openDataRoot(dataRoot);
assertDataRootWritable(layout);
const releaseRuntimeLock = acquireRuntimeLock(layout);
try {
  const fixtureRepository = fixture ? prepareFixtureRepository(layout.tmpRoot) : null;
  const productionCodex = fixture ? null : new CodexCliRunner({ runtimeRoot: layout.tmpRoot, storageLayout: layout });
  const app = await createApp({ paperSource, directPdfSource, storageLayout: layout,
    settingsRuntime: {
      host, port, startedAt, fixture, takeawayQualityReleased,
      codexRuntimeStatus: () => productionCodex?.runtimeStatus() ?? {
        installedVersion: null, minimumVersion: MINIMUM_CODEX_VERSION, versionStatus: "unavailable",
        capabilityStatus: "not-run",
        capabilityChecks: {
          structured: { status: "not-run", checkedAt: null },
          agenticEvidence: { status: "not-run", checkedAt: null },
        },
        checkedAt: startedAt,
      },
    },
    agentExecutionMetadata: (taskKind) => productionCodex?.executionMetadata(taskKind) ?? null,
    ...(fixture ? {
      repositoryAdapter: new GitRepositoryAdapter({
        "https://github.com/example/fixture": fixtureRepository!,
        "https://github.com/example/manual": fixtureRepository!,
      }),
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
          };
        },
        async runEntry(context) { return { answer: "已确认结论与 active Summary 支持可追溯阅读。",
          sourceHandles: context.sources.map((source) => source.handle), uncertainty: null }; },
      },
      agenticEvidenceRunner: fixtureAgenticRunner(layout), takeawaySelectionRunner: fixtureSelectionRunner,
    } : { repositoryAdapter: new GitRepositoryAdapter(), codexRunner: productionCodex!,
      agenticEvidenceRunner: productionCodex!,
      ...(takeawayQualityReleased ? { takeawaySelectionRunner: productionCodex! } : {}) }) });
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
