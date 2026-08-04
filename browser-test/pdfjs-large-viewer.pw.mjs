import { writeFile } from "node:fs/promises";
import { expect, test } from "playwright/test";

const paperId = "paper:fixture:2024:fixture-paper";
let pdfByteSize = 0;

test.beforeAll(async ({ request }) => {
  const submitted = await request.post("/api/imports", {
    data: { arxivUrl: "https://arxiv.org/abs/2401.12345v2" },
  });
  expect(submitted.status()).toBe(202);
  const importRequestId = (await submitted.json()).importRequest.id;

  await expect.poll(async () => {
    const response = await request.get(`/api/imports/${encodeURIComponent(importRequestId)}`);
    return (await response.json()).jobs.at(-1)?.state;
  }, { timeout: 45_000 }).toBe("succeeded");

  const workspace = await request.get(`/api/papers/${encodeURIComponent(paperId)}`);
  const pdfUrl = (await workspace.json()).pdf.url;
  const head = await request.head(pdfUrl);
  pdfByteSize = Number(head.headers()["content-length"]);
  expect(pdfByteSize).toBeGreaterThan(12 * 1024 * 1024);
});

test("large PDF records first-render, transport, CPU, and heap gates", async ({ page }, testInfo) => {
  const pdfRequests = [];
  const pdfResponses = [];
  page.on("request", (request) => {
    if (/\/api\/artifacts\/[0-9a-f]{64}\/pdf/.test(request.url())) {
      pdfRequests.push({ range: request.headers().range ?? null });
    }
  });
  page.on("response", (response) => {
    if (/\/api\/artifacts\/[0-9a-f]{64}\/pdf/.test(response.url())) {
      pdfResponses.push({ status: response.status(), contentRange: response.headers()["content-range"] ?? null });
    }
  });

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const beforeMetrics = await cdp.send("Performance.getMetrics");
  const startedAt = performance.now();
  await page.goto(`/papers/${encodeURIComponent(paperId)}`);
  await expect(page.locator('[data-viewer-engine="pdfjs"] canvas[data-rendered-page="1"]')).toBeVisible();
  const firstRenderMs = performance.now() - startedAt;
  const renderObservedAt = await page.evaluate(() => performance.now());
  await expect.poll(() => pdfResponses.length).toBeGreaterThan(0);
  const afterMetrics = await cdp.send("Performance.getMetrics");
  const metric = (metrics, name) => metrics.metrics.find((item) => item.name === name)?.value ?? 0;
  const jsHeapDeltaBytes = metric(afterMetrics, "JSHeapUsedSize") - metric(beforeMetrics, "JSHeapUsedSize");
  const taskDurationSeconds = metric(afterMetrics, "TaskDuration") - metric(beforeMetrics, "TaskDuration");
  const resources = await page.evaluate(() => performance.getEntriesByType("resource")
    .filter((entry) => /\/api\/artifacts\/.+\/pdf/.test(entry.name))
    .map((entry) => ({ durationMs: entry.duration, responseEnd: entry.responseEnd,
      transferSize: entry.transferSize, decodedBodySize: entry.decodedBodySize })));
  const fullResponseCompletedBeforeRenderObservation = resources.some((resource) =>
    resource.decodedBodySize >= pdfByteSize && resource.responseEnd <= renderObservedAt);

  expect(firstRenderMs).toBeLessThanOrEqual(1_500);
  expect(pdfRequests.length).toBeLessThanOrEqual(4);
  expect(pdfRequests.some((request) => request.range)).toBe(true);
  expect(pdfResponses.some((response) => response.status === 200)).toBe(true);
  expect(pdfResponses.some((response) => response.status === 206 &&
    /^bytes \d+-\d+\/\d+$/.test(response.contentRange ?? ""))).toBe(true);
  expect(fullResponseCompletedBeforeRenderObservation).toBe(true);
  expect(jsHeapDeltaBytes).toBeLessThan(64 * 1024 * 1024);
  expect(taskDurationSeconds).toBeLessThan(1);
  const metrics = {
    pdfByteSize,
    firstRenderMs,
    pdfRequestCount: pdfRequests.length,
    rangeRequestCount: pdfRequests.filter((request) => request.range).length,
    pdfRequests,
    pdfResponses,
    resources,
    fullResponseCompletedBeforeRenderObservation,
    jsHeapDeltaBytes,
    taskDurationSeconds,
    caveat: "Chrome page-target metrics exclude the PDF.js worker process.",
  };
  await writeFile(testInfo.outputPath("pdfjs-large-metrics.json"), `${JSON.stringify(metrics, null, 2)}\n`, "utf8");
  await page.screenshot({ path: testInfo.outputPath("pdfjs-large-a4-first-render.png") });
});
