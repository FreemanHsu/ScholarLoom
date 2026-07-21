import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, join, normalize, relative } from "node:path";

export type ProposedCitation = { path: string; lineStart: number; lineEnd: number; quote: string };

export type GroundedReceipt = {
  evidenceKind: "pdf" | "summary" | "code" | "library" | "visual";
  sourceId: string;
  sourceRevision: string | null;
  workspacePath: string;
  contentHash: string;
  quote: string;
  locator: Record<string, unknown> & { lineStart: number; lineEnd: number };
};

type ManifestSource = {
  kind: "pdf" | "summary" | "code" | "library" | "conversation" | "visual";
  path: string;
  sourceId: string;
  revision?: string;
  contentHash: string;
  citable: boolean;
  locator?: Record<string, unknown>;
};

export class AnswerGroundingGate {
  static open(workspaceRoot: string): AnswerGroundingGate {
    return new AnswerGroundingGate(workspaceRoot);
  }

  readonly #sources: Map<string, ManifestSource>;

  private constructor(private readonly workspaceRoot: string) {
    const manifest = JSON.parse(readFileSync(join(workspaceRoot, "MANIFEST.json"), "utf8")) as { sources?: ManifestSource[] };
    if (!Array.isArray(manifest.sources)) throw new Error("grounding-manifest-invalid");
    this.#sources = new Map(manifest.sources.map((source) => [source.path, source]));
  }

  verify(citations: ProposedCitation[]): GroundedReceipt[] {
    return citations.map((citation) => {
      const source = this.#sources.get(citation.path);
      if (!source) throw new Error(`citation-source-unknown:${citation.path}`);
      if (!source.citable || source.kind === "conversation") throw new Error(`citation-scope-forbidden:${citation.path}`);
      if (!Number.isInteger(citation.lineStart) || !Number.isInteger(citation.lineEnd) || citation.lineStart < 1 ||
          citation.lineEnd < citation.lineStart || citation.lineEnd - citation.lineStart > 200) {
        throw new Error("citation-line-range-invalid");
      }
      if (!citation.quote || citation.quote.length > 500) throw new Error("citation-quote-invalid");
      const absolute = this.#resolve(citation.path);
      const bytes = readFileSync(absolute);
      const text = bytes.toString("utf8");
      const lines = text.split(/\r?\n/);
      if (citation.lineEnd > lines.length) throw new Error("citation-line-range-invalid");
      const selected = lines.slice(citation.lineStart - 1, citation.lineEnd).join("\n");
      if (!normalizeText(selected).includes(normalizeText(citation.quote))) throw new Error("citation-quote-mismatch");
      const fullHash = createHash("sha256").update(bytes).digest("hex");
      const contentStartLine = typeof source.locator?.contentStartLine === "number" ? source.locator.contentStartLine : null;
      const contentHash = contentStartLine === null ? fullHash : createHash("sha256")
        .update(lines.slice(contentStartLine - 1).join("\n").replace(/\n$/, "")).digest("hex");
      if (source.contentHash !== fullHash && source.contentHash !== contentHash) throw new Error("citation-content-hash-mismatch");
      return {
        evidenceKind: source.kind,
        sourceId: source.sourceId,
        sourceRevision: source.revision ?? null,
        workspacePath: source.path,
        contentHash: source.contentHash,
        quote: citation.quote,
        locator: { ...(source.locator ?? {}), lineStart: citation.lineStart, lineEnd: citation.lineEnd },
      } as GroundedReceipt;
    });
  }

  repair(citations: ProposedCitation[]): GroundedReceipt[] {
    const repaired = citations.map((citation) => {
      const source = this.#sources.get(citation.path);
      if (!source?.citable || source.kind === "conversation" || !citation.quote || citation.quote.length > 500) return citation;
      const lines = readFileSync(this.#resolve(citation.path), "utf8").split(/\r?\n/);
      const matches = lines.flatMap((line, index) => normalizeText(line).includes(normalizeText(citation.quote))
        ? [{ lineStart: index + 1, lineEnd: index + 1 }] : []);
      return matches.length === 1 ? { ...citation, ...matches[0] } : citation;
    });
    return this.verify(repaired);
  }

  #resolve(path: string): string {
    if (isAbsolute(path) || normalize(path).startsWith("..")) throw new Error("citation-path-unsafe");
    const absolute = join(this.workspaceRoot, path);
    if (relative(this.workspaceRoot, absolute).startsWith("..")) throw new Error("citation-path-unsafe");
    return absolute;
  }
}

function normalizeText(value: string): string {
  return value.normalize("NFC").replace(/\s+/g, " ").trim();
}
