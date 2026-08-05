import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { PDF_DELIVERY_CORPUS, type PdfDeliveryCorpusPaper } from "./pdf-delivery-corpus.js";
import {
  auditPdfCompression,
  PDF_COMPRESSION_QUALITY_GATES,
  type PdfCompressionAudit,
  type PdfCompressionPageRenderer,
} from "./pdf-compression-audit.js";
import {
  GHOSTSCRIPT_EBOOK_PARAMETERS,
  type PdfCompressionTool,
} from "./ghostscript-ebook-tool.js";

const run = promisify(execFile);

export const PDF_COMPRESSION_CORPUS = [
  ...PDF_DELIVERY_CORPUS,
  {
    arxivId: "2411.02293", version: 5,
    title: "Hunyuan3D 1.0: A Unified Framework for Text-to-3D and Image-to-3D Generation",
    authors: ["Tencent Hunyuan3D"], year: 2024, profile: "image-heavy-3d-generation",
    pdfUrl: "https://arxiv.org/pdf/2411.02293v5",
    expectedSha256: "6467c327e68f48acf9d1d2bc11a7636c017359d0b0a140589262bf1c40c68def",
  },
] as const satisfies readonly PdfDeliveryCorpusPaper[];

export const PDF_COMPRESSION_BENCHMARK_GATES = {
  maximumSizeRatio: 0.70,
  ...PDF_COMPRESSION_QUALITY_GATES,
} as const;

export type PdfStructureValidator = {
  readonly name: string;
  version(): Promise<string>;
  validate(inputPath: string): Promise<boolean>;
};

export class QpdfStructureValidator implements PdfStructureValidator {
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

  async validate(inputPath: string): Promise<boolean> {
    try {
      const { stdout } = await run(this.#executable, ["--check", inputPath], {
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      });
      return stdout.includes("No syntax or stream encoding errors found");
    } catch {
      return false;
    }
  }
}

export type PdfCompressionCorpusReport = {
  schemaVersion: 1;
  generatedAt: string;
  strategy: "ebook-compression";
  tool: { name: string; version: string };
  validator: { name: string; version: string };
  parameters: typeof GHOSTSCRIPT_EBOOK_PARAMETERS;
  gates: typeof PDF_COMPRESSION_BENCHMARK_GATES;
  summary: {
    papers: number;
    go: number;
    noGo: number;
    recommendation: "go" | "no-go";
  };
  samples: PdfCompressionCorpusSample[];
};

export type PdfCompressionCorpusSample = PdfDeliveryCorpusPaper & {
  sourceHash: string;
  outputHash: string;
  repeatedOutputHash: string;
  sourceBytes: number;
  outputBytes: number;
  sizeRatio: number;
  savingsRatio: number;
  durationMs: number;
  deterministic: boolean;
  structureValid: boolean;
  qualityPassed: boolean;
  passesSizeGate: boolean;
  decision: "go" | "no-go";
  reasons: string[];
  audit: PdfCompressionAudit | null;
  auditError: string | null;
};

export async function benchmarkPdfCompressionCorpus(options: {
  runtimeRoot: string;
  outputRoot: string;
  corpus: readonly PdfDeliveryCorpusPaper[];
  fetchPdf(paper: PdfDeliveryCorpusPaper): Promise<Uint8Array>;
  tool: PdfCompressionTool;
  validator: PdfStructureValidator;
  renderer?: PdfCompressionPageRenderer;
  now?: () => Date;
}): Promise<PdfCompressionCorpusReport> {
  const now = options.now ?? (() => new Date());
  const [toolVersion, validatorVersion] = await Promise.all([
    options.tool.version(),
    options.validator.version(),
  ]);
  await Promise.all([
    mkdir(options.runtimeRoot, { recursive: true }),
    mkdir(options.outputRoot, { recursive: true }),
  ]);
  const samples: PdfCompressionCorpusSample[] = [];
  for (const paper of options.corpus) {
    samples.push(await benchmarkPaper(options, paper));
  }
  const go = samples.filter((sample) => sample.decision === "go").length;
  return {
    schemaVersion: 1,
    generatedAt: now().toISOString(),
    strategy: "ebook-compression",
    tool: { name: options.tool.name, version: toolVersion },
    validator: { name: options.validator.name, version: validatorVersion },
    parameters: GHOSTSCRIPT_EBOOK_PARAMETERS,
    gates: PDF_COMPRESSION_BENCHMARK_GATES,
    summary: {
      papers: samples.length,
      go,
      noGo: samples.length - go,
      recommendation: samples.length > 0 && go === samples.length ? "go" : "no-go",
    },
    samples,
  };
}

