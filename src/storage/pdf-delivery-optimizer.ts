import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import type Database from "better-sqlite3";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

import type { StorageLayout } from "./layout.js";
import { ensureNoSymlinkDirectory, readRegularFileNoFollow } from "./safe-local-path.js";

const run = promisify(execFile);

export const LOSSLESS_LINEARIZATION_PARAMETERS = {
  maximumSizeRatio: 1.02,
  minimumSourceBytes: 1_048_576,
} as const;

export type PdfLinearizationTool = {
  readonly name: string;
  version(): Promise<string>;
  isLinearized(inputPath: string): Promise<boolean>;
  linearize(inputPath: string, outputPath: string): Promise<void>;
  validate(outputPath: string): Promise<boolean>;
};

export type OriginalPdfArtifact = {
  id: string;
  contentHash: string;
  storageRef: string;
  byteSize: number;
};

export type PdfDeliveryOptimization = {
  status: "selected" | "skipped" | "failed";
  reason: string;
  outputArtifactId: string | null;
  outputContentHash: string | null;
};

export class QpdfLinearizationTool implements PdfLinearizationTool {
  readonly name = "qpdf";
  readonly #executable: string;

  constructor(executable = "qpdf") {
    this.#executable = executable;
  }

  async version(): Promise<string> {
    const { stdout } = await run(this.#executable, ["--version"], { timeout: 5_000, maxBuffer: 64 * 1024 });
    const match = stdout.match(/qpdf version ([^\s]+)/);
    if (!match) throw new Error("qpdf-version-invalid");
    return match[1]!;
  }

  async isLinearized(inputPath: string): Promise<boolean> {
    const { stdout } = await run(this.#executable, ["--check-linearization", inputPath],
      { timeout: 30_000, maxBuffer: 256 * 1024 });
    return !stdout.includes("is not linearized");
  }

  async linearize(inputPath: string, outputPath: string): Promise<void> {
    await run(this.#executable, ["--linearize", inputPath, outputPath], { timeout: 120_000, maxBuffer: 1024 * 1024 });
  }

  async validate(outputPath: string): Promise<boolean> {
    try {
      const [structure, linearization] = await Promise.all([
        run(this.#executable, ["--check", outputPath], { timeout: 30_000, maxBuffer: 1024 * 1024 }),
        run(this.#executable, ["--check-linearization", outputPath], { timeout: 30_000, maxBuffer: 256 * 1024 }),
      ]);
      return structure.stdout.includes("No syntax or stream encoding errors found") &&
        linearization.stdout.includes("no linearization errors");
    } catch {
      return false;
    }
  }
}

export class PdfDeliveryOptimizer {
  readonly #inFlight = new Map<string, Promise<PdfDeliveryOptimization>>();

  constructor(private readonly layout: StorageLayout, private readonly database: Database.Database,
    private readonly tool: PdfLinearizationTool = new QpdfLinearizationTool(),
    private readonly now: () => Date = () => new Date()) {}

  prepare(source: OriginalPdfArtifact): Promise<PdfDeliveryOptimization> {
    const existing = this.#inFlight.get(source.id);
    if (existing) return existing;
    const task = this.#prepare(source).finally(() => this.#inFlight.delete(source.id));
    this.#inFlight.set(source.id, task);
    return task;
  }

  async rebuildAll(): Promise<void> {
    const sources = this.database.prepare(`SELECT DISTINCT a.id,a.content_hash,a.storage_ref,a.byte_size
      FROM paper_versions v JOIN artifacts a ON a.id=v.pdf_artifact_id
      WHERE a.artifact_type='paper-pdf' ORDER BY a.id`).all() as
      Array<{ id: string; content_hash: string; storage_ref: string; byte_size: number }>;
    for (const source of sources) {
      await this.prepare({ id: source.id, contentHash: source.content_hash,
        storageRef: source.storage_ref, byteSize: source.byte_size });
    }
  }

  async #prepare(source: OriginalPdfArtifact): Promise<PdfDeliveryOptimization> {
    const started = performance.now();
    const parametersJson = JSON.stringify(LOSSLESS_LINEARIZATION_PARAMETERS);
    const reusable = this.#reusable(source, parametersJson);
    if (reusable) return reusable;
    if (source.byteSize < LOSSLESS_LINEARIZATION_PARAMETERS.minimumSourceBytes) {
      return this.#record(source, { status: "skipped", reason: "below-minimum-size", outputArtifactId: null,
        outputContentHash: null }, null, null, { durationMs: performance.now() - started });
    }

    let toolVersion: string;
    try { toolVersion = await this.tool.version(); }
    catch {
      return this.#record(source, { status: "skipped", reason: "tool-unavailable", outputArtifactId: null,
        outputContentHash: null }, null, null, { durationMs: performance.now() - started });
    }

