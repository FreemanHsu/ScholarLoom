import { existsSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

export function cleanupPdfBrowserFixture(port) {
  const fixtureMarker = join(tmpdir(), `scholarloom-pdf-browser-${port}.root`);
  if (!existsSync(fixtureMarker)) return;

  const fixtureRoot = readFileSync(fixtureMarker, "utf8");
  if (dirname(fixtureRoot) !== tmpdir() || !basename(fixtureRoot).startsWith("scholarloom-pdf-browser-")) {
    throw new Error(`Refusing to clean unexpected browser fixture root: ${fixtureRoot}`);
  }

  rmSync(fixtureRoot, { recursive: true, force: true });
  unlinkSync(fixtureMarker);
}

export default function teardownPdfBrowserFixture() {
  cleanupPdfBrowserFixture(3014);
}
