import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const run = promisify(execFile);

export const GHOSTSCRIPT_EBOOK_PARAMETERS = {
  compatibilityLevel: "1.5",
  pdfSettings: "ebook",
  preserveAnnotations: true,
  preserveMarkedContent: true,
  omitInfoDate: true,
  omitId: true,
  deterministicUuid: "sha256-source-content",
} as const;

export type PdfCompressionTool = {
  readonly name: string;
  version(): Promise<string>;
  compress(inputPath: string, outputPath: string): Promise<void>;
};

export class GhostscriptEbookTool implements PdfCompressionTool {
  readonly name = "ghostscript-pdfwrite";
  readonly #executable: string;

  constructor(executable = "gs") {
    this.#executable = executable;
  }

  async version(): Promise<string> {
    const { stdout } = await run(this.#executable, ["--version"], {
      timeout: 5_000,
      maxBuffer: 64 * 1024,
    });
    const version = stdout.trim();
    if (!/^\d+(?:\.\d+)+$/.test(version)) throw new Error("ghostscript-version-invalid");
    return version;
  }

  async compress(inputPath: string, outputPath: string): Promise<void> {
    const sourceHash = createHash("sha256").update(await readFile(inputPath)).digest("hex");
    await run(this.#executable, [
      "-dSAFER",
      "-dBATCH",
      "-dNOPAUSE",
      "-dQUIET",
      "-sDEVICE=pdfwrite",
      `-dCompatibilityLevel=${GHOSTSCRIPT_EBOOK_PARAMETERS.compatibilityLevel}`,
      `-dPDFSETTINGS=/${GHOSTSCRIPT_EBOOK_PARAMETERS.pdfSettings}`,
      `-dPreserveAnnots=${GHOSTSCRIPT_EBOOK_PARAMETERS.preserveAnnotations}`,
      `-dPreserveMarkedContent=${GHOSTSCRIPT_EBOOK_PARAMETERS.preserveMarkedContent}`,
      `-dOmitInfoDate=${GHOSTSCRIPT_EBOOK_PARAMETERS.omitInfoDate}`,
      `-dOmitID=${GHOSTSCRIPT_EBOOK_PARAMETERS.omitId}`,
      `-sDocumentUUID=${deterministicUuid(`document:${sourceHash}`)}`,
      `-sInstanceUUID=${deterministicUuid(`instance:${sourceHash}`)}`,
      `-sOutputFile=${outputPath}`,
      inputPath,
    ], { timeout: 300_000, maxBuffer: 4 * 1024 * 1024 });
  }
}

function deterministicUuid(seed: string): string {
  const hex = createHash("sha256").update(seed).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
