import { expect, test } from "playwright/test";
import { writeFile } from "node:fs/promises";

const paperId = "paper:fixture:2024:fixture-paper";

test.beforeAll(async ({ request }) => {
  const submitted = await request.post("/api/imports", {
    data: { arxivUrl: "https://arxiv.org/abs/2401.12345v2" },
  });
  expect(submitted.status()).toBe(202);
  const importRequestId = (await submitted.json()).importRequest.id;

  await expect.poll(async () => {
    const response = await request.get(`/api/imports/${encodeURIComponent(importRequestId)}`);
    return (await response.json()).jobs.at(-1)?.state;
  }, { timeout: 30_000 }).toBe("succeeded");
});

test("feature-flagged PDF.js fits the real A4 first page to the source pane", async ({ page }, testInfo) => {
  const startedAt = performance.now();
  await page.goto(`/papers/${encodeURIComponent(paperId)}`);

  const reader = page.locator('[data-viewer-engine="pdfjs"]');
  const canvas = reader.locator('canvas[data-rendered-page="1"]');
  await expect(reader).toBeVisible();
  await expect(canvas).toBeVisible();
  await expect.poll(async () => {
    const readerBox = await reader.boundingBox();
    const canvasBox = await canvas.boundingBox();
    return readerBox && canvasBox ? Math.abs(readerBox.width - 32 - canvasBox.width) : null;
  }).toBeLessThanOrEqual(2);
  const firstRenderMs = performance.now() - startedAt;
  expect(firstRenderMs).toBeLessThan(2_000);
  const resources = await page.evaluate(() => performance.getEntriesByType("resource")
    .filter((entry) => /pdf(?:\.worker)?-[^/]+\.(?:js|mjs)$|\/api\/artifacts\/.+\/pdf/.test(entry.name))
    .map((entry) => ({ name: entry.name.split("/").at(-1), durationMs: entry.duration,
      transferSize: entry.transferSize, decodedBodySize: entry.decodedBodySize })));
  await writeFile(testInfo.outputPath("pdfjs-first-render-metrics.json"),
    `${JSON.stringify({ firstRenderMs, resources }, null, 2)}\n`, "utf8");
  await page.screenshot({ path: testInfo.outputPath("pdfjs-a4-page-1-fit-width.png") });
});

test("Evidence navigation reuses one PDF.js document without exposing the previous page", async ({ page }, testInfo) => {
  let pdfRequestCount = 0;
  let rangeRequestCount = 0;
  page.on("request", (request) => {
    if (/\/api\/artifacts\/[0-9a-f]{64}\/pdf/.test(request.url())) {
      pdfRequestCount += 1;
      if (request.headers().range) rangeRequestCount += 1;
    }
  });
  await page.goto(`/papers/${encodeURIComponent(paperId)}`);

  const reader = page.locator('[data-viewer-engine="pdfjs"]');
  await expect(reader.locator('canvas[data-rendered-page="1"]')).toBeVisible();
  await reader.evaluate((element) => { element.setAttribute("data-test-instance", "stable-reader"); });
  const initialPdfRequestCount = pdfRequestCount;
  const evidence = page.getByRole("button", { name: /Table 1 reports accuracy 91\.2\./ });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const beforeMetrics = await cdp.send("Performance.getMetrics");
  const renderDurationsMs = [];

  for (let jump = 0; jump < 30; jump += 1) {
    let startedAt = performance.now();
    await evidence.click();
    await expect(page).toHaveURL(/\?pdf=open&page=2&anchor=/);
    await expect(reader.locator('canvas[data-rendered-page="1"]')).toHaveCount(0);
    await expect(reader.locator('canvas[data-rendered-page="2"]')).toBeVisible();
    await expect(reader).toHaveAttribute("data-test-instance", "stable-reader");
    renderDurationsMs.push(performance.now() - startedAt);

    startedAt = performance.now();
    await page.goBack();
    await expect(page).not.toHaveURL(/[?&]page=2(?:&|$)/);
    await expect(reader.locator('canvas[data-rendered-page="2"]')).toHaveCount(0);
    await expect(reader.locator('canvas[data-rendered-page="1"]')).toBeVisible();
    await expect(reader).toHaveAttribute("data-test-instance", "stable-reader");
    renderDurationsMs.push(performance.now() - startedAt);
  }

  expect(pdfRequestCount).toBe(initialPdfRequestCount);
  const sortedDurations = [...renderDurationsMs].sort((left, right) => left - right);
  const p95RenderMs = sortedDurations[Math.ceil(sortedDurations.length * .95) - 1];
  expect(p95RenderMs).toBeLessThan(500);
  const afterMetrics = await cdp.send("Performance.getMetrics");
  const metric = (metrics, name) => metrics.metrics.find((item) => item.name === name)?.value ?? null;
  await writeFile(testInfo.outputPath("pdfjs-evidence-metrics.json"), `${JSON.stringify({
      transitions: renderDurationsMs.length,
      p95RenderMs,
      maximumRenderMs: sortedDurations.at(-1),
      pdfRequestCount,
      rangeRequestCount,
      jsHeapUsedBytes: metric(afterMetrics, "JSHeapUsedSize"),
      taskDurationSeconds: metric(afterMetrics, "TaskDuration") - metric(beforeMetrics, "TaskDuration"),
    }, null, 2)}\n`, "utf8");
});

test("PDF.js reports loading and recalculates fit-width after pane resizes", async ({ page }, testInfo) => {
  let delayed = false;
  await page.route(/\/api\/artifacts\/[0-9a-f]{64}\/pdf/, async (route) => {
    if (!delayed) {
      delayed = true;
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
    await route.continue();
  });
  await page.goto(`/papers/${encodeURIComponent(paperId)}`);

  const reader = page.locator('[data-viewer-engine="pdfjs"]');
  await expect(reader.getByRole("status")).toContainText("正在加载原文");
  const canvas = reader.locator('canvas[data-rendered-page="1"]');
  await expect(canvas).toBeVisible();
  const initialWidth = (await canvas.boundingBox()).width;

  const divider = page.getByRole("separator", { name: "调整 Summary 与工作区宽度" });
  for (let press = 0; press < 3; press += 1) await divider.press("ArrowRight");
  await expect(divider).toHaveAttribute("aria-valuenow", "56");
  await expect.poll(async () => (await canvas.boundingBox()).width).toBeLessThan(initialWidth);
  await page.screenshot({ path: testInfo.outputPath("pdfjs-a4-narrow-source.png") });

  for (let press = 0; press < 9; press += 1) await divider.press("ArrowLeft");
  await expect(divider).toHaveAttribute("aria-valuenow", "38");
  await expect.poll(async () => (await canvas.boundingBox()).width).toBeGreaterThan(initialWidth);
  await page.screenshot({ path: testInfo.outputPath("pdfjs-a4-wide-source.png") });
});

test("PDF.js load failure falls back to the native viewer on the requested page", async ({ page }) => {
  let pdfAttempt = 0;
  await page.route(/\/api\/artifacts\/[0-9a-f]{64}\/pdf/, async (route) => {
    pdfAttempt += 1;
    if (pdfAttempt === 1) await route.abort("failed");
    else await route.continue();
  });
  await page.goto(`/papers/${encodeURIComponent(paperId)}?pdf=open&page=2&anchor=page%3A2`);

  const fallback = page.locator('[data-viewer-engine="native-fallback"]');
  await expect(fallback.getByRole("alert")).toContainText("已切换到浏览器 PDF 阅读器");
  await expect(fallback.getByTitle("原始 PDF")).toHaveAttribute("src", /#page=2&view=FitH&navpanes=0$/);
});
