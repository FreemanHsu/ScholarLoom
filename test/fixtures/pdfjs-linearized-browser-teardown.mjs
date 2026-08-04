import { cleanupPdfBrowserFixture } from "./pdf-browser-teardown.mjs";

export default function teardownLinearizedPdfJsBrowserFixture() {
  cleanupPdfBrowserFixture(3017);
}
