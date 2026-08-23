import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";

import Database from "better-sqlite3";

import type { StorageLayout } from "./layout.js";
import { migrate } from "./migrations.js";

export const CURATED_SEARCH_LIMIT = 30;

export type CuratedSourceType = "summary" | "takeaway" | "topic-knowledge";

export type CuratedSearchInput = {
  query: string;
  limit?: number;
  sourceTypes?: CuratedSourceType[];
  paperIds?: string[];
  directionIds?: string[];
  topicIds?: string[];
  years?: { from?: number; to?: number };
};

export type CuratedSearchResult = {
  handle: string;
  sourceType: CuratedSourceType;
  sourceId: string;
  revisionId: string;
  contentHash: string;
  title: string;
  trustLabel: "generated-from-primary-source" | "user-confirmed";
  matchedSection: string;
  excerpt: string;
};

export type CuratedSearchPage = {
  results: CuratedSearchResult[];
  projection: { stale: boolean; lastSuccessfulAt: string | null };
};

export type CuratedLocator = { lineStart: number; lineEnd: number };

export type CuratedSourceDocument = CuratedSearchResult & {
  sections: Array<{ heading: string | null; locator: CuratedLocator; text: string }>;
};

export type CuratedCitationCandidate = {
  handle: string;
  locator: CuratedLocator;
  quote: string;
};

export type VerifiedCuratedCitation = Omit<CuratedSearchResult, "matchedSection" | "excerpt"> & {
  locator: CuratedLocator;
  quote: string;
};

export type CuratedCitationIdentityInput = Omit<VerifiedCuratedCitation, "handle" | "title" | "trustLabel">;

export type CuratedKnowledgeReader = {
  search(input: CuratedSearchInput): CuratedSearchPage;
  open(handle: string): CuratedSourceDocument;
  verify(input: CuratedCitationCandidate): VerifiedCuratedCitation;
  verifyIdentity(input: CuratedCitationIdentityInput): VerifiedCuratedCitation;
  availability(identity: Pick<VerifiedCuratedCitation, "sourceType" | "sourceId" | "revisionId" | "contentHash">):
    { available: boolean; reason: "available" | "missing" | "ineligible" | "integrity-withheld" };
};

type EligibleRow = {
  source_type: CuratedSourceType;
  source_id: string;
  title: string;
  body: string;
  revision_id: string;
  content_hash: string;
};

type SourceRow = EligibleRow & { markdown_path: string };

export class SqliteCuratedKnowledgeReader implements CuratedKnowledgeReader {
  readonly #layout: StorageLayout;
  readonly #database: Database.Database;

  static open(layout: StorageLayout): SqliteCuratedKnowledgeReader {
    const database = new Database(layout.databasePath);
    database.pragma("foreign_keys = ON");
    database.pragma("busy_timeout = 5000");
    migrate(database);
    return new SqliteCuratedKnowledgeReader(layout, database);
  }

  private constructor(layout: StorageLayout, database: Database.Database) {
    this.#layout = layout;
    this.#database = database;
  }

