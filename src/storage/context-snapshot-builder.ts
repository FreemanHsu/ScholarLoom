import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";
import { KnowledgeCorpusManifestBuilder, type FrozenKnowledgeCorpus } from "./knowledge-corpus-manifest.js";
import { ContextSnapshotDiffReader, type ContextSnapshotMaterial } from "./context-snapshot-diff.js";
import { isRepositoryMaterialized } from "./repository-materialization.js";

export class ConversationCreationConflict extends Error {
  constructor(
    readonly code: "conversation-context-unchanged" | "conversation-successor-already-exists",
    readonly details: { parentStatus: string } |
      { existingConversationId: string; existingConversationStatus: string },
  ) {
    super(code);
  }
}

export class ContextSnapshotBuilder {
  readonly #corpus: KnowledgeCorpusManifestBuilder;
  readonly #diff: ContextSnapshotDiffReader;

  constructor(
    private readonly database: Database.Database,
    private readonly now: () => Date,
    private readonly repositoryRoot: string,
  ) {
    this.#corpus = new KnowledgeCorpusManifestBuilder(database, now);
    this.#diff = new ContextSnapshotDiffReader(database);
  }

  create(paperId: string, continuedFromConversationId: string | null = null): unknown | null {
    const timestamp = this.now().toISOString();
    const candidate = this.#buildCandidate(paperId);
    if (!candidate) return null;
    if (continuedFromConversationId && !this.database.prepare("SELECT 1 FROM conversations WHERE id=? AND paper_id=?")
      .get(continuedFromConversationId, paperId)) return null;
    const conversationId = `conversation:${randomUUID()}`;
    const snapshotId = `context-snapshot:${randomUUID()}`;
    let frozenVersionDiff: unknown | null = null;
    if (continuedFromConversationId) {
      const parent = this.database.prepare(`SELECT c.status,c.snapshot_integrity,c.active_context_snapshot_id
        FROM conversations c
        WHERE c.id=? AND c.paper_id=?`).get(continuedFromConversationId, paperId) as {
          status: string; snapshot_integrity: string; active_context_snapshot_id: string | null;
        } | undefined;
      if (!parent) return null;
      const comparison = parent.snapshot_integrity === "frozen"
        ? this.#diff.compareWithMaterial(parent.active_context_snapshot_id, candidate.material)
        : { status: "unavailable" };
      if ((comparison as { status: string; identical?: boolean }).status === "available" &&
          (comparison as { identical?: boolean }).identical) {
        throw new ConversationCreationConflict("conversation-context-unchanged", { parentStatus: parent.status });
      }
      const children = this.database.prepare(`SELECT id,status,active_context_snapshot_id
        FROM conversations
        WHERE continued_from_conversation_id=? AND paper_id=?
        ORDER BY created_at,id`).all(continuedFromConversationId, paperId) as Array<{
          id: string; status: string; active_context_snapshot_id: string | null;
        }>;
      for (const child of children) {
        const childComparison = this.#diff.compareWithMaterial(child.active_context_snapshot_id, candidate.material) as {
          status: string; identical?: boolean;
        };
        if (childComparison.status === "available" && childComparison.identical) {
          throw new ConversationCreationConflict("conversation-successor-already-exists", {
            existingConversationId: child.id,
            existingConversationStatus: child.status,
          });
        }
      }
      const parentVersionId = this.database.prepare(`SELECT cs.paper_version_id FROM conversations c
        JOIN context_snapshots cs ON cs.id=c.active_context_snapshot_id WHERE c.id=?`).pluck()
        .get(continuedFromConversationId) as string;
      const versionDiff = this.database.prepare(`SELECT d.id,d.before_version_id,d.after_version_id,d.contract_version,
        d.material_diff_json,d.semantic_diff_json,d.semantic_error,d.artifact_id
        FROM paper_version_diffs d JOIN paper_version_candidates candidate ON candidate.version_diff_id=d.id
        WHERE d.before_version_id=? AND d.after_version_id=? AND d.status='ready'
          AND candidate.preparation_status='accepted' ORDER BY d.updated_at DESC LIMIT 1`).get(
          parentVersionId, candidate.paperVersionId) as { id: string; before_version_id: string; after_version_id: string;
            contract_version: string; material_diff_json: string; semantic_diff_json: string | null;
            semantic_error: string | null; artifact_id: string | null } | undefined;
      if (versionDiff) frozenVersionDiff = { id: versionDiff.id, beforeVersionId: versionDiff.before_version_id,
        afterVersionId: versionDiff.after_version_id, contractVersion: versionDiff.contract_version,
        materialDiff: JSON.parse(versionDiff.material_diff_json),
        semanticDiff: versionDiff.semantic_diff_json ? JSON.parse(versionDiff.semantic_diff_json) : null,
        semanticError: versionDiff.semantic_error, artifactId: versionDiff.artifact_id };
    }
    this.database.transaction(() => {
      const pageElements = this.database.prepare(`SELECT id,page_number FROM document_elements
        WHERE extraction_run_id=? AND element_type='page' ORDER BY page_number`).all(candidate.extractionRunId) as
        Array<{ id: string; page_number: number }>;
      if (pageElements.length === 0) throw new Error("conversation-context-unavailable");
      for (const page of pageElements) {
        const anchorId = `evidence:${candidate.paperVersionId}:page:${page.page_number}:source`;
        this.database.prepare(`INSERT OR IGNORE INTO evidence_anchors
          (id,anchor_type,paper_version_id,extraction_run_id,document_element_id,page_number,quote_text,verification_status,locator_json,created_at)
          VALUES (?,'pdf-page',?,?,?,?,NULL,'located',?,?)`)
          .run(anchorId, candidate.paperVersionId, candidate.extractionRunId, page.id, page.page_number,
            JSON.stringify({ page: page.page_number }), timestamp);
      }
      this.#corpus.persist(candidate.corpus);
      this.database.prepare(`INSERT INTO conversations
        (id,paper_id,active_context_snapshot_id,title,status,snapshot_integrity,continued_from_conversation_id,created_at,updated_at)
        VALUES (?,?,?,'新对话','active','frozen',?,?,?)`)
        .run(conversationId, paperId, snapshotId, continuedFromConversationId, timestamp, timestamp);
      this.database.prepare(`INSERT INTO context_snapshots
        (id,conversation_id,paper_version_id,summary_revision_id,extraction_run_id,repositories_json,created_at,
          knowledge_corpus_manifest_id,version_diff_json)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(snapshotId, conversationId, candidate.paperVersionId, candidate.summaryRevisionId,
          candidate.extractionRunId, JSON.stringify(candidate.frozenRepositories), timestamp, candidate.corpus.id,
          frozenVersionDiff ? JSON.stringify(frozenVersionDiff) : null);
    })();
    return { conversation: { id: conversationId, paperId, title: "新对话", status: "active",
      snapshotIntegrity: "frozen", continuedFromConversationId }, contextSnapshot: { id: snapshotId,
      paperVersionId: candidate.paperVersionId, summaryRevisionId: candidate.summaryRevisionId,
      extractionRunId: candidate.extractionRunId, pageCount: candidate.pageCount,
      knowledgeCorpusManifestId: candidate.corpus.id, repositorySnapshots: candidate.frozenRepositories } };
  }

  preview(conversationId: string): unknown | null {
    const parent = this.database.prepare(`SELECT paper_id,status,snapshot_integrity,active_context_snapshot_id
      FROM conversations WHERE id=?`).get(conversationId) as {
        paper_id: string; status: string; snapshot_integrity: string; active_context_snapshot_id: string | null;
      } | undefined;
    if (!parent) return null;
    const candidate = this.#buildCandidate(parent.paper_id);
    if (!candidate) return { status: "unavailable", parentStatus: parent.status,
      reason: "conversation-context-unavailable" };
    if (parent.snapshot_integrity !== "frozen") return { status: "available", parentStatus: parent.status,
      comparison: { status: "unavailable", reason: "conversation-context-legacy" } };
    const comparison = this.#diff.compareWithMaterial(parent.active_context_snapshot_id, candidate.material) as {
      status: string; identical?: boolean;
    };
    return { status: comparison.status === "available" && comparison.identical ? "no-change" : "available",
      parentStatus: parent.status, comparison };
  }

  #buildCandidate(paperId: string): {
    paperVersionId: string;
    summaryRevisionId: string;
    extractionRunId: string;
    pageCount: number;
    frozenRepositories: Array<{ id: string; commitSha: string }>;
    corpus: FrozenKnowledgeCorpus;
    material: ContextSnapshotMaterial;
  } | null {
    const row = this.database.prepare(`SELECT p.current_version_id,pv.source_type,pv.source_version,
      s.id summary_id,s.revision,s.markdown_hash,s.extraction_run_id,e.page_count,e.extractor_name,e.extractor_version,
      a.content_hash extraction_hash
      FROM papers p JOIN paper_versions pv ON pv.id=p.current_version_id
      JOIN summary_revisions s ON s.paper_id=p.id AND s.paper_version_id=p.current_version_id AND s.status='active'
      JOIN extraction_runs e ON e.id=s.extraction_run_id AND e.paper_version_id=p.current_version_id AND e.status='succeeded'
      LEFT JOIN artifacts a ON a.id=e.output_artifact_id WHERE p.id=?`).get(paperId) as {
        current_version_id: string; source_type: string; source_version: string; summary_id: string; revision: number;
        markdown_hash: string; extraction_run_id: string; page_count: number; extractor_name: string;
        extractor_version: string; extraction_hash: string | null;
      } | undefined;
    if (!row) return null;
    const repositories = this.database.prepare(`SELECT rs.id,rs.commit_sha,rs.local_path,rs.code_repository_id,
      cr.canonical_url,cr.owner_name,cr.repository_name FROM paper_code_links pcl
      JOIN repository_snapshots rs ON rs.id=pcl.repository_snapshot_id
      JOIN code_repositories cr ON cr.id=rs.code_repository_id
      WHERE pcl.paper_id=? AND pcl.status='confirmed' ORDER BY rs.id`).all(paperId) as Array<{
        id: string; commit_sha: string; local_path: string; code_repository_id: string; canonical_url: string;
        owner_name: string | null; repository_name: string | null;
      }>;
    if (repositories.some((repository) =>
      !isRepositoryMaterialized(this.repositoryRoot, repository.local_path, repository.commit_sha))) return null;
    const corpus = this.#corpus.build(paperId);
    const frozenRepositories = repositories.map((repository) => ({ id: repository.id, commitSha: repository.commit_sha }));
    return {
      paperVersionId: row.current_version_id,
      summaryRevisionId: row.summary_id,
      extractionRunId: row.extraction_run_id,
      pageCount: row.page_count,
      frozenRepositories,
      corpus,
      material: {
        id: "latest-context-candidate",
        paperVersion: { id: row.current_version_id, sourceType: row.source_type, sourceVersion: row.source_version },
        summaryRevision: { id: row.summary_id, revision: row.revision, contentHash: row.markdown_hash },
        extractionRun: { id: row.extraction_run_id, extractorName: row.extractor_name,
          extractorVersion: row.extractor_version, outputHash: row.extraction_hash },
        repositories: { status: "available", items: repositories.map((repository) => ({
          repositoryId: repository.code_repository_id,
          snapshotId: repository.id,
          name: repository.repository_name ?? repository.owner_name ?? repository.canonical_url,
          url: repository.canonical_url,
          commitSha: repository.commit_sha,
        })) },
        knowledgeCorpus: { status: "available", id: corpus.id, hash: corpus.hash, manifest: corpus.manifest },
      },
    };
  }
}
