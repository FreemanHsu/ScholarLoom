import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createFixturePdf } from "../src/adapters/fixture.js";
import { QpdfStructureValidator } from "../src/benchmark/pdf-compression-corpus.js";
import {
  GHOSTSCRIPT_EBOOK_PARAMETERS,
  GhostscriptEbookTool,
} from "../src/benchmark/ghostscript-ebook-tool.js";

describe("GhostscriptEbookTool", () => {
  it("regenerates a PDF with the fixed reviewed ebook policy", async () => {
    const root = await mkdtemp(join(tmpdir(), "scholarloom-ghostscript-tool-"));
    const executable = join(root, "fixture-gs.mjs");
    const inputPath = join(root, "source with spaces.pdf");
    const outputPath = join(root, "derived with spaces.pdf");
    const argumentsPath = join(root, "arguments.json");
    await writeFile(executable, `#!/usr/bin/env node
import { copyFile, writeFile } from "node:fs/promises";
const args = process.argv.slice(2);
if (args[0] === "--version") process.stdout.write("10.05.1\\n");
else {
  const output = args.find((arg) => arg.startsWith("-sOutputFile="))?.slice("-sOutputFile=".length);
  await writeFile(${JSON.stringify(argumentsPath)}, JSON.stringify(args));
  await copyFile(args.at(-1), output);
}
`);
    await chmod(executable, 0o700);
    await writeFile(inputPath, "%PDF-fixture");
    const sourceHash = createHash("sha256").update("%PDF-fixture").digest("hex");

    try {
      const tool = new GhostscriptEbookTool(executable);
      expect(await tool.version()).toBe("10.05.1");
      await tool.compress(inputPath, outputPath);

      expect(await readFile(outputPath, "utf8")).toBe("%PDF-fixture");
      expect(JSON.parse(await readFile(argumentsPath, "utf8"))).toEqual([
        "-dSAFER",
        "-dBATCH",
        "-dNOPAUSE",
        "-dQUIET",
        "-sDEVICE=pdfwrite",
        "-dCompatibilityLevel=1.5",
        "-dPDFSETTINGS=/ebook",
        "-dPreserveAnnots=true",
        "-dPreserveMarkedContent=true",
        "-dOmitInfoDate=true",
        "-dOmitID=true",
        `-sDocumentUUID=${deterministicUuid(`document:${sourceHash}`)}`,
        `-sInstanceUUID=${deterministicUuid(`instance:${sourceHash}`)}`,
        `-sOutputFile=${outputPath}`,
        inputPath,
      ]);
      expect(GHOSTSCRIPT_EBOOK_PARAMETERS).toEqual({
        compatibilityLevel: "1.5",
        pdfSettings: "ebook",
        preserveAnnotations: true,
        preserveMarkedContent: true,
        omitInfoDate: true,
        omitId: true,
        deterministicUuid: "sha256-source-content",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

const ghostscriptAvailable = spawnSync("gs", ["--version"], { stdio: "ignore" }).status === 0;
const qpdfAvailable = spawnSync("qpdf", ["--version"], { stdio: "ignore" }).status === 0;

describe.runIf(ghostscriptAvailable && qpdfAvailable)("installed GhostscriptEbookTool", () => {
  it("produces deterministic structurally valid PDF bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "scholarloom-real-ghostscript-tool-"));
    const inputPath = join(root, "source.pdf");
    const outputPath = join(root, "output.pdf");
    const repeatedOutputPath = join(root, "output-repeated.pdf");
    try {
      await writeFile(inputPath, await createFixturePdf());
      const tool = new GhostscriptEbookTool();
      await tool.compress(inputPath, outputPath);
      await tool.compress(inputPath, repeatedOutputPath);
      const [output, repeated] = await Promise.all([readFile(outputPath), readFile(repeatedOutputPath)]);
      expect(createHash("sha256").update(repeated).digest("hex"))
        .toBe(createHash("sha256").update(output).digest("hex"));
      await expect(new QpdfStructureValidator().validate(outputPath)).resolves.toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});

function deterministicUuid(seed: string): string {
  const hex = createHash("sha256").update(seed).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