  search(input: CuratedSearchInput): CuratedSearchPage {
    const query = input.query.trim();
    const limit = input.limit ?? CURATED_SEARCH_LIMIT;
    if (!query || query.length > 2_000 || !Number.isInteger(limit) || limit < 1 || limit > CURATED_SEARCH_LIMIT) {
      throw new Error("curated-search-invalid");
    }
    if (input.sourceTypes?.some((type) => !["summary", "takeaway", "topic-knowledge"].includes(type))) {
      throw new Error("curated-search-invalid");
    }
    if (input.paperIds && (input.paperIds.length > 100 || input.paperIds.some((id) => !id.trim()))) {
      throw new Error("curated-search-invalid");
    }
    const topicConstraints = [...new Set([...(input.directionIds ?? []), ...(input.topicIds ?? [])])];
    if (topicConstraints.length > 100 || topicConstraints.some((id) => !id.trim())) {
      throw new Error("curated-search-invalid");
    }
    if (input.years && ((!validYear(input.years.from) && input.years.from !== undefined) ||
        (!validYear(input.years.to) && input.years.to !== undefined) ||
        (input.years.from !== undefined && input.years.to !== undefined && input.years.from > input.years.to))) {
      throw new Error("curated-search-invalid");
    }
    const clauses: string[] = [];
    const parameters: unknown[] = [toFtsQuery(query)];
    if (input.sourceTypes?.length) {
      clauses.push(`d.source_type IN (${input.sourceTypes.map(() => "?").join(",")})`);
      parameters.push(...input.sourceTypes);
    }
    if (input.paperIds?.length) {
      const placeholders = input.paperIds.map(() => "?").join(",");
      clauses.push(`((d.source_type='summary' AND sp.id IN (${placeholders}))
        OR (d.source_type='takeaway' AND ta.paper_id IN (${placeholders}))
        OR (d.source_type='topic-knowledge' AND EXISTS (SELECT 1 FROM paper_direction_assignments assignment
          WHERE assignment.topic_id=d.source_id AND assignment.paper_id IN (${placeholders}))))`);
      parameters.push(...input.paperIds, ...input.paperIds, ...input.paperIds);
    }
    if (topicConstraints.length) {
      const placeholders = topicConstraints.map(() => "?").join(",");
      clauses.push(`((d.source_type='summary' AND EXISTS (SELECT 1 FROM paper_direction_assignments assignment
          WHERE assignment.paper_id=sp.id AND assignment.topic_id IN (${placeholders})))
        OR (d.source_type='takeaway' AND EXISTS (SELECT 1 FROM paper_direction_assignments assignment
          WHERE assignment.paper_id=ta.paper_id AND assignment.topic_id IN (${placeholders})))
        OR (d.source_type='topic-knowledge' AND d.source_id IN (${placeholders})))`);
      parameters.push(...topicConstraints, ...topicConstraints, ...topicConstraints);
    }
    if (input.years?.from !== undefined) {
      clauses.push(`((d.source_type IN ('summary','takeaway') AND catalog.publication_year>=?)
        OR (d.source_type='topic-knowledge' AND EXISTS (SELECT 1 FROM paper_direction_assignments assignment
          JOIN paper_catalog_documents topic_catalog ON topic_catalog.paper_id=assignment.paper_id
          WHERE assignment.topic_id=d.source_id AND topic_catalog.publication_year>=?)))`);
      parameters.push(input.years.from, input.years.from);
    }
    if (input.years?.to !== undefined) {
      clauses.push(`((d.source_type IN ('summary','takeaway') AND catalog.publication_year<=?)
        OR (d.source_type='topic-knowledge' AND EXISTS (SELECT 1 FROM paper_direction_assignments assignment
          JOIN paper_catalog_documents topic_catalog ON topic_catalog.paper_id=assignment.paper_id
          WHERE assignment.topic_id=d.source_id AND topic_catalog.publication_year<=?)))`);
      parameters.push(input.years.to, input.years.to);
    }
    parameters.push(limit);
    const rows = this.#database.prepare(`SELECT d.source_type,d.source_id,d.title,d.body,
        CASE d.source_type WHEN 'summary' THEN s.id WHEN 'takeaway' THEN tr.id ELSE tkr.id END revision_id,
        CASE d.source_type WHEN 'summary' THEN s.markdown_hash WHEN 'takeaway' THEN tr.markdown_hash
          ELSE tkr.markdown_hash END content_hash
      FROM curated_search_fts f JOIN curated_search_documents d ON d.rowid=f.rowid
      LEFT JOIN summary_revisions s ON d.source_type='summary' AND s.id=d.source_id
        AND s.status='active'
      LEFT JOIN papers sp ON s.paper_id=sp.id AND sp.current_version_id=s.paper_version_id
      LEFT JOIN takeaway_revisions tr ON d.source_type='takeaway' AND tr.id=d.source_id
        AND tr.review_status='confirmed'
      LEFT JOIN takeaways ta ON tr.takeaway_id=ta.id AND ta.active_revision_id=tr.id
      LEFT JOIN paper_catalog_documents catalog ON catalog.paper_id=COALESCE(sp.id,ta.paper_id)
      LEFT JOIN topic_knowledge_revisions tkr ON d.source_type='topic-knowledge' AND tkr.topic_id=d.source_id
        AND tkr.active=1 AND tkr.review_status='confirmed' AND tkr.usage_level='knowledge-ready'
        AND tkr.eligibility_status='eligible'
      LEFT JOIN direction_catalog direction ON direction.topic_id=d.source_id AND direction.revision_id=tkr.id
        AND direction.lifecycle_status='active' AND direction.review_status='confirmed'
      WHERE curated_search_fts MATCH ?
        AND ((d.source_type='summary' AND sp.id IS NOT NULL)
          OR (d.source_type='takeaway' AND ta.id IS NOT NULL)
          OR (d.source_type='topic-knowledge' AND direction.topic_id IS NOT NULL))
        ${clauses.map((clause) => `AND ${clause}`).join("\n")}
      ORDER BY rank,d.source_type,d.source_id LIMIT ?`).all(...parameters) as EligibleRow[];
    const results = rows.map((row) => ({
      handle: sourceHandle(row),
      sourceType: row.source_type,
      sourceId: row.source_id,
      revisionId: row.revision_id,
      contentHash: row.content_hash,
      title: row.title,
      trustLabel: row.source_type === "summary"
        ? "generated-from-primary-source" as const : "user-confirmed" as const,
      matchedSection: "document",
      excerpt: boundedExcerpt(row.body),
    }));
    const state = this.#database.prepare(`SELECT last_successful_at FROM projection_state
      WHERE projection='global-curated'`).get() as { last_successful_at: string | null } | undefined;
    const pending = Number(this.#database.prepare(`SELECT count(*) FROM index_outbox
      WHERE projection='global-curated' AND state='pending'`).pluck().get());
    return { results, projection: { stale: pending > 0, lastSuccessfulAt: state?.last_successful_at ?? null } };
  }

  open(handle: string): CuratedSourceDocument {
    const source = this.#source(handle);
    const markdown = this.#readVault(source.markdown_path);
    if (sha256(markdown) !== source.content_hash) throw new Error("curated-source-integrity-mismatch");
    return {
      ...publicSource(source),
      sections: markdownSections(markdown),
    };
  }

  verify(input: CuratedCitationCandidate): VerifiedCuratedCitation {
    if (!input.quote.trim() || input.quote.length > 1_200 || !validLocator(input.locator)) {
      throw new Error("curated-citation-invalid");
    }
    const source = this.#source(input.handle);
    const markdown = this.#readVault(source.markdown_path);
    if (sha256(markdown) !== source.content_hash) throw new Error("curated-source-integrity-mismatch");
    const lines = markdown.split("\n");
    if (input.locator.lineEnd > lines.length) throw new Error("curated-citation-locator-invalid");
    const selected = lines.slice(input.locator.lineStart - 1, input.locator.lineEnd).join("\n");
    if (!normalizeText(selected).includes(normalizeText(input.quote))) {
      throw new Error("curated-citation-quote-mismatch");
    }
    const { matchedSection: _matchedSection, excerpt: _excerpt, ...identity } = publicSource(source);
    return { ...identity, locator: input.locator, quote: input.quote.trim() };
  }

  verifyIdentity(input: CuratedCitationIdentityInput): VerifiedCuratedCitation {
    if (!input.quote.trim() || input.quote.length > 1_200 || !validLocator(input.locator)) {
      throw new Error("curated-citation-invalid");
    }
    const source = this.#sourceByIdentity(input.sourceType, input.sourceId);
    if (source.revision_id !== input.revisionId || source.content_hash !== input.contentHash) {
      throw new Error("curated-citation-identity-stale");
    }
    const markdown = this.#readVault(source.markdown_path);
    if (sha256(markdown) !== source.content_hash) throw new Error("curated-source-integrity-mismatch");
    verifyQuote(markdown, input.locator, input.quote);
    const { matchedSection: _matchedSection, excerpt: _excerpt, ...identity } = publicSource(source);
    return { ...identity, locator: input.locator, quote: input.quote.trim() };
  }

  availability(identity: Pick<VerifiedCuratedCitation, "sourceType" | "sourceId" | "revisionId" | "contentHash">) {
    let source: SourceRow;
    try { source = this.#sourceByIdentity(identity.sourceType, identity.sourceId); }
    catch (error) {
      if (error instanceof Error && error.message === "curated-source-ineligible") {
        return { available: false as const, reason: "ineligible" as const };
      }
      return { available: false as const, reason: "missing" as const };
    }
    if (source.revision_id !== identity.revisionId) return { available: false as const, reason: "ineligible" as const };
    try {
      const markdown = this.#readVault(source.markdown_path);
      if (sha256(markdown) !== identity.contentHash) {
        return { available: false as const, reason: "integrity-withheld" as const };
      }
    } catch {
      return { available: false as const, reason: "missing" as const };
    }
    return { available: true as const, reason: "available" as const };
  }

  close(): void {
    this.#database.close();
  }

  #readVault(relativePath: string): string {
    const absolute = resolve(this.#layout.vaultRoot, relativePath);
    const prefix = `${resolve(this.#layout.vaultRoot)}${sep}`;
    if (!absolute.startsWith(prefix)) throw new Error("curated-source-path-invalid");
    return readFileSync(absolute, "utf8");
  }

  #source(handle: string): SourceRow {
    const match = /^curated:(summary|takeaway|topic-knowledge):([^:]+):([a-f0-9]{16})$/u.exec(handle);
    if (!match) throw new Error("curated-source-handle-invalid");
    const sourceType = match[1] as CuratedSourceType;
    const sourceId = decodeURIComponent(match[2]!);
    const source = this.#sourceByIdentity(sourceType, sourceId);
    if (!source.content_hash.startsWith(match[3]!)) throw new Error("curated-source-handle-stale");
    return source;
  }

  #sourceByIdentity(sourceType: CuratedSourceType, sourceId: string): SourceRow {
    let row: SourceRow | undefined;
    if (sourceType === "summary") {
      row = this.#database.prepare(`SELECT d.source_type,d.source_id,d.title,d.body,s.id revision_id,
        s.markdown_hash content_hash,s.markdown_path FROM curated_search_documents d
        JOIN summary_revisions s ON s.id=d.source_id JOIN papers p ON p.id=s.paper_id
        WHERE d.source_type='summary' AND d.source_id=? AND s.status='active'
          AND p.current_version_id=s.paper_version_id`).get(sourceId) as SourceRow | undefined;
    } else if (sourceType === "takeaway") {
      row = this.#database.prepare(`SELECT d.source_type,d.source_id,d.title,d.body,tr.id revision_id,
        tr.markdown_hash content_hash,tr.markdown_path FROM curated_search_documents d
        JOIN takeaway_revisions tr ON tr.id=d.source_id JOIN takeaways t ON t.id=tr.takeaway_id
        WHERE d.source_type='takeaway' AND d.source_id=? AND tr.review_status='confirmed'
          AND t.active_revision_id=tr.id`).get(sourceId) as SourceRow | undefined;
    } else {
      row = this.#database.prepare(`SELECT d.source_type,d.source_id,d.title,d.body,r.id revision_id,
        r.markdown_hash content_hash,r.markdown_path FROM curated_search_documents d
        JOIN topic_knowledge_revisions r ON r.topic_id=d.source_id
        JOIN direction_catalog direction ON direction.topic_id=d.source_id AND direction.revision_id=r.id
        WHERE d.source_type='topic-knowledge' AND d.source_id=? AND r.active=1
          AND r.review_status='confirmed' AND r.usage_level='knowledge-ready'
          AND r.eligibility_status='eligible' AND direction.lifecycle_status='active'
          AND direction.review_status='confirmed'`).get(sourceId) as SourceRow | undefined;
    }
    if (!row) throw new Error("curated-source-ineligible");
    return row;
  }
}

function toFtsQuery(query: string): string {
  const terms = query.split(/[^\p{Letter}\p{Number}_-]+/u).filter((term) => [...term].length >= 2);
  const selected = terms.length ? terms : [query];
  return selected.slice(0, 20).map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
}

function sourceHandle(row: Pick<EligibleRow, "source_type" | "source_id" | "content_hash">): string {
  return `curated:${row.source_type}:${encodeURIComponent(row.source_id)}:${row.content_hash.slice(0, 16)}`;
}

function boundedExcerpt(body: string): string {
  const normalized = body.replace(/\s+/gu, " ").trim();
  return normalized.length <= 480 ? normalized : `${normalized.slice(0, 477)}…`;
}

function publicSource(row: EligibleRow): CuratedSearchResult {
  return {
    handle: sourceHandle(row),
    sourceType: row.source_type,
    sourceId: row.source_id,
    revisionId: row.revision_id,
    contentHash: row.content_hash,
    title: row.title,
    trustLabel: row.source_type === "summary" ? "generated-from-primary-source" : "user-confirmed",
    matchedSection: "document",
    excerpt: boundedExcerpt(row.body),
  };
}

function markdownSections(markdown: string): CuratedSourceDocument["sections"] {
  const lines = markdown.split("\n");
  const headings = lines.flatMap((line, index) => {
    const match = /^#{1,6}\s+(.+?)\s*$/u.exec(line);
    return match ? [{ index, heading: match[1]!.trim() }] : [];
  });
  if (headings.length === 0) return [{ heading: null, locator: { lineStart: 1, lineEnd: Math.min(lines.length, 200) },
    text: lines.slice(0, 200).join("\n").slice(0, 8_000) }];
  return headings.slice(0, 12).map((heading, index) => {
    const end = Math.min(lines.length, (headings[index + 1]?.index ?? lines.length));
    const boundedEnd = Math.min(end, heading.index + 200);
    return { heading: heading.heading, locator: { lineStart: heading.index + 1, lineEnd: boundedEnd },
      text: lines.slice(heading.index, boundedEnd).join("\n").slice(0, 8_000) };
  });
}

function validLocator(locator: CuratedLocator): boolean {
  return Boolean(locator) && Number.isInteger(locator.lineStart) && Number.isInteger(locator.lineEnd) &&
    locator.lineStart >= 1 && locator.lineEnd >= locator.lineStart && locator.lineEnd - locator.lineStart <= 200;
}

function validYear(value: number | undefined): boolean {
  return Number.isInteger(value) && value! >= 1000 && value! <= 9999;
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function verifyQuote(markdown: string, locator: CuratedLocator, quote: string): void {
  if (!validLocator(locator) || !quote.trim() || quote.length > 1_200) throw new Error("curated-citation-invalid");
  const lines = markdown.split("\n");
  if (locator.lineEnd > lines.length) throw new Error("curated-citation-locator-invalid");
  const selected = lines.slice(locator.lineStart - 1, locator.lineEnd).join("\n");
  if (!normalizeText(selected).includes(normalizeText(quote))) throw new Error("curated-citation-quote-mismatch");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