    const inputPath = join(this.layout.root, source.storageRef);
    try {
      const opened = readRegularFileNoFollow(this.layout.originalsRoot, inputPath, "pdf-optimization-source-unsafe");
      if (opened.size !== source.byteSize || createHash("sha256").update(opened.bytes).digest("hex") !== source.contentHash) {
        return this.#record(source, { status: "failed", reason: "source-integrity-failed", outputArtifactId: null,
          outputContentHash: null }, toolVersion, null, { durationMs: performance.now() - started });
      }
      if (await this.tool.isLinearized(inputPath)) {
        return this.#record(source, { status: "skipped", reason: "already-linearized", outputArtifactId: null,
          outputContentHash: null }, toolVersion, null, { durationMs: performance.now() - started });
      }

      const temporaryRoot = await mkdtemp(join(this.layout.tmpRoot, "pdf-linearization-"));
      const outputPath = join(temporaryRoot, "output.pdf");
      try {
        await this.tool.linearize(inputPath, outputPath);
        const outputDetails = await lstat(outputPath);
        if (!outputDetails.isFile() || outputDetails.isSymbolicLink() || !await this.tool.validate(outputPath)) {
          return this.#record(source, { status: "failed", reason: "output-validation-failed", outputArtifactId: null,
            outputContentHash: null }, toolVersion, null, { durationMs: performance.now() - started });
        }
        const outputBytes = await readFile(outputPath);
        const sizeRatio = outputBytes.length / source.byteSize;
        if (sizeRatio > LOSSLESS_LINEARIZATION_PARAMETERS.maximumSizeRatio) {
          return this.#record(source, { status: "skipped", reason: "size-inflation", outputArtifactId: null,
            outputContentHash: null }, toolVersion, outputBytes.length,
          { durationMs: performance.now() - started, sizeRatio });
        }
        let sourcePageCount: number;
        let outputPageCount: number;
        try {
          [sourcePageCount, outputPageCount] = await Promise.all([
            pdfPageCount(opened.bytes), pdfPageCount(outputBytes),
          ]);
        } catch (error) {
          return this.#record(source, { status: "failed", reason: "output-validation-failed", outputArtifactId: null,
            outputContentHash: null }, toolVersion, outputBytes.length,
          { durationMs: performance.now() - started, sizeRatio, errorCode: optimizationErrorCode(error) });
        }
        if (sourcePageCount !== outputPageCount) {
          return this.#record(source, { status: "failed", reason: "page-count-mismatch", outputArtifactId: null,
            outputContentHash: null }, toolVersion, outputBytes.length,
          { durationMs: performance.now() - started, sizeRatio, sourcePageCount, outputPageCount });
        }

        const outputHash = createHash("sha256").update(outputBytes).digest("hex");
        const artifactId = `artifact:pdf-delivery:${outputHash}`;
        const storageRef = join("derived", "pdf-delivery", outputHash.slice(0, 2), `${outputHash}.pdf`);
        await this.#publish(outputPath, storageRef, outputHash, outputBytes.length);
        const now = this.now().toISOString();
        this.database.transaction(() => {
          this.database.prepare(`INSERT OR IGNORE INTO artifacts
            (id,artifact_type,content_hash,storage_ref,media_type,byte_size,created_by_kind,retention_class,integrity_status,created_at,created_by_id)
            VALUES (?,'paper-pdf-delivery',?,?, 'application/pdf',?,'job-run','rebuildable','verified',?,NULL)`)
            .run(artifactId, outputHash, storageRef, outputBytes.length, now);
          const storedArtifactId = (this.database.prepare(`SELECT id FROM artifacts
            WHERE artifact_type='paper-pdf-delivery' AND content_hash=?`).get(outputHash) as { id: string }).id;
          this.database.prepare(`INSERT OR IGNORE INTO artifact_parents(artifact_id,parent_artifact_id,relationship,ordinal)
            VALUES (?,?,'delivery-derived-from',0)`).run(storedArtifactId, source.id);
          this.#upsert(source, { status: "selected", reason: "linearized", outputArtifactId: storedArtifactId,
            outputContentHash: outputHash }, toolVersion, outputBytes.length, parametersJson,
          { durationMs: performance.now() - started, sizeRatio, sourcePageCount, outputPageCount }, now);
        })();
        return { status: "selected", reason: "linearized", outputArtifactId: artifactId, outputContentHash: outputHash };
      } finally {
        await rm(temporaryRoot, { recursive: true, force: true });
      }
    } catch (error) {
      return this.#record(source, { status: "failed", reason: "tool-failed", outputArtifactId: null,
        outputContentHash: null }, toolVersion, null, { durationMs: performance.now() - started,
        errorCode: optimizationErrorCode(error) });
    }
  }

  #reusable(source: OriginalPdfArtifact, parametersJson: string): PdfDeliveryOptimization | null {
    const row = this.database.prepare(`SELECT o.output_artifact_id,o.reason,o.parameters_json,
        a.content_hash,a.storage_ref,a.byte_size
      FROM pdf_delivery_optimizations o JOIN artifacts a ON a.id=o.output_artifact_id
      WHERE o.source_artifact_id=? AND o.strategy='lossless-linearization' AND o.status='selected'`)
      .get(source.id) as { output_artifact_id: string; reason: string; parameters_json: string;
        content_hash: string; storage_ref: string; byte_size: number } | undefined;
    if (!row || row.parameters_json !== parametersJson) return null;
    try {
      const absolute = join(this.layout.root, row.storage_ref);
      const opened = readRegularFileNoFollow(this.layout.derivedRoot, absolute, "pdf-optimization-output-unsafe");
      if (opened.size !== row.byte_size || createHash("sha256").update(opened.bytes).digest("hex") !== row.content_hash) return null;
      return { status: "selected", reason: row.reason, outputArtifactId: row.output_artifact_id,
        outputContentHash: row.content_hash };
    } catch {
      return null;
    }
  }

  #record(source: OriginalPdfArtifact, result: PdfDeliveryOptimization, toolVersion: string | null,
    outputByteSize: number | null, metrics: Record<string, unknown>): PdfDeliveryOptimization {
    const now = this.now().toISOString();
    this.#upsert(source, result, toolVersion, outputByteSize, JSON.stringify(LOSSLESS_LINEARIZATION_PARAMETERS), metrics, now);
    return result;
  }

  #upsert(source: OriginalPdfArtifact, result: PdfDeliveryOptimization, toolVersion: string | null,
    outputByteSize: number | null, parametersJson: string, metrics: Record<string, unknown>, now: string): void {
    this.database.prepare(`INSERT INTO pdf_delivery_optimizations
      (id,source_artifact_id,output_artifact_id,strategy,tool_name,tool_version,parameters_json,status,reason,
       source_byte_size,output_byte_size,metrics_json,attempted_at,updated_at)
      VALUES (?,?,?,'lossless-linearization',?,?,?,?,?,?,?, ?,?,?)
      ON CONFLICT(source_artifact_id,strategy) DO UPDATE SET
        output_artifact_id=excluded.output_artifact_id,tool_name=excluded.tool_name,tool_version=excluded.tool_version,
        parameters_json=excluded.parameters_json,status=excluded.status,reason=excluded.reason,
        source_byte_size=excluded.source_byte_size,output_byte_size=excluded.output_byte_size,
        metrics_json=excluded.metrics_json,attempted_at=excluded.attempted_at,updated_at=excluded.updated_at`)
      .run(optimizationId(source.id), source.id, result.outputArtifactId, this.tool.name, toolVersion, parametersJson,
        result.status, result.reason, source.byteSize, outputByteSize, JSON.stringify(metrics), now, now);
  }

  async #publish(stagedPath: string, storageRef: string, expectedHash: string, expectedSize: number): Promise<void> {
    const target = join(this.layout.root, storageRef);
    const parent = dirname(target);
    ensureNoSymlinkDirectory(this.layout.derivedRoot, parent, "pdf-optimization-output-unsafe");
    if (existsSync(target)) {
      const existing = readRegularFileNoFollow(this.layout.derivedRoot, target, "pdf-optimization-output-unsafe");
      if (existing.size === expectedSize && createHash("sha256").update(existing.bytes).digest("hex") === expectedHash) return;
      const invalid = `${target}.invalid-${randomUUID()}`;
      await rename(target, invalid);
      try { await chmod(stagedPath, 0o400); await rename(stagedPath, target); }
      catch (error) { await rename(invalid, target); throw error; }
      await rm(invalid, { force: true });
    } else {
      await mkdir(parent, { recursive: true, mode: 0o700 });
      await chmod(stagedPath, 0o400);
      await rename(stagedPath, target);
    }
    const published = await stat(target);
    if (!published.isFile() || published.size !== expectedSize) throw new Error("pdf-optimization-publish-failed");
  }
}

function optimizationId(sourceArtifactId: string): string {
  return `pdf-delivery-optimization:${createHash("sha256").update(sourceArtifactId).digest("hex")}`;
}

async function pdfPageCount(bytes: Uint8Array): Promise<number> {
  const loadingTask = getDocument({ data: new Uint8Array(bytes) });
  try { return (await loadingTask.promise).numPages; }
  finally { await loadingTask.destroy(); }
}

function optimizationErrorCode(error: unknown): string {
  const systemCode = (error as NodeJS.ErrnoException | null)?.code;
  if (systemCode) return systemCode;
  return error instanceof Error ? error.message.split(":", 1)[0]!.slice(0, 120) : "unknown";
}
