import type Database from "better-sqlite3";

export type ManifestSummary = { paperId: string; revisionId: string; markdownPath: string; contentHash: string };
export type ManifestKnowledge = { paperId: string; revisionId: string; markdownPath: string; contentHash: string };
export type ContextKnowledgeManifest = { summaries: ManifestSummary[]; knowledge: ManifestKnowledge[] };

export type ContextSnapshotMaterial = {
  id: string;
  paperVersion: { id: string; sourceType: string; sourceVersion: string };
  summaryRevision: { id: string; revision: number; contentHash: string };
  extractionRun: {
    id: string;
    extractorName: string;
    extractorVersion: string;
    outputHash: string | null;
  };
  repositories: {
    status: "available" | "unavailable";
    reason?: string;
    items: Array<{
      repositoryId: string;
      snapshotId: string;
      name: string;
      url: string;
      commitSha: string;
    }>;
  };
  knowledgeCorpus: {
    status: "available";
    id: string;
    hash: string;
    manifest: ContextKnowledgeManifest;
  } | {
    status: "unavailable";
    reason: string;
  };
};

function scalar<T>(before: T, after: T, identical: boolean) {
  return { status: identical ? "unchanged" as const : "changed" as const, before, after };
}

function tupleKey(entry: ManifestKnowledge): string {
  return `${entry.paperId}\u0000${entry.revisionId}\u0000${entry.contentHash}`;
}

export class ContextSnapshotDiffReader {
  constructor(private readonly database: Database.Database) {}

  compare(beforeSnapshotId: string | null, afterSnapshotId: string | null): unknown {
    if (!beforeSnapshotId || !afterSnapshotId) {
      return { status: "unavailable", reason: "conversation-context-incomplete" };
    }
    const before = this.read(beforeSnapshotId);
    const after = this.read(afterSnapshotId);
    if (!before || !after) return { status: "unavailable", reason: "conversation-context-incomplete" };
    return this.compareMaterials(before, after);
  }

  compareWithMaterial(beforeSnapshotId: string | null, after: ContextSnapshotMaterial): unknown {
    if (!beforeSnapshotId) return { status: "unavailable", reason: "conversation-context-incomplete" };
    const before = this.read(beforeSnapshotId);
    if (!before) return { status: "unavailable", reason: "conversation-context-incomplete" };
    return this.compareMaterials(before, after);
  }

  compareMaterials(before: ContextSnapshotMaterial, after: ContextSnapshotMaterial): unknown {
    const paperVersion = scalar(before.paperVersion, after.paperVersion, before.paperVersion.id === after.paperVersion.id);
    const summaryRevision = scalar(before.summaryRevision, after.summaryRevision,
      before.summaryRevision.id === after.summaryRevision.id);
    const extractionRun = this.#compareExtraction(before.extractionRun, after.extractionRun);
    const repositories = this.#compareRepositories(before.repositories, after.repositories);
    const knowledgeCorpus = this.#compareKnowledge(before.knowledgeCorpus, after.knowledgeCorpus);
    const identical = paperVersion.status === "unchanged" && summaryRevision.status === "unchanged" &&
      extractionRun.status === "unchanged" && repositories.status === "available" &&
      repositories.added.length === 0 && repositories.removed.length === 0 && repositories.changed.length === 0 &&
      knowledgeCorpus.status === "unchanged";
    return { status: "available", identical,
      diff: { paperVersion, summaryRevision, extractionRun, repositories, knowledgeCorpus } };
  }

