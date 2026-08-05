import { createHash, timingSafeEqual } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { getDocument, OPS, type PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import { PDFDocument } from "pdf-lib";

import { PdfPageRenderer } from "../storage/pdf-page-renderer.js";

export const PDF_COMPRESSION_QUALITY_GATES = {
  minimumSampledPageSsim: 0.99,
} as const;

type PdfPair = {
  sourceBytes: Buffer;
  outputBytes: Buffer;
  sourceHash: string;
  outputHash: string;
  renderRoot?: string;
  renderer?: PdfCompressionPageRenderer;
};

export type PdfCompressionPageRenderer = {
  render(source: { artifactId: string; contentHash: string; bytes: Buffer }, page: number): Promise<{
    imageBytes: Buffer;
  }>;
};

export type PdfCompressionAudit = {
  passes: boolean;
  pageCount: { source: number; output: number; matches: boolean };
  geometryMatches: boolean;
  normalizedTextMatches: boolean;
  outlineMatches: boolean;
  annotationMatches: boolean;
  structuredContentMatches: boolean;
  sampledPages: Array<{
    page: number;
    profiles: Array<"first" | "middle" | "last" | "image-heavy" | "text-mismatch" | "annotation-mismatch">;
    ssim: number;
    passes: boolean;
  }>;
};

const standardFontDataUrl = `${join(dirname(createRequire(import.meta.url)
  .resolve("pdfjs-dist/package.json")), "standard_fonts")}/`;

export async function auditPdfCompression(pair: PdfPair): Promise<PdfCompressionAudit> {
  assertHash(pair.sourceBytes, pair.sourceHash, "source");
  assertHash(pair.outputBytes, pair.outputHash, "output");
  const [source, output] = await Promise.all([
    inspectPdf(pair.sourceBytes),
    inspectPdf(pair.outputBytes),
  ]);
  const pageCountMatches = source.pageCount === output.pageCount;
  const selectedPages = selectSamplePages(source.pageCount, source.imageCounts);
  const textMismatchPages = pageCountMatches ? mismatchPages(source.text, output.text) : [];
  const annotationMismatchPages = pageCountMatches ? mismatchPages(source.annotations, output.annotations) : [];
  for (const page of textMismatchPages) addSample(selectedPages, page, "text-mismatch");
  for (const page of annotationMismatchPages) addSample(selectedPages, page, "annotation-mismatch");
  const sampledPages = pageCountMatches
    ? await renderAndCompare(pair, selectedPages)
    : [];
  const geometryMatches = pageCountMatches && canonical(source.geometry) === canonical(output.geometry);
  const normalizedTextMatches = pageCountMatches && textMismatchPages.length === 0;
  const outlineMatches = canonical(source.outline) === canonical(output.outline);
  const annotationMatches = pageCountMatches && annotationMismatchPages.length === 0;
  const structuredContentMatches = pageCountMatches &&
    canonical(source.structuredContent) === canonical(output.structuredContent);
  return {
    passes: pageCountMatches && geometryMatches && normalizedTextMatches && outlineMatches &&
      annotationMatches && structuredContentMatches && sampledPages.length > 0 &&
      sampledPages.every((sample) => sample.passes),
    pageCount: { source: source.pageCount, output: output.pageCount, matches: pageCountMatches },
    geometryMatches,
    normalizedTextMatches,
    outlineMatches,
    annotationMatches,
    structuredContentMatches,
    sampledPages,
  };
}

async function inspectPdf(bytes: Buffer) {
  const layoutDocument = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const pageBoxes = layoutDocument.getPages().map((page) => ({
    mediaBox: page.getMediaBox(),
    cropBox: page.getCropBox(),
    rotation: page.getRotation().angle,
  }));
  const loadingTask = getDocument({
    data: new Uint8Array(bytes),
    standardFontDataUrl,
    useSystemFonts: false,
  });
  try {
    const document = await loadingTask.promise;
    const geometry: unknown[] = [];
    const text: string[] = [];
    const annotations: unknown[] = [];
    const structureTrees: unknown[] = [];
    const imageCounts: number[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      geometry.push({ view: page.view, rotate: page.rotate, userUnit: page.userUnit,
        boxes: pageBoxes[pageNumber - 1] });
      const content = await page.getTextContent();
      text.push(content.items.map((item) => "str" in item ? item.str : "").join(" ")
        .normalize("NFKC").replace(/\s+/g, " ").trim());
      annotations.push(await Promise.all((await page.getAnnotations())
        .map((annotation) => annotationSemantics(document, annotation))));
      structureTrees.push(await page.getStructTree());
      const operators = await page.getOperatorList();
      imageCounts.push(operators.fnArray.filter(isImageOperator).length);
      page.cleanup();
    }
    const [outline, fieldObjects, markInfo, attachments] = await Promise.all([
      document.getOutline(),
      document.getFieldObjects(),
      document.getMarkInfo(),
      document.getAttachments(),
    ]);
    const attachmentContents = attachments ? await Promise.all([...attachments.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(async ([id, metadata]) => ({ id, metadata, content: await document.getAttachmentContent(id) }))) : [];
    return {
      pageCount: document.numPages,
      geometry,
      text,
      annotations,
      outline: await outlineSemantics(document, outline),
      imageCounts,
      structuredContent: {
        markInfo,
        fieldObjects,
        structureTrees,
        attachments: attachmentContents,
      },
    };
  } finally {
    await loadingTask.destroy();
  }
}

async function annotationSemantics(document: PDFDocumentProxy,
  annotation: Record<string, unknown>): Promise<Record<string, unknown>> {
  const semantics = Object.fromEntries(Object.entries(annotation)
    .filter(([key, value]) => key !== "id" && key !== "ref" && key !== "dest" && typeof value !== "function"));
  if (annotation.dest) semantics.destination = await destinationSemantics(document, annotation.dest);
  return semantics;
}

async function outlineSemantics(document: PDFDocumentProxy,
  items: Awaited<ReturnType<PDFDocumentProxy["getOutline"]>>): Promise<unknown> {
  if (!items) return null;
  return Promise.all(items.map(async (item) => ({
    title: item.title,
    destination: item.dest ? await destinationSemantics(document, item.dest) : null,
    url: item.url,
    unsafeUrl: item.unsafeUrl,
    count: item.count,
    items: await outlineSemantics(document, item.items),
  })));
}

async function destinationSemantics(document: PDFDocumentProxy, destination: unknown): Promise<unknown> {
  const explicit = typeof destination === "string" ? await document.getDestination(destination) : destination;
  if (!Array.isArray(explicit)) return normalize(explicit);
  const [pageReference, kind, ...coordinates] = explicit;
  let page: number | null = null;
  if (typeof pageReference === "number") page = pageReference + 1;
  else if (pageReference && typeof pageReference === "object" && "num" in pageReference && "gen" in pageReference) {
    try { page = await document.getPageIndex(pageReference as { num: number; gen: number }) + 1; }
    catch { page = null; }
  }
  return { page, kind: kind && typeof kind === "object" && "name" in kind ? kind.name : kind,
    coordinates: normalize(coordinates) };
}

function isImageOperator(operator: number): boolean {
  return operator === OPS.paintImageMaskXObject || operator === OPS.paintImageMaskXObjectGroup ||
    operator === OPS.paintImageXObject || operator === OPS.paintImageXObjectRepeat ||
    operator === OPS.paintImageMaskXObjectRepeat;
}

type SampleProfile = PdfCompressionAudit["sampledPages"][number]["profiles"][number];

function selectSamplePages(pageCount: number, imageCounts: number[]): Map<number, Set<SampleProfile>> {
  const samples = new Map<number, Set<SampleProfile>>();
  addSample(samples, 1, "first");
  addSample(samples, Math.ceil(pageCount / 2), "middle");
  addSample(samples, pageCount, "last");
  const maximumImages = Math.max(0, ...imageCounts);
  if (maximumImages > 0) addSample(samples, imageCounts.indexOf(maximumImages) + 1, "image-heavy");
  return samples;
}

function addSample(samples: Map<number, Set<SampleProfile>>, page: number, profile: SampleProfile): void {
  const profiles = samples.get(page) ?? new Set();
  profiles.add(profile);
  samples.set(page, profiles);
}

function mismatchPages(source: unknown[], output: unknown[]): number[] {
  return source.flatMap((value, index) => canonical(value) === canonical(output[index]) ? [] : [index + 1]);
}

async function renderAndCompare(pair: PdfPair,
  selectedPages: Map<number, Set<SampleProfile>>): Promise<PdfCompressionAudit["sampledPages"]> {
  const renderer = pair.renderer ?? new PdfPageRenderer();
  const results: PdfCompressionAudit["sampledPages"] = [];
  for (const [page, profiles] of [...selectedPages].sort(([left], [right]) => left - right)) {
    const source = await renderer.render({ artifactId: `benchmark:source:${pair.sourceHash}`,
      contentHash: pair.sourceHash, bytes: pair.sourceBytes }, page);
    const output = await renderer.render({ artifactId: `benchmark:output:${pair.outputHash}`,
      contentHash: pair.outputHash, bytes: pair.outputBytes }, page);
    if (pair.renderRoot) {
      await mkdir(pair.renderRoot, { recursive: true });
      const prefix = `page-${String(page).padStart(3, "0")}`;
      await Promise.all([
        writeFile(join(pair.renderRoot, `${prefix}-source.png`), source.imageBytes),
        writeFile(join(pair.renderRoot, `${prefix}-output.png`), output.imageBytes),
      ]);
    }
    const ssim = await imageSsim(source.imageBytes, output.imageBytes);
    results.push({ page, profiles: [...profiles],
      ssim, passes: ssim >= PDF_COMPRESSION_QUALITY_GATES.minimumSampledPageSsim });
  }
  return results;
}

async function imageSsim(leftBytes: Buffer, rightBytes: Buffer): Promise<number> {
  if (leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)) return 1;
  const { createCanvas, loadImage } = await import("@napi-rs/canvas");
  const [leftImage, rightImage] = await Promise.all([loadImage(leftBytes), loadImage(rightBytes)]);
  if (leftImage.width !== rightImage.width || leftImage.height !== rightImage.height) return 0;
  const leftCanvas = createCanvas(leftImage.width, leftImage.height);
  const rightCanvas = createCanvas(rightImage.width, rightImage.height);
  const leftContext = leftCanvas.getContext("2d");
  const rightContext = rightCanvas.getContext("2d");
  leftContext.drawImage(leftImage, 0, 0);
  rightContext.drawImage(rightImage, 0, 0);
  const left = leftContext.getImageData(0, 0, leftImage.width, leftImage.height).data;
  const right = rightContext.getImageData(0, 0, rightImage.width, rightImage.height).data;
  const blockSize = 8;
  let sum = 0;
  let blocks = 0;
  for (let y = 0; y < leftImage.height; y += blockSize) {
    for (let x = 0; x < leftImage.width; x += blockSize) {
      sum += (blockSsim(left, right, leftImage.width, leftImage.height, x, y, blockSize, 0) +
        blockSsim(left, right, leftImage.width, leftImage.height, x, y, blockSize, 1) +
        blockSsim(left, right, leftImage.width, leftImage.height, x, y, blockSize, 2)) / 3;
      blocks += 1;
    }
  }
  return Number((sum / blocks).toFixed(6));
}

function blockSsim(left: Uint8ClampedArray, right: Uint8ClampedArray, width: number, height: number,
  startX: number, startY: number, size: number, channel: 0 | 1 | 2): number {
  let leftMean = 0;
  let rightMean = 0;
  let count = 0;
  const values: Array<[number, number]> = [];
  for (let y = startY; y < Math.min(startY + size, height); y += 1) {
    for (let x = startX; x < Math.min(startX + size, width); x += 1) {
      const index = (y * width + x) * 4;
      const leftValue = left[index + channel]!;
      const rightValue = right[index + channel]!;
      values.push([leftValue, rightValue]);
      leftMean += leftValue;
      rightMean += rightValue;
      count += 1;
    }
  }
  leftMean /= count;
  rightMean /= count;
  let leftVariance = 0;
  let rightVariance = 0;
  let covariance = 0;
  for (const [leftValue, rightValue] of values) {
    leftVariance += (leftValue - leftMean) ** 2;
    rightVariance += (rightValue - rightMean) ** 2;
    covariance += (leftValue - leftMean) * (rightValue - rightMean);
  }
  const divisor = Math.max(1, count - 1);
  leftVariance /= divisor;
  rightVariance /= divisor;
  covariance /= divisor;
  const c1 = (0.01 * 255) ** 2;
  const c2 = (0.03 * 255) ** 2;
  return ((2 * leftMean * rightMean + c1) * (2 * covariance + c2)) /
    ((leftMean ** 2 + rightMean ** 2 + c1) * (leftVariance + rightVariance + c2));
}

function assertHash(bytes: Buffer, expected: string, label: string): void {
  if (createHash("sha256").update(bytes).digest("hex") !== expected) {
    throw new Error(`compression-audit-${label}-hash-mismatch`);
  }
}

function canonical(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString("hex");
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => typeof entry !== "function" && entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, normalize(entry)]));
  return String(value);
}
