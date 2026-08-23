import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { createInterface } from "node:readline";

import { CuratedKnowledgeToolAuthority } from "../storage/curated-knowledge-tools.js";
import type { CuratedToolLimits } from "../storage/curated-knowledge-tools.js";
import { SqliteCuratedKnowledgeReader, type CuratedSourceType } from "../storage/curated-knowledge-reader.js";
import { openDataRoot } from "../storage/layout.js";

type JsonRpcRequest = { jsonrpc?: string; id?: string | number | null; method?: string; params?: unknown };

const bindingPath = process.env.SCHOLARLOOM_CURATED_BINDING_FILE;
if (!bindingPath) throw new Error("curated-binding-required");
assertPrivateFile(bindingPath, "curated-binding-unsafe");
const binding = JSON.parse(readFileSync(bindingPath, "utf8")) as { dataRoot?: unknown; statePath?: unknown; limits?: unknown };
if (typeof binding.dataRoot !== "string" || typeof binding.statePath !== "string") {
  throw new Error("curated-binding-invalid");
}
const bindingDirectory = resolve(dirname(bindingPath));
const statePath = resolve(binding.statePath);
if (!statePath.startsWith(`${bindingDirectory}${sep}`)) throw new Error("curated-state-path-invalid");

const reader = SqliteCuratedKnowledgeReader.open(openDataRoot(binding.dataRoot));
const authority = new CuratedKnowledgeToolAuthority(reader, curatedLimits(binding.limits));
const readOnlyAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: false,
  openWorldHint: false } as const;

const tools = [
  {
    name: "search_curated_knowledge",
    description: "Search eligible ScholarLoom curated knowledge. Iteratively reformulate queries when coverage is incomplete; do not assume the first results are sufficient.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["query"], properties: {
        query: { type: "string", minLength: 1, maxLength: 2_000 },
        limit: { type: "integer", minimum: 1, maximum: 30 },
        sourceTypes: { type: "array", maxItems: 3, items: { type: "string", enum: ["summary", "takeaway", "topic-knowledge"] } },
        paperIds: { type: "array", maxItems: 100, items: { type: "string", minLength: 1, maxLength: 500 } },
        directionIds: { type: "array", maxItems: 100, items: { type: "string", minLength: 1, maxLength: 500 } },
        topicIds: { type: "array", maxItems: 100, items: { type: "string", minLength: 1, maxLength: 500 } },
        years: { type: "object", additionalProperties: false, properties: {
          from: { type: "integer", minimum: 1000, maximum: 9999 }, to: { type: "integer", minimum: 1000, maximum: 9999 },
        } },
      },
    },
    annotations: readOnlyAnnotations,
  },
  {
    name: "open_curated_source",
    description: "Open one search result by its invocation-local opaque handle. Read the relevant section before citing it.",
    inputSchema: { type: "object", additionalProperties: false, required: ["handle"], properties: {
      handle: { type: "string", pattern: "^curated-source-[0-9]{2}$" },
    } },
    annotations: readOnlyAnnotations,
  },
  {
    name: "verify_curated_citation",
    description: "Verify an exact quote from an opened curated source. Call this for every final citation and copy the returned receipt exactly.",
    inputSchema: { type: "object", additionalProperties: false,
      required: ["handle", "locator", "quote", "whySelected"], properties: {
        handle: { type: "string", pattern: "^curated-source-[0-9]{2}$" },
        locator: { type: "object", additionalProperties: false, required: ["lineStart", "lineEnd"], properties: {
          lineStart: { type: "integer", minimum: 1 }, lineEnd: { type: "integer", minimum: 1 },
        } },
        quote: { type: "string", minLength: 1, maxLength: 1_200 },
        whySelected: { type: "string", minLength: 1, maxLength: 1_000 },
      } },
    annotations: readOnlyAnnotations,
  },
] as const;

