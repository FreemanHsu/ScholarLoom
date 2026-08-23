import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { SqliteCuratedKnowledgeReader } from "../src/storage/curated-knowledge-reader.js";
import { initializeDataRoot } from "../src/storage/layout.js";
import { ImportStore } from "../src/storage/import-store.js";
import { curatedKnowledgeFixture } from "./helpers/curated-knowledge-fixture.js";
import { migrate } from "../src/storage/migrations.js";

describe("CuratedKnowledgeReader", () => {
  it("returns more than eight active curated candidates without exposing ineligible material", async () => {
    const root = await mkdtemp(join(tmpdir(), "scholarloom-curated-reader-"));
    const layout = initializeDataRoot(join(root, "data"));
    const reader = SqliteCuratedKnowledgeReader.open(layout);
    const database = new Database(layout.databasePath);
    database.pragma("foreign_keys = ON");
    migrate(database);
    const now = "2026-08-23T00:00:00.000Z";

    for (let index = 0; index < 12; index += 1) {
      seedSummary(database, layout.vaultRoot, {
        index,
        status: "active",
        body: `Diffusion control candidate ${index} provides curated evidence.`,
        now,
      });
    }
    seedSummary(database, layout.vaultRoot, {
      index: 12,
      status: "superseded",
      body: "Diffusion control INELIGIBLE_REVISION_SENTINEL.",
      now,
    });
    database.prepare(`INSERT INTO curated_search_documents(id,source_type,source_id,title,body,updated_at)
      VALUES ('paper-working-sentinel','paper-working','message:sentinel','Sentinel',
        'Diffusion control PAPER_WORKING_SENTINEL',?)`).run(now);

    const page = reader.search({ query: "Diffusion control", limit: 30 });

    expect(page.results).toHaveLength(12);
    expect(page.results.map((result) => result.title)).toContain("Candidate 11");
    expect(JSON.stringify(page)).not.toContain("INELIGIBLE_REVISION_SENTINEL");
    expect(JSON.stringify(page)).not.toContain("PAPER_WORKING_SENTINEL");
    expect(page.projection).toEqual({ stale: false, lastSuccessfulAt: null });
    expect(reader.search({ query: "Diffusion control", paperIds: ["paper:11"] }).results.map((result) => result.sourceId))
      .toEqual(["summary:11"]);
    expect(reader.search({ query: "Diffusion control", years: { from: 2010, to: 2011 } }).results)
      .toHaveLength(2);
    database.prepare("UPDATE projection_state SET last_successful_at=?,updated_at=? WHERE projection='global-curated'")
      .run(now, now);
    database.prepare(`INSERT INTO index_outbox(projection,source_id,operation,state,created_at)
      VALUES ('global-curated','pending-source','upsert','pending',?)`).run(now);
    expect(reader.search({ query: "Diffusion control" }).projection)
      .toEqual({ stale: true, lastSuccessfulAt: now });
    database.close();
    reader.close();
  });

  it("opens canonical Markdown and verifies an exact bounded quote against its frozen identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "scholarloom-curated-open-"));
    const layout = initializeDataRoot(join(root, "data"));
    const reader = SqliteCuratedKnowledgeReader.open(layout);
    const database = new Database(layout.databasePath);
    database.pragma("foreign_keys = ON");
    seedSummary(database, layout.vaultRoot, {
      index: 0,
      status: "active",
      body: "Diffusion control uses iterative denoising with explicit conditioning.",
      now: "2026-08-23T00:00:00.000Z",
    });
    const result = reader.search({ query: "iterative denoising" }).results[0]!;

    const opened = reader.open(result.handle);
    expect(opened).toMatchObject({
      handle: result.handle,
      sourceType: "summary",
      sourceId: "summary:0",
      revisionId: "summary:0",
      contentHash: result.contentHash,
      title: "Candidate 0",
      trustLabel: "generated-from-primary-source",
    });
    expect(opened).not.toHaveProperty("markdown");
    expect(opened.sections.every((section) => section.text.length <= 8_000)).toBe(true);
    expect(opened.sections[0]).toMatchObject({ heading: "Candidate 0", locator: { lineStart: 1, lineEnd: 4 } });

    const citation = reader.verify({
      handle: result.handle,
      locator: { lineStart: 3, lineEnd: 3 },
      quote: "Diffusion control uses iterative denoising with explicit conditioning.",
    });
    expect(citation).toMatchObject({
      handle: result.handle,
      sourceType: "summary",
      sourceId: "summary:0",
      revisionId: "summary:0",
      quote: "Diffusion control uses iterative denoising with explicit conditioning.",
    });
    expect(() => reader.verify({
      handle: result.handle,
      locator: { lineStart: 3, lineEnd: 3 },
      quote: "A claim that is not present.",
    })).toThrow("curated-citation-quote-mismatch");
    database.close();
    reader.close();
  });

  it("returns equivalent eligible results after a full curated projection rebuild", async () => {
    const fixture = await curatedKnowledgeFixture(Array.from({ length: 10 }, (_, index) => ({
      sourceId: `rebuild-summary-${index}`, title: `Rebuild Candidate ${index}`,
      body: `Rebuild equivalence evidence ${index}.`,
    })));
    const before = fixture.reader.search({ query: "Rebuild equivalence", limit: 30 }).results
      .map(({ sourceType, sourceId, revisionId, contentHash }) => ({ sourceType, sourceId, revisionId, contentHash }));
    const store = ImportStore.open(fixture.layout);
    store.rebuildCuratedProjection();
    store.close();
    const after = fixture.reader.search({ query: "Rebuild equivalence", limit: 30 }).results
      .map(({ sourceType, sourceId, revisionId, contentHash }) => ({ sourceType, sourceId, revisionId, contentHash }));
    expect(after).toEqual(before);
    fixture.close();
  });

  it("mechanically excludes unconfirmed Takeaways and superseded Topic Knowledge", async () => {
    const root = await mkdtemp(join(tmpdir(), "scholarloom-curated-eligibility-"));
    const layout = initializeDataRoot(join(root, "data"));
    const database = new Database(layout.databasePath);
    database.pragma("foreign_keys = ON");
    migrate(database);
    const now = "2026-08-23T00:00:00.000Z";
    seedSummary(database, layout.vaultRoot, { index: 0, status: "active", body: "base", now });
    seedTakeaway(database, layout.vaultRoot, { id: "takeaway-confirmed", revisionId: "takeaway-confirmed:r1",
      reviewStatus: "confirmed", body: "ELIGIBLETAKEAWAY confirmed evidence.", now });
    seedTakeaway(database, layout.vaultRoot, { id: "takeaway-unconfirmed", revisionId: "takeaway-unconfirmed:r1",
      reviewStatus: "needs-review", body: "ELIGIBLETAKEAWAY UNCONFIRMED_SENTINEL.", now });
    seedTopicKnowledge(database, layout.vaultRoot, { topicId: "topic:active", revisionId: "topic:active:r1",
      lifecycleStatus: "active", body: "TOPICKNOWLEDGE active evidence.", now });
    seedTopicKnowledge(database, layout.vaultRoot, { topicId: "topic:superseded", revisionId: "topic:superseded:r1",
      lifecycleStatus: "superseded", body: "TOPICKNOWLEDGE SUPERSEDED_TOPIC_SENTINEL.", now });
    database.prepare(`INSERT INTO paper_direction_assignments(paper_id,topic_id,assignment_role,ordinal)
      VALUES ('paper:0','topic:active','primary',0)`).run();
    const reader = SqliteCuratedKnowledgeReader.open(layout);

    const takeaways = reader.search({ query: "ELIGIBLETAKEAWAY" }).results;
    expect(takeaways.map((result) => result.sourceId)).toEqual(["takeaway-confirmed:r1"]);
    expect(JSON.stringify(takeaways)).not.toContain("UNCONFIRMED_SENTINEL");
    const topics = reader.search({ query: "TOPICKNOWLEDGE" }).results;
    expect(topics.map((result) => result.sourceId)).toEqual(["topic:active"]);
    expect(JSON.stringify(topics)).not.toContain("SUPERSEDED_TOPIC_SENTINEL");
    expect(reader.search({ query: "base", directionIds: ["topic:active"] }).results.map((result) => result.sourceId))
      .toEqual(["summary:0"]);
    reader.close();
    database.close();
  });
});

