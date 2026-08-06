import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, normalize, relative } from "node:path";
import type Database from "better-sqlite3";
import type { StorageLayout } from "./layout.js";

export type TextProposedCitation = {
  kind: "text";
  path: string;
  lineStart: number;
  lineEnd: number;
  quote: string;
};

export type VisualProposedCitation = {
  kind: "visual";
  sourceId: string;
  page: number;
  imageHash: string;
  observation: string;
};

export type ProposedCitation = TextProposedCitation | VisualProposedCitation;

export type GroundedTextReceipt = {
  evidenceKind: "pdf" | "summary" | "code" | "library";
  sourceId: string;
  sourceRevision: string | null;
  workspacePath: string;
  contentHash: string;
  quote: string;
  locator: Record<string, unknown> & { lineStart: number; lineEnd: number };
};

export type GroundedVisualReceipt = {
  evidenceKind: "visual";
  sourceId: string;
  sourceRevision: string | null;
  sourceArtifactId: string;
  sourceContentHash: string;
  page: number;
  rendererName: string;
  rendererVersion: string;
  rendererFingerprint: string;
  renderSettings: Record<string, unknown>;
  renderArtifactId: string;
  imageHash: string;
  observation: string;
};

export type GroundedReceipt = GroundedTextReceipt | GroundedVisualReceipt;

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
  static open(workspaceRoot: string, database?: Database.Database, contextSnapshotId?: string,
    visualAttempt?: { attemptId: string; runEpoch: number; layout: StorageLayout }): AnswerGroundingGate {
    return new AnswerGroundingGate(workspaceRoot, database, contextSnapshotId, visualAttempt);
  }

  readonly #sources: Map<string, ManifestSource>;

  private constructor(private readonly workspaceRoot: string, private readonly database?: Database.Database,
    private readonly contextSnapshotId?: string,
    private readonly visualAttempt?: { attemptId: string; runEpoch: number; layout: StorageLayout }) {
    const manifest = JSON.parse(readFileSync(join(workspaceRoot, "MANIFEST.json"), "utf8")) as { sources?: ManifestSource[] };
    if (!Array.isArray(manifest.sources)) throw new Error("grounding-manifest-invalid");
    this.#sources = new Map(manifest.sources.map((source) => [source.path, source]));
    if (database && contextSnapshotId) for (const source of manifest.sources) this.#verifyAuthority(database, contextSnapshotId, source);
  }

  verify(citations: ProposedCitation[]): GroundedReceipt[] {
    return citations.map((citation) => {
      if (citation.kind === "visual") return this.#verifyVisual(citation);
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
      } as GroundedTextReceipt;
    });
  }

  repair(citations: ProposedCitation[]): GroundedReceipt[] {
    const repaired = citations.map((citation) => {
      if (citation.kind === "visual") return citation;
      const source = this.#sources.get(citation.path);
      if (!source?.citable || source.kind === "conversation" || !citation.quote || citation.quote.length > 500) return citation;
      const lines = readFileSync(this.#resolve(citation.path), "utf8").split(/\r?\n/);
      const contentStartLine = typeof source.locator?.contentStartLine === "number" ? source.locator.contentStartLine : 1;
      const match = locateUniqueLineRange(lines, citation.quote, contentStartLine) ??
        (source.kind === "pdf" ? locateUniquePdfDehyphenatedRange(lines, citation.quote, contentStartLine) : null);
      return match ? { ...citation, ...match } : citation;
    });
    return this.verify(repaired);
  }

  #resolve(path: string): string {
    if (isAbsolute(path) || normalize(path).startsWith("..")) throw new Error("citation-path-unsafe");
    const absolute = join(this.workspaceRoot, path);
    if (relative(this.workspaceRoot, absolute).startsWith("..")) throw new Error("citation-path-unsafe");
    return absolute;
  }

  #verifyVisual(citation: VisualProposedCitation): GroundedVisualReceipt {
    if (!this.database || !this.contextSnapshotId || !this.visualAttempt) throw new Error("visual-citation-verifier-unavailable");
    if (!Number.isInteger(citation.page) || citation.page < 1 || !/^[a-f0-9]{64}$/.test(citation.imageHash) ||
        !citation.observation || [...citation.observation].length > 1000) throw new Error("visual-citation-invalid");
    const row = this.database.prepare(`SELECT cs.paper_version_id,cs.extraction_run_id,source.id source_artifact_id,
      source.content_hash source_content_hash,extraction.page_count,inspection.render_artifact_id,
      render.renderer_name,render.renderer_version,render.renderer_fingerprint,render.render_settings_json,
      render.image_content_hash,render.storage_ref,render.byte_size,render.cache_state
      FROM job_runs job JOIN conversation_turn_attempts attempt ON attempt.job_run_id=job.id
      JOIN messages user_message ON user_message.id=attempt.user_message_id
      JOIN context_snapshots cs ON cs.id=user_message.context_snapshot_id
      JOIN paper_versions version ON version.id=cs.paper_version_id
      JOIN artifacts source ON source.id=version.pdf_artifact_id
      JOIN extraction_runs extraction ON extraction.id=cs.extraction_run_id
      JOIN visual_page_inspections inspection ON inspection.job_run_id=job.id AND inspection.run_epoch=job.run_epoch
        AND inspection.source_artifact_id=source.id AND inspection.page_number=? AND inspection.inspection_status='ready'
      JOIN visual_render_artifacts render ON render.id=inspection.render_artifact_id
      WHERE job.id=? AND job.run_epoch=? AND job.state='running' AND cs.id=? AND cs.paper_version_id=?`)
      .get(citation.page, this.visualAttempt.attemptId, this.visualAttempt.runEpoch, this.contextSnapshotId, citation.sourceId) as {
        paper_version_id: string; extraction_run_id: string; source_artifact_id: string; source_content_hash: string;
        page_count: number; render_artifact_id: string; renderer_name: string; renderer_version: string;
        renderer_fingerprint: string; render_settings_json: string; image_content_hash: string; storage_ref: string;
        byte_size: number; cache_state: string;
      } | undefined;
    if (!row || citation.page > row.page_count) throw new Error("visual-citation-source-unknown");
    if (row.cache_state !== "complete" || row.image_content_hash !== citation.imageHash) throw new Error("visual-citation-hash-mismatch");
    const imagePath = join(this.visualAttempt.layout.root, row.storage_ref);
    const fromDerived = relative(this.visualAttempt.layout.derivedRoot, imagePath);
    if (!fromDerived || fromDerived.startsWith("..") || isAbsolute(fromDerived)) throw new Error("visual-citation-path-unsafe");
    const stat = lstatSync(imagePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== row.byte_size) {
      throw new Error("visual-citation-artifact-invalid");
    }
    if (createHash("sha256").update(readFileSync(imagePath)).digest("hex") !== citation.imageHash) {
      throw new Error("visual-citation-hash-mismatch");
    }
    return { evidenceKind: "visual", sourceId: row.paper_version_id, sourceRevision: row.extraction_run_id,
      sourceArtifactId: row.source_artifact_id, sourceContentHash: row.source_content_hash, page: citation.page,
      rendererName: row.renderer_name, rendererVersion: row.renderer_version,
      rendererFingerprint: row.renderer_fingerprint,
      renderSettings: JSON.parse(row.render_settings_json) as Record<string, unknown>,
      renderArtifactId: row.render_artifact_id, imageHash: row.image_content_hash, observation: citation.observation };
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

