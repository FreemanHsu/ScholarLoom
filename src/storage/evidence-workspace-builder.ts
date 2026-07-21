import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";

import Database from "better-sqlite3";

import type { StorageLayout } from "./layout.js";

const BUILDER_VERSION = "evidence-workspace-v1";

export type EvidenceWorkspace = {
  id: string;
  root: string;
  workspaceHash: string;
  status: "built";
};

type SourceManifest = {
  builderVersion: string;
  contextSnapshotId: string;
  knowledgeCorpusManifestId: string;
  sources: Array<{
    kind: "pdf" | "summary" | "code" | "library" | "conversation";
    path: string;
    sourceId: string;
    revision?: string;
    contentHash: string;
    citable: boolean;
    locator?: Record<string, unknown>;
  }>;
};

export class EvidenceWorkspaceBuilder {
  static open(layout: StorageLayout): EvidenceWorkspaceBuilder {
    return new EvidenceWorkspaceBuilder(layout);
  }

  readonly #database: Database.Database;
  readonly #workspaceRoot: string;

  private constructor(private readonly layout: StorageLayout) {
    this.#database = new Database(layout.databasePath);
    this.#database.pragma("foreign_keys = ON");
    this.#workspaceRoot = join(layout.derivedRoot, "evidence-workspaces");
    mkdirSync(this.#workspaceRoot, { recursive: true });
    for (const name of readdirSync(this.#workspaceRoot)) {
      if (name.includes(".building-")) rmSync(join(this.#workspaceRoot, name), { recursive: true, force: true });
    }
    this.#database.prepare(`UPDATE evidence_workspaces SET status='failed',failed_at=?,error_json=?
      WHERE status='building'`).run(new Date().toISOString(), JSON.stringify({ code: "markerless-build" }));
  }

  ensure(contextSnapshotId: string): EvidenceWorkspace {
    const source = this.#loadSource(contextSnapshotId);
    const descriptor = JSON.stringify({ builderVersion: BUILDER_VERSION, contextSnapshotId,
      corpus: source.corpusHash, summary: source.summaryHash, pages: source.pages.map((page) => [page.id, page.hash]),
      repositories: source.repositories.map((repository) => [repository.snapshotId, repository.commitSha]), messagesHash: source.messagesHash });
    const workspaceHash = createHash("sha256").update(descriptor).digest("hex");
    const id = `evidence-workspace:${workspaceHash}`;
    const finalRoot = join(this.#workspaceRoot, workspaceHash);
    const existing = this.#database.prepare(`SELECT status FROM evidence_workspaces WHERE id=?`).get(id) as { status: string } | undefined;
    if (existing?.status === "built" && this.#isComplete(finalRoot, workspaceHash)) {
      this.#database.prepare("UPDATE evidence_workspaces SET last_accessed_at=? WHERE id=?").run(new Date().toISOString(), id);
      return { id, root: finalRoot, workspaceHash, status: "built" };
    }
    if (existsSync(finalRoot)) rmSync(finalRoot, { recursive: true, force: true });
    const buildingRoot = `${finalRoot}.building-${randomUUID()}`;
    const now = new Date().toISOString();
    this.#database.prepare(`INSERT INTO evidence_workspaces
      (id,context_snapshot_id,knowledge_corpus_manifest_id,workspace_hash,root_ref,status,builder_version,created_at,last_accessed_at)
      VALUES (?,?,?,?,?,'building',?,?,?)
      ON CONFLICT(id) DO UPDATE SET status='building',error_json=NULL,failed_at=NULL,evicted_at=NULL,last_accessed_at=excluded.last_accessed_at`)
      .run(id, contextSnapshotId, source.corpusId, workspaceHash,
        relative(this.layout.root, finalRoot), BUILDER_VERSION, now, now);
    try {
      const manifest: SourceManifest = { builderVersion: BUILDER_VERSION, contextSnapshotId,
        knowledgeCorpusManifestId: source.corpusId, sources: [] };
      for (const page of source.pages) {
        const workspacePath = `paper/pages/page-${String(page.page).padStart(4, "0")}.md`;
        const header = `---\nsource_kind: pdf\npaper_version_id: "${source.paperVersionId}"\nextraction_run_id: "${source.extractionRunId}"\npage_number: ${page.page}\nelement_id: "${page.id}"\ncontent_hash: "${page.hash}"\n---\n\n`;
        this.#write(buildingRoot, workspacePath, `${header}${page.text}\n`);
        manifest.sources.push({ kind: "pdf", path: workspacePath, sourceId: source.paperVersionId,
          revision: source.extractionRunId, contentHash: page.hash, citable: true,
          locator: { page: page.page, elementId: page.id, contentStartLine: 10 } });
      }
      this.#copy(buildingRoot, "paper/summary.md", source.summaryPath);
      manifest.sources.push({ kind: "summary", path: "paper/summary.md", sourceId: source.summaryId,
        revision: source.summaryId, contentHash: source.summaryHash, citable: true });

      for (const item of source.corpus.summaries) {
        const workspacePath = `library/summaries/${safeName(item.revisionId)}.md`;
        this.#copy(buildingRoot, workspacePath, join(this.layout.vaultRoot, item.markdownPath));
        manifest.sources.push({ kind: "library", path: workspacePath, sourceId: item.revisionId,
          revision: item.revisionId, contentHash: item.contentHash, citable: true });
      }
      for (const item of source.corpus.knowledge) {
        const workspacePath = `library/knowledge/${safeName(item.revisionId)}.md`;
        this.#copy(buildingRoot, workspacePath, join(this.layout.vaultRoot, item.markdownPath));
        manifest.sources.push({ kind: "library", path: workspacePath, sourceId: item.revisionId,
          revision: item.revisionId, contentHash: item.contentHash, citable: true });
      }

      for (const repository of source.repositories) {
        const prefix = `repositories/${safeName(repository.name)}`;
        let repositoryBytes = 0;
        const entries = execFileSync("git", ["-C", repository.localPath, "ls-tree", "-r", "-l", "-z", repository.commitSha],
          { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\0").filter(Boolean);
        for (const entry of entries) {
          const parsed = /^(\d+) (\w+) ([a-f0-9]+)\s+(\d+|-)\t([\s\S]+)$/.exec(entry);
          if (!parsed || parsed[2] !== "blob" || parsed[1] === "120000") continue;
          const size = parsed[4] === "-" ? 0 : Number(parsed[4]);
          const path = parsed[5]!;
          if (size > 20 * 1024 * 1024 || excludedRepositoryPath(path)) continue;
          const bytes = execFileSync("git", ["-C", repository.localPath, "show", `${repository.commitSha}:${path}`],
            { encoding: "buffer", maxBuffer: 21 * 1024 * 1024 });
          if (bytes.subarray(0, Math.min(bytes.length, 8192)).includes(0)) continue;
          repositoryBytes += bytes.length;
          if (repositoryBytes > 1024 * 1024 * 1024) throw new Error("evidence-workspace-repository-too-large");
          const workspacePath = `${prefix}/${path}`;
          this.#writeBytes(buildingRoot, workspacePath, bytes);
          manifest.sources.push({ kind: "code", path: workspacePath, sourceId: repository.snapshotId,
            revision: repository.commitSha, contentHash: createHash("sha256").update(bytes).digest("hex"), citable: true,
            locator: { commitSha: repository.commitSha, path, blobHash: parsed[3] } });
        }
      }

      const messagesPath = "conversation/recent-messages.md";
      this.#write(buildingRoot, messagesPath, `---\ncitable: false\nscope: context-only\n---\n\n${source.messagesText}`);
      manifest.sources.push({ kind: "conversation", path: messagesPath, sourceId: contextSnapshotId,
        contentHash: source.messagesHash, citable: false });
      this.#write(buildingRoot, "MANIFEST.json", `${JSON.stringify(manifest, null, 2)}\n`);
      this.#write(buildingRoot, "COMPLETE", `${workspaceHash}\n${BUILDER_VERSION}\n`);
      this.#validate(buildingRoot);
      const byteSize = this.#treeSize(buildingRoot);
      this.#makeReadOnly(buildingRoot);
      renameSync(buildingRoot, finalRoot);
      this.#database.prepare(`UPDATE evidence_workspaces SET status='built',byte_size=?,completed_at=?,last_accessed_at=? WHERE id=?`)
        .run(byteSize, new Date().toISOString(), new Date().toISOString(), id);
      this.#collectGarbage(20 * 1024 * 1024 * 1024, id);
      return { id, root: finalRoot, workspaceHash, status: "built" };
    } catch (error) {
      rmSync(buildingRoot, { recursive: true, force: true });
      this.#database.prepare(`UPDATE evidence_workspaces SET status='failed',failed_at=?,error_json=? WHERE id=?`)
        .run(new Date().toISOString(), JSON.stringify({ code: "workspace-build-failed",
          detail: error instanceof Error ? error.message : String(error) }), id);
      throw error;
    }
  }

  close(): void { this.#database.close(); }

  #loadSource(contextSnapshotId: string) {
    const snapshot = this.#database.prepare(`SELECT cs.conversation_id,cs.paper_version_id,cs.summary_revision_id,cs.extraction_run_id,
      cs.repositories_json,cs.knowledge_corpus_manifest_id,s.markdown_path,s.markdown_hash,m.manifest_hash,m.manifest_json
      FROM context_snapshots cs JOIN summary_revisions s ON s.id=cs.summary_revision_id
      JOIN knowledge_corpus_manifests m ON m.id=cs.knowledge_corpus_manifest_id WHERE cs.id=?`).get(contextSnapshotId) as {
        conversation_id: string; paper_version_id: string; summary_revision_id: string; extraction_run_id: string;
        repositories_json: string; knowledge_corpus_manifest_id: string; markdown_path: string; markdown_hash: string;
        manifest_hash: string; manifest_json: string;
      } | undefined;
    if (!snapshot) throw new Error("evidence-workspace-context-unavailable");
    const pages = (this.#database.prepare(`SELECT id,page_number,text_content FROM document_elements
      WHERE extraction_run_id=? AND element_type='page' ORDER BY page_number,ordinal`).all(snapshot.extraction_run_id) as Array<{
        id: string; page_number: number; text_content: string;
      }>).map((page) => ({ id: page.id, page: page.page_number, text: page.text_content,
        hash: createHash("sha256").update(page.text_content).digest("hex") }));
    if (pages.length === 0) throw new Error("evidence-workspace-pages-unavailable");
    const messages = this.#database.prepare(`SELECT role,content FROM messages WHERE conversation_id=?
      ORDER BY ordinal DESC,created_at DESC,id DESC LIMIT 20`).all(snapshot.conversation_id) as Array<{ role: string; content: string }>;
    const messagesText = messages.reverse().map((message) => `## ${message.role}\n\n${message.content}\n`).join("\n");
    return {
      paperVersionId: snapshot.paper_version_id,
      extractionRunId: snapshot.extraction_run_id,
      summaryId: snapshot.summary_revision_id,
      summaryPath: join(this.layout.vaultRoot, snapshot.markdown_path),
      summaryHash: snapshot.markdown_hash,
      corpusId: snapshot.knowledge_corpus_manifest_id,
      corpusHash: snapshot.manifest_hash,
      corpus: JSON.parse(snapshot.manifest_json) as {
        summaries: Array<{ revisionId: string; markdownPath: string; contentHash: string }>;
        knowledge: Array<{ revisionId: string; markdownPath: string; contentHash: string }>;
      },
      repositories: (JSON.parse(snapshot.repositories_json) as Array<{ id: string; commitSha: string }>).map((repository) => {
        const row = this.#database.prepare(`SELECT rs.local_path,cr.repository_name FROM repository_snapshots rs
          JOIN code_repositories cr ON cr.id=rs.code_repository_id WHERE rs.id=? AND rs.commit_sha=?`).get(repository.id, repository.commitSha) as
          { local_path: string; repository_name: string | null } | undefined;
        if (!row) throw new Error("evidence-workspace-repository-unavailable");
        return { snapshotId: repository.id, commitSha: repository.commitSha,
          name: row.repository_name ?? repository.id, localPath: join(this.layout.repositoryRoot, row.local_path) };
      }),
      pages,
      messagesText,
      messagesHash: createHash("sha256").update(messagesText).digest("hex"),
    };
  }

  #write(root: string, path: string, content: string): void {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, { encoding: "utf8", mode: 0o600 });
  }

  #copy(root: string, path: string, source: string): void {
    const bytes = readFileSync(source);
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, bytes, { mode: 0o600 });
  }

  #writeBytes(root: string, path: string, bytes: Uint8Array): void {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, bytes, { mode: 0o600 });
  }

  #validate(root: string): void {
    const visit = (path: string) => {
      const entry = lstatSync(path);
      if (entry.isSymbolicLink()) throw new Error("evidence-workspace-symlink");
      if (entry.isFile() && entry.nlink !== 1) throw new Error("evidence-workspace-hardlink");
      if (entry.isDirectory()) for (const name of readdirSync(path)) visit(join(path, name));
    };
    visit(root);
  }

  #treeSize(root: string): number {
    let size = 0;
    const visit = (path: string) => {
      const entry = statSync(path);
      if (entry.isFile()) size += entry.size;
      else for (const name of readdirSync(path)) visit(join(path, name));
    };
    visit(root);
    return size;
  }

  #makeReadOnly(root: string): void {
    const visit = (path: string) => {
      const entry = lstatSync(path);
      if (entry.isDirectory()) {
        for (const name of readdirSync(path)) visit(join(path, name));
        chmodSync(path, 0o500);
      } else chmodSync(path, 0o400);
    };
    visit(root);
  }

  #collectGarbage(capBytes: number, currentId: string): void {
    const rows = this.#database.prepare(`SELECT id,root_ref,byte_size FROM evidence_workspaces WHERE status='built'
      ORDER BY COALESCE(last_accessed_at,created_at) ASC`).all() as Array<{ id: string; root_ref: string; byte_size: number }>;
    let total = rows.reduce((sum, row) => sum + row.byte_size, 0);
    for (const row of rows) {
      if (total <= capBytes) break;
      if (row.id === currentId || this.#database.prepare(`SELECT 1 FROM job_runs WHERE evidence_workspace_id=?
        AND state IN ('queued','running','canceling')`).get(row.id)) continue;
      const root = join(this.layout.root, row.root_ref);
      if (existsSync(root)) {
        this.#makeWritable(root);
        rmSync(root, { recursive: true, force: true });
      }
      this.#database.prepare("UPDATE evidence_workspaces SET status='evicted',evicted_at=? WHERE id=?")
        .run(new Date().toISOString(), row.id);
      total -= row.byte_size;
    }
  }

  #makeWritable(root: string): void {
    const visit = (path: string) => {
      const entry = lstatSync(path);
      chmodSync(path, entry.isDirectory() ? 0o700 : 0o600);
      if (entry.isDirectory()) for (const name of readdirSync(path)) visit(join(path, name));
    };
    visit(root);
  }

  #isComplete(root: string, hash: string): boolean {
    return existsSync(join(root, "COMPLETE")) && readFileSync(join(root, "COMPLETE"), "utf8").startsWith(`${hash}\n`);
  }
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function excludedRepositoryPath(path: string): boolean {
  const normalized = `/${path.toLowerCase()}/`;
  if (/\/(?:node_modules|dist|build|target|coverage|\.git|__pycache__)\//.test(normalized)) return true;
  return /\.(?:png|jpe?g|gif|webp|pdf|zip|tar|gz|7z|onnx|pt|pth|ckpt|safetensors|bin|wasm)$/i.test(path);
}
