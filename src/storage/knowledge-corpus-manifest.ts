import { createHash } from "node:crypto";

import type Database from "better-sqlite3";

export type FrozenKnowledgeCorpus = {
  id: string;
  hash: string;
  manifest: {
    summaries: Array<{ paperId: string; revisionId: string; markdownPath: string; contentHash: string }>;
    knowledge: Array<{ paperId: string; revisionId: string; markdownPath: string; contentHash: string }>;
  };
};

export class KnowledgeCorpusManifestBuilder {
  constructor(private readonly database: Database.Database, private readonly now: () => Date) {}

  freeze(currentPaperId: string): FrozenKnowledgeCorpus {
    const summaries = (this.database.prepare(`SELECT paper_id,id,markdown_path,markdown_hash
      FROM summary_revisions WHERE status='active' AND paper_id<>? ORDER BY paper_id,id`).all(currentPaperId) as Array<{
        paper_id: string; id: string; markdown_path: string; markdown_hash: string;
      }>).map((row) => ({ paperId: row.paper_id, revisionId: row.id, markdownPath: row.markdown_path, contentHash: row.markdown_hash }));
    const knowledge = (this.database.prepare(`SELECT t.paper_id,tr.id,tr.markdown_path,tr.markdown_hash
      FROM takeaways t JOIN takeaway_revisions tr ON tr.id=t.active_revision_id
      WHERE tr.review_status='confirmed' AND t.paper_id<>? ORDER BY t.paper_id,tr.id`).all(currentPaperId) as Array<{
        paper_id: string; id: string; markdown_path: string; markdown_hash: string;
      }>).map((row) => ({ paperId: row.paper_id, revisionId: row.id, markdownPath: row.markdown_path, contentHash: row.markdown_hash }));
    const manifest = { summaries, knowledge };
    const canonical = JSON.stringify(manifest);
    const hash = createHash("sha256").update(canonical).digest("hex");
    const id = `knowledge-corpus:${hash}`;
    this.database.prepare(`INSERT OR IGNORE INTO knowledge_corpus_manifests(id,manifest_hash,manifest_json,created_at)
      VALUES (?,?,?,?)`).run(id, hash, canonical, this.now().toISOString());
    return { id, hash, manifest };
  }
}
