import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import Database from "better-sqlite3";

import { SqliteCuratedKnowledgeReader } from "../../src/storage/curated-knowledge-reader.js";
import { initializeDataRoot } from "../../src/storage/layout.js";
import { migrate } from "../../src/storage/migrations.js";

export async function curatedKnowledgeFixture(documents: Array<{ sourceId: string; title: string; body: string }>) {
  const root = await mkdtemp(join(tmpdir(), "scholarloom-curated-fixture-"));
  const layout = initializeDataRoot(join(root, "data"));
  const database = new Database(layout.databasePath);
  database.pragma("foreign_keys = ON");
  migrate(database);
  const now = "2026-08-23T00:00:00.000Z";
  documents.forEach((document, index) => seedSummary(database, layout.vaultRoot, document, index, now));
  const reader = SqliteCuratedKnowledgeReader.open(layout);
  return { layout, database, reader, close() { reader.close(); database.close(); } };
}

function seedSummary(database: Database.Database, vaultRoot: string,
  document: { sourceId: string; title: string; body: string }, index: number, now: string): void {
  const paperId = `paper:${document.sourceId}`;
  const versionId = `paper-version:${document.sourceId}`;
  const artifactId = `artifact:${document.sourceId}`;
  const extractionId = `extraction:${document.sourceId}`;
  const markdownPath = `library/papers/${encodeURIComponent(document.sourceId)}/summary.md`;
  const markdown = `# ${document.title}\n\n${document.body}\n`;
  const markdownHash = sha256(markdown);
  const absolute = join(vaultRoot, markdownPath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, markdown, "utf8");
  database.prepare(`INSERT INTO papers(id,title,acquisition_status,origin,lifecycle_status,current_version_id,created_at,updated_at)
    VALUES (?,?,'ingested','manual-import','active',?,?,?)`).run(paperId, document.title, versionId, now, now);
  database.prepare(`INSERT INTO paper_catalog_documents
    (paper_id,canonical_title,preferred_alias,authors_json,publication_year,search_text,updated_at)
    VALUES (?,?,NULL,'[]',?,?,?)`).run(paperId, document.title, 2000 + index, document.title, now);
  database.prepare(`INSERT INTO artifacts(id,artifact_type,content_hash,storage_ref,media_type,byte_size,
    created_by_kind,retention_class,integrity_status,created_at)
    VALUES (?,'paper-pdf',?,?,'application/pdf',1,'fixture','immutable','verified',?)`)
    .run(artifactId, sha256(`pdf:${document.sourceId}`), `papers/${encodeURIComponent(document.sourceId)}.pdf`, now);
  database.prepare(`INSERT INTO paper_versions(id,paper_id,source_type,source_version,source_url,resolved_at,
    processing_status,accepted_at,created_at,updated_at,pdf_artifact_id)
    VALUES (?,?,'arxiv','v1',?,?,'ready',?,?,?,?)`)
    .run(versionId, paperId, `https://example.test/${encodeURIComponent(document.sourceId)}`, now, now, now, now, artifactId);
  database.prepare(`INSERT INTO extraction_runs(id,paper_version_id,source_artifact_id,extractor_name,extractor_version,
    status,page_count,started_at,completed_at) VALUES (?,?,?,'fixture','1','succeeded',1,?,?)`)
    .run(extractionId, versionId, artifactId, now, now);
  database.prepare(`INSERT INTO summary_revisions(id,paper_id,paper_version_id,extraction_run_id,revision,status,read_status,
    markdown_path,markdown_hash,structured_json,skill_path,skill_content_hash,canonical_sections_hash,created_at)
    VALUES (?,?,?,?,1,'active','read',?,?,'{}','skills/paper-reading/SKILL.md',?,?,?)`)
    .run(document.sourceId, paperId, versionId, extractionId, markdownPath, markdownHash,
      "1".repeat(64), markdownHash, now);
  database.prepare(`INSERT INTO curated_search_documents(id,source_type,source_id,title,body,updated_at)
    VALUES (?,'summary',?,?,?,?)`).run(`curated:${document.sourceId}`, document.sourceId,
      document.title, document.body, now);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
