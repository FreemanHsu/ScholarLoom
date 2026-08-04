import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

const port = Number.parseInt(process.env.SCHOLARLOOM_PORT ?? "3014", 10);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid PDF browser fixture port");
const fixtureMarker = join(tmpdir(), `scholarloom-pdf-browser-${port}.root`);

function removeMarkedFixture(): void {
  if (!existsSync(fixtureMarker)) return;
  const markedRoot = readFileSync(fixtureMarker, "utf8");
  if (dirname(markedRoot) !== tmpdir() || !basename(markedRoot).startsWith("scholarloom-pdf-browser-")) {
    throw new Error(`Refusing to clean unexpected browser fixture root: ${markedRoot}`);
  }
  rmSync(markedRoot, { recursive: true, force: true });
  unlinkSync(fixtureMarker);
}

removeMarkedFixture();
const fixtureRoot = mkdtempSync(join(tmpdir(), "scholarloom-pdf-browser-"));
writeFileSync(fixtureMarker, fixtureRoot, { flag: "wx" });
let cleaned = false;

function cleanup(): void {
  if (cleaned) return;
  cleaned = true;
  rmSync(fixtureRoot, { recursive: true, force: true });
  if (existsSync(fixtureMarker) && readFileSync(fixtureMarker, "utf8") === fixtureRoot) unlinkSync(fixtureMarker);
}

process.env.SCHOLARLOOM_FIXTURE = "1";
process.env.SCHOLARLOOM_DATA_ROOT = join(fixtureRoot, "data");
process.env.SCHOLARLOOM_HOST = "127.0.0.1";
process.env.SCHOLARLOOM_PORT = String(port);

process.once("exit", cleanup);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    cleanup();
    process.exit(0);
  });
}

await import("../../src/server.js");