  read(snapshotId: string): ContextSnapshotMaterial | null {
    const row = this.database.prepare(`SELECT cs.id,cs.paper_version_id,cs.summary_revision_id,cs.extraction_run_id,
      cs.repositories_json,cs.knowledge_corpus_manifest_id,pv.source_type,pv.source_version,
      sr.revision,sr.markdown_hash,er.extractor_name,er.extractor_version,a.content_hash extraction_hash,
      kcm.manifest_hash,kcm.manifest_json
      FROM context_snapshots cs
      JOIN paper_versions pv ON pv.id=cs.paper_version_id
      JOIN summary_revisions sr ON sr.id=cs.summary_revision_id
      JOIN extraction_runs er ON er.id=cs.extraction_run_id
      LEFT JOIN artifacts a ON a.id=er.output_artifact_id
      JOIN knowledge_corpus_manifests kcm ON kcm.id=cs.knowledge_corpus_manifest_id
      WHERE cs.id=?`).get(snapshotId) as {
        id: string; paper_version_id: string; summary_revision_id: string; extraction_run_id: string;
        repositories_json: string; knowledge_corpus_manifest_id: string; source_type: string; source_version: string;
        revision: number; markdown_hash: string; extractor_name: string; extractor_version: string;
        extraction_hash: string | null; manifest_hash: string; manifest_json: string;
      } | undefined;
    if (!row) return null;
    let repositories: ContextSnapshotMaterial["repositories"];
    try {
      const frozen = JSON.parse(row.repositories_json) as Array<{ id?: unknown; commitSha?: unknown }>;
      if (!Array.isArray(frozen)) throw new Error("not-array");
      const items = frozen.map((item) => {
        if (typeof item.id !== "string" || typeof item.commitSha !== "string") throw new Error("invalid-entry");
        const repository = this.database.prepare(`SELECT rs.id,rs.code_repository_id,rs.commit_sha,
          cr.canonical_url,cr.owner_name,cr.repository_name FROM repository_snapshots rs
          JOIN code_repositories cr ON cr.id=rs.code_repository_id WHERE rs.id=?`).get(item.id) as {
            id: string; code_repository_id: string; commit_sha: string; canonical_url: string;
            owner_name: string | null; repository_name: string | null;
          } | undefined;
        if (!repository || repository.commit_sha !== item.commitSha) throw new Error("snapshot-unavailable");
        return {
          repositoryId: repository.code_repository_id,
          snapshotId: repository.id,
          name: repository.repository_name ?? repository.owner_name ?? repository.canonical_url,
          url: repository.canonical_url,
          commitSha: repository.commit_sha,
        };
      });
      repositories = { status: "available", items };
    } catch {
      repositories = { status: "unavailable", reason: "conversation-repositories-invalid", items: [] };
    }
    let knowledgeCorpus: ContextSnapshotMaterial["knowledgeCorpus"];
    try {
      const manifest = JSON.parse(row.manifest_json) as ContextKnowledgeManifest;
      if (!Array.isArray(manifest.summaries) || !Array.isArray(manifest.knowledge)) throw new Error("invalid-manifest");
      const validEntry = (entry: unknown): entry is ManifestSummary => {
        if (!entry || typeof entry !== "object") return false;
        const candidate = entry as Record<string, unknown>;
        return typeof candidate.paperId === "string" && typeof candidate.revisionId === "string" &&
          typeof candidate.markdownPath === "string" && typeof candidate.contentHash === "string";
      };
      if (!manifest.summaries.every(validEntry) || !manifest.knowledge.every(validEntry)) {
        throw new Error("invalid-manifest-entry");
      }
      knowledgeCorpus = { status: "available", id: row.knowledge_corpus_manifest_id,
        hash: row.manifest_hash, manifest };
    } catch {
      knowledgeCorpus = { status: "unavailable", reason: "conversation-knowledge-manifest-invalid" };
    }
    return {
      id: row.id,
      paperVersion: { id: row.paper_version_id, sourceType: row.source_type, sourceVersion: row.source_version },
      summaryRevision: { id: row.summary_revision_id, revision: row.revision, contentHash: row.markdown_hash },
      extractionRun: { id: row.extraction_run_id, extractorName: row.extractor_name,
        extractorVersion: row.extractor_version, outputHash: row.extraction_hash },
      repositories,
      knowledgeCorpus,
    };
  }

