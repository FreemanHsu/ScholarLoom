import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, join, normalize, relative } from "node:path";
import type Database from "better-sqlite3";

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
  static open(workspaceRoot: string, database?: Database.Database, contextSnapshotId?: string): AnswerGroundingGate {
    return new AnswerGroundingGate(workspaceRoot, database, contextSnapshotId);
  }

  readonly #sources: Map<string, ManifestSource>;

  private constructor(private readonly workspaceRoot: string, database?: Database.Database, contextSnapshotId?: string) {
    const manifest = JSON.parse(readFileSync(join(workspaceRoot, "MANIFEST.json"), "utf8")) as { sources?: ManifestSource[] };
    if (!Array.isArray(manifest.sources)) throw new Error("grounding-manifest-invalid");
    this.#sources = new Map(manifest.sources.map((source) => [source.path, source]));
    if (database && contextSnapshotId) for (const source of manifest.sources) this.#verifyAuthority(database, contextSnapshotId, source);
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
      if (contentStartLine !== null && citation.lineStart < contentStartLine) throw new Error("citation-metadata-not-citable");
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

  #verifyAuthority(database: Database.Database, snapshotId: string, source: ManifestSource): void {
    if (source.kind === "conversation") {
      if (source.sourceId !== snapshotId) throw new Error("grounding-authority-mismatch");
      return;
    }
    if (source.kind === "pdf") {
      const row = database.prepare(`SELECT de.text_content FROM context_snapshots cs JOIN document_elements de
        ON de.extraction_run_id=cs.extraction_run_id WHERE cs.id=? AND cs.paper_version_id=? AND cs.extraction_run_id=?
        AND de.id=? AND de.page_number=?`).get(snapshotId, source.sourceId, source.revision,
          source.locator?.elementId, source.locator?.page) as { text_content: string } | undefined;
      if (!row || createHash("sha256").update(row.text_content).digest("hex") !== source.contentHash) throw new Error("grounding-authority-mismatch");
      return;
    }
    if (source.kind === "summary") {
      const row = database.prepare(`SELECT s.markdown_hash FROM context_snapshots cs JOIN summary_revisions s
        ON s.id=cs.summary_revision_id WHERE cs.id=? AND s.id=?`).get(snapshotId, source.sourceId) as { markdown_hash: string } | undefined;
      if (!row || row.markdown_hash !== source.contentHash) throw new Error("grounding-authority-mismatch");
      return;
    }
    if (source.kind === "code") {
      const row = database.prepare("SELECT repositories_json FROM context_snapshots WHERE id=?").get(snapshotId) as { repositories_json: string } | undefined;
      const owned = row && (JSON.parse(row.repositories_json) as Array<{ id: string; commitSha: string }>)
        .some((item) => item.id === source.sourceId && item.commitSha === source.revision);
      if (!owned) throw new Error("grounding-authority-mismatch");
      return;
    }
    if (source.kind === "library") {
      const row = database.prepare(`SELECT m.manifest_json FROM context_snapshots cs JOIN knowledge_corpus_manifests m
        ON m.id=cs.knowledge_corpus_manifest_id WHERE cs.id=?`).get(snapshotId) as { manifest_json: string } | undefined;
      const manifest = row ? JSON.parse(row.manifest_json) as { summaries: Array<{ revisionId: string; contentHash: string }>;
        knowledge: Array<{ revisionId: string; contentHash: string }> } : null;
      const owned = manifest && [...manifest.summaries, ...manifest.knowledge]
        .some((item) => item.revisionId === source.sourceId && item.contentHash === source.contentHash);
      if (!owned) throw new Error("grounding-authority-mismatch");
    }
  }
}

function normalizeText(value: string): string {
  return value.normalize("NFC").replace(/\s+/g, " ").trim();
}