function seedSummary(database: Database.Database, vaultRoot: string, input: {
  index: number;
  status: "active" | "superseded";
  body: string;
  now: string;
}): void {
  const paperId = `paper:${input.index}`;
  const versionId = `paper-version:${input.index}`;
  const artifactId = `artifact:${input.index}`;
  const extractionId = `extraction:${input.index}`;
  const summaryId = `summary:${input.index}`;
  const markdownPath = `library/papers/paper-${input.index}/summary.md`;
  const markdown = `# Candidate ${input.index}\n\n${input.body}\n`;
  const markdownHash = createHash("sha256").update(markdown).digest("hex");
  const absolute = join(vaultRoot, markdownPath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, markdown, "utf8");
  database.prepare(`INSERT INTO papers(id,title,acquisition_status,origin,lifecycle_status,current_version_id,created_at,updated_at)
    VALUES (?,?,'ingested','manual-import','active',?,?,?)`).run(paperId, `Candidate ${input.index}`, versionId, input.now, input.now);
  database.prepare(`INSERT INTO paper_catalog_documents
    (paper_id,canonical_title,preferred_alias,authors_json,publication_year,search_text,updated_at)
    VALUES (?,?,NULL,'[]',?,?,?)`).run(paperId, `Candidate ${input.index}`, 2000 + input.index,
      `Candidate ${input.index}`, input.now);
  database.prepare(`INSERT INTO artifacts(id,artifact_type,content_hash,storage_ref,media_type,byte_size,
    created_by_kind,retention_class,integrity_status,created_at)
    VALUES (?,'paper-pdf',?,?,'application/pdf',1,'fixture','immutable','verified',?)`)
    .run(artifactId, createHash("sha256").update(`pdf:${input.index}`).digest("hex"),
      `papers/${input.index}.pdf`, input.now);
  database.prepare(`INSERT INTO paper_versions(id,paper_id,source_type,source_version,source_url,resolved_at,
    processing_status,accepted_at,created_at,updated_at,pdf_artifact_id)
    VALUES (?,?,'arxiv','v1',?,?, 'ready',?,?,?,?)`)
    .run(versionId, paperId, `https://example.test/${input.index}`, input.now, input.now, input.now, input.now, artifactId);
  database.prepare(`INSERT INTO extraction_runs(id,paper_version_id,source_artifact_id,extractor_name,extractor_version,
    status,page_count,started_at,completed_at) VALUES (?,?,?,'fixture','1','succeeded',1,?,?)`)
    .run(extractionId, versionId, artifactId, input.now, input.now);
  database.prepare(`INSERT INTO summary_revisions(id,paper_id,paper_version_id,extraction_run_id,revision,status,read_status,
    markdown_path,markdown_hash,structured_json,skill_path,skill_content_hash,canonical_sections_hash,created_at)
    VALUES (?,?,?,?,1,?,'read',?,?,'{}','skills/paper-reading/SKILL.md',?,?,?)`)
    .run(summaryId, paperId, versionId, extractionId, input.status, markdownPath, markdownHash,
      "1".repeat(64), markdownHash, input.now);
  database.prepare(`INSERT INTO curated_search_documents(id,source_type,source_id,title,body,updated_at)
    VALUES (?,'summary',?,?,?,?)`).run(`curated:${summaryId}`, summaryId, `Candidate ${input.index}`, input.body, input.now);
}

