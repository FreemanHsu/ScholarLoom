import { expect, test } from "playwright/test";

const paperId = "paper:fixture:2024:fixture-paper";

async function nativeViewerState(page) {
  const frame = nativeViewerFrame(page);
  if (!frame) return null;
  return frame.evaluate(() => {
    const viewer = document.querySelector("pdf-viewer");
    const viewport = viewer?.viewport_;
    if (!viewport) return null;
    const viewportCenter = viewport.position.y +
      viewer.shadowRoot.querySelector("#scroller").getBoundingClientRect().height / 2;
    const currentPage = viewport.pageDimensions_.findIndex((page) =>
      viewportCenter >= page.y && viewportCenter < page.y + page.height) + 1;
    return { fittingType: viewport.fittingType_, zoom: viewport.internalZoom_, currentPage };
  });
}

function nativeViewerFrame(page) {
  return page.frames().find((candidate) => candidate.url().startsWith("chrome-extension://"));
}

async function expectFitToWidth(page) {
  await expect.poll(async () => (await nativeViewerState(page))?.fittingType).toBe("fit-to-width");
}

async function expectNativePage(page, expectedPage) {
  await expect.poll(async () => (await nativeViewerState(page))?.currentPage).toBe(expectedPage);
}

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

test("A4 and Letter Evidence pages remain fit-to-width as the Paper Workspace resizes", async ({ page }, testInfo) => {
  await page.goto(`/papers/${encodeURIComponent(paperId)}`);

  const pdfFrame = page.getByTitle("原始 PDF");
  await expect(pdfFrame).toHaveAttribute("src", /#page=1&view=FitH&navpanes=0$/);
  await expectFitToWidth(page);
  await expectNativePage(page, 1);
  await page.screenshot({ path: testInfo.outputPath("a4-page-1-fit-width.png") });

  const evidence = page.getByRole("button", { name: /Table 1 reports accuracy 91\.2\./ });
  await evidence.click();
  await expect(page).toHaveURL(/\?pdf=open&page=2&anchor=/);
  await expect(pdfFrame).toHaveAttribute("src", /#page=2&view=FitH&navpanes=0$/);
  await expectFitToWidth(page);
  await expectNativePage(page, 2);
  const initialLetterZoom = (await nativeViewerState(page)).zoom;
  await page.screenshot({ path: testInfo.outputPath("letter-page-2-fit-width.png") });

  const divider = page.getByRole("separator", { name: "调整 Summary 与工作区宽度" });
  for (let press = 0; press < 3; press += 1) await divider.press("ArrowRight");
  await expect(divider).toHaveAttribute("aria-valuenow", "56");
  await expectFitToWidth(page);
  await expect.poll(async () => (await nativeViewerState(page)).zoom).toBeLessThan(initialLetterZoom);
  await page.screenshot({ path: testInfo.outputPath("letter-page-2-narrow-source.png") });

  for (let press = 0; press < 9; press += 1) await divider.press("ArrowLeft");
  await expect(divider).toHaveAttribute("aria-valuenow", "38");
  await expectFitToWidth(page);
  await expect.poll(async () => (await nativeViewerState(page)).zoom).toBeGreaterThan(initialLetterZoom);
  await page.screenshot({ path: testInfo.outputPath("letter-page-2-wide-source.png") });

  await page.goBack();
  await expect(page).not.toHaveURL(/[?&]page=2(?:&|$)/);
  await expect(pdfFrame).toHaveAttribute("src", /#page=1&view=FitH&navpanes=0$/);
  await expectFitToWidth(page);
  await expectNativePage(page, 1);
});
