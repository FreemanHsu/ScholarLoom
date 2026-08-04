import { defineConfig } from "playwright/test";

export default defineConfig({
  testDir: "./browser-test",
  testMatch: "pdfjs-linearized-viewer.pw.mjs",
  globalTeardown: "./test/fixtures/pdfjs-linearized-browser-teardown.mjs",
  outputDir: "output/playwright/pdfjs-linearized/test-results",
  reporter: "list",
  timeout: 60_000,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:3017",
    channel: "chrome",
    headless: false,
    viewport: { width: 1600, height: 1000 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "SCHOLARLOOM_PORT=3017 SCHOLARLOOM_PDF_VIEWER=pdfjs SCHOLARLOOM_PDF_OPTIMIZATION=lossless-linearization SCHOLARLOOM_FIXTURE_PDF=large node --import tsx test/fixtures/pdf-browser-server.ts",
    url: "http://127.0.0.1:3017/",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