function seedTakeaway(database: Database.Database, vaultRoot: string, input: {
  id: string; revisionId: string; reviewStatus: "confirmed" | "needs-review"; body: string; now: string;
}): void {
  const markdownPath = `knowledge/takeaways/${input.id}.md`;
  const markdownHash = writeMarkdown(vaultRoot, markdownPath, `# ${input.id}\n\n${input.body}\n`);
  database.prepare("INSERT INTO takeaways(id,paper_id,active_revision_id,created_at) VALUES (?,'paper:0',?,?)")
    .run(input.id, input.revisionId, input.now);
  database.prepare(`INSERT INTO takeaway_revisions
    (id,takeaway_id,revision,claim,review_status,provenance_json,markdown_path,markdown_hash,confirmed_at)
    VALUES (?,?,1,?,?,'[]',?,?,?)`).run(input.revisionId, input.id, input.body, input.reviewStatus,
      markdownPath, markdownHash, input.now);
  database.prepare(`INSERT INTO curated_search_documents(id,source_type,source_id,title,body,updated_at)
    VALUES (?,'takeaway',?,?,?,?)`).run(`curated:${input.revisionId}`, input.revisionId, input.id, input.body, input.now);
}

function seedTopicKnowledge(database: Database.Database, vaultRoot: string, input: {
  topicId: string; revisionId: string; lifecycleStatus: "active" | "superseded"; body: string; now: string;
}): void {
  const markdownPath = `knowledge/directions/${encodeURIComponent(input.topicId)}.md`;
  const markdownHash = writeMarkdown(vaultRoot, markdownPath, `# ${input.topicId}\n\n${input.body}\n`);
  database.prepare(`INSERT INTO direction_catalog
    (topic_id,title,aliases_json,scope,usage_level,lifecycle_status,superseded_by,revision_id,revision_number,
     review_status,markdown_path,markdown_hash,created_at,updated_at)
    VALUES (?,?,'[]','scope','knowledge-ready',?,NULL,?,1,'confirmed',?,?,?,?)`)
    .run(input.topicId, input.topicId, input.lifecycleStatus, input.revisionId, markdownPath, markdownHash,
      input.now, input.now);
  database.prepare(`INSERT INTO topic_knowledge_revisions
    (id,topic_id,revision_number,usage_level,review_status,epistemic_status,markdown_path,markdown_hash,
     history_path,knowledge_body_hash,provenance_json,owner_attested,eligibility_status,active,confirmed_at,created_at)
    VALUES (?,?,1,'knowledge-ready','confirmed','evidence-backed',?,?,NULL,?,'[]',1,'eligible',1,?,?)`)
    .run(input.revisionId, input.topicId, markdownPath, markdownHash, markdownHash, input.now, input.now);
  database.prepare(`INSERT INTO curated_search_documents(id,source_type,source_id,title,body,updated_at)
    VALUES (?,'topic-knowledge',?,?,?,?)`).run(`curated:${input.topicId}`, input.topicId,
      input.topicId, input.body, input.now);
}

function writeMarkdown(vaultRoot: string, markdownPath: string, markdown: string): string {
  const absolute = join(vaultRoot, markdownPath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, markdown, "utf8");
  return createHash("sha256").update(markdown).digest("hex");
}