  #compareExtraction(before: ContextSnapshotMaterial["extractionRun"], after: ContextSnapshotMaterial["extractionRun"]) {
    if (before.id === after.id) return { status: "unchanged" as const, equalityBasis: "run-id" as const, before, after };
    if (before.outputHash && after.outputHash) {
      return { status: before.outputHash === after.outputHash ? "unchanged" as const : "changed" as const,
        equalityBasis: "output-hash" as const, provenanceChanged: true, before, after };
    }
    return { status: "changed" as const, equalityBasis: "run-id-unverified" as const,
      provenanceChanged: true, equivalenceUnverified: true, before, after };
  }

  #compareRepositories(before: ContextSnapshotMaterial["repositories"], after: ContextSnapshotMaterial["repositories"]) {
    if (before.status === "unavailable" || after.status === "unavailable") {
      return { status: "unavailable" as const, reason: before.reason ?? after.reason,
        added: [], removed: [], changed: [], unchanged: [] };
    }
    const beforeById = new Map(before.items.map((item) => [item.repositoryId, item]));
    const afterById = new Map(after.items.map((item) => [item.repositoryId, item]));
    const added = after.items.filter((item) => !beforeById.has(item.repositoryId));
    const removed = before.items.filter((item) => !afterById.has(item.repositoryId));
    const changed = after.items.flatMap((item) => {
      const previous = beforeById.get(item.repositoryId);
      return previous && previous.commitSha !== item.commitSha ? [{ repositoryId: item.repositoryId, before: previous, after: item }] : [];
    });
    const unchanged = after.items.filter((item) => beforeById.get(item.repositoryId)?.commitSha === item.commitSha);
    return { status: "available" as const, added, removed, changed, unchanged };
  }

  #compareKnowledge(before: ContextSnapshotMaterial["knowledgeCorpus"], after: ContextSnapshotMaterial["knowledgeCorpus"]) {
    if (before.status === "unavailable" || after.status === "unavailable") {
      return { status: "unavailable" as const,
        reason: before.status === "unavailable" ? before.reason : after.status === "unavailable" ? after.reason : undefined };
    }
    if (before.id === after.id) {
      return { status: "unchanged" as const, before: { id: before.id, hash: before.hash },
        after: { id: after.id, hash: after.hash }, summaries: { added: [], removed: [], changed: [] },
        knowledge: { added: [], removed: [] } };
    }
    const beforeSummaries = new Map(before.manifest.summaries.map((entry) => [entry.paperId, entry]));
    const afterSummaries = new Map(after.manifest.summaries.map((entry) => [entry.paperId, entry]));
    const added = after.manifest.summaries.filter((entry) => !beforeSummaries.has(entry.paperId));
    const removed = before.manifest.summaries.filter((entry) => !afterSummaries.has(entry.paperId));
    const changed = after.manifest.summaries.flatMap((entry) => {
      const previous = beforeSummaries.get(entry.paperId);
      return previous && (previous.revisionId !== entry.revisionId || previous.contentHash !== entry.contentHash)
        ? [{ paperId: entry.paperId, before: previous, after: entry }] : [];
    });
    const beforeKnowledge = new Map(before.manifest.knowledge.map((entry) => [tupleKey(entry), entry]));
    const afterKnowledge = new Map(after.manifest.knowledge.map((entry) => [tupleKey(entry), entry]));
    const knowledgeAdded = after.manifest.knowledge.filter((entry) => !beforeKnowledge.has(tupleKey(entry)));
    const knowledgeRemoved = before.manifest.knowledge.filter((entry) => !afterKnowledge.has(tupleKey(entry)));
    const unchanged = added.length === 0 && removed.length === 0 && changed.length === 0 &&
      knowledgeAdded.length === 0 && knowledgeRemoved.length === 0;
    return { status: unchanged ? "unchanged" as const : "changed" as const,
      before: { id: before.id, hash: before.hash }, after: { id: after.id, hash: after.hash },
      summaries: { added, removed, changed },
      knowledge: { added: knowledgeAdded, removed: knowledgeRemoved } };
  }
}
