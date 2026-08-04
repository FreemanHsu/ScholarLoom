import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createFixturePdf } from "../src/adapters/fixture.js";
import { QpdfLinearizationTool } from "../src/storage/pdf-delivery-optimizer.js";
import { PdfPageRenderer } from "../src/storage/pdf-page-renderer.js";

const qpdfAvailable = spawnSync("qpdf", ["--version"], { stdio: "ignore" }).status === 0;

describe.runIf(qpdfAvailable && process.platform === "darwin")("QpdfLinearizationTool", () => {
  it("produces a structurally valid linearized PDF with identical rendered pages", async () => {
    const root = await mkdtemp(join(tmpdir(), "scholarloom-qpdf-"));
    const sourcePath = join(root, "source.pdf");
    const outputPath = join(root, "linearized.pdf");
    const repeatedOutputPath = join(root, "linearized-repeated.pdf");
    const sourceBytes = Buffer.from(await createFixturePdf());
    await writeFile(sourcePath, sourceBytes);
    const tool = new QpdfLinearizationTool();

    expect(await tool.version()).toMatch(/^\d+\.\d+\.\d+/);
    expect(await tool.isLinearized(sourcePath)).toBe(false);
    await tool.linearize(sourcePath, outputPath);
    await tool.linearize(sourcePath, repeatedOutputPath);
    expect(await tool.validate(outputPath)).toBe(true);
    expect(await tool.isLinearized(outputPath)).toBe(true);

    const outputBytes = await readFile(outputPath);
    const repeatedOutputBytes = await readFile(repeatedOutputPath);
    expect(createHash("sha256").update(repeatedOutputBytes).digest("hex"))
      .toBe(createHash("sha256").update(outputBytes).digest("hex"));
    expect(createHash("sha256").update(outputBytes).digest("hex"))
      .not.toBe(createHash("sha256").update(sourceBytes).digest("hex"));
    const renderer = new PdfPageRenderer();
    for (const page of [1, 2]) {
      const source = await renderer.render({ artifactId: "artifact:source",
        contentHash: createHash("sha256").update(sourceBytes).digest("hex"), bytes: sourceBytes }, page);
      const derived = await renderer.render({ artifactId: "artifact:derived",
        contentHash: createHash("sha256").update(outputBytes).digest("hex"), bytes: outputBytes }, page);
      expect(derived.imageHash).toBe(source.imageHash);
      expect(derived.descriptor.pageCount).toBe(source.descriptor.pageCount);
    }
    await rm(root, { recursive: true });
  }, 60_000);
});
