import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";

import { expect, test } from "playwright/test";

const paperId = "paper:fixture:2024:fixture-paper";
const originalHash = "a167661f12ae6f251492db8a0646a4d0bb13463162ff4340a105cbbbdd9f1a4e";
const qpdfAvailable = spawnSync("qpdf", ["--version"], { stdio: "ignore" }).status === 0;
let deliveryUrl = "";
let pdfByteSize = 0;

test.beforeAll(async ({ request }) => {
  test.skip(!qpdfAvailable, "qpdf is unavailable; application fallback is covered by integration tests");
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
  deliveryUrl = (await workspace.json()).pdf.url;
  expect(deliveryUrl).not.toContain(originalHash);
  const head = await request.head(deliveryUrl);
  pdfByteSize = Number(head.headers()["content-length"]);
  expect(pdfByteSize).toBeGreaterThan(12 * 1024 * 1024);
  expect(pdfByteSize).toBeLessThanOrEqual(12_588_462 * 1.02);
});

test("linearized delivery renders before a throttled complete response", async ({ page }, testInfo) => {
  const pdfRequests = [];
  page.on("request", (request) => {
    if (request.url().includes(deliveryUrl)) pdfRequests.push({ range: request.headers().range ?? null });
  });
  await page.goto("/");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 40,
    downloadThroughput: 2 * 1024 * 1024,
    uploadThroughput: 2 * 1024 * 1024,
    connectionType: "wifi",
  });

  const startedAt = performance.now();
  await page.goto(`/papers/${encodeURIComponent(paperId)}`);
  await expect(page.locator('[data-viewer-engine="pdfjs"] canvas[data-rendered-page="1"]'))
    .toBeVisible({ timeout: 10_000 });
  const firstRenderMs = performance.now() - startedAt;
  const resourcesAtRender = await page.evaluate(() => performance.getEntriesByType("resource")
    .filter((entry) => /\/api\/artifacts\/.+\/pdf/.test(entry.name))
    .map((entry) => ({ responseEnd: entry.responseEnd, transferSize: entry.transferSize,
      decodedBodySize: entry.decodedBodySize })));
  const fullResponseCompletedBeforeRender = resourcesAtRender.some((resource) => resource.decodedBodySize >= pdfByteSize);

  expect(firstRenderMs).toBeLessThan(5_000);
  expect(fullResponseCompletedBeforeRender).toBe(false);
  expect(pdfRequests.some((request) => request.range)).toBe(true);

  await cdp.send("Network.emulateNetworkConditions", {
    offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
  });
  await page.screenshot({ path: testInfo.outputPath("pdfjs-linearized-first-render.png") });
  await writeFile(testInfo.outputPath("pdfjs-linearized-metrics.json"), `${JSON.stringify({
    pdfByteSize, firstRenderMs, pdfRequests, resourcesAtRender, fullResponseCompletedBeforeRender,
    throttledDownloadBytesPerSecond: 2 * 1024 * 1024,
  }, null, 2)}\n`, "utf8");
});
