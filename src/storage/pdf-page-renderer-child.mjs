import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { createCanvas } from "@napi-rs/canvas";
import { getDocument, AnnotationMode } from "pdfjs-dist/legacy/build/pdf.mjs";

const MAX_INPUT_BYTES = 64 * 1024 * 1024;
const MAX_PIXEL_EDGE = 10_000;
const MAX_PIXEL_COUNT = 40_000_000;
const MAX_OUTPUT_BYTES = 20 * 1024 * 1024;
const SCALE = 2;
const standardFontDataUrl = `${join(dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json")), "standard_fonts")}/`;

class NapiCanvasFactory {
  create(width, height) {
    const canvas = createCanvas(width, height);
    return { canvas, context: canvas.getContext("2d") };
  }

  reset(target, width, height) {
    target.canvas.width = width;
    target.canvas.height = height;
  }

  destroy(target) {
    target.canvas.width = 0;
    target.canvas.height = 0;
    target.canvas = null;
    target.context = null;
  }
}

async function readInput() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_INPUT_BYTES) throw new Error("renderer-input-too-large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

try {
  const pageNumber = Number.parseInt(process.argv[2] ?? "", 10);
  if (!Number.isInteger(pageNumber) || pageNumber < 1) throw new Error("renderer-page-invalid");
  const bytes = await readInput();
  const loadingTask = getDocument({ data: new Uint8Array(bytes), standardFontDataUrl, isEvalSupported: false,
    useSystemFonts: false, disableFontFace: false });
  const document = await loadingTask.promise;
  if (pageNumber > document.numPages) throw new Error(`renderer-page-out-of-bounds:${document.numPages}`);
  const page = await document.getPage(pageNumber);
  const viewport = page.getViewport({ scale: SCALE });
  const width = Math.ceil(viewport.width);
  const height = Math.ceil(viewport.height);
  if (width > MAX_PIXEL_EDGE || height > MAX_PIXEL_EDGE || width * height > MAX_PIXEL_COUNT) {
    throw new Error("renderer-page-too-large");
  }
  const canvasFactory = new NapiCanvasFactory();
  const target = canvasFactory.create(width, height);
  target.context.save();
  target.context.fillStyle = "#ffffff";
  target.context.fillRect(0, 0, width, height);
  target.context.restore();
  await page.render({ canvasContext: target.context, viewport, canvasFactory, intent: "display",
    annotationMode: AnnotationMode.DISABLE, background: "#ffffff" }).promise;
  const png = target.canvas.toBuffer("image/png");
  if (png.length > MAX_OUTPUT_BYTES) throw new Error("renderer-output-too-large");
  process.stdout.write(JSON.stringify({ page: pageNumber, pageCount: document.numPages, pixelWidth: width,
    pixelHeight: height, imageBase64: png.toString("base64") }));
  await loadingTask.destroy();
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