function locateUniqueLineRange(lines: string[], quote: string, contentStartLine: number): { lineStart: number; lineEnd: number } | null {
  const segments: Array<{ line: number; start: number; end: number }> = [];
  let searchable = "";
  for (let index = Math.max(0, contentStartLine - 1); index < lines.length; index += 1) {
    const normalized = normalizeText(lines[index]!);
    if (!normalized) continue;
    if (searchable) searchable += " ";
    const start = searchable.length;
    searchable += normalized;
    segments.push({ line: index + 1, start, end: searchable.length });
  }
  const needle = normalizeText(quote);
  if (!needle) return null;
  const offset = searchable.indexOf(needle);
  if (offset === -1 || searchable.indexOf(needle, offset + 1) !== -1) return null;
  const first = segmentAtOffset(segments, offset);
  const last = segmentAtOffset(segments, offset + needle.length - 1);
  return first && last ? { lineStart: first.line, lineEnd: last.line } : null;
}

function locateUniquePdfDehyphenatedRange(lines: string[], quote: string,
  contentStartLine: number): { lineStart: number; lineEnd: number; quote: string } | null {
  const firstLineIndex = Math.max(0, contentStartLine - 1);
  const searchable = lines.slice(firstLineIndex).join("\n").normalize("NFC");
  const match = locateUniqueNormalizedMatch(searchable, quote);
  if (!match) return null;
  const repairedQuote = searchable.slice(match.start, match.end);
  if (!repairedQuote || repairedQuote.length > 500) return null;
  const lineStart = firstLineIndex + 1 + countNewlines(searchable, match.start);
  const lineEnd = firstLineIndex + 1 + countNewlines(searchable, match.end);
  return { lineStart, lineEnd, quote: repairedQuote };
}

