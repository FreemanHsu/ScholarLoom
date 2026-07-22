import { createInterface } from "node:readline";
import { lstatSync, readFileSync } from "node:fs";

import Database from "better-sqlite3";

import { openDataRoot } from "../storage/layout.js";
import { PdfPageRenderer } from "../storage/pdf-page-renderer.js";
import { VisualEvidenceShim } from "../storage/visual-evidence-shim.js";
import { VisualEvidenceStore } from "../storage/visual-evidence-store.js";

type JsonRpcRequest = { jsonrpc?: string; id?: string | number | null; method?: string; params?: unknown };

const bindingPath = process.env.SCHOLARLOOM_VISUAL_BINDING_FILE;
if (!bindingPath) throw new Error("visual-binding-required");
const bindingStat = lstatSync(bindingPath);
const currentUid = process.getuid?.();
if (!bindingStat.isFile() || bindingStat.isSymbolicLink() || (bindingStat.mode & 0o077) !== 0 ||
    (currentUid !== undefined && bindingStat.uid !== currentUid)) throw new Error("visual-binding-unsafe");
const binding = JSON.parse(readFileSync(bindingPath, "utf8")) as { dataRoot?: unknown; attemptId?: unknown; runEpoch?: unknown };
if (typeof binding.dataRoot !== "string" || typeof binding.attemptId !== "string" ||
    !Number.isInteger(binding.runEpoch) || (binding.runEpoch as number) < 1) throw new Error("visual-binding-invalid");

const layout = openDataRoot(binding.dataRoot);
const database = new Database(layout.databasePath);
database.pragma("foreign_keys = ON");
const store = new VisualEvidenceStore(layout, database, new PdfPageRenderer());
const shim = new VisualEvidenceShim({ attemptId: binding.attemptId, runEpoch: binding.runEpoch as number, layout, database, store });

const tools = [
  { name: "inspect_pdf_page", description: "Render and inspect one page from the Attempt's frozen PDF source.",
    inputSchema: { type: "object", additionalProperties: false, required: ["sourceId", "page"], properties: {
      sourceId: { type: "string", minLength: 1 }, page: { type: "integer", minimum: 1 },
    } }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: "budget_status", description: "Return the current Attempt's visual page budget.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
] as const;

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => void handleLine(line));
process.on("SIGTERM", close);
process.on("SIGINT", close);

async function handleLine(line: string): Promise<void> {
  let request: JsonRpcRequest;
  try { request = JSON.parse(line) as JsonRpcRequest; }
  catch { return writeError(null, -32700, "parse-error"); }
  if (request.method === "notifications/initialized") return;
  if (request.method === "initialize") return writeResult(request.id, {
    protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "scholarloom-visual", version: "1" },
  });
  if (request.method === "tools/list") return writeResult(request.id, { tools });
  if (request.method !== "tools/call") return writeError(request.id, -32601, "method-not-found");
  const params = request.params as { name?: unknown; arguments?: unknown } | undefined;
  try {
    if (params?.name === "budget_status") {
      if (!plainObject(params.arguments) || Object.keys(params.arguments).length !== 0) throw new Error("visual-tool-arguments-invalid");
      return writeResult(request.id, { content: [{ type: "text", text: JSON.stringify(shim.budgetStatus()) }] });
    }
    if (params?.name === "inspect_pdf_page") {
      if (!plainObject(params.arguments) || Object.keys(params.arguments).some((key) => !["sourceId", "page"].includes(key)) ||
          typeof params.arguments.sourceId !== "string" || !Number.isInteger(params.arguments.page)) {
        throw new Error("visual-tool-arguments-invalid");
      }
      const result = await shim.inspectPdfPage({ sourceId: params.arguments.sourceId, page: params.arguments.page as number });
      const descriptor = { sourceId: params.arguments.sourceId, page: result.page, imageHash: result.imageHash,
        rendererName: result.rendererName, rendererVersion: result.rendererVersion,
        rendererFingerprint: result.rendererFingerprint, renderSettings: result.renderSettings, budget: result.budget };
      return writeResult(request.id, { content: [
        { type: "text", text: JSON.stringify(descriptor) },
        { type: "image", data: result.imageBytes.toString("base64"), mimeType: "image/png" },
      ] });
    }
    throw new Error("visual-tool-unknown");
  } catch (error) {
    return writeResult(request.id, { isError: true, content: [{ type: "text", text: errorCode(error) }] });
  }
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "visual-tool-failed";
  return message.split(":", 1)[0]!.slice(0, 120);
}

function writeResult(id: JsonRpcRequest["id"], result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: id ?? null, result })}\n`);
}

function writeError(id: JsonRpcRequest["id"], code: number, message: string): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code, message } })}\n`);
}

function close(): void {
  database.close();
  process.exit(0);
}
