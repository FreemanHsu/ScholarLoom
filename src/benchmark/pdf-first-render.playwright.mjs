async (page) => {
  const pdfResources = () => page.evaluate(() => performance.getEntriesByType("resource")
    .filter((entry) => /\/api\/artifacts\/.+\/pdf/.test(entry.name))
    .map((entry) => ({ responseEnd: entry.responseEnd, transferSize: entry.transferSize,
      decodedBodySize: entry.decodedBodySize })));
  const metrics = (result) => Object.fromEntries(result.metrics.map((metric) => [metric.name, metric.value]));
  const metricDelta = (before, after, name) => (after[name] ?? 0) - (before[name] ?? 0);
  const origin = page.url().match(/^https?:\/\/[^/]+/)?.[0];
  if (!origin) throw new Error("benchmark origin is unavailable");
  const papersResponse = await page.request.get(`${origin}/api/papers`);
  const papers = (await papersResponse.json()).papers;
  if (papers.length !== 1) throw new Error("benchmark server must contain exactly one Paper");
  const paperId = papers[0].id;
  const workspaceResponse = await page.request.get(`${origin}/api/papers/${encodeURIComponent(paperId)}`);
  const workspace = await workspaceResponse.json();
  const pdfPath = workspace.pdf.url;
  const head = await page.request.head(`${origin}${pdfPath}`);
  const pdfByteSize = Number(head.headers()["content-length"]);
  const requests = [];
  const responses = [];
  let phase = "first-page";
  page.on("request", (request) => {
    if (request.url().includes(pdfPath)) requests.push({ phase, range: request.headers().range ?? null });
  });
  page.on("response", (response) => {
    if (response.url().includes(pdfPath)) {
      responses.push({ phase, status: response.status(), contentRange: response.headers()["content-range"] ?? null });
    }
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Performance.enable");
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 40,
    downloadThroughput: 2 * 1024 * 1024,
    uploadThroughput: 2 * 1024 * 1024,
    connectionType: "wifi",
  });
  const performanceBefore = metrics(await cdp.send("Performance.getMetrics"));
  const startedAt = Date.now();
  await page.goto(`${origin}/papers/${encodeURIComponent(paperId)}`);
  await page.locator('[data-viewer-engine="pdfjs"] canvas[data-rendered-page="1"]')
    .waitFor({ state: "visible", timeout: 10_000 });
  const firstRenderMs = Date.now() - startedAt;
  const performanceAfterFirst = metrics(await cdp.send("Performance.getMetrics"));
  const resourcesAfterFirst = await pdfResources();
  phase = "evidence-page";
  const jumpStartedAt = Date.now();
  await page.locator(".summary-claims-section .claim").first().click();
  await page.locator('[data-viewer-engine="pdfjs"] canvas[data-rendered-page="2"]')
    .waitFor({ state: "visible", timeout: 10_000 });
  const evidencePageRenderMs = Date.now() - jumpStartedAt;
  const performanceAfterEvidence = metrics(await cdp.send("Performance.getMetrics"));
  const resourcesAfterEvidence = await pdfResources();
  const requestPolicy = await page.locator('[data-viewer-engine="pdfjs"]')
    .getAttribute("data-request-policy");
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
  });
  return {
    paperId,
    pdfByteSize,
    requestPolicy,
    firstRenderMs,
    evidencePageRenderMs,
    requests,
    responses,
    resourcesAfterFirst,
    resourcesAfterEvidence,
    completedResponseBodyBytesBeforeFirstRender:
      resourcesAfterFirst.reduce((total, resource) => total + resource.decodedBodySize, 0),
    completedResponseBodyBytesBeforeEvidenceRender:
      resourcesAfterEvidence.reduce((total, resource) => total + resource.decodedBodySize, 0),
    fullResponseCompletedBeforeFirstRender:
      resourcesAfterFirst.some((resource) => resource.decodedBodySize >= pdfByteSize),
    fullResponseCompletedBeforeEvidenceRender:
      resourcesAfterEvidence.some((resource) => resource.decodedBodySize >= pdfByteSize),
    taskDurationMsToFirstRender: metricDelta(performanceBefore, performanceAfterFirst, "TaskDuration") * 1000,
    taskDurationMsToEvidenceRender:
      metricDelta(performanceAfterFirst, performanceAfterEvidence, "TaskDuration") * 1000,
    jsHeapUsedDeltaBytesToFirstRender:
      metricDelta(performanceBefore, performanceAfterFirst, "JSHeapUsedSize"),
    jsHeapUsedDeltaBytesToEvidenceRender:
      metricDelta(performanceAfterFirst, performanceAfterEvidence, "JSHeapUsedSize"),
  };
}
