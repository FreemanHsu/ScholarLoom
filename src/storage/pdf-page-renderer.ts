import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type FrozenPdfSource = {
  artifactId: string;
  contentHash: string;
  bytes: Buffer;
};

export const PDF_RENDER_SETTINGS = {
  scale: 2,
  dpi: 144,
  background: "#ffffff",
  intent: "display",
  annotations: "disabled",
  systemFonts: false,
  eval: false,
  format: "image/png",
} as const;

const rendererIdentity = {
  name: "pdfjs-napi-canvas",
  version: "6.1.200+1.0.2",
  runtime: `node-${process.versions.node}`,
  platform: `${process.platform}-${process.arch}`,
  isolation: "macos-seatbelt",
  settings: PDF_RENDER_SETTINGS,
};

export const PDF_RENDERER_FINGERPRINT = createHash("sha256").update(JSON.stringify(rendererIdentity)).digest("hex");

export type PdfRenderResult = {
  imageBytes: Buffer;
  imageHash: string;
  descriptor: {
    sourceArtifactId: string;
    sourceContentHash: string;
    page: number;
    pageCount: number;
    pixelWidth: number;
    pixelHeight: number;
    rendererName: string;
    rendererVersion: string;
    rendererFingerprint: string;
    isolation: "macos-seatbelt";
    settings: typeof PDF_RENDER_SETTINGS;
  };
};

export class PdfPageRenderer {
  async render(source: FrozenPdfSource, page: number): Promise<PdfRenderResult> {
    if (createHash("sha256").update(source.bytes).digest("hex") !== source.contentHash) {
      throw new Error("renderer-source-hash-mismatch");
    }
    const childPath = fileURLToPath(new URL("./pdf-page-renderer-child.mjs", import.meta.url));
    const output = await runRendererChild(childPath, source.bytes, page);
    const imageBytes = Buffer.from(output.imageBase64, "base64");
    const imageHash = createHash("sha256").update(imageBytes).digest("hex");
    return { imageBytes, imageHash, descriptor: {
      sourceArtifactId: source.artifactId, sourceContentHash: source.contentHash, page: output.page,
      pageCount: output.pageCount, pixelWidth: output.pixelWidth, pixelHeight: output.pixelHeight,
      rendererName: rendererIdentity.name, rendererVersion: rendererIdentity.version,
      rendererFingerprint: PDF_RENDERER_FINGERPRINT, isolation: "macos-seatbelt", settings: PDF_RENDER_SETTINGS,
    } };
  }
}

type ChildOutput = { page: number; pageCount: number; pixelWidth: number; pixelHeight: number; imageBase64: string };

function runRendererChild(childPath: string, bytes: Buffer, page: number): Promise<ChildOutput> {
  return new Promise((resolve, reject) => {
    if (process.platform !== "darwin") return reject(new Error("renderer-isolation-unavailable"));
    const require = createRequire(import.meta.url);
    const nodeExecutable = realpathSync(process.execPath);
    const nodeRuntimeRoot = dirname(dirname(nodeExecutable));
    const rendererModuleRoots = [dirname(require.resolve("pdfjs-dist/package.json")),
      join(dirname(require.resolve("@napi-rs/canvas/package.json")), "..")];
    const profile = seatbeltProfile([nodeRuntimeRoot, ...rendererModuleRoots, childPath,
      ...linkedRuntimeLibraries(nodeExecutable, nodeRuntimeRoot)]);
    const child = spawn("/usr/bin/sandbox-exec", ["-p", profile, nodeExecutable,
      "--max-old-space-size=384", childPath, String(page)], {
      cwd: dirname(childPath), env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", OPENSSL_CONF: "/dev/null" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let forcedFailure: string | null = null;
    const timeout = setTimeout(() => { forcedFailure = "renderer-timeout"; child.kill("SIGKILL"); }, 20_000);
    const rssWatchdog = setInterval(() => {
      if (!child.pid) return;
      const result = spawnSync("/bin/ps", ["-o", "rss=", "-p", String(child.pid)], { encoding: "utf8", timeout: 500 });
      const rssKib = Number.parseInt(result.stdout.trim(), 10);
      if (Number.isFinite(rssKib) && rssKib > 512 * 1024) {
        forcedFailure = "renderer-memory-limit";
        child.kill("SIGKILL");
      }
    }, 250);
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > 28 * 1024 * 1024) {
        forcedFailure = "renderer-output-limit";
        child.kill("SIGKILL");
      }
      else stdout.push(chunk);
    });
    child.stderr.resume();
    child.on("error", (error) => { clearTimeout(timeout); clearInterval(rssWatchdog); reject(error); });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      clearInterval(rssWatchdog);
      if (forcedFailure) reject(new Error(forcedFailure));
      else if (code !== 0) reject(new Error(`renderer-failed:${code ?? signal ?? "unknown"}`));
      else {
        try { resolve(JSON.parse(Buffer.concat(stdout).toString("utf8")) as ChildOutput); }
        catch { reject(new Error("renderer-output-invalid")); }
      }
    });
    child.stdin.end(bytes);
  });
}

