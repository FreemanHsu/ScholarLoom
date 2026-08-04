async (page) => {
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
  page.on("request", (request) => {
    if (request.url().includes(pdfPath)) requests.push({ range: request.headers().range ?? null });
  });
  page.on("response", (response) => {
    if (response.url().includes(pdfPath)) {
      responses.push({ status: response.status(), contentRange: response.headers()["content-range"] ?? null });
    }
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 40,
    downloadThroughput: 2 * 1024 * 1024,
    uploadThroughput: 2 * 1024 * 1024,
    connectionType: "wifi",
  });
  const startedAt = Date.now();
  await page.goto(`${origin}/papers/${encodeURIComponent(paperId)}`);
  await page.locator('[data-viewer-engine="pdfjs"] canvas[data-rendered-page="1"]')
    .waitFor({ state: "visible", timeout: 10_000 });
  const firstRenderMs = Date.now() - startedAt;
  const resources = await page.evaluate(() => performance.getEntriesByType("resource")
    .filter((entry) => /\/api\/artifacts\/.+\/pdf/.test(entry.name))
    .map((entry) => ({ responseEnd: entry.responseEnd, transferSize: entry.transferSize,
      decodedBodySize: entry.decodedBodySize })));
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
  });
  return {
    paperId,
    pdfByteSize,
    firstRenderMs,
    requests,
    responses,
    resources,
    completedResponseBodyBytesBeforeRender:
      resources.reduce((total, resource) => total + resource.decodedBodySize, 0),
    fullResponseCompletedBeforeRender: resources.some((resource) => resource.decodedBodySize >= pdfByteSize),
  };
}