function locateUniqueNormalizedMatch(value: string, quote: string): { start: number; end: number } | null {
  const searchable = normalizePdfTextWithOffsets(value);
  const needle = normalizePdfTextWithOffsets(quote).text;
  if (!needle) return null;
  const offset = searchable.text.indexOf(needle);
  if (offset === -1 || searchable.text.indexOf(needle, offset + 1) !== -1) return null;
  const first = searchable.offsets[offset];
  const last = searchable.offsets[offset + needle.length - 1];
  return first && last ? { start: first.start, end: last.end } : null;
}

function normalizePdfTextWithOffsets(value: string): {
  text: string;
  offsets: Array<{ start: number; end: number }>;
} {
  const input = value.normalize("NFC");
  const characters: Array<{ value: string; start: number; end: number }> = [];
  for (let index = 0; index < input.length;) {
    const character = String.fromCodePoint(input.codePointAt(index)!);
    const end = index + character.length;
    if (character === "-" && isUnicodeLetter(characters.at(-1)?.value)) {
      let next = end;
      while (next < input.length) {
        const whitespace = String.fromCodePoint(input.codePointAt(next)!);
        if (!/^\s$/u.test(whitespace)) break;
        next += whitespace.length;
      }
      const following = next < input.length ? String.fromCodePoint(input.codePointAt(next)!) : "";
      if (next > end && /^\p{Ll}$/u.test(following)) {
        index = next;
        continue;
      }
    }
    characters.push({ value: character, start: index, end });
    index = end;
  }

  const normalized: typeof characters = [];
  for (const character of characters) {
    if (/^\s$/u.test(character.value)) {
      if (normalized.length === 0) continue;
      const previous = normalized.at(-1)!;
      if (previous.value === " ") previous.end = character.end;
      else normalized.push({ value: " ", start: character.start, end: character.end });
      continue;
    }
    normalized.push(character);
  }
  if (normalized.at(-1)?.value === " ") normalized.pop();

  const offsets: Array<{ start: number; end: number }> = [];
  for (const character of normalized) {
    for (let index = 0; index < character.value.length; index += 1) {
      offsets.push({ start: character.start, end: character.end });
    }
  }
  return { text: normalized.map((character) => character.value).join(""), offsets };
}

function isUnicodeLetter(value: string | undefined): boolean { return Boolean(value && /^\p{L}$/u.test(value)); }

function countNewlines(value: string, end: number): number {
  let count = 0;
  for (let index = 0; index < end; index += 1) if (value[index] === "\n") count += 1;
  return count;
}

function segmentAtOffset(segments: Array<{ line: number; start: number; end: number }>, offset: number) {
  let low = 0;
  let high = segments.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const segment = segments[middle]!;
    if (offset < segment.start) high = middle - 1;
    else if (offset >= segment.end) low = middle + 1;
    else return segment;
  }
  return null;
}
