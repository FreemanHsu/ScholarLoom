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
import { PaperSourceError } from "./adapters/safe-pdf-downloader.js";

const fixture = process.env.SCHOLARLOOM_FIXTURE === "1";
const fixtureChatFailures = new Set<string>();
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
          return { answer: "固定 commit 中的 README 说明了证据与实现的连接。", citations: [
            { sourceHandle: code.handle, locator: code.locator }, { sourceHandle: "pdf-page:2", locator: "p. 2" },
            { sourceHandle: summary.handle, locator: summary.locator }],
            proposedTakeaways: [{ claim: "该论文用可追溯证据连接实验与实现。", sourceHandles: ["pdf-page:2", code.handle], quote: null }] };
        },
        async runEntry(context) { return { answer: "已确认结论与 active Summary 支持可追溯阅读。",
          sourceHandles: context.sources.map((source) => source.handle), uncertainty: null }; },
      },
    } : { repositoryAdapter: new GitRepositoryAdapter(), codexRunner: new CodexCliRunner() }) });
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
