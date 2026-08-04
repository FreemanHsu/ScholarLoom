import { defineConfig } from "playwright/test";

export default defineConfig({
  testDir: "./browser-test",
  testMatch: "pdfjs-large-viewer.pw.mjs",
  globalTeardown: "./test/fixtures/pdfjs-large-browser-teardown.mjs",
  outputDir: "output/playwright/pdfjs-large-spike/test-results",
  reporter: "list",
  timeout: 60_000,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:3016",
    channel: "chrome",
    headless: false,
    viewport: { width: 1600, height: 1000 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "SCHOLARLOOM_PORT=3016 SCHOLARLOOM_PDF_VIEWER=pdfjs SCHOLARLOOM_FIXTURE_PDF=large node --import tsx test/fixtures/pdf-browser-server.ts",
    url: "http://127.0.0.1:3016/",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