async function benchmarkPaper(options: Parameters<typeof benchmarkPdfCompressionCorpus>[0],
  paper: PdfDeliveryCorpusPaper): Promise<PdfCompressionCorpusSample> {
  if (!paper.expectedSha256) throw new Error(`compression-corpus-source-hash-unpinned:${paper.arxivId}v${paper.version}`);
  const sourceBytes = Buffer.from(await options.fetchPdf(paper));
  if (!sourceBytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
    throw new Error(`compression-corpus-source-not-pdf:${paper.arxivId}v${paper.version}`);
  }
  const sourceHash = hash(sourceBytes);
  if (sourceHash !== paper.expectedSha256) {
    throw new Error(`compression-corpus-source-hash-mismatch:${paper.arxivId}v${paper.version}`);
  }
  const sampleKey = `${paper.arxivId}v${paper.version}`;
  const sampleRoot = await mkdtemp(join(options.runtimeRoot, `${sampleKey}-`));
  const outputRoot = join(options.outputRoot, sampleKey);
  try {
    const inputPath = join(sampleRoot, "source.pdf");
    const outputPath = join(sampleRoot, "compressed.pdf");
    const repeatedOutputPath = join(sampleRoot, "compressed-repeated.pdf");
    await writeFile(inputPath, sourceBytes);
    const started = performance.now();
    await options.tool.compress(inputPath, outputPath);
    const durationMs = performance.now() - started;
    await options.tool.compress(inputPath, repeatedOutputPath);
    const [outputBytes, repeatedOutputBytes, outputValid, repeatedOutputValid] = await Promise.all([
      readFile(outputPath),
      readFile(repeatedOutputPath),
      options.validator.validate(outputPath),
      options.validator.validate(repeatedOutputPath),
    ]);
    const outputHash = hash(outputBytes);
    const repeatedOutputHash = hash(repeatedOutputBytes);
    const deterministic = outputHash === repeatedOutputHash;
    const structureValid = outputValid && repeatedOutputValid;
    const sizeRatio = outputBytes.length / sourceBytes.length;
    const savingsRatio = 1 - sizeRatio;
    const passesSizeGate = sizeRatio <= PDF_COMPRESSION_BENCHMARK_GATES.maximumSizeRatio;
    await mkdir(outputRoot, { recursive: true });
    await copyFile(outputPath, join(outputRoot, "compressed.pdf"));
    let audit: PdfCompressionAudit | null = null;
    let auditError: string | null = null;
    try {
      audit = await auditPdfCompression({
        sourceBytes,
        outputBytes,
        sourceHash,
        outputHash,
        renderRoot: outputRoot,
        ...(options.renderer ? { renderer: options.renderer } : {}),
      });
    } catch (error) {
      auditError = errorCode(error);
    }
    const reasons = [
      ...(!deterministic ? ["non-deterministic-output"] : []),
      ...(!structureValid ? ["structural-validation-failed"] : []),
      ...(!passesSizeGate ? ["insufficient-size-reduction"] : []),
      ...(audit && !audit.passes ? ["quality-gate-failed"] : []),
      ...(!audit ? ["quality-audit-failed"] : []),
    ];
    return {
      ...paper,
      sourceHash,
      outputHash,
      repeatedOutputHash,
      sourceBytes: sourceBytes.length,
      outputBytes: outputBytes.length,
      sizeRatio,
      savingsRatio,
      durationMs,
      deterministic,
      structureValid,
      qualityPassed: audit?.passes ?? false,
      passesSizeGate,
      decision: reasons.length === 0 ? "go" : "no-go",
      reasons,
      audit,
      auditError,
    };
  } finally {
    await rm(sampleRoot, { recursive: true, force: true });
  }
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code) return code;
  return error instanceof Error ? error.message.split(":", 1)[0]!.slice(0, 120) : "unknown";
}
