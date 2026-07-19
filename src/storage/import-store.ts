import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

import Database from "better-sqlite3";

import type { ResolvedPaper } from "../app.js";
import { migrate } from "./migrations.js";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { RepositoryAdapter } from "../adapters/git-repository.js";

const standardFontDataUrl = `${join(dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json")), "standard_fonts")}/`;

export type StoredPaper = { id: string; arxivId: string; version: number; title: string };
export type StoredImportRequest = { id: string; paperId: string; status: "resolved" };

export type SummaryResult = {
  sections: Array<{ key: string; title: string; body: string }>;
  claims: Array<{ voice: "authors-claim" | "paper-evidence" | "agent-assessment"; claim: string; sourceHandle: string }>;
  readStatus: "abstract" | "skimmed" | "read";
};
export type ChatResult = {
  answer: string;
  citations: Array<{ sourceHandle: string; locator: string }>;
  proposedTakeaways: Array<{ claim: string; sourceHandles: string[]; quote?: string }>;
};
export type EntryResult = { answer: string; sourceHandles: string[]; uncertainty: string | null };

type ImportStatus = {
  importRequest: { id: string; paperId: string; resolutionStatus: string };
  jobs: Array<{ id: string; jobType: string; state: string; progress: number }>;
};

export class ImportStore {
  readonly #database: Database.Database;
  readonly #assetRoot: string;
  readonly #knowledgeRoot: string;
  readonly #repositoryRoot: string;
  readonly #failurePoint: "staged" | "renamed" | "metadata-committed" | null;
  readonly #now: () => Date;

