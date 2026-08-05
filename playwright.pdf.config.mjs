import { defineConfig } from "playwright/test";

export default defineConfig({
  testDir: "./browser-test",
  testMatch: "pdf-native-viewer.pw.mjs",
  globalTeardown: "./test/fixtures/pdf-browser-teardown.mjs",
  outputDir: "output/playwright/pdf-fit-width/test-results",
  reporter: "list",
  timeout: 45_000,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:3014",
    channel: "chrome",
    headless: false,
    viewport: { width: 1600, height: 1000 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "SCHOLARLOOM_PORT=3014 node --import tsx test/fixtures/pdf-browser-server.ts",
    url: "http://127.0.0.1:3014/",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
