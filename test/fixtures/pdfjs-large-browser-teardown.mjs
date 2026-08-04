import { cleanupPdfBrowserFixture } from "./pdf-browser-teardown.mjs";

export default function teardownLargePdfJsBrowserFixture() {
  cleanupPdfBrowserFixture(3016);
}