persistState();
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
    protocolVersion: "2024-11-05", capabilities: { tools: {} },
    serverInfo: { name: "scholarloom-curated-knowledge", version: "1" },
  });
  if (request.method === "tools/list") return writeResult(request.id, { tools });
  if (request.method !== "tools/call") return writeError(request.id, -32601, "method-not-found");
  const params = request.params as { name?: unknown; arguments?: unknown } | undefined;
  try {
    const args = plainObject(params?.arguments) ? params.arguments : null;
    if (params?.name === "search_curated_knowledge") {
      if (!args || typeof args.query !== "string" || hasUnknownKeys(args,
        ["query", "limit", "sourceTypes", "paperIds", "directionIds", "topicIds", "years"])) {
        throw new Error("curated-search-arguments-invalid");
      }
      const result = authority.search({ query: args.query,
        ...(args.limit === undefined ? {} : { limit: integer(args.limit) }),
        ...(args.sourceTypes === undefined ? {} : { sourceTypes: sourceTypes(args.sourceTypes) }),
        ...(args.paperIds === undefined ? {} : { paperIds: strings(args.paperIds) }),
        ...(args.directionIds === undefined ? {} : { directionIds: strings(args.directionIds) }),
        ...(args.topicIds === undefined ? {} : { topicIds: strings(args.topicIds) }),
        ...(args.years === undefined ? {} : { years: years(args.years) }),
      });
      persistState();
      return toolResult(request.id, result);
    }
    if (params?.name === "open_curated_source") {
      if (!args || typeof args.handle !== "string" || hasUnknownKeys(args, ["handle"])) {
        throw new Error("curated-open-arguments-invalid");
      }
      const result = authority.open(args.handle);
      persistState();
      return toolResult(request.id, result);
    }
    if (params?.name === "verify_curated_citation") {
      if (!args || typeof args.handle !== "string" || typeof args.quote !== "string" ||
          typeof args.whySelected !== "string" || !plainObject(args.locator) ||
          hasUnknownKeys(args, ["handle", "locator", "quote", "whySelected"]) ||
          hasUnknownKeys(args.locator, ["lineStart", "lineEnd"])) throw new Error("curated-verify-arguments-invalid");
      const result = authority.verify({ handle: args.handle,
        locator: { lineStart: integer(args.locator.lineStart), lineEnd: integer(args.locator.lineEnd) },
        quote: args.quote, whySelected: args.whySelected });
      persistState();
      return toolResult(request.id, result);
    }
    throw new Error("curated-tool-unknown");
  } catch (error) {
    persistState();
    return writeResult(request.id, { isError: true, content: [{ type: "text", text: errorCode(error) }] });
  }
}

function persistState(): void {
  const temporary = `${statePath}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(authority.snapshot()), { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, statePath);
}

function sourceTypes(value: unknown): CuratedSourceType[] {
  const values = strings(value);
  if (values.some((entry) => !["summary", "takeaway", "topic-knowledge"].includes(entry))) {
    throw new Error("curated-search-arguments-invalid");
  }
  return values as CuratedSourceType[];
}

function years(value: unknown): { from?: number; to?: number } {
  if (!plainObject(value) || hasUnknownKeys(value, ["from", "to"])) throw new Error("curated-search-arguments-invalid");
  return { ...(value.from === undefined ? {} : { from: integer(value.from) }),
    ...(value.to === undefined ? {} : { to: integer(value.to) }) };
}

function curatedLimits(value: unknown): Partial<CuratedToolLimits> {
  if (value === undefined) return {};
  const keys = ["resultsPerSearch", "uniqueCandidates", "openedSources", "searchCalls", "finalReceipts"] as const;
  if (!plainObject(value) || hasUnknownKeys(value, [...keys])) throw new Error("curated-binding-limits-invalid");
  return Object.fromEntries(keys.flatMap((key) => value[key] === undefined ? [] : [[key, integer(value[key])]]));
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error("curated-search-arguments-invalid");
  }
  return value as string[];
}

function integer(value: unknown): number {
  if (!Number.isInteger(value)) throw new Error("curated-tool-integer-invalid");
  return value as number;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasUnknownKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).some((key) => !allowed.includes(key));
}

function assertPrivateFile(path: string, code: string): void {
  const stat = lstatSync(path);
  const currentUid = process.getuid?.();
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 ||
      (currentUid !== undefined && stat.uid !== currentUid)) throw new Error(code);
}

function toolResult(id: JsonRpcRequest["id"], value: unknown): void {
  writeResult(id, { content: [{ type: "text", text: JSON.stringify(value) }] });
}

function errorCode(error: unknown): string {
  return (error instanceof Error ? error.message : "curated-tool-failed").split(":", 1)[0]!.slice(0, 120);
}

function writeResult(id: JsonRpcRequest["id"], result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: id ?? null, result })}\n`);
}

function writeError(id: JsonRpcRequest["id"], code: number, message: string): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code, message } })}\n`);
}

function close(): void {
  reader.close();
  process.exit(0);
}