  constructor(path = ":memory:", assetRoot = join(process.cwd(), ".scholarloom", "assets"), knowledgeRoot = process.cwd(),
    repositoryRoot = join(process.cwd(), ".scholarloom", "repositories"), failurePoint: "staged" | "renamed" | "metadata-committed" | null = null,
    now: () => Date = () => new Date()) {
    this.#assetRoot = assetRoot;
    this.#knowledgeRoot = knowledgeRoot;
    this.#repositoryRoot = repositoryRoot;
    this.#failurePoint = failurePoint;
    this.#now = now;
    this.#database = new Database(path);
    this.#database.pragma("foreign_keys = ON");
    this.#database.pragma("journal_mode = WAL");
    this.#database.pragma("busy_timeout = 5000");
    migrate(this.#database);
    this.#database.prepare("UPDATE job_runs SET state = 'interrupted' WHERE state = 'running'").run();
    this.#recoverWrites();
    const archiveBefore = new Date(this.#now().getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    this.#database.prepare(`UPDATE proposals SET review_status='archived',archived_at=?
      WHERE proposal_type='reconciliation' AND review_status='pending' AND created_at < ?`).run(this.#now().toISOString(), archiveBefore);
  }

  async ingestPaper(input: {
    paper: StoredPaper;
    pdfBytes: Uint8Array;
    runSummary(context: { paperId: string; title: string; pages: Array<{ handle: string; page: number; text: string }> }): Promise<SummaryResult>;
    repositoryAdapter?: RepositoryAdapter;
  }): Promise<void> {
    const now = new Date().toISOString();
    const bytes = new Uint8Array(input.pdfBytes);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const storageRef = join("papers", hash.slice(0, 2), `${hash}.pdf`);
    const absolutePdf = join(this.#assetRoot, storageRef);
    mkdirSync(dirname(absolutePdf), { recursive: true });
    if (!existsSync(absolutePdf)) {
      const stagedPdf = `${absolutePdf}.staged-${randomUUID()}`;
      writeFileSync(stagedPdf, bytes);
      renameSync(stagedPdf, absolutePdf);
    }
    const artifactId = `artifact:pdf:${hash}`;
    const versionId = `paper-version:${input.paper.id}:arxiv:v${input.paper.version}`;
    this.#database.prepare(`INSERT INTO artifacts(id,artifact_type,content_hash,storage_ref,media_type,byte_size,created_by_kind,retention_class,created_at)
      VALUES (?,'paper-pdf',?,?,'application/pdf',?,'external-source','irreplaceable',?) ON CONFLICT(artifact_type,content_hash) DO NOTHING`)
      .run(artifactId, hash, storageRef, bytes.byteLength, now);
    this.#database.prepare("UPDATE paper_versions SET pdf_artifact_id=?,processing_status='processing',updated_at=? WHERE id=?")
      .run(artifactId, now, versionId);

    const extractionId = `extraction:${versionId}:pdfjs`;
    this.#database.prepare(`INSERT INTO extraction_runs(id,paper_version_id,source_artifact_id,extractor_name,extractor_version,status,started_at)
      VALUES (?,?,?,'pdfjs','5','running',?) ON CONFLICT(id) DO NOTHING`).run(extractionId, versionId, artifactId, now);
    const document = await getDocument({ data: bytes, standardFontDataUrl }).promise;
    const pages: Array<{ handle: string; page: number; text: string }> = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items.map((item) => "str" in item ? item.str : "").join(" ").trim();
      const elementId = `document-element:${extractionId}:page:${pageNumber}`;
      this.#database.prepare(`INSERT INTO document_elements(id,extraction_run_id,element_type,page_number,ordinal,text_content,bbox_json)
        VALUES (?,?,'page',?,0,?,'{}') ON CONFLICT(extraction_run_id,page_number,ordinal) DO UPDATE SET text_content=excluded.text_content`)
        .run(elementId, extractionId, pageNumber, text);
      pages.push({ handle: `pdf-page:${pageNumber}`, page: pageNumber, text });
    }
    const extractionArtifactId = `artifact:${extractionId}`;
    this.#storeArtifact(extractionArtifactId, "document-extraction", Buffer.from(JSON.stringify(pages)), "json", "job-run", null, artifactId);
    this.#database.prepare("UPDATE extraction_runs SET status='succeeded',page_count=?,completed_at=? WHERE id=?")
      .run(document.numPages, now, extractionId);
    this.#database.prepare("UPDATE extraction_runs SET output_artifact_id=? WHERE id=?").run(extractionArtifactId, extractionId);

    const explicitUrl = pages.map((page) => page.text).join("\n").match(/https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/)?.[0]?.replace(/[.,;)]$/, "");
    const repositoryWork = input.repositoryAdapter && explicitUrl
      ? this.#materializeRepository(input.paper.id, explicitUrl, input.repositoryAdapter, now).catch((error: unknown) =>
        this.#recordRepositoryFailure(input.paper.id, explicitUrl, error, now))
      : Promise.resolve();
    const summaryContext = { paperId: input.paper.id, title: input.paper.title, pages };
    const result = await input.runSummary(summaryContext);
    if (!result.sections.length || !result.claims.length || !["abstract", "skimmed", "read"].includes(result.readStatus)) {
      throw new Error("codex-output-invalid");
    }
    const agentRunId = this.#recordAgentRun("paper-summary", input.paper.id, null, summaryContext, result, "skills/paper-reading/SKILL.md");
    const claims = result.claims.map((claim, ordinal) => {
      const page = pages.find((candidate) => candidate.handle === claim.sourceHandle);
      if (!page) throw new Error(`codex-output-invalid: unknown source handle ${claim.sourceHandle}`);
      const quoteVerified = page.text.includes(claim.claim);
      const anchorId = `evidence:${versionId}:page:${page.page}:claim:${ordinal}`;
      this.#database.prepare(`INSERT INTO evidence_anchors(id,anchor_type,paper_version_id,extraction_run_id,document_element_id,page_number,quote_text,verification_status,locator_json,created_at)
        VALUES (?,'pdf-page',?,?,?, ?,?,?,?,?) ON CONFLICT(id) DO NOTHING`)
        .run(anchorId, versionId, extractionId, `document-element:${extractionId}:page:${page.page}`, page.page,
          claim.claim, quoteVerified ? "verified" : "located", JSON.stringify({ page: page.page }), now);
      return { ...claim, evidenceAnchorId: anchorId, page: page.page, verified: quoteVerified,
        evidence: { id: anchorId, page: page.page, verified: quoteVerified } };
    });
    const structured = { ...result, claims };
    const slug = input.paper.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "paper";
    const relativePath = join("library", "papers", slug, `summary-v${input.paper.version}-r1.md`);
    const targetPath = join(this.#knowledgeRoot, relativePath);
    const skillHash = createHash("sha256").update(readFileSync(join(process.cwd(), "skills/paper-reading/SKILL.md"))).digest("hex");
    const summaryId = `summary:${versionId}:r1`;
    const markdown = renderSummary({ summaryId, paper: input.paper, versionId, extractionId, agentRunId, skillHash, result: structured, date: now.slice(0, 10) });
    const markdownHash = createHash("sha256").update(markdown).digest("hex");
    const stagedPath = `${targetPath}.staged`;
    const writeId = `knowledge-write:${summaryId}`;
    mkdirSync(dirname(targetPath), { recursive: true });
    const writePayload = { summaryId, paperId: input.paper.id, paperTitle: input.paper.title, versionId, extractionId,
      readStatus: result.readStatus, relativePath, markdownHash, structured, skillHash, agentRunId, claims, now };
    this.#database.prepare(`INSERT INTO knowledge_write_requests(id,request_type,target_path,staged_path,result_hash,phase,created_at,updated_at,payload_json)
      VALUES (?,'summary',?,?,?,'reserved',?,?,?) ON CONFLICT(id) DO NOTHING`).run(writeId, relativePath, `${relativePath}.staged`, markdownHash, now, now, JSON.stringify(writePayload));
    writeFileSync(stagedPath, markdown, "utf8");
    this.#database.prepare("UPDATE knowledge_write_requests SET phase='staged',updated_at=? WHERE id=?").run(now, writeId);
    this.#maybeFail("staged");
    this.#advanceSummaryWrite(writeId);
    await repositoryWork;
  }

  #maybeFail(phase: "staged" | "renamed" | "metadata-committed"): void {
    if (this.#failurePoint === phase) throw new Error(`fault-injected:${phase}`);
  }

  #recoverWrites(): void {
    const rows = this.#database.prepare("SELECT id,request_type,phase,staged_path FROM knowledge_write_requests WHERE phase NOT IN ('complete','failed','conflicted') ORDER BY created_at").all() as
      Array<{ id: string; request_type: string; phase: string; staged_path: string }>;
    for (const row of rows) {
      if (row.phase === "reserved" && !existsSync(this.#knowledgePath(row.staged_path))) {
        this.#database.prepare("UPDATE knowledge_write_requests SET phase='failed',error_code='staged-file-missing',updated_at=? WHERE id=?")
          .run(new Date().toISOString(), row.id);
      } else if (row.request_type === "summary") this.#advanceSummaryWrite(row.id);
      else if (row.request_type === "takeaway") this.#advanceTakeawayWrite(row.id);
      else if (row.request_type === "paper-manifest") this.#advanceManifestWrite(row.id);
    }
  }

  #advanceSummaryWrite(writeId: string): void {
    const row = this.#database.prepare(`SELECT target_path,staged_path,result_hash,phase,payload_json FROM knowledge_write_requests WHERE id=?`).get(writeId) as
      { target_path: string; staged_path: string; result_hash: string; phase: string; payload_json: string };
    const payload = JSON.parse(row.payload_json) as { summaryId: string; paperId: string; paperTitle: string; versionId: string; extractionId: string;
      readStatus: string; relativePath: string; markdownHash: string; structured: SummaryResult; skillHash: string;
      claims: Array<{ evidenceAnchorId: string }>; agentRunId: string; now: string };
    let phase = row.phase;
    const targetPath = this.#knowledgePath(row.target_path);
    const stagedPath = this.#knowledgePath(row.staged_path);
    if (phase === "staged") {
      if (existsSync(targetPath)) {
        const finalHash = createHash("sha256").update(readFileSync(targetPath)).digest("hex");
        if (finalHash !== row.result_hash) {
          const now = new Date().toISOString();
          this.#database.transaction(() => {
            this.#database.prepare("UPDATE knowledge_write_requests SET phase='conflicted',error_code='external-edit',updated_at=? WHERE id=?").run(now, writeId);
            this.#database.prepare(`INSERT OR IGNORE INTO proposals(id,proposal_type,paper_id,payload_json,review_status,one_click_eligible,created_at)
              VALUES (?,'reconciliation',?,?,'pending',0,?)`).run(`proposal:reconciliation:${writeId}`, payload.paperId,
                JSON.stringify({ writeId, targetPath: row.target_path, expectedHash: row.result_hash, actualHash: finalHash }), now);
          })();
          return;
        }
        if (existsSync(stagedPath)) unlinkSync(stagedPath);
      } else renameSync(stagedPath, targetPath);
      this.#database.prepare("UPDATE knowledge_write_requests SET phase='renamed',updated_at=? WHERE id=?").run(new Date().toISOString(), writeId);
      phase = "renamed";
      this.#maybeFail("renamed");
    }
    if (phase === "renamed") {
      const pdfArtifact = (this.#database.prepare("SELECT pdf_artifact_id FROM paper_versions WHERE id=?").get(payload.versionId) as { pdf_artifact_id: string }).pdf_artifact_id;
      this.#storeArtifact(`artifact:${payload.summaryId}`, "paper-summary", readFileSync(targetPath), "md", "agent-run", payload.agentRunId, pdfArtifact);
      this.#database.transaction(() => {
        this.#database.prepare(`INSERT INTO summary_revisions(id,paper_id,paper_version_id,extraction_run_id,revision,status,read_status,markdown_path,markdown_hash,structured_json,skill_path,skill_content_hash,created_at,agent_run_id)
          VALUES (?,?,?,?,1,'active',?,?,?,?, 'skills/paper-reading/SKILL.md',?,?,?) ON CONFLICT(id) DO NOTHING`)
          .run(payload.summaryId, payload.paperId, payload.versionId, payload.extractionId, payload.readStatus, payload.relativePath,
            payload.markdownHash, JSON.stringify(payload.structured), payload.skillHash, payload.now, payload.agentRunId);
        payload.claims.forEach((claim, ordinal) => this.#database.prepare(`INSERT INTO summary_claim_evidence(summary_revision_id,claim_ordinal,evidence_anchor_id)
          VALUES (?,?,?) ON CONFLICT DO NOTHING`).run(payload.summaryId, ordinal, claim.evidenceAnchorId));
        this.#database.prepare(`INSERT OR IGNORE INTO index_outbox(projection,source_id,operation,state,created_at)
          VALUES ('global-curated',?,'upsert','pending',?)`).run(payload.summaryId, payload.now);
        this.#database.prepare("UPDATE knowledge_write_requests SET phase='metadata-committed',updated_at=? WHERE id=?").run(new Date().toISOString(), writeId);
      })();
      phase = "metadata-committed";
      this.#maybeFail("metadata-committed");
    }
    if (phase === "metadata-committed" || phase === "indexed") {
      this.#database.transaction(() => {
        this.#database.prepare(`INSERT INTO curated_search_documents(id,source_type,source_id,title,body,updated_at)
          VALUES (?,'summary',?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET title=excluded.title,body=excluded.body,updated_at=excluded.updated_at`)
          .run(`curated:${payload.summaryId}`, payload.summaryId, payload.paperTitle, payload.structured.sections.map((section) => section.body).join("\n"), payload.now);
        this.#database.prepare("UPDATE projection_state SET last_successful_at=?,updated_at=? WHERE projection='global-curated'").run(payload.now, payload.now);
        this.#database.prepare("UPDATE index_outbox SET state='complete',completed_at=? WHERE projection='global-curated' AND source_id=? AND operation='upsert'")
          .run(payload.now, payload.summaryId);
        this.#database.prepare("UPDATE knowledge_write_requests SET phase='complete',updated_at=? WHERE id=?").run(new Date().toISOString(), writeId);
        this.#database.prepare("UPDATE paper_versions SET processing_status='available',updated_at=? WHERE id=?").run(payload.now, payload.versionId);
      })();
      this.#writePaperManifest(payload.paperId, payload.paperTitle, payload.versionId, payload.summaryId, payload.now);
    }
  }

  #writePaperManifest(paperId: string, title: string, versionId: string, summaryId: string, now: string): void {
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "paper";
    const relativePath = join("library", "papers", slug, "paper.md");
    const target = join(this.#knowledgeRoot, relativePath);
    const metadata = this.getResolvedMetadata(paperId)!;
    const markdown = `---\nid: "${paperId}"\ntype: paper\ntitle: "${title}"\nauthors: ${JSON.stringify(metadata.authors)}\nyear: ${metadata.year}\nvenue: null\nexternal_identities:\n  arxiv: "${metadata.arxivId}"\n  doi: null\nacquisition_status: ingested\norigin: manual-import\ncurrent_version_id: "${versionId}"\ncurrent_summary_revision_id: "${summaryId}"\npaper_code_links: []\nread_status: read\nstatus: active\ntopics: []\nconcepts: []\ntags: []\ncreated: ${now.slice(0, 10)}\nupdated: ${now.slice(0, 10)}\n---\n\n# ${title}\n\n## Current reading\n\n- Current Paper Version: ${versionId}\n- Active Paper Summary: [[${relativePath.replace(/\/paper\.md$/, "")}/summary-${versionId.match(/:v(\d+)$/)?.[1] ? `v${versionId.match(/:v(\d+)$/)![1]}-r1` : "r1"}]]\n\n## Confirmed Takeaways\n\n| Takeaway | Active revision | Evidence | Status |\n|---|---|---|---|\n`;
    const hash = createHash("sha256").update(markdown).digest("hex");
    const writeId = `knowledge-write:paper-manifest:${paperId}`;
    this.#database.prepare(`INSERT INTO knowledge_write_requests(id,request_type,target_path,staged_path,result_hash,phase,created_at,updated_at,payload_json)
      VALUES (?,'paper-manifest',?,?,?,'reserved',?,?,?) ON CONFLICT(id) DO NOTHING`)
      .run(writeId, relativePath, `${relativePath}.staged`, hash, now, now, JSON.stringify({ paperId, versionId, summaryId }));
    const phase = (this.#database.prepare("SELECT phase FROM knowledge_write_requests WHERE id=?").get(writeId) as { phase: string }).phase;
    if (phase === "complete") return;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(`${target}.staged`, markdown, "utf8");
    this.#database.prepare("UPDATE knowledge_write_requests SET phase='staged',updated_at=? WHERE id=?").run(now, writeId);
    this.#advanceManifestWrite(writeId);
  }

  #advanceManifestWrite(writeId: string): void {
    const row = this.#database.prepare("SELECT target_path,staged_path,result_hash,phase,payload_json FROM knowledge_write_requests WHERE id=?").get(writeId) as
      { target_path: string; staged_path: string; result_hash: string; phase: string; payload_json: string };
    const targetPath = this.#knowledgePath(row.target_path);
    const stagedPath = this.#knowledgePath(row.staged_path);
    if (row.phase === "staged") {
      if (existsSync(targetPath)) {
        const actualHash = createHash("sha256").update(readFileSync(targetPath)).digest("hex");
        if (actualHash !== row.result_hash) {
          const { paperId } = JSON.parse(row.payload_json) as { paperId: string };
          this.#createWriteConflict(writeId, paperId, row.target_path, row.result_hash, actualHash);
          return;
        }
        if (existsSync(stagedPath)) unlinkSync(stagedPath);
      } else renameSync(stagedPath, targetPath);
      this.#database.prepare("UPDATE knowledge_write_requests SET phase='renamed',updated_at=? WHERE id=?").run(new Date().toISOString(), writeId);
    }
    this.#database.prepare("UPDATE knowledge_write_requests SET phase='metadata-committed',updated_at=? WHERE id=? AND phase='renamed'").run(new Date().toISOString(), writeId);
    this.#database.prepare("UPDATE knowledge_write_requests SET phase='indexed',updated_at=? WHERE id=? AND phase='metadata-committed'").run(new Date().toISOString(), writeId);
    this.#database.prepare("UPDATE knowledge_write_requests SET phase='complete',updated_at=? WHERE id=? AND phase='indexed'").run(new Date().toISOString(), writeId);
  }

  #createWriteConflict(writeId: string, paperId: string, targetPath: string, expectedHash: string, actualHash: string): void {
    const now = new Date().toISOString();
    this.#database.transaction(() => {
      this.#database.prepare("UPDATE knowledge_write_requests SET phase='conflicted',error_code='external-edit',updated_at=? WHERE id=?").run(now, writeId);
      this.#database.prepare(`INSERT OR IGNORE INTO proposals(id,proposal_type,paper_id,payload_json,review_status,one_click_eligible,created_at)
        VALUES (?,'reconciliation',?,?,'pending',0,?)`).run(`proposal:reconciliation:${writeId}`, paperId,
          JSON.stringify({ writeId, targetPath, expectedHash, actualHash }), now);
    })();
  }

  getPaperWorkspace(id: string): unknown | null {
    const paper = this.listPapers().find((candidate) => candidate.id === id);
    if (!paper) return null;
    const versionId = `paper-version:${paper.id}:arxiv:v${paper.version}`;
    const extraction = this.#database.prepare("SELECT id,page_count FROM extraction_runs WHERE paper_version_id=? AND status='succeeded'").get(versionId) as
      { id: string; page_count: number } | undefined;
    const summary = this.#database.prepare("SELECT id,status,read_status,markdown_path,structured_json FROM summary_revisions WHERE paper_id=? AND status='active'").get(id) as
      { id: string; status: string; read_status: string; markdown_path: string; structured_json: string } | undefined;
    const repository = this.#database.prepare(`SELECT cr.canonical_url,rs.commit_sha,rs.id snapshot_id,pcl.status
      FROM paper_code_links pcl JOIN code_repositories cr ON cr.id=pcl.code_repository_id
      LEFT JOIN repository_snapshots rs ON rs.id=pcl.repository_snapshot_id WHERE pcl.paper_id=? ORDER BY pcl.created_at DESC LIMIT 1`).get(id) as
      { canonical_url: string; commit_sha: string | null; snapshot_id: string | null; status: string } | undefined;
    const files = repository?.snapshot_id ? (this.#database.prepare(`SELECT relative_path,start_line,end_line FROM code_elements
      WHERE repository_snapshot_id=? ORDER BY relative_path`).all(repository.snapshot_id) as
      Array<{ relative_path: string; start_line: number; end_line: number }>).map((file) =>
        ({ path: file.relative_path, startLine: file.start_line, endLine: file.end_line })) : [];
    return {
      paper: { ...paper, versionId },
      pdf: extraction ? { pageCount: extraction.page_count } : null,
      summary: summary ? { id: summary.id, status: summary.status, readStatus: summary.read_status,
        markdownPath: summary.markdown_path, ...JSON.parse(summary.structured_json) as object } : null,
      repository: repository ? { url: repository.canonical_url, commitSha: repository.commit_sha,
        status: repository.status === "confirmed" ? "ready" : "failed", files } : null,
    };
  }

  async #materializeRepository(paperId: string, url: string, adapter: RepositoryAdapter, now: string): Promise<void> {
    const existing = this.#database.prepare(`SELECT 1 FROM paper_code_links pcl JOIN code_repositories cr ON cr.id=pcl.code_repository_id
      WHERE pcl.paper_id=? AND cr.canonical_url=? AND pcl.status='confirmed'`).get(paperId, url);
    if (existing) return;
    const digest = createHash("sha256").update(url).digest("hex").slice(0, 16);
    const repositoryId = `repository:${digest}`;
    const destination = join(this.#repositoryRoot, digest);
    mkdirSync(this.#repositoryRoot, { recursive: true });
    const { commitSha } = await adapter.materialize(url, destination);
    const snapshotId = `repository-snapshot:${repositoryId}:${commitSha}`;
    const parsed = new URL(url);
    const [owner, name] = parsed.pathname.slice(1).split("/");
    this.#database.transaction(() => {
      this.#database.prepare(`INSERT INTO code_repositories(id,canonical_url,host,owner_name,repository_name,availability_status,created_at,updated_at)
        VALUES (?,?,?,?,?,'available',?,?) ON CONFLICT(canonical_url) DO NOTHING`).run(repositoryId, url, parsed.host, owner, name, now, now);
      this.#database.prepare(`INSERT INTO repository_snapshots(id,code_repository_id,commit_sha,local_path,created_at)
        VALUES (?,?,?,?,?) ON CONFLICT(code_repository_id,commit_sha) DO NOTHING`).run(snapshotId, repositoryId, commitSha, digest, now);
      this.#database.prepare(`INSERT INTO paper_code_links(id,paper_id,code_repository_id,link_type,origin,status,repository_snapshot_id,created_at)
        VALUES (?,?,?,'official','paper-explicit','confirmed',?,?) ON CONFLICT(paper_id,code_repository_id) DO UPDATE SET repository_snapshot_id=excluded.repository_snapshot_id,status='confirmed'`)
        .run(`paper-code-link:${paperId}:${repositoryId}`, paperId, repositoryId, snapshotId, now);
      for (const file of listTextFiles(destination)) {
        const text = readFileSync(file.absolute, "utf8");
        const lineCount = Math.max(1, text.split("\n").length);
        this.#database.prepare(`INSERT INTO code_elements(id,repository_snapshot_id,relative_path,start_line,end_line,text_content,content_hash)
          VALUES (?,?,?,?,?,?,?) ON CONFLICT(repository_snapshot_id,relative_path,start_line,end_line) DO NOTHING`)
          .run(`code-element:${snapshotId}:${file.relative}`, snapshotId, file.relative, 1, lineCount, text,
            createHash("sha256").update(text).digest("hex"));
      }
    })();
  }

  #recordRepositoryFailure(paperId: string, url: string, error: unknown, now: string): void {
    const digest = createHash("sha256").update(url).digest("hex").slice(0, 16);
    const repositoryId = `repository:${digest}`;
    const parsed = new URL(url);
    const [owner, name] = parsed.pathname.slice(1).split("/");
    this.#database.transaction(() => {
      this.#database.prepare(`INSERT INTO code_repositories(id,canonical_url,host,owner_name,repository_name,availability_status,created_at,updated_at)
        VALUES (?,?,?,?,?,'unavailable',?,?) ON CONFLICT(canonical_url) DO UPDATE SET availability_status='unavailable',updated_at=excluded.updated_at`)
        .run(repositoryId, url, parsed.host, owner, name, now, now);
      this.#database.prepare(`INSERT INTO paper_code_links(id,paper_id,code_repository_id,link_type,origin,status,created_at)
        VALUES (?,?,?,'official','paper-explicit','rejected',?) ON CONFLICT(paper_id,code_repository_id) DO UPDATE SET status='rejected'`)
        .run(`paper-code-link:${paperId}:${repositoryId}`, paperId, repositoryId, now);
      this.#database.prepare(`INSERT OR IGNORE INTO proposals(id,proposal_type,paper_id,payload_json,review_status,one_click_eligible,created_at)
        VALUES (?,'repository-retry',?,?,'pending',0,?)`).run(`proposal:repository-retry:${paperId}:${digest}`, paperId,
          JSON.stringify({ url, error: error instanceof Error ? error.message : "repository-unavailable" }), now);
    })();
  }

  getPdf(versionId: string): Uint8Array | null {
    const row = this.#database.prepare(`SELECT a.storage_ref FROM paper_versions v JOIN artifacts a ON a.id=v.pdf_artifact_id WHERE v.id=?`).get(versionId) as
      { storage_ref: string } | undefined;
    return row ? readFileSync(join(this.#assetRoot, row.storage_ref)) : null;
  }

  startConversation(paperId: string): unknown | null {
    const now = new Date().toISOString();
    const row = this.#database.prepare(`SELECT p.current_version_id,s.id summary_id,s.extraction_run_id
      FROM papers p LEFT JOIN summary_revisions s ON s.paper_id=p.id AND s.status='active' WHERE p.id=?`).get(paperId) as
      { current_version_id: string; summary_id: string | null; extraction_run_id: string | null } | undefined;
    if (!row) return null;
    const repositories = this.#database.prepare(`SELECT rs.id,rs.commit_sha FROM paper_code_links pcl
      JOIN repository_snapshots rs ON rs.id=pcl.repository_snapshot_id WHERE pcl.paper_id=? AND pcl.status='confirmed'`).all(paperId) as
      Array<{ id: string; commit_sha: string }>;
    const conversationId = `conversation:${randomUUID()}`;
    const snapshotId = `context-snapshot:${randomUUID()}`;
    this.#database.transaction(() => {
      this.#database.prepare("INSERT INTO conversations(id,paper_id,active_context_snapshot_id,created_at,updated_at) VALUES (?,?,?,?,?)")
        .run(conversationId, paperId, snapshotId, now, now);
      this.#database.prepare(`INSERT INTO context_snapshots(id,conversation_id,paper_version_id,summary_revision_id,extraction_run_id,repositories_json,created_at)
        VALUES (?,?,?,?,?,?,?)`).run(snapshotId, conversationId, row.current_version_id, row.summary_id, row.extraction_run_id,
          JSON.stringify(repositories.map((repository) => ({ id: repository.id, commitSha: repository.commit_sha }))), now);
    })();
    return { conversation: { id: conversationId, paperId }, contextSnapshot: { id: snapshotId,
      paperVersionId: row.current_version_id, summaryRevisionId: row.summary_id, extractionRunId: row.extraction_run_id,
      repositorySnapshots: repositories.map((repository) => ({ id: repository.id, commitSha: repository.commit_sha })) } };
  }

  async sendMessage(conversationId: string, content: string, runChat: (context: {
    paperId: string; conversationId: string; content: string; sources: Array<{ handle: string; type: "pdf" | "code"; text: string; locator: string }>;
  }) => Promise<ChatResult>): Promise<unknown | null> {
    const conversation = this.#database.prepare(`SELECT c.paper_id,c.active_context_snapshot_id,cs.extraction_run_id,cs.repositories_json
      FROM conversations c JOIN context_snapshots cs ON cs.id=c.active_context_snapshot_id WHERE c.id=?`).get(conversationId) as
      { paper_id: string; active_context_snapshot_id: string; extraction_run_id: string; repositories_json: string } | undefined;
    if (!conversation) return null;
    const pages = this.#database.prepare(`SELECT page_number,text_content FROM document_elements WHERE extraction_run_id=? ORDER BY page_number`).all(conversation.extraction_run_id) as
      Array<{ page_number: number; text_content: string }>;
    const repositories = JSON.parse(conversation.repositories_json) as Array<{ id: string; commitSha: string }>;
    const allCode = repositories.flatMap((repository) => (this.#database.prepare(`SELECT relative_path,start_line,end_line,text_content
      FROM code_elements WHERE repository_snapshot_id=? ORDER BY relative_path`).all(repository.id) as
      Array<{ relative_path: string; start_line: number; end_line: number; text_content: string }>).map((file) => ({ ...file, repository })));
    const terms = content.toLowerCase().split(/\s+/).filter((term) => term.length >= 4);
    const code = allCode.filter((file) => /^readme(?:\.|$)/i.test(file.relative_path) || terms.some((term) =>
      file.relative_path.toLowerCase().includes(term) || file.text_content.toLowerCase().includes(term))).slice(0, 12);
    const sources = [
      ...pages.map((page) => ({ handle: `pdf-page:${page.page_number}`, type: "pdf" as const, text: page.text_content, locator: `p. ${page.page_number}` })),
      ...code.map((file) => ({ handle: `code:${file.relative_path}`, type: "code" as const, text: file.text_content,
        locator: `${file.relative_path}:${file.start_line}-${file.end_line}` })),
    ];
    const chatContext = { paperId: conversation.paper_id, conversationId, content, sources };
    const output = await runChat(chatContext);
    if (!output.answer || output.citations.some((citation) => !sources.some((source) => source.handle === citation.sourceHandle))) {
      throw new Error("codex-output-invalid");
    }
    this.#recordAgentRun("paper-chat", conversation.paper_id, conversation.active_context_snapshot_id, chatContext, output, null);
    const now = new Date().toISOString();
    const userMessageId = `message:${randomUUID()}`;
    const assistantMessageId = `message:${randomUUID()}`;
    const citations = output.citations.map((citation) => {
      const source = sources.find((candidate) => candidate.handle === citation.sourceHandle)!;
      if (source.type === "pdf") return { type: "pdf", page: Number.parseInt(source.handle.slice(9), 10), locator: citation.locator };
      const file = code.find((candidate) => `code:${candidate.relative_path}` === source.handle)!;
      return { type: "code", commitSha: file.repository.commitSha, path: file.relative_path,
        startLine: file.start_line, endLine: file.end_line, locator: citation.locator };
    });
    const proposals = output.proposedTakeaways.map((proposal) => {
      const resolved = proposal.sourceHandles.map((handle) => sources.find((source) => source.handle === handle)).filter(Boolean) as typeof sources;
      if (resolved.length !== proposal.sourceHandles.length) throw new Error("codex-output-invalid");
      const quoteVerified = !proposal.quote || resolved.some((source) => source.text.includes(proposal.quote!));
      return { id: `proposal:${randomUUID()}`, proposalType: "takeaway", claim: proposal.claim,
        sourceHandles: proposal.sourceHandles, quote: proposal.quote ?? null, oneClickEligible: quoteVerified };
    });
    this.#database.transaction(() => {
      this.#database.prepare(`INSERT INTO messages(id,conversation_id,context_snapshot_id,role,content,citations_json,created_at) VALUES (?,?,?,'user',?,'[]',?)`)
        .run(userMessageId, conversationId, conversation.active_context_snapshot_id, content, now);
      this.#database.prepare(`INSERT INTO messages(id,conversation_id,context_snapshot_id,role,content,citations_json,created_at) VALUES (?,?,?,'assistant',?,?,?)`)
        .run(assistantMessageId, conversationId, conversation.active_context_snapshot_id, output.answer, JSON.stringify(citations), now);
      for (const proposal of proposals) this.#database.prepare(`INSERT INTO proposals(id,proposal_type,paper_id,source_message_id,payload_json,review_status,one_click_eligible,created_at)
        VALUES (?,'takeaway',?,?,?,'pending',?,?)`).run(proposal.id, conversation.paper_id, assistantMessageId,
          JSON.stringify({ claim: proposal.claim, sourceHandles: proposal.sourceHandles, quote: proposal.quote }), proposal.oneClickEligible ? 1 : 0, now);
      this.#database.prepare("UPDATE conversations SET updated_at=? WHERE id=?").run(now, conversationId);
    })();
    this.#event(conversationId, "message-complete", { messageId: assistantMessageId, proposalIds: proposals.map((proposal) => proposal.id) });
    return { message: { id: assistantMessageId, role: "assistant", content: output.answer, citations }, proposals };
  }

  decideProposal(proposalId: string, idempotencyKey: string): { status: number; body: unknown } {
    const existing = this.#database.prepare("SELECT result_json FROM review_decisions WHERE idempotency_key=?").get(idempotencyKey) as
      { result_json: string } | undefined;
    if (existing) return { status: 200, body: JSON.parse(existing.result_json) as unknown };
    const proposal = this.#database.prepare("SELECT paper_id,payload_json,review_status,one_click_eligible FROM proposals WHERE id=?").get(proposalId) as
      { paper_id: string; payload_json: string; review_status: string; one_click_eligible: number } | undefined;
    if (!proposal) return { status: 404, body: { code: "proposal-not-found" } };
    if (proposal.review_status !== "pending") return { status: 409, body: { code: "proposal-already-decided" } };
    const opened = this.#database.prepare("SELECT 1 FROM source_open_events WHERE proposal_id=? LIMIT 1").get(proposalId);
    if (!proposal.one_click_eligible && !opened) return { status: 409, body: { code: "source-verification-required" } };
    const payload = JSON.parse(proposal.payload_json) as { claim: string; sourceHandles: string[] };
    const now = new Date().toISOString();
    const slug = payload.claim.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-").slice(0, 48).replace(/-$/, "") || "takeaway";
    const takeawayId = `takeaway:${proposal.paper_id}:${createHash("sha256").update(payload.claim).digest("hex").slice(0, 12)}`;
    const revisionId = `${takeawayId}:r1`;
    const paper = this.listPapers().find((candidate) => candidate.id === proposal.paper_id)!;
    const relativePath = join("library", "papers", paper.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""), "takeaways", `${slug}.md`);
    const target = join(this.#knowledgeRoot, relativePath);
    const markdown = `---\nid: "${takeawayId}"\ntype: takeaway\npaper_id: "${proposal.paper_id}"\nrevision_id: "${revisionId}"\nrevision: 1\nreview_status: confirmed\nepistemic_status: evidence-backed\nprovenance: ${JSON.stringify(payload.sourceHandles)}\nsemantic_relations: []\nconfirmed_at: ${now.slice(0, 10)}\ncreated: ${now.slice(0, 10)}\nupdated: ${now.slice(0, 10)}\n---\n\n# ${payload.claim}\n\n## Claim\n\n${payload.claim}\n\n## Evidence\n\n${payload.sourceHandles.map((handle) => `- ${handle}`).join("\n")}\n`;
    const hash = createHash("sha256").update(markdown).digest("hex");
    const body = { reviewDecision: { id: `review-decision:${randomUUID()}`, action: "accept" },
      takeaway: { id: takeawayId, revisionId, revision: 1, reviewStatus: "confirmed", markdownPath: relativePath } };
    const writeId = `knowledge-write:${revisionId}`;
    const staged = `${target}.staged`;
    const writePayload = { paperId: proposal.paper_id, proposalId, idempotencyKey, claim: payload.claim,
      sourceHandles: payload.sourceHandles, takeawayId, revisionId, relativePath, hash, now, body };
    this.#database.prepare(`INSERT INTO knowledge_write_requests(id,request_type,target_path,staged_path,result_hash,phase,created_at,updated_at,payload_json)
      VALUES (?,'takeaway',?,?,?,'reserved',?,?,?) ON CONFLICT(id) DO NOTHING`)
      .run(writeId, relativePath, `${relativePath}.staged`, hash, now, now, JSON.stringify(writePayload));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(staged, markdown, "utf8");
    this.#database.prepare("UPDATE knowledge_write_requests SET phase='staged',updated_at=? WHERE id=?").run(now, writeId);
    this.#advanceTakeawayWrite(writeId);
    const writePhase = (this.#database.prepare("SELECT phase FROM knowledge_write_requests WHERE id=?").get(writeId) as { phase: string }).phase;
    if (writePhase !== "complete") return { status: 409, body: { code: "knowledge-write-conflicted" } };
    return { status: 201, body };
  }

  #advanceTakeawayWrite(writeId: string): void {
    const row = this.#database.prepare("SELECT target_path,staged_path,result_hash,phase,payload_json FROM knowledge_write_requests WHERE id=?").get(writeId) as
      { target_path: string; staged_path: string; result_hash: string; phase: string; payload_json: string };
    const payload = JSON.parse(row.payload_json) as { paperId: string; proposalId: string; idempotencyKey: string; claim: string;
      sourceHandles: string[]; takeawayId: string; revisionId: string; relativePath: string; hash: string; now: string;
      body: { reviewDecision: { id: string; action: string }; takeaway: unknown } };
    let phase = row.phase;
    const targetPath = this.#knowledgePath(row.target_path);
    const stagedPath = this.#knowledgePath(row.staged_path);
    if (phase === "staged") {
      if (existsSync(targetPath)) {
        const actualHash = createHash("sha256").update(readFileSync(targetPath)).digest("hex");
        if (actualHash !== row.result_hash) { this.#createWriteConflict(writeId, payload.paperId, row.target_path, row.result_hash, actualHash); return; }
        if (existsSync(stagedPath)) unlinkSync(stagedPath);
      } else renameSync(stagedPath, targetPath);
      this.#database.prepare("UPDATE knowledge_write_requests SET phase='renamed',updated_at=? WHERE id=?").run(new Date().toISOString(), writeId);
      phase = "renamed";
    }
    if (phase === "renamed") {
      const summaryArtifact = this.#database.prepare(`SELECT 'artifact:' || id artifact_id FROM summary_revisions WHERE paper_id=? AND status='active'`).get(payload.paperId) as { artifact_id: string } | undefined;
      this.#storeArtifact(`artifact:${payload.revisionId}`, "takeaway", readFileSync(targetPath), "md", "user", payload.body.reviewDecision.id, summaryArtifact?.artifact_id ?? null);
      this.#database.transaction(() => {
        this.#database.prepare("INSERT OR IGNORE INTO takeaways(id,paper_id,active_revision_id,created_at) VALUES (?,?,?,?)")
          .run(payload.takeawayId, payload.paperId, payload.revisionId, payload.now);
        this.#database.prepare(`INSERT OR IGNORE INTO takeaway_revisions(id,takeaway_id,revision,claim,review_status,provenance_json,markdown_path,markdown_hash,confirmed_at)
          VALUES (?,?,1,?,'confirmed',?,?,?,?)`).run(payload.revisionId, payload.takeawayId, payload.claim,
            JSON.stringify(payload.sourceHandles), payload.relativePath, payload.hash, payload.now);
        this.#database.prepare("UPDATE proposals SET review_status='accepted',decided_at=? WHERE id=?").run(payload.now, payload.proposalId);
        this.#database.prepare("INSERT OR IGNORE INTO review_decisions(id,proposal_id,action,idempotency_key,result_json,created_at) VALUES (?,?, 'accept',?,?,?)")
          .run(payload.body.reviewDecision.id, payload.proposalId, payload.idempotencyKey, JSON.stringify(payload.body), payload.now);
        this.#database.prepare(`INSERT OR IGNORE INTO index_outbox(projection,source_id,operation,state,created_at)
          VALUES ('global-curated',?,'upsert','pending',?)`).run(payload.revisionId, payload.now);
        this.#database.prepare("UPDATE knowledge_write_requests SET phase='metadata-committed',updated_at=? WHERE id=?").run(new Date().toISOString(), writeId);
      })();
      phase = "metadata-committed";
    }
    if (phase === "metadata-committed" || phase === "indexed") this.#database.transaction(() => {
      this.#database.prepare(`INSERT INTO curated_search_documents(id,source_type,source_id,title,body,updated_at)
        VALUES (?,'takeaway',?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET title=excluded.title,body=excluded.body,updated_at=excluded.updated_at`)
        .run(`curated:${payload.revisionId}`, payload.revisionId, payload.claim, payload.claim, payload.now);
      this.#database.prepare("UPDATE projection_state SET last_successful_at=?,updated_at=? WHERE projection='global-curated'").run(payload.now, payload.now);
      this.#database.prepare("UPDATE index_outbox SET state='complete',completed_at=? WHERE projection='global-curated' AND source_id=? AND operation='upsert'")
        .run(payload.now, payload.revisionId);
      this.#database.prepare("UPDATE knowledge_write_requests SET phase='complete',updated_at=? WHERE id=?").run(new Date().toISOString(), writeId);
    })();
  }

  issueProposalSourceOpen(proposalId: string): { pdfUrl: string; page: number } | null {
    const row = this.#database.prepare(`SELECT p.payload_json,pa.current_version_id FROM proposals p JOIN papers pa ON pa.id=p.paper_id
      WHERE p.id=? AND p.review_status='pending'`).get(proposalId) as { payload_json: string; current_version_id: string } | undefined;
    if (!row) return null;
    const payload = JSON.parse(row.payload_json) as { sourceHandles?: string[] };
    const handle = payload.sourceHandles?.find((candidate) => candidate.startsWith("pdf-page:"));
    if (!handle) return null;
    const token = randomUUID();
    this.#database.prepare("INSERT INTO source_open_tokens(token,proposal_id,paper_version_id,source_handle,issued_at) VALUES (?,?,?,?,?)")
      .run(token, proposalId, row.current_version_id, handle, new Date().toISOString());
    const page = Number.parseInt(handle.slice(9), 10);
    return { pdfUrl: `/api/paper-versions/${encodeURIComponent(row.current_version_id)}/pdf?openToken=${token}#page=${page}`, page };
  }

  consumeSourceOpenToken(versionId: string, token: string): void {
    const row = this.#database.prepare(`SELECT proposal_id,source_handle FROM source_open_tokens
      WHERE token=? AND paper_version_id=? AND consumed_at IS NULL`).get(token, versionId) as { proposal_id: string; source_handle: string } | undefined;
    if (!row) return;
    const now = new Date().toISOString();
    this.#database.transaction(() => {
      this.#database.prepare("UPDATE source_open_tokens SET consumed_at=? WHERE token=?").run(now, token);
      this.#database.prepare("INSERT OR IGNORE INTO source_open_events(id,proposal_id,source_handle,opened_at) VALUES (?,?,?,?)")
        .run(`source-open:${row.proposal_id}:${row.source_handle}`, row.proposal_id, row.source_handle, now);
    })();
  }

  async answerEntry(question: string, runEntry: (context: { question: string; sources: Array<{
    handle: string; sourceType: string; sourceId: string; title: string; body: string;
  }> }) => Promise<EntryResult>): Promise<unknown> {
    const terms = question.trim().split(/\s+/).filter((term) => term.length >= 3);
    const byId = new Map<string, { id: string; source_type: string; source_id: string; title: string; body: string }>();
    for (const term of terms) {
      const rows = this.#database.prepare(`SELECT d.id,d.source_type,d.source_id,d.title,d.body FROM curated_search_fts f
        JOIN curated_search_documents d ON d.rowid=f.rowid WHERE curated_search_fts MATCH ? ORDER BY rank LIMIT 8`).all(`"${term.replaceAll('"', '""')}"`) as
        Array<{ id: string; source_type: string; source_id: string; title: string; body: string }>;
      rows.forEach((row) => byId.set(row.id, row));
    }
    const sources = [...byId.values()].sort((a, b) => a.source_type.localeCompare(b.source_type)).map((row) => ({
      handle: `curated:${row.source_id}`, sourceType: row.source_type, sourceId: row.source_id, title: row.title, body: row.body,
    }));
    const entryContext = { question, sources };
    const output = await runEntry(entryContext);
    if (!output.answer || output.sourceHandles.some((handle) => !sources.some((source) => source.handle === handle))) throw new Error("codex-output-invalid");
    this.#recordAgentRun("entry-answer", null, null, entryContext, output, null);
    const selected = output.sourceHandles.map((handle) => sources.find((source) => source.handle === handle)!).map(({ body: _body, handle, ...source }) => {
      const paperId = source.sourceType === "summary"
        ? (this.#database.prepare("SELECT paper_id FROM summary_revisions WHERE id=?").get(source.sourceId) as { paper_id: string }).paper_id
        : (this.#database.prepare(`SELECT t.paper_id FROM takeaway_revisions tr JOIN takeaways t ON t.id=tr.takeaway_id WHERE tr.id=?`).get(source.sourceId) as { paper_id: string }).paper_id;
      return { handle, ...source, paperId, href: `/papers/${encodeURIComponent(paperId)}#${source.sourceType}=${encodeURIComponent(source.sourceId)}` };
    });
    const state = this.#database.prepare("SELECT last_successful_at FROM projection_state WHERE projection='global-curated'").get() as
      { last_successful_at: string | null };
    const pending = (this.#database.prepare("SELECT count(*) count FROM index_outbox WHERE projection='global-curated' AND state='pending'").get() as { count: number }).count;
    return { answer: output.answer, uncertainty: output.uncertainty, sources: selected,
      projection: { stale: pending > 0, lastSuccessfulAt: state.last_successful_at,
        ...(pending > 0 ? { notice: "知识索引更新中" } : {}) } };
  }

  listProposals(): unknown[] {
    return (this.#database.prepare(`SELECT id,proposal_type,review_status,one_click_eligible,created_at,archived_at,payload_json
      FROM proposals ORDER BY created_at,id`).all() as Array<{ id: string; proposal_type: string; review_status: string;
      one_click_eligible: number; created_at: string; archived_at: string | null; payload_json: string }>).map((row) => ({
        id: row.id, proposalType: row.proposal_type, reviewStatus: row.review_status, oneClickEligible: row.one_click_eligible === 1,
        createdAt: row.created_at, archivedAt: row.archived_at, payload: JSON.parse(row.payload_json) as unknown,
      }));
  }

  reopenProposal(id: string): boolean {
    return this.#database.prepare(`UPDATE proposals SET review_status='pending',archived_at=NULL
      WHERE id=? AND proposal_type='reconciliation' AND review_status='archived'`).run(id).changes === 1;
  }

  rebuildCuratedProjection(): { count: number; rebuiltAt: string } {
    const now = this.#now().toISOString();
    return this.#database.transaction(() => {
      this.#database.prepare("DELETE FROM curated_search_documents").run();
      const summaries = this.#database.prepare(`SELECT s.id,p.title,s.structured_json FROM summary_revisions s
        JOIN papers p ON p.id=s.paper_id WHERE s.status='active' ORDER BY s.id`).all() as
        Array<{ id: string; title: string; structured_json: string }>;
      for (const summary of summaries) {
        const structured = JSON.parse(summary.structured_json) as SummaryResult;
        this.#database.prepare(`INSERT INTO curated_search_documents(id,source_type,source_id,title,body,updated_at)
          VALUES (?,'summary',?,?,?,?)`).run(`curated:${summary.id}`, summary.id, summary.title,
            structured.sections.map((section) => section.body).join("\n"), now);
      }
      const takeaways = this.#database.prepare(`SELECT tr.id,tr.claim FROM takeaway_revisions tr
        JOIN takeaways t ON t.active_revision_id=tr.id WHERE tr.review_status='confirmed' ORDER BY tr.id`).all() as
        Array<{ id: string; claim: string }>;
      for (const takeaway of takeaways) this.#database.prepare(`INSERT INTO curated_search_documents(id,source_type,source_id,title,body,updated_at)
        VALUES (?,'takeaway',?,?,?,?)`).run(`curated:${takeaway.id}`, takeaway.id, takeaway.claim, takeaway.claim, now);
      this.#database.prepare(`UPDATE projection_state SET last_successful_at=?,rebuilt_at=?,updated_at=? WHERE projection='global-curated'`).run(now, now, now);
      this.#database.prepare("UPDATE index_outbox SET state='complete',completed_at=? WHERE projection='global-curated' AND state='pending'").run(now);
      return { count: summaries.length + takeaways.length, rebuiltAt: now };
    })();
  }

  diagnostics(): unknown {
    const integrity = (this.#database.pragma("integrity_check") as Array<{ integrity_check: string }>).map((row) => row.integrity_check);
    const foreignKeys = this.#database.pragma("foreign_key_check") as unknown[];
    const schemaVersion = (this.#database.prepare("SELECT max(version) version FROM schema_migrations").get() as { version: number }).version;
    const interruptedJobs = (this.#database.prepare("SELECT count(*) count FROM job_runs WHERE state='interrupted'").get() as { count: number }).count;
    const openWrites = (this.#database.prepare("SELECT count(*) count FROM knowledge_write_requests WHERE phase NOT IN ('complete','failed','conflicted')").get() as { count: number }).count;
    const pendingIndex = (this.#database.prepare("SELECT count(*) count FROM index_outbox WHERE state='pending'").get() as { count: number }).count;
    const missingArtifacts = (this.#database.prepare("SELECT storage_ref FROM artifacts").all() as Array<{ storage_ref: string }>).filter((row) => !existsSync(join(this.#assetRoot, row.storage_ref))).map((row) => row.storage_ref);
    const missingMarkdown = [
      ...(this.#database.prepare("SELECT markdown_path FROM summary_revisions").all() as Array<{ markdown_path: string }>),
      ...(this.#database.prepare("SELECT markdown_path FROM takeaway_revisions").all() as Array<{ markdown_path: string }>),
    ].filter((row) => !existsSync(join(this.#knowledgeRoot, row.markdown_path))).map((row) => row.markdown_path);
    return { schemaVersion, integrity, foreignKeyViolations: foreignKeys, interruptedJobs, openWrites, pendingIndex,
      missingArtifacts, missingMarkdown, healthy: integrity.every((value) => value === "ok") && foreignKeys.length === 0 && missingArtifacts.length === 0 && missingMarkdown.length === 0 };
  }

  #recordAgentRun(taskKind: string, paperId: string | null, contextSnapshotId: string | null, context: unknown, output: unknown, skillPath: string | null): string {
    const now = new Date().toISOString();
    const jobId = `job:${randomUUID()}`;
    const outputJson = JSON.stringify(output);
    const promptHash = createHash("sha256").update(JSON.stringify(context)).digest("hex");
    const schemaHash = createHash("sha256").update(`${taskKind}:schema:v1`).digest("hex");
    const skillHash = skillPath ? createHash("sha256").update(readFileSync(join(process.cwd(), skillPath))).digest("hex") : null;
    this.#database.transaction(() => {
      this.#database.prepare(`INSERT INTO job_runs(id,job_type,paper_id,state,progress,idempotency_key,input_json,output_json,queued_at,started_at,completed_at,heartbeat_at)
        VALUES (?,?,?,'succeeded',1,?,'{}',?,?,?,?,?)`).run(jobId, taskKind, paperId, `${taskKind}:${jobId}`, outputJson, now, now, now, now);
      this.#database.prepare(`INSERT INTO agent_runs(job_run_id,task_kind,model,codex_version,skill_path,skill_content_hash,context_snapshot_id,output_schema_hash,prompt_hash,output_json)
        VALUES (?,?,NULL,'unknown',?,?,?,?,?,?)`).run(jobId, taskKind, skillPath, skillHash, contextSnapshotId, schemaHash, promptHash, outputJson);
    })();
    return jobId;
  }

  #storeArtifact(id: string, artifactType: string, bytes: Uint8Array, extension: string, createdByKind: string,
    createdById: string | null, parentArtifactId: string | null): void {
    const hash = createHash("sha256").update(bytes).digest("hex");
    const storageRef = join("derived", artifactType, hash.slice(0, 2), `${hash}.${extension}`);
    const absolute = join(this.#assetRoot, storageRef);
    mkdirSync(dirname(absolute), { recursive: true });
    if (!existsSync(absolute)) {
      const staged = `${absolute}.staged-${randomUUID()}`;
      writeFileSync(staged, bytes);
      renameSync(staged, absolute);
    }
    this.#database.prepare(`INSERT OR IGNORE INTO artifacts(id,artifact_type,content_hash,storage_ref,media_type,byte_size,created_by_kind,retention_class,integrity_status,created_at,created_by_id)
      VALUES (?,?,?,?,?,?,?,'historical','verified',?,?)`).run(id, artifactType, hash, storageRef,
        extension === "json" ? "application/json" : "text/markdown", bytes.byteLength, createdByKind, new Date().toISOString(), createdById);
    if (parentArtifactId) this.#database.prepare(`INSERT OR IGNORE INTO artifact_parents(artifact_id,parent_artifact_id,relationship,ordinal)
      VALUES (?,?,'derived-from',0)`).run(id, parentArtifactId);
  }

  #knowledgePath(relativePath: string): string { return join(this.#knowledgeRoot, relativePath); }

  importPaper(input: { originalInput: string; resolved: ResolvedPaper; version: number; processing?: boolean }): {
    paper: StoredPaper; importRequest: StoredImportRequest;
  } {
    const now = new Date().toISOString();
    const author = input.resolved.authors[0]!.trim().split(/\s+/).at(-1)!.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
    const titleSlug = input.resolved.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").split("-").slice(0, 6).join("-");
    const paperId = `paper:${author}:${input.resolved.year}:${titleSlug}`;
    const versionId = `paper-version:${paperId}:arxiv:v${input.version}`;
    return this.#database.transaction(() => {
      this.#database.prepare(`INSERT INTO papers
        (id,title,acquisition_status,origin,lifecycle_status,current_version_id,created_at,updated_at)
        VALUES (?,?, 'ingested','manual-import','active',?,?,?) ON CONFLICT(id) DO NOTHING`)
        .run(paperId, input.resolved.title, versionId, now, now);
      this.#database.prepare(`INSERT INTO paper_external_identities
        (id,paper_id,identity_type,normalized_value,canonical_url,metadata_json,created_at)
        VALUES (?,?, 'arxiv',?,?, ?,?) ON CONFLICT(identity_type,normalized_value) DO NOTHING`)
        .run(`identity:arxiv:${input.resolved.arxivId}`, paperId, input.resolved.arxivId,
          `https://arxiv.org/abs/${input.resolved.arxivId}`, JSON.stringify({ authors: input.resolved.authors, year: input.resolved.year }), now);
      this.#database.prepare(`INSERT INTO paper_versions
        (id,paper_id,source_type,source_version,source_url,resolved_at,processing_status,accepted_at,created_at,updated_at)
        VALUES (?,?, 'arxiv',?,?,?,'accepted',?,?,?) ON CONFLICT(paper_id,source_type,source_version) DO NOTHING`)
        .run(versionId, paperId, `v${input.version}`, `https://arxiv.org/abs/${input.resolved.arxivId}v${input.version}`,
          now, now, now, now);
      this.#database.prepare("UPDATE papers SET current_version_id = COALESCE(current_version_id, ?) WHERE id = ?")
        .run(versionId, paperId);

      const importId = `import:${randomUUID()}`;
      this.#database.prepare(`INSERT INTO import_requests
        (id,original_input,normalized_input,submitted_at,resolution_status,resolved_paper_id,completed_at)
        VALUES (?,?,?,?, 'resolved',?,?)`)
        .run(importId, input.originalInput, input.resolved.arxivId, now, paperId, now);
      const jobId = `job:${randomUUID()}`;
      this.#database.prepare(`INSERT INTO job_runs
        (id,job_type,import_request_id,paper_id,state,progress,idempotency_key,input_json,output_json,queued_at,started_at,completed_at,heartbeat_at)
        VALUES (?,'paper-import',?,?,?, ?,?,'{}','{}',?,?,?,?)`)
        .run(jobId, importId, paperId, input.processing ? "running" : "succeeded", input.processing ? 0.1 : 1,
          `paper-import:${importId}`, now, now, input.processing ? null : now, now);
      this.#event(importId, "job-progress", { jobId, jobType: "paper-import", state: input.processing ? "running" : "succeeded", progress: input.processing ? 0.1 : 1 });

      return {
        paper: { id: paperId, arxivId: input.resolved.arxivId, title: input.resolved.title, version: input.version },
        importRequest: { id: importId, paperId, status: "resolved" as const },
      };
    })();
  }

  finishImport(importId: string, error?: unknown): void {
    const now = new Date().toISOString();
    const state = error ? "failed" : "succeeded";
    const progress = error ? 0.1 : 1;
    const errorJson = error ? JSON.stringify({ message: error instanceof Error ? error.message : "import-failed" }) : null;
    const job = this.#database.prepare(`UPDATE job_runs SET state=?,progress=?,error_json=?,completed_at=?,heartbeat_at=?
      WHERE import_request_id=? AND job_type='paper-import' RETURNING id`).get(state, progress, errorJson, now, now, importId) as { id: string } | undefined;
    if (job) this.#event(importId, "job-progress", { jobId: job.id, jobType: "paper-import", state, progress });
  }

  getImport(id: string): ImportStatus | null {
    const row = this.#database.prepare(`SELECT id,resolved_paper_id,resolution_status FROM import_requests WHERE id=?`).get(id) as
      { id: string; resolved_paper_id: string; resolution_status: string } | undefined;
    if (!row) return null;
    const jobs = this.#database.prepare(`SELECT id,job_type,state,progress FROM job_runs WHERE import_request_id=? ORDER BY queued_at,id`).all(id) as
      Array<{ id: string; job_type: string; state: string; progress: number }>;
    return { importRequest: { id: row.id, paperId: row.resolved_paper_id, resolutionStatus: row.resolution_status },
      jobs: jobs.map((job) => ({ id: job.id, jobType: job.job_type, state: job.state, progress: job.progress })) };
  }

  listEvents(scope: string, afterId: number): Array<{ id: number; type: string; data: unknown }> {
    return (this.#database.prepare(`SELECT id,event_type,data_json FROM durable_events WHERE scope=? AND id>? ORDER BY id`).all(scope, afterId) as
      Array<{ id: number; event_type: string; data_json: string }>).map((row) =>
        ({ id: row.id, type: row.event_type, data: JSON.parse(row.data_json) as unknown }));
  }

  #event(scope: string, type: string, data: unknown): void {
    this.#database.prepare("INSERT INTO durable_events(scope,event_type,data_json,created_at) VALUES (?,?,?,?)")
      .run(scope, type, JSON.stringify(data), new Date().toISOString());
  }

  listPapers(): StoredPaper[] {
    return (this.#database.prepare(`SELECT p.id,p.title,i.normalized_value,v.source_version FROM papers p
      JOIN paper_external_identities i ON i.paper_id=p.id AND i.identity_type='arxiv'
      JOIN paper_versions v ON v.id=p.current_version_id ORDER BY i.normalized_value`).all() as
      Array<{ id: string; title: string; normalized_value: string; source_version: string }>).map((row) => ({
        id: row.id, arxivId: row.normalized_value, title: row.title, version: Number.parseInt(row.source_version.slice(1), 10),
      }));
  }

  findFrozenArxiv(arxivId: string): StoredPaper | null {
    return this.listPapers().find((paper) => paper.arxivId === arxivId) ?? null;
  }

  getResolvedMetadata(paperId: string): ResolvedPaper | null {
    const paper = this.listPapers().find((candidate) => candidate.id === paperId);
    if (!paper) return null;
    const row = this.#database.prepare("SELECT metadata_json FROM paper_external_identities WHERE paper_id=? AND identity_type='arxiv'").get(paperId) as { metadata_json: string };
    const metadata = JSON.parse(row.metadata_json) as { authors: string[]; year: number };
    return { arxivId: paper.arxivId, latestVersion: paper.version, title: paper.title, authors: metadata.authors, year: metadata.year };
  }

  proposePaperUpdate(paper: StoredPaper, latestVersion: number): unknown | null {
    if (latestVersion <= paper.version) return null;
    const id = `proposal:paper-version-update:${paper.id}:v${latestVersion}`;
    const now = new Date().toISOString();
    this.#database.prepare(`INSERT OR IGNORE INTO proposals(id,proposal_type,paper_id,payload_json,review_status,one_click_eligible,created_at)
      VALUES (?,'paper-version-update',?,?,'pending',1,?)`).run(id, paper.id,
        JSON.stringify({ currentVersion: paper.version, latestVersion }), now);
    return { id, proposalType: "paper-version-update", currentVersion: paper.version, latestVersion, reviewStatus: "pending" };
  }

  close(): void { this.#database.close(); }
}

function listTextFiles(root: string): Array<{ absolute: string; relative: string }> {
  const tracked = execFileSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
  return tracked.map((relative) => ({ relative, absolute: join(root, relative) })).filter((file) =>
    statSync(file.absolute).size <= 256_000 && !readFileSync(file.absolute).includes(0));
}

function renderSummary(input: { summaryId: string; paper: StoredPaper; versionId: string; extractionId: string; agentRunId: string; skillHash: string;
  result: Omit<SummaryResult, "claims"> & { claims: Array<SummaryResult["claims"][number] & { page: number }> }; date: string }): string {
  const sections = input.result.sections.map((section, index) => `## ${index + 1}. ${section.title}\n\n${section.body}`).join("\n\n");
  const claims = input.result.claims.map((claim) => `| ${claim.voice} | ${claim.claim} | p. ${claim.page} |`).join("\n");
  return `---\nartifact_id: "artifact:${input.summaryId}"\ntype: paper-summary\npaper_id: "${input.paper.id}"\npaper_version_id: "${input.versionId}"\nextraction_run_id: "${input.extractionId}"\nsummary_revision_id: "${input.summaryId}"\nrevision: 1\nstatus: active\nread_status: ${input.result.readStatus}\nskill_path: skills/paper-reading/SKILL.md\nskill_content_hash: "${input.skillHash}"\nagent_run_id: "${input.agentRunId}"\ngenerated_at: ${input.date}\ncreated: ${input.date}\nupdated: ${input.date}\n---\n\n# ${input.paper.title} — Paper Summary\n\n${sections}\n\n## Key Claims\n\n| Voice | Claim | Evidence Anchor |\n|---|---|---|\n${claims}\n`;
}