function seatbeltProfile(readPaths: string[]): string {
  const nodeExecutable = readPaths[0] ? join(readPaths[0], "bin", "node") : process.execPath;
  const allowed = [...new Set(["/System", "/usr/lib", "/private/var/db/timezone", "/dev/null", "/dev/urandom", ...readPaths,
    ...readPaths.flatMap(symlinkAncestors)])];
  const rules = allowed.map((path) => `(allow file-read* (${statSync(path).isDirectory()
    ? "subpath" : "literal"} ${JSON.stringify(path)}))`).join("\n");
  const traversalRules = [...new Set(readPaths.filter((path) => path.startsWith("/opt/homebrew/"))
    .flatMap(pathAncestors).filter((path) => path === "/opt" || path.startsWith("/opt/homebrew")))]
    .map((path) => `(allow file-read* (literal ${JSON.stringify(path)}))`).join("\n");
  const metadataRules = [...new Set(readPaths.flatMap(pathAncestors))]
    .map((path) => `(allow file-read-metadata (literal ${JSON.stringify(path)}))`).join("\n");
  return `(version 1)\n(import "system.sb")\n(deny network*)\n(deny file-write*)\n(deny file-read*)\n(allow process-exec (literal ${JSON.stringify(nodeExecutable)}))\n${metadataRules}\n${traversalRules}\n${rules}`;
}

function symlinkAncestors(path: string): string[] {
  const parts = path.split("/").filter(Boolean);
  const symlinks: string[] = [];
  let current = "";
  for (const part of parts) {
    current = `${current}/${part}`;
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) symlinks.push(current);
  }
  return symlinks;
}

function linkedRuntimeLibraries(nodeExecutable: string, nodeRuntimeRoot: string): string[] {
  const pending = [nodeExecutable];
  const visited = new Set<string>();
  const libraries = new Set<string>();
  while (pending.length > 0) {
    const binary = pending.pop()!;
    if (visited.has(binary)) continue;
    visited.add(binary);
    const output = spawnSync("/usr/bin/otool", ["-L", binary], { encoding: "utf8", timeout: 2_000 });
    if (output.status !== 0) throw new Error("renderer-runtime-inspection-failed");
    for (const line of output.stdout.split("\n").slice(1)) {
      const installName = line.trim().split(/\s+\(/, 1)[0];
      if (!installName || installName.startsWith("/System/") || installName.startsWith("/usr/lib/")) continue;
      const candidate = installName.startsWith("@rpath/")
        ? join(nodeRuntimeRoot, "lib", installName.slice("@rpath/".length))
        : installName.startsWith("@loader_path/")
          ? join(dirname(binary), installName.slice("@loader_path/".length)) : installName;
      if (!candidate.startsWith("/") || !existsSync(candidate)) continue;
      const resolved = realpathSync(candidate);
      libraries.add(dirname(candidate));
      libraries.add(candidate);
      libraries.add(dirname(resolved));
      libraries.add(resolved);
      pending.push(resolved);
    }
  }
  return [...libraries];
}

function pathAncestors(path: string): string[] {
  const ancestors: string[] = [];
  for (let current = dirname(path); current !== "/" && current !== "."; current = dirname(current)) ancestors.push(current);
  return ancestors;
}
