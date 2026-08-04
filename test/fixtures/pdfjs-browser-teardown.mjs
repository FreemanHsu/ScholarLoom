import { cleanupPdfBrowserFixture } from "./pdf-browser-teardown.mjs";

export default function teardownPdfJsBrowserFixture() {
  cleanupPdfBrowserFixture(3015);
}
