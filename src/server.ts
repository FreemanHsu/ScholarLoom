import { createApp, type PaperSource } from "./app.js";
import { createFixturePdf, fixtureSummary, prepareFixtureRepository } from "./adapters/fixture.js";
import { GitRepositoryAdapter } from "./adapters/git-repository.js";
import { ArxivPaperSource } from "./adapters/arxiv.js";
import { CodexCliRunner } from "./adapters/codex-cli.js";
import { existsSync } from "node:fs";
import { parsePort, requireLoopbackHost } from "./runtime-config.js";
import { DATA_MANIFEST_NAME, defaultDataRoot, initializeDataRoot, openDataRoot } from "./storage/layout.js";
import { acquireRuntimeLock } from "./storage/runtime-lock.js";
import { join } from "node:path";

const fixture = process.env.SCHOLARLOOM_FIXTURE === "1";
const paperSource: PaperSource = fixture ? {
  async resolve(arxivId) { return { arxivId, latestVersion: 2, title: "Fixture Paper", authors: ["Ada Fixture"], year: 2024 }; },
  async fetchPdf() { return createFixturePdf(); },
} : new ArxivPaperSource();

const host = requireLoopbackHost(process.env.SCHOLARLOOM_HOST ?? "127.0.0.1");
const port = parsePort(process.env.SCHOLARLOOM_PORT ?? "3000");

const dataRoot = process.env.SCHOLARLOOM_DATA_ROOT ?? defaultDataRoot();
if (fixture && !existsSync(join(dataRoot, DATA_MANIFEST_NAME))) initializeDataRoot(dataRoot);
const layout = openDataRoot(dataRoot);
const releaseRuntimeLock = acquireRuntimeLock(layout);
try {
  const fixtureRepository = fixture ? prepareFixtureRepository(layout.tmpRoot) : null;
  const app = await createApp({ paperSource, storageLayout: layout, ...(fixture ? {
      repositoryAdapter: new GitRepositoryAdapter({ "https://github.com/example/fixture": fixtureRepository! }),
      codexRunner: {
        async runSummary() { return fixtureSummary; },
        async runChat() { return { answer: "固定 commit 中的 README 说明了证据与实现的连接。", citations: [
          { sourceHandle: "code:README.md", locator: "README.md:1-2" }, { sourceHandle: "pdf-page:2", locator: "p. 2" }],
          proposedTakeaways: [{ claim: "该论文用可追溯证据连接实验与实现。", sourceHandles: ["pdf-page:2", "code:README.md"] }] }; },
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
