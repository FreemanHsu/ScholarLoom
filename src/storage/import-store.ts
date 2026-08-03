import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

import Database from "better-sqlite3";

import type { ResolvedPaper } from "../app.js";
import type { PreparedDirectPdfImport } from "../adapters/direct-pdf.js";
import type { DownloadedPdf } from "../adapters/safe-pdf-downloader.js";
import { migrate } from "./migrations.js";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { RepositoryAdapter } from "../adapters/git-repository.js";
import { isRetryableImportJobState, requireImportJobState, type ImportJobError, type ImportJobState, type ImportStage } from "../domain/import-job.js";
import { inspectDataRootAccess, type StorageLayout } from "./layout.js";
import { recoverInterruptedRuns } from "./bootstrap-recovery.js";
import { KnowledgeWriter } from "./knowledge-writer.js";
import { ContextSnapshotBuilder } from "./context-snapshot-builder.js";
import { ConversationStore } from "./conversation-store.js";
import { canonicalSectionHash } from "./canonical-section-hash.js";
import { RepositoryAssociations } from "./repository-associations.js";
import { liveDuplicateRevisionIds } from "./takeaway-distillation.js";
import { EPISTEMIC_STATUSES, TAKEAWAY_KINDS, type EpistemicStatus, type TakeawayKind } from "../agent/takeaway-distillation.js";
import type {
  AgentExecutionMetadataProvider,
  AgentTaskKind,
} from "../agent/agent-configuration.js";
import {
  validateChatOutput,
  validateEntryOutput,
  type EntryAnswerStatus,
} from "../agent/output-contracts.js";
import { PaperOrganizationStore, PaperOrganizationStoreError } from "./paper-organization-store.js";
import { PaperTaxonomyStore } from "./paper-taxonomy-store.js";
import {
  PaperOrganizationBatchStore,
  type PaperOrganizationBatchAction,
} from "./paper-organization-batch-store.js";
import type { OrganizationQueueQuery } from "./paper-organization-store.js";
import {
  PAPER_ORGANIZATION_CONTRACT_VERSION,
  type PaperOrganizationScope,
} from "../agent/paper-organization.js";
import {
  PaperResolver,
  PaperResolverError,
  type PaperResolution,
  type PaperResolverMode,
} from "./paper-resolver.js";
import { TopicKnowledgeStore } from "./topic-knowledge-store.js";

const standardFontDataUrl = `${join(dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json")), "standard_fonts")}/`;

export type StoredPaper = {
  id: string;
  arxivId?: string;
  versionId: string;
  version: number;
  versionLabel: string;
  sourceType: "arxiv" | "direct-pdf";
  sourceUrl: string;
  title: string;
  authors: string[];
  year: number;
  updatedAt?: string;
  processing?: { state: ImportJobState; progress: number; needsAttention: boolean; error: ImportJobError | null } | null;
  summaryStatus?: "ready" | "processing" | "failed";
  codeStatus?: "ready" | "failed" | "not-linked";
  pendingReviewCount?: number;
  aliases?: import("../domain/paper-organization.js").PaperAlias[];
  preferredAlias?: string | null;
  directions?: import("./paper-organization-store.js").CatalogDirection[];
  externalIdentities?: string[];
  pendingOrganizationCount?: number;
  aliasCollision?: boolean;
  matchedBy?: {
    kind: "external-identity" | "preferred-alias" | "alias" | "canonical-title" | "prefix" | "catalog";
    value: string;
    exact: boolean;
  };
};
export type StoredImportRequest = { id: string; paperId: string; status: "resolved" };

export type SummaryResult = {
  sections: Array<{ key: string; title: string; body: string }>;
  claims: Array<{ voice: "authors-claim" | "paper-evidence" | "agent-assessment"; claim: string; sourceHandle: string }>;
  readStatus: "abstract" | "skimmed" | "read";
};
export type ChatResult = {
  answer: string;
  citations: Array<{ sourceHandle: string; locator: string }>;
};
export type ChatSource = {
  handle: string;
  type: "pdf" | "summary" | "code" | "message";
  text: string;
  locator: string;
};
export type EntryResult = {
  answerStatus: EntryAnswerStatus;
  answer: string;
  sourceHandles: string[];
  uncertainty: string | null;
};
export type EntryResolutionRequest = {
  mode: PaperResolverMode;
  resolutionMode?: "auto" | "off";
  resolutionSelection?: {
    snapshotHash: string;
    groups: Record<string, string>;
  };
};
export type TakeawayReviewInput = {
  edited?: Partial<{ title: string; claim: string; evidenceRationale: string; caveat: string | null;
    receiptIds: string[]; epistemicStatus: EpistemicStatus }>;
  evidenceReviewed?: boolean;
  duplicateAcknowledged?: boolean;
  rejectReason?: "useful-answer-not-knowledge" | "context-incomplete" | "incorrect-or-unsupported" |
    "duplicate" | "too-broad" | "too-trivial" | "other";
};

type ImportStatus = {
  importRequest: { id: string; paperId: string | null; resolutionStatus: string;
    error: { code: string; detail: string } | null };
  jobs: Array<{ id: string; jobType: string; state: ImportJobState; progress: number; attempt: number; error: ImportJobError | null }>;
};

type ImportJobHandle = { id: string; attempt: number; state: ImportJobState };
type ImportExecution = { paper: StoredPaper; arxivId?: string; version: number; importRequest: StoredImportRequest; job: ImportJobHandle };
type RetryImportResult = { ok: true; execution: ImportExecution; replayed: boolean } |
  { ok: false; code: "job-not-found" | "job-not-retryable" | "job-already-active" | "idempotency-key-conflict" };

export class ImportStore {
  readonly #layout: StorageLayout;
  readonly #database: Database.Database;
  readonly #artifactRoot: string;
  readonly #knowledgeRoot: string;
  readonly #failurePoint: "reserved" | "staged" | "renamed" | "metadata-committed" | "indexed" | null;
  readonly #now: () => Date;
  readonly #contextSnapshots: ContextSnapshotBuilder;
  readonly #conversations: ConversationStore;
  readonly #knowledgeWriter: KnowledgeWriter;
  readonly #repositoryAssociations: RepositoryAssociations;
  readonly #paperOrganization: PaperOrganizationStore;
  readonly #paperTaxonomy: PaperTaxonomyStore;
  readonly #paperOrganizationBatches: PaperOrganizationBatchStore;
  readonly #paperResolver: PaperResolver;
  readonly #topicKnowledge: TopicKnowledgeStore;
  readonly #agentExecutionMetadata: AgentExecutionMetadataProvider | undefined;

  static open(layout: StorageLayout,
    failurePoint: "reserved" | "staged" | "renamed" | "metadata-committed" | "indexed" | null = null,
    now?: () => Date, repositoryRuntime?: { adapter?: RepositoryAdapter; schedule(task: Promise<void>): void;
      agentExecutionMetadata?: AgentExecutionMetadataProvider }): ImportStore {
    return new ImportStore(layout, failurePoint, now, repositoryRuntime);
  }

  private constructor(layout: StorageLayout,
    failurePoint: "reserved" | "staged" | "renamed" | "metadata-committed" | "indexed" | null = null,
    now: () => Date = () => new Date(),
    repositoryRuntime: { adapter?: RepositoryAdapter; schedule(task: Promise<void>): void;
      agentExecutionMetadata?: AgentExecutionMetadataProvider } = { schedule() {} }) {
    this.#layout = layout;
    this.#artifactRoot = layout.root;
    this.#knowledgeRoot = layout.vaultRoot;
    this.#failurePoint = failurePoint;
    this.#now = now;
    this.#agentExecutionMetadata = repositoryRuntime.agentExecutionMetadata;
    this.#database = new Database(layout.databasePath);
    this.#database.pragma("foreign_keys = ON");
    this.#database.pragma("journal_mode = WAL");
    this.#database.pragma("busy_timeout = 5000");
    migrate(this.#database);
    this.#contextSnapshots = new ContextSnapshotBuilder(this.#database, this.#now, layout.repositoryRoot);
    this.#conversations = new ConversationStore(this.#database, this.#now);
    this.#repositoryAssociations = new RepositoryAssociations(this.#database, {
      repositoryRoot: layout.repositoryRoot,
      ...(repositoryRuntime.adapter ? { adapter: repositoryRuntime.adapter } : {}),
      schedule: repositoryRuntime.schedule,
      now: this.#now,
    });
    recoverInterruptedRuns(this.#database, this.#now().toISOString());
    this.#knowledgeWriter = new KnowledgeWriter(this.#database, {
      now: this.#now,
      stagedFileExists: (relativePath) => existsSync(this.#knowledgePath(relativePath)),
      afterTakeawayPhase: (phase) => this.#maybeFail(phase),
      afterOrganizationPhase: (phase) => this.#maybeFail(phase),
      advanceSummary: (id) => this.#advanceSummaryWrite(id),
      advancePaperManifest: (id) => this.#advanceManifestWrite(id),
      knowledgePath: (relativePath) => this.#knowledgePath(relativePath),
      storeArtifact: (id, bytes, reviewDecisionId, parentArtifactId) =>
        this.#storeArtifact(id, "takeaway", bytes, "md", "user", reviewDecisionId, parentArtifactId),
      createWriteConflict: (writeId, paperId, targetPath, expectedHash, actualHash) =>
        this.#createWriteConflict(writeId, paperId, targetPath, expectedHash, actualHash),
      rebuildPaperCatalog: (trustedWrite) => this.#paperOrganization.rebuildCatalog(trustedWrite),
    });
    this.#paperOrganization = new PaperOrganizationStore(this.#database, layout, this.#now, this.#knowledgeWriter);
    this.#topicKnowledge = new TopicKnowledgeStore(this.#database, layout, this.#now,
      (trusted) => this.#paperOrganization.rebuildCatalog(trusted));
    this.#paperTaxonomy = new PaperTaxonomyStore(this.#database, layout, this.#now,
      this.#knowledgeWriter, this.#paperOrganization);
    this.#paperOrganizationBatches = new PaperOrganizationBatchStore(
      this.#database, this.#now, this.#paperOrganization);
    this.#paperResolver = new PaperResolver(this.#database);
    this.#knowledgeWriter.recover();
    this.#paperOrganization.rebuildCatalog();
    this.#topicKnowledge.recover();
    const archiveBefore = new Date(this.#now().getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    this.#database.prepare(`UPDATE proposals SET review_status='archived',archived_at=?
      WHERE proposal_type='reconciliation' AND review_status='pending' AND created_at < ?`).run(this.#now().toISOString(), archiveBefore);
  }

  async ingestPaper(input: {
    paper: StoredPaper;
    pdfBytes: Uint8Array;
    onStage?: (stage: Exclude<ImportStage, "pdf-download">) => void;
    runSummary(context: { paperId: string; title: string; pages: Array<{ handle: string; page: number; text: string }> }): Promise<SummaryResult>;
  }): Promise<void> {
    input.onStage?.("pdf-storage");
    const now = new Date().toISOString();
    const bytes = new Uint8Array(input.pdfBytes);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const storageRef = join("originals", "papers", hash.slice(0, 2), `${hash}.pdf`);
    const absolutePdf = join(this.#artifactRoot, storageRef);
    mkdirSync(dirname(absolutePdf), { recursive: true });
    const existingPdfValid = this.#fileMatches(absolutePdf, hash, bytes.byteLength);
    if (!existingPdfValid) {
      const stagedPdf = `${absolutePdf}.staged-${randomUUID()}`;
      writeFileSync(stagedPdf, bytes);
      renameSync(stagedPdf, absolutePdf);
      chmodSync(absolutePdf, 0o400);
    }
    const artifactId = `artifact:pdf:${hash}`;
    const versionId = input.paper.versionId;
    this.#database.prepare(`INSERT INTO artifacts(id,artifact_type,content_hash,storage_ref,media_type,byte_size,created_by_kind,retention_class,created_at)
      VALUES (?,'paper-pdf',?,?,'application/pdf',?,'external-source','irreplaceable',?) ON CONFLICT(artifact_type,content_hash) DO NOTHING`)
      .run(artifactId, hash, storageRef, bytes.byteLength, now);
    this.#database.prepare("UPDATE paper_versions SET pdf_artifact_id=?,processing_status='processing',updated_at=? WHERE id=?")
      .run(artifactId, now, versionId);

    const extractionId = `extraction:${versionId}:pdfjs`;
    const completedExtraction = this.#database.prepare(`SELECT output_artifact_id,page_count FROM extraction_runs
      WHERE id=? AND status='succeeded'`).get(extractionId) as { output_artifact_id: string | null; page_count: number | null } | undefined;
    const storedPageCount = (this.#database.prepare("SELECT count(*) count FROM document_elements WHERE extraction_run_id=? AND element_type='page'")
      .get(extractionId) as { count: number }).count;
    const extractionReusable = Boolean(completedExtraction?.output_artifact_id && completedExtraction.page_count === storedPageCount &&
      storedPageCount > 0 && this.#artifactIsValid(completedExtraction.output_artifact_id));
    let pages: Array<{ handle: string; page: number; text: string }>;
    if (extractionReusable) {
      pages = (this.#database.prepare(`SELECT page_number,text_content FROM document_elements
        WHERE extraction_run_id=? AND element_type='page' ORDER BY page_number,ordinal`).all(extractionId) as
        Array<{ page_number: number; text_content: string }>).map((page) =>
        ({ handle: `pdf-page:${page.page_number}`, page: page.page_number, text: page.text_content }));
    } else {
      this.#database.prepare(`INSERT INTO extraction_runs(id,paper_version_id,source_artifact_id,extractor_name,extractor_version,status,started_at)
        VALUES (?,?,?,'pdfjs','5','running',?) ON CONFLICT(id) DO UPDATE SET status='running',started_at=excluded.started_at`)
        .run(extractionId, versionId, artifactId, now);
      input.onStage?.("pdf-extraction");
      const document = await getDocument({ data: bytes, standardFontDataUrl }).promise;
      pages = [];
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
      const storedExtractionArtifactId = this.#storeArtifact(extractionArtifactId, "document-extraction",
        Buffer.from(JSON.stringify(pages)), "json", "job-run", null, artifactId);
      this.#database.prepare("UPDATE extraction_runs SET status='succeeded',page_count=?,completed_at=?,output_artifact_id=? WHERE id=?")
        .run(document.numPages, now, storedExtractionArtifactId, extractionId);
    }

    const summaryId = `summary:${versionId}:r1`;
    const existingWrite = this.#database.prepare("SELECT phase,payload_json FROM knowledge_write_requests WHERE id=?")
      .get(`knowledge-write:${summaryId}`) as { phase: string; payload_json: string } | undefined;
    if (existingWrite) {
      input.onStage?.("knowledge-write");
      if (existingWrite.phase === "conflicted") throw new Error("knowledge-write-conflicted");
      if (existingWrite.phase === "failed") {
        const payload = JSON.parse(existingWrite.payload_json) as { markdown?: string };
        if (!payload.markdown) throw new Error("knowledge-write-recovery-unavailable");
        this.#database.prepare("UPDATE knowledge_write_requests SET phase='reserved',error_code=NULL,updated_at=? WHERE id=?")
          .run(new Date().toISOString(), `knowledge-write:${summaryId}`);
      }
      this.#advanceSummaryWrite(`knowledge-write:${summaryId}`);
      const resumed = this.#database.prepare("SELECT phase FROM knowledge_write_requests WHERE id=?")
        .get(`knowledge-write:${summaryId}`) as { phase: string };
      if (resumed.phase !== "complete") throw new Error(`knowledge-write-incomplete:${resumed.phase}`);
      return;
    }

    const summaryContext = { paperId: input.paper.id, title: input.paper.title, pages };
    input.onStage?.("paper-summary");
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
    const summaryVersion = input.paper.sourceType === "arxiv" ? `v${input.paper.version}` : `pdf-${input.paper.versionLabel.replace(/^sha256:/, "").slice(0, 12)}`;
    const relativePath = join("library", "papers", slug, `summary-${summaryVersion}-r1.md`);
    const targetPath = join(this.#knowledgeRoot, relativePath);
    const skillHash = createHash("sha256").update(readFileSync(join(process.cwd(), "skills/paper-reading/SKILL.md"))).digest("hex");
    const markdown = renderSummary({ summaryId, paper: input.paper, versionId, extractionId, agentRunId, skillHash, result: structured, date: now.slice(0, 10) });
    const markdownHash = createHash("sha256").update(markdown).digest("hex");
    const stagedPath = `${targetPath}.staged`;
    const writeId = `knowledge-write:${summaryId}`;
    mkdirSync(dirname(targetPath), { recursive: true });
    input.onStage?.("knowledge-write");
    const writePayload = { summaryId, paperId: input.paper.id, paperTitle: input.paper.title, versionId, extractionId, markdown,
      readStatus: result.readStatus, relativePath, markdownHash, structured, skillHash, agentRunId, claims, now };
    this.#database.prepare(`INSERT INTO knowledge_write_requests(id,request_type,target_path,staged_path,result_hash,phase,created_at,updated_at,payload_json)
      VALUES (?,'summary',?,?,?,'reserved',?,?,?) ON CONFLICT(id) DO NOTHING`).run(writeId, relativePath, `${relativePath}.staged`, markdownHash, now, now, JSON.stringify(writePayload));
    writeFileSync(stagedPath, markdown, "utf8");
    this.#database.prepare("UPDATE knowledge_write_requests SET phase='staged',updated_at=? WHERE id=?").run(now, writeId);
    this.#maybeFail("staged");
    this.#advanceSummaryWrite(writeId);
  }

  #maybeFail(phase: "reserved" | "staged" | "renamed" | "metadata-committed" | "indexed"): void {
    if (this.#failurePoint === phase) throw new Error(`fault-injected:${phase}`);
  }

  #advanceSummaryWrite(writeId: string): void {
    const row = this.#database.prepare(`SELECT target_path,staged_path,result_hash,phase,payload_json FROM knowledge_write_requests WHERE id=?`).get(writeId) as
      { target_path: string; staged_path: string; result_hash: string; phase: string; payload_json: string };
    const payload = JSON.parse(row.payload_json) as { summaryId: string; paperId: string; paperTitle: string; versionId: string; extractionId: string; markdown?: string;
      readStatus: string; relativePath: string; markdownHash: string; structured: SummaryResult; skillHash: string;
      claims: Array<{ evidenceAnchorId: string }>; agentRunId: string; now: string };
    let phase = row.phase;
    const targetPath = this.#knowledgePath(row.target_path);
    const stagedPath = this.#knowledgePath(row.staged_path);
    if ((phase === "reserved" || phase === "staged") && !existsSync(stagedPath) && !existsSync(targetPath) && payload.markdown) {
      const recoveredHash = createHash("sha256").update(payload.markdown).digest("hex");
      if (recoveredHash === row.result_hash) writeFileSync(stagedPath, payload.markdown, "utf8");
    }
    if (phase === "reserved" && existsSync(stagedPath)) {
      const stagedHash = createHash("sha256").update(readFileSync(stagedPath)).digest("hex");
      if (stagedHash !== row.result_hash) {
        this.#database.prepare("UPDATE knowledge_write_requests SET phase='failed',error_code='staged-hash-mismatch',updated_at=? WHERE id=?")
          .run(new Date().toISOString(), writeId);
        return;
      }
      this.#database.prepare("UPDATE knowledge_write_requests SET phase='staged',updated_at=? WHERE id=?").run(new Date().toISOString(), writeId);
      phase = "staged";
    }
    if (phase === "staged") {
      if (existsSync(targetPath)) {
        const finalHash = createHash("sha256").update(readFileSync(targetPath)).digest("hex");
        if (finalHash !== row.result_hash) {
          const now = new Date().toISOString();
          this.#database.transaction(() => {
            this.#database.prepare("UPDATE knowledge_write_requests SET phase='conflicted',error_code='external-edit',updated_at=? WHERE id=?").run(now, writeId);
            this.#database.prepare(`INSERT OR IGNORE INTO proposals(id,proposal_type,paper_id,payload_json,review_status,one_click_eligible,created_at)
              VALUES (?,'reconciliation',?,?,'pending',0,?)`).run(`proposal:reconciliation:${writeId}`, payload.paperId,
                JSON.stringify({
                  writeId,
                  targetKind: "summary",
                  targetPath: row.target_path,
                  expectedHash: row.result_hash,
                  actualHash: finalHash,
                }), now);
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
        this.#database.prepare(`INSERT INTO summary_revisions(id,paper_id,paper_version_id,extraction_run_id,revision,status,read_status,markdown_path,markdown_hash,structured_json,skill_path,skill_content_hash,created_at,agent_run_id,canonical_sections_hash)
          VALUES (?,?,?,?,1,'active',?,?,?,?, 'skills/paper-reading/SKILL.md',?,?,?,?) ON CONFLICT(id) DO NOTHING`)
          .run(payload.summaryId, payload.paperId, payload.versionId, payload.extractionId, payload.readStatus, payload.relativePath,
            payload.markdownHash, JSON.stringify(payload.structured), payload.skillHash, payload.now, payload.agentRunId,
            canonicalSectionHash(payload.structured));
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
      const currentVersion = (this.#database.prepare("SELECT current_version_id FROM papers WHERE id=?").get(payload.paperId) as
        { current_version_id: string }).current_version_id;
      const acceptedCandidate = this.#database.prepare(`SELECT 1 FROM proposals WHERE paper_id=? AND proposal_type='paper-version-update'
        AND review_status='accepted' AND json_extract(payload_json,'$.candidateVersionId')=? LIMIT 1`).get(payload.paperId, payload.versionId);
      const activateVersion = currentVersion === payload.versionId || Boolean(acceptedCandidate);
      this.#database.transaction(() => {
        this.#database.prepare(`INSERT INTO curated_search_documents(id,source_type,source_id,title,body,updated_at)
          VALUES (?,'summary',?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET title=excluded.title,body=excluded.body,updated_at=excluded.updated_at`)
          .run(`curated:${payload.summaryId}`, payload.summaryId, payload.paperTitle, payload.structured.sections.map((section) => section.body).join("\n"), payload.now);
        this.#database.prepare("UPDATE projection_state SET last_successful_at=?,updated_at=? WHERE projection='global-curated'").run(payload.now, payload.now);
        this.#database.prepare("UPDATE index_outbox SET state='complete',completed_at=? WHERE projection='global-curated' AND source_id=? AND operation='upsert'")
          .run(payload.now, payload.summaryId);
        this.#database.prepare("UPDATE knowledge_write_requests SET phase='complete',updated_at=? WHERE id=?").run(new Date().toISOString(), writeId);
        this.#database.prepare("UPDATE paper_versions SET processing_status='available',updated_at=? WHERE id=?").run(payload.now, payload.versionId);
        if (activateVersion) this.#database.prepare("UPDATE papers SET current_version_id=?,updated_at=? WHERE id=?")
          .run(payload.versionId, payload.now, payload.paperId);
        if (activateVersion) {
          try {
            this.#database.prepare(`INSERT INTO paper_organization_triggers
              (paper_id,summary_revision_id,summary_hash,contract_version,state,created_at)
              VALUES (?,?,?,?, 'pending',?) ON CONFLICT(paper_id,summary_revision_id,contract_version) DO NOTHING`)
              .run(payload.paperId, payload.summaryId, payload.markdownHash,
                PAPER_ORGANIZATION_CONTRACT_VERSION, payload.now);
          } catch {
            // Organization suggestions are auxiliary; they must never roll back a confirmed Summary.
          }
        }
      })();
      if (activateVersion) this.#writePaperManifest(payload.paperId, payload.paperTitle, payload.versionId, payload.summaryId, payload.now);
    }
  }

  #writePaperManifest(paperId: string, title: string, versionId: string, summaryId: string, now: string): void {
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "paper";
    const relativePath = join("library", "papers", slug, "paper.md");
    const target = join(this.#knowledgeRoot, relativePath);
    const identity = this.#database.prepare(`SELECT identity_type,normalized_value,metadata_json FROM paper_external_identities
      WHERE paper_id=? ORDER BY CASE identity_type WHEN 'arxiv' THEN 0 ELSE 1 END,created_at LIMIT 1`).get(paperId) as
      { identity_type: string; normalized_value: string; metadata_json: string };
    const metadata = JSON.parse(identity.metadata_json) as { authors: string[]; year: number };
    const summaryPath = this.#database.prepare("SELECT markdown_path FROM summary_revisions WHERE id=?").pluck().get(summaryId) as string;
    const markdown = `---\nid: "${paperId}"\ntype: paper\ntitle: "${title}"\nauthors: ${JSON.stringify(metadata.authors)}\nyear: ${metadata.year}\nvenue: null\nexternal_identities:\n  ${identity.identity_type}: "${identity.normalized_value}"\nacquisition_status: ingested\norigin: manual-import\ncurrent_version_id: "${versionId}"\ncurrent_summary_revision_id: "${summaryId}"\npaper_code_links: []\nread_status: read\nstatus: active\naliases: []\ndirections: []\ntopics: []\nconcepts: []\ntags: []\ncreated: ${now.slice(0, 10)}\nupdated: ${now.slice(0, 10)}\n---\n\n# ${title}\n\n## Current reading\n\n- Current Paper Version: ${versionId}\n- Active Paper Summary: [[${summaryPath.replace(/\.md$/, "")}]]\n\n## Confirmed Takeaways\n\n| Takeaway | Active revision | Evidence | Status |\n|---|---|---|---|\n`;
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
    this.#paperOrganization.rebuildCatalog({ targetPath: relativePath, resultHash: hash });
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
    const requestType = this.#database.prepare("SELECT request_type FROM knowledge_write_requests WHERE id=?")
      .pluck().get(writeId) as string | undefined;
    this.#database.transaction(() => {
      this.#database.prepare("UPDATE knowledge_write_requests SET phase='conflicted',error_code='external-edit',updated_at=? WHERE id=?").run(now, writeId);
      this.#database.prepare(`INSERT OR IGNORE INTO proposals(id,proposal_type,paper_id,payload_json,review_status,one_click_eligible,created_at)
        VALUES (?,'reconciliation',?,?,'pending',0,?)`).run(`proposal:reconciliation:${writeId}`, paperId,
          JSON.stringify({
            writeId,
            targetKind: requestType === "paper-manifest" ? "paper-manifest"
              : requestType === "takeaway" ? "takeaway" : "unknown",
            targetPath,
            expectedHash,
            actualHash,
          }), now);
    })();
  }

  getPaperWorkspace(id: string): unknown | null {
    const paper = this.listPapers().find((candidate) => candidate.id === id);
    if (!paper) return null;
    const versionId = paper.versionId;
    const extraction = this.#database.prepare("SELECT id,page_count FROM extraction_runs WHERE paper_version_id=? AND status='succeeded'").get(versionId) as
      { id: string; page_count: number } | undefined;
    const summary = this.#database.prepare(`SELECT id,status,read_status,markdown_path,structured_json FROM summary_revisions
      WHERE paper_id=? AND paper_version_id=? AND status='active' ORDER BY revision DESC LIMIT 1`).get(id, versionId) as
      { id: string; status: string; read_status: string; markdown_path: string; structured_json: string } | undefined;
    const latestJob = this.#database.prepare(`SELECT id,state,progress,attempt,error_json FROM job_runs
      WHERE paper_id=? AND job_type='paper-import' ORDER BY attempt DESC,queued_at DESC,id DESC LIMIT 1`).get(id) as
      { id: string; state: string; progress: number; attempt: number; error_json: string | null } | undefined;
    return {
      paper: { ...paper, versionId },
      pdf: extraction ? { pageCount: extraction.page_count } : null,
      summary: summary ? { id: summary.id, status: summary.status, readStatus: summary.read_status,
        markdownPath: summary.markdown_path, ...JSON.parse(summary.structured_json) as object } : null,
      processing: latestJob ? { jobId: latestJob.id, state: requireImportJobState(latestJob.state), progress: latestJob.progress,
        attempt: latestJob.attempt, error: parseStoredImportError(latestJob.error_json) } : null,
      repositories: this.#repositoryAssociations.list(id),
    };
  }

  getPdf(versionId: string): Uint8Array | null {
    const row = this.#database.prepare(`SELECT a.id,a.storage_ref FROM paper_versions v JOIN artifacts a ON a.id=v.pdf_artifact_id WHERE v.id=?`).get(versionId) as
      { id: string; storage_ref: string } | undefined;
    return row && this.#artifactIsValid(row.id) ? readFileSync(join(this.#artifactRoot, row.storage_ref)) : null;
  }

  listRepositoryAssociations(paperId: string): unknown[] {
    return this.#repositoryAssociations.list(paperId);
  }

  addManualRepositoryAssociation(paperId: string, url: string, idempotencyKey: string): unknown {
    return this.#repositoryAssociations.addManual(paperId, url, idempotencyKey);
  }

  confirmRepositoryAssociation(paperId: string, associationId: string, idempotencyKey: string): unknown {
    return this.#repositoryAssociations.confirm(paperId, associationId, idempotencyKey);
  }

  retryRepositoryAssociation(paperId: string, associationId: string, idempotencyKey: string): unknown {
    return this.#repositoryAssociations.retry(paperId, associationId, idempotencyKey);
  }

  removeRepositoryAssociation(paperId: string, associationId: string, idempotencyKey: string): unknown {
    return this.#repositoryAssociations.remove(paperId, associationId, idempotencyKey);
  }

  startConversation(paperId: string, continuedFromConversationId: string | null = null): unknown | null {
    return this.#contextSnapshots.create(paperId, continuedFromConversationId);
  }

  listConversations(paperId: string): unknown[] {
    return this.#conversations.listForPaper(paperId);
  }

  renameConversation(conversationId: string, title: string): boolean {
    return this.#conversations.rename(conversationId, title);
  }

  setConversationArchived(conversationId: string, archived: boolean): boolean {
    return this.#conversations.setArchived(conversationId, archived);
  }

  getConversation(conversationId: string): unknown | null {
    return this.#conversations.read(conversationId);
  }

  getConversationLineage(conversationId: string): unknown | null {
    return this.#conversations.readLineage(conversationId);
  }

  previewConversationContinuation(conversationId: string): unknown | null {
    return this.#contextSnapshots.preview(conversationId);
  }

  conversationTurnBlock(conversationId: string, idempotencyKey: string): string | null {
    return this.#conversations.turnBlock(conversationId, idempotencyKey);
  }

  messageRetryBlock(messageId: string, idempotencyKey: string): string | null {
    return this.#conversations.retryBlock(messageId, idempotencyKey);
  }

  paperExists(paperId: string): boolean {
    return this.#conversations.paperExists(paperId);
  }

  async sendMessage(conversationId: string, content: string, idempotencyKey: string, runChat: (context: {
    paperId: string; conversationId: string; content: string; sources: ChatSource[];
  }) => Promise<ChatResult>, retryUserMessageId: string | null = null): Promise<unknown | null> {
    const conversation = this.#database.prepare(`SELECT c.paper_id,c.active_context_snapshot_id,c.status,c.snapshot_integrity,
      cs.paper_version_id,cs.summary_revision_id,cs.extraction_run_id,cs.repositories_json
      FROM conversations c JOIN context_snapshots cs ON cs.id=c.active_context_snapshot_id WHERE c.id=?`).get(conversationId) as
      { paper_id: string; active_context_snapshot_id: string; status: string; snapshot_integrity: string;
        paper_version_id: string; summary_revision_id: string; extraction_run_id: string; repositories_json: string } | undefined;
    if (!conversation) return null;
    if (conversation.status !== "active") throw new Error("conversation-archived");
    if (conversation.snapshot_integrity !== "frozen") throw new Error("conversation-legacy-read-only");
    const pages = this.#database.prepare(`SELECT d.page_number,d.text_content,e.id evidence_anchor_id
      FROM document_elements d JOIN evidence_anchors e ON e.document_element_id=d.id
        AND e.id='evidence:' || ? || ':page:' || d.page_number || ':source'
      WHERE d.extraction_run_id=? ORDER BY d.page_number`).all(conversation.paper_version_id, conversation.extraction_run_id) as
      Array<{ page_number: number; text_content: string; evidence_anchor_id: string }>;
    const repositories = JSON.parse(conversation.repositories_json) as Array<{ id: string; commitSha: string }>;
    const allCode = repositories.flatMap((repository) => (this.#database.prepare(`SELECT relative_path,start_line,end_line,text_content
      FROM code_elements WHERE repository_snapshot_id=? ORDER BY relative_path`).all(repository.id) as
      Array<{ relative_path: string; start_line: number; end_line: number; text_content: string }>).map((file) => ({ ...file, repository })));
    const terms = content.toLowerCase().split(/\s+/).filter((term) => term.length >= 4);
    const code = allCode.filter((file) => /^readme(?:\.|$)/i.test(file.relative_path) || terms.some((term) =>
      file.relative_path.toLowerCase().includes(term) || file.text_content.toLowerCase().includes(term))).slice(0, 12);
    const summary = this.#database.prepare("SELECT structured_json FROM summary_revisions WHERE id=?")
      .get(conversation.summary_revision_id) as { structured_json: string };
    const summarySections = (JSON.parse(summary.structured_json) as { sections?: Array<{ key: string; title: string; body: string }> }).sections ?? [];
    const history = this.#database.prepare(`SELECT id,role,content FROM messages WHERE conversation_id=? ORDER BY ordinal,created_at,id`)
      .all(conversationId) as Array<{ id: string; role: string; content: string }>;
    const sources = [
      ...pages.map((page) => ({ handle: `pdf-page:${page.page_number}`, type: "pdf" as const, text: page.text_content,
        locator: `p. ${page.page_number}`, evidenceAnchorId: page.evidence_anchor_id })),
      ...summarySections.map((section) => ({ handle: `summary:${conversation.summary_revision_id}:${section.key}`,
        type: "summary" as const, text: `${section.title}\n${section.body}`, locator: section.key,
        summaryRevisionId: conversation.summary_revision_id, sectionKey: section.key })),
      ...code.map((file) => ({ handle: `code:${file.repository.id}:${file.relative_path}`, type: "code" as const, text: file.text_content,
        locator: `${file.relative_path}:${file.start_line}-${file.end_line}` })),
      ...history.map((message) => ({ handle: `message:${message.id}`, type: "message" as const, text: message.content,
        locator: message.id, messageId: message.id })),
    ];
    const chatContext = { paperId: conversation.paper_id, conversationId, content, sources };
    const now = new Date().toISOString();
    const userMessageId = retryUserMessageId ?? `message:${randomUUID()}`;
    const jobRunId = `job:${randomUUID()}`;
    const attempt = this.#database.transaction(() => {
      const replay = this.#database.prepare(`SELECT j.id,j.state,a.user_message_id FROM job_runs j
        JOIN conversation_turn_attempts a ON a.job_run_id=j.id WHERE j.idempotency_key=?`).get(idempotencyKey) as
        { id: string; state: string; user_message_id: string } | undefined;
      if (replay) return { replayed: true, jobRunId: replay.id, userMessageId: replay.user_message_id, state: replay.state };
      const active = this.#database.prepare(`SELECT 1 FROM conversation_turn_attempts a JOIN job_runs j ON j.id=a.job_run_id
        WHERE a.conversation_id=? AND j.state IN ('queued','running') LIMIT 1`).get(conversationId);
      if (active) throw new Error("conversation-turn-active");
      const attemptNo = retryUserMessageId
        ? (this.#database.prepare("SELECT COALESCE(MAX(attempt_no),0)+1 next FROM conversation_turn_attempts WHERE user_message_id=?")
          .get(userMessageId) as { next: number }).next
        : 1;
      if (retryUserMessageId) {
        const retryable = this.#database.prepare(`SELECT 1 FROM messages m
          WHERE m.id=? AND m.conversation_id=? AND m.role='user'
            AND NOT EXISTS (SELECT 1 FROM messages reply WHERE reply.in_reply_to_message_id=m.id)
            AND EXISTS (SELECT 1 FROM conversation_turn_attempts a JOIN job_runs j ON j.id=a.job_run_id
              WHERE a.user_message_id=m.id AND j.state IN ('failed','interrupted'))`).get(userMessageId, conversationId);
        if (!retryable) throw new Error("message-not-retryable");
      } else {
        const ordinal = (this.#database.prepare("SELECT COALESCE(MAX(ordinal),0)+1 next FROM messages WHERE conversation_id=?")
          .get(conversationId) as { next: number }).next;
        this.#database.prepare(`INSERT INTO messages
          (id,conversation_id,context_snapshot_id,role,content,citations_json,created_at,ordinal)
          VALUES (?,?,?,'user',?,'[]',?,?)`).run(userMessageId, conversationId, conversation.active_context_snapshot_id, content, now, ordinal);
      }
      this.#database.prepare(`INSERT INTO job_runs
        (id,job_type,paper_id,state,progress,attempt,idempotency_key,input_json,queued_at,started_at,heartbeat_at)
        VALUES (?,'paper-chat',?,'running',0.1,?,?,?,?,?,?)`).run(jobRunId, conversation.paper_id, attemptNo, idempotencyKey,
          JSON.stringify({ content, contextSnapshotId: conversation.active_context_snapshot_id, sources }), now, now, now);
      this.#database.prepare(`INSERT INTO conversation_turn_attempts(job_run_id,conversation_id,user_message_id,attempt_no,created_at)
        VALUES (?,?,?,?,?)`).run(jobRunId, conversationId, userMessageId, attemptNo, now);
      this.#database.prepare("INSERT INTO durable_events(scope,event_type,data_json,created_at) VALUES (?,'message-started',?,?)")
        .run(conversationId, JSON.stringify({ jobRunId, userMessageId }), now);
      if (!retryUserMessageId) this.#database.prepare(`UPDATE conversations SET title=CASE WHEN title='新对话' THEN ? ELSE title END,updated_at=? WHERE id=?`)
        .run(content.trim().slice(0, 40), now, conversationId);
      return { replayed: false, jobRunId, userMessageId, state: "running" };
    })();
    if (attempt.replayed) return { attempt: { id: attempt.jobRunId, state: attempt.state }, userMessage: { id: attempt.userMessageId }, replayed: true };
    let output: ChatResult;
    try {
      output = await runChat(chatContext);
      try { validateChatOutput(output, sources); }
      catch { throw new Error("codex-output-invalid"); }
    } catch (error) {
      const failedAt = new Date().toISOString();
      this.#database.transaction(() => {
        const changed = this.#database.prepare(`UPDATE job_runs SET state='failed',progress=1,error_json=?,completed_at=?,heartbeat_at=?
          WHERE id=? AND state='running'`).run(JSON.stringify({ code: error instanceof Error ? error.message : "codex-failed" }), failedAt, failedAt, jobRunId).changes;
        if (changed) this.#database.prepare("INSERT INTO durable_events(scope,event_type,data_json,created_at) VALUES (?,'message-failed',?,?)")
          .run(conversationId, JSON.stringify({ jobRunId, userMessageId }), failedAt);
      })();
      throw error;
    }
    const assistantMessageId = `message:${randomUUID()}`;
    const citations = output.citations.map((citation) => {
      const source = sources.find((candidate) => candidate.handle === citation.sourceHandle)!;
      if (source.type === "pdf") return { type: "pdf", page: Number.parseInt(source.handle.slice(9), 10),
        paperVersionId: conversation.paper_version_id, evidenceAnchorId: source.evidenceAnchorId, locator: citation.locator };
      if (source.type === "summary") return { type: "summary", summaryRevisionId: source.summaryRevisionId,
        sectionKey: source.sectionKey, locator: citation.locator };
      if (source.type === "message") return { type: "message", conversationId, messageId: source.messageId, locator: citation.locator };
      const file = code.find((candidate) => `code:${candidate.repository.id}:${candidate.relative_path}` === source.handle)!;
      return { type: "code", commitSha: file.repository.commitSha, path: file.relative_path,
        startLine: file.start_line, endLine: file.end_line, locator: citation.locator };
    });
    const proposals: never[] = [];
    try { this.#database.transaction(() => {
      const completedAt = new Date().toISOString();
      const changed = this.#database.prepare(`UPDATE job_runs SET state='succeeded',progress=1,output_json=?,completed_at=?,heartbeat_at=?
        WHERE id=? AND state='running'`).run(JSON.stringify(output), completedAt, completedAt, jobRunId).changes;
      if (!changed) return;
      const execution = this.#agentExecutionMetadata?.("paper-chat") ?? null;
      const assistantOrdinal = (this.#database.prepare("SELECT COALESCE(MAX(ordinal),0)+1 next FROM messages WHERE conversation_id=?")
        .get(conversationId) as { next: number }).next;
      this.#database.prepare(`INSERT INTO agent_runs(job_run_id,task_kind,model,reasoning_effort,codex_version,
        configuration_version,skill_path,skill_content_hash,context_snapshot_id,output_schema_hash,prompt_hash,output_json)
        VALUES (?,'paper-chat',?,?,?,?,NULL,NULL,?,?,?,?)`)
        .run(jobRunId, execution?.model ?? null, execution?.reasoningEffort ?? null, execution?.codexVersion ?? "unknown",
          execution?.configurationVersion ?? null, conversation.active_context_snapshot_id,
          createHash("sha256").update("paper-chat:schema:v1").digest("hex"),
          createHash("sha256").update(JSON.stringify(chatContext)).digest("hex"), JSON.stringify(output));
      this.#database.prepare(`INSERT INTO messages
        (id,conversation_id,context_snapshot_id,role,content,citations_json,created_at,ordinal,in_reply_to_message_id)
        VALUES (?,?,?,'assistant',?,'[]',?,?,?)`)
        .run(assistantMessageId, conversationId, conversation.active_context_snapshot_id, output.answer, completedAt, assistantOrdinal, userMessageId);
      citations.forEach((citation, index) => this.#database.prepare(`INSERT INTO message_citations
        (id,message_id,ordinal,kind,source_handle,locator_json,verification_status) VALUES (?,?,?,?,?,?,'verified')`)
        .run(`message-citation:${assistantMessageId}:${index + 1}`, assistantMessageId, index + 1,
          citation.type === "pdf" ? "pdf_anchor" : citation.type === "summary" ? "summary_locator"
            : citation.type === "message" ? "message" : "repo_lines",
          output.citations[index]!.sourceHandle, JSON.stringify(citation)));
      this.#database.prepare("UPDATE conversations SET updated_at=? WHERE id=?").run(completedAt, conversationId);
      this.#database.prepare("INSERT INTO durable_events(scope,event_type,data_json,created_at) VALUES (?,'message-complete',?,?)")
        .run(conversationId, JSON.stringify({ jobRunId, messageId: assistantMessageId, proposalIds: [] }), completedAt);
    })(); } catch (error) {
      const failedAt = new Date().toISOString();
      this.#database.transaction(() => {
        const changed = this.#database.prepare(`UPDATE job_runs SET state='failed',progress=1,error_json=?,completed_at=?,heartbeat_at=?
          WHERE id=? AND state='running'`).run(JSON.stringify({ code: "message-commit-failed",
            detail: error instanceof Error ? error.message : String(error) }), failedAt, failedAt, jobRunId).changes;
        if (changed) this.#database.prepare("INSERT INTO durable_events(scope,event_type,data_json,created_at) VALUES (?,'message-failed',?,?)")
          .run(conversationId, JSON.stringify({ jobRunId, userMessageId }), failedAt);
      })();
      throw error;
    }
    return { attempt: { id: jobRunId, state: "succeeded" }, userMessage: { id: userMessageId },
      message: { id: assistantMessageId, role: "assistant", content: output.answer, citations }, proposals, replayed: false };
  }

  retryMessage(messageId: string, idempotencyKey: string, runChat: (context: {
    paperId: string; conversationId: string; content: string; sources: ChatSource[];
  }) => Promise<ChatResult>): Promise<unknown | null> {
    const row = this.#database.prepare("SELECT conversation_id,content FROM messages WHERE id=? AND role='user'").get(messageId) as
      { conversation_id: string; content: string } | undefined;
    if (!row) return Promise.resolve(null);
    return this.sendMessage(row.conversation_id, row.content, idempotencyKey, runChat, messageId);
  }

  getMessageConversationId(messageId: string): string | null {
    return this.#conversations.messageConversationId(messageId);
  }

  getPaperKnowledge(paperId: string): unknown | null {
    if (!this.#database.prepare("SELECT 1 FROM papers WHERE id=?").get(paperId)) return null;
    const pendingProposals = (this.#database.prepare(`SELECT p.id,p.proposal_type,p.review_status,p.one_click_eligible,
      p.payload_json,p.created_at,p.source_message_id,m.conversation_id,c.snapshot_integrity,j.state distillation_state
      FROM proposals p LEFT JOIN messages m ON m.id=p.source_message_id
      LEFT JOIN conversations c ON c.id=m.conversation_id
      LEFT JOIN job_runs j ON j.id=json_extract(p.payload_json,'$.distillationJobRunId')
      WHERE p.paper_id=? AND p.proposal_type='takeaway' AND p.review_status='pending'
      ORDER BY p.created_at,p.id`).all(paperId) as Array<{
        id: string; proposal_type: string; review_status: string; one_click_eligible: number; payload_json: string;
        created_at: string; source_message_id: string | null; conversation_id: string | null;
        snapshot_integrity: string | null; distillation_state: string | null;
      }>).map((proposal) => {
        const payload = JSON.parse(proposal.payload_json) as Record<string, unknown> & { claim?: string };
        const liveDuplicateIds = payload.claim ? liveDuplicateRevisionIds(this.#database, paperId, payload.claim) : [];
        return {
        id: proposal.id,
        proposalType: proposal.proposal_type,
        reviewStatus: proposal.review_status,
        oneClickEligible: proposal.one_click_eligible === 1 && proposal.snapshot_integrity !== "legacy" && liveDuplicateIds.length === 0,
        legacySource: proposal.snapshot_integrity === "legacy",
        ...payload,
        liveDuplicateIds,
        duplicateAcknowledgementRequired: liveDuplicateIds.length > 0,
        source: { conversationId: proposal.conversation_id, messageId: proposal.source_message_id },
        sourceConversationHref: proposal.conversation_id
          ? `/papers/${encodeURIComponent(paperId)}/conversations/${encodeURIComponent(proposal.conversation_id)}` : null,
        distillationState: proposal.distillation_state,
        createdAt: proposal.created_at,
      }; });
    const confirmedTakeaways = (this.#database.prepare(`SELECT t.id,tr.id revision_id,tr.revision,tr.claim,tr.provenance_json,
      tr.markdown_path,tr.confirmed_at,p.source_message_id,m.conversation_id
      FROM takeaways t JOIN takeaway_revisions tr ON tr.id=t.active_revision_id
      LEFT JOIN review_decisions d ON json_extract(d.result_json,'$.takeaway.revisionId')=tr.id
      LEFT JOIN proposals p ON p.id=d.proposal_id
      LEFT JOIN messages m ON m.id=p.source_message_id
      WHERE t.paper_id=? AND tr.review_status='confirmed'
      ORDER BY tr.confirmed_at,tr.id`).all(paperId) as Array<{
        id: string; revision_id: string; revision: number; claim: string; provenance_json: string;
        markdown_path: string; confirmed_at: string; source_message_id: string | null; conversation_id: string | null;
      }>).map((takeaway) => ({ id: takeaway.id, revisionId: takeaway.revision_id, revision: takeaway.revision,
        claim: takeaway.claim, reviewStatus: "confirmed", evidence: JSON.parse(takeaway.provenance_json) as unknown,
        markdownPath: takeaway.markdown_path, confirmedAt: takeaway.confirmed_at,
        source: { conversationId: takeaway.conversation_id, messageId: takeaway.source_message_id } }));
    return { pendingProposals, confirmedTakeaways };
  }

  decideProposal(proposalId: string, idempotencyKey: string, action: "accept" | "edit-and-accept" | "reject" = "accept",
    reviewInput: TakeawayReviewInput = {}): { status: number; body: unknown; execution?: ImportExecution } {
    const existing = this.#database.prepare("SELECT result_json FROM review_decisions WHERE idempotency_key=?").get(idempotencyKey) as
      { result_json: string } | undefined;
    if (existing) return { status: 200, body: JSON.parse(existing.result_json) as unknown };
    const proposal = this.#database.prepare(`SELECT p.proposal_type,p.paper_id,p.payload_json,p.review_status,p.one_click_eligible,
      c.snapshot_integrity FROM proposals p LEFT JOIN messages m ON m.id=p.source_message_id
      LEFT JOIN conversations c ON c.id=m.conversation_id WHERE p.id=?`).get(proposalId) as
      { proposal_type: string; paper_id: string; payload_json: string; review_status: string;
        one_click_eligible: number; snapshot_integrity: string | null } | undefined;
    if (!proposal) return { status: 404, body: { code: "proposal-not-found" } };
    if (proposal.review_status !== "pending") return { status: 409, body: { code: "proposal-already-decided" } };
    if (proposal.proposal_type === "reconciliation") {
      if (action === "edit-and-accept") {
        return { status: 400, body: { code: "reconciliation-edit-not-supported" } };
      }
      const payload = JSON.parse(proposal.payload_json) as {
        targetKind?: string;
        targetPath?: string;
        actualHash?: string | null;
        writeId?: string;
      };
      if (!payload.targetPath || (payload.actualHash !== undefined && payload.actualHash !== null &&
          typeof payload.actualHash !== "string")) {
        return { status: 409, body: { code: "reconciliation-payload-invalid" } };
      }
      if (action === "accept") {
        if (payload.targetKind !== "paper" && payload.targetKind !== "topic") {
          return { status: 409, body: { code: "reconciliation-accept-not-supported" } };
        }
        try {
          this.#paperOrganization.validateReconciliationTarget({
            targetKind: payload.targetKind,
            targetPath: payload.targetPath,
            actualHash: payload.actualHash ?? null,
          });
        } catch (error) {
          return { status: 409, body: {
            code: error instanceof Error ? error.message : "reconciliation-target-invalid",
          } };
        }
      }
      const now = this.#now().toISOString();
      const decisionId = `review-decision:${randomUUID()}`;
      const body = {
        reviewDecision: { id: decisionId, action },
        proposal: { id: proposalId, reviewStatus: action === "accept" ? "accepted" : "rejected" },
        ...(action === "reject" ? { requiresFileRestore: true } : {}),
      };
      let rebuild: { count: number; rebuiltAt: string; blocked?: boolean } | undefined;
      try {
        this.#database.transaction(() => {
          this.#database.prepare(`UPDATE proposals SET review_status=?,decided_at=?
            WHERE id=? AND review_status='pending'`)
            .run(action === "accept" ? "accepted" : "rejected", now, proposalId);
          this.#database.prepare(`INSERT INTO review_decisions
            (id,proposal_id,action,idempotency_key,result_json,created_at)
            VALUES (?,?,?,?,?,?)`).run(decisionId, proposalId, action, idempotencyKey, JSON.stringify(body), now);
          if (action === "accept") {
            if (payload.writeId) {
              this.#database.prepare(`UPDATE knowledge_write_requests
                SET phase='failed',error_code='reconciliation-accepted-external',updated_at=?
                WHERE id=? AND phase='conflicted'`).run(now, payload.writeId);
            }
            rebuild = this.#paperOrganization.rebuildCatalog();
          }
        })();
      } catch (error) {
        return { status: 409, body: {
          code: error instanceof Error ? error.message : "reconciliation-activation-failed",
        } };
      }
      if (action === "accept") this.#knowledgeWriter.recover();
      return { status: 201, body: {
        ...body,
        ...(rebuild ? { projection: { blocked: rebuild.blocked === true, count: rebuild.count } } : {}),
      } };
    }
    if (action === "reject") {
      const allowedReasons = ["useful-answer-not-knowledge", "context-incomplete", "incorrect-or-unsupported",
        "duplicate", "too-broad", "too-trivial", "other"];
      if (reviewInput.rejectReason && !allowedReasons.includes(reviewInput.rejectReason)) {
        return { status: 400, body: { code: "reject-reason-invalid" } };
      }
      const now = this.#now().toISOString();
      const decisionId = `review-decision:${randomUUID()}`;
      const rejectedPayload = JSON.parse(proposal.payload_json) as { claim?: string };
      const liveDuplicateIds = proposal.proposal_type === "takeaway" && rejectedPayload.claim
        ? liveDuplicateRevisionIds(this.#database, proposal.paper_id, rejectedPayload.claim) : [];
      const body = { reviewDecision: { id: decisionId, action: "reject", reason: reviewInput.rejectReason ?? null },
        proposal: { id: proposalId, reviewStatus: "rejected" } };
      this.#database.transaction(() => {
        if (proposal.proposal_type === "takeaway") this.#database.prepare(`UPDATE takeaway_review_requirements
          SET live_duplicate_warning=?,live_duplicate_ids_json=?,updated_at=? WHERE proposal_id=?`)
          .run(liveDuplicateIds.length > 0 ? 1 : 0, JSON.stringify(liveDuplicateIds), now, proposalId);
        this.#database.prepare("UPDATE proposals SET review_status='rejected',decided_at=? WHERE id=? AND review_status='pending'").run(now, proposalId);
        this.#database.prepare("INSERT INTO review_decisions(id,proposal_id,action,idempotency_key,result_json,created_at) VALUES (?,?,'reject',?,?,?)")
          .run(decisionId, proposalId, idempotencyKey, JSON.stringify(body), now);
      })();
      return { status: 201, body };
    }
    if (proposal.proposal_type === "takeaway" && proposal.snapshot_integrity === "legacy") {
      return { status: 409, body: { code: "LEGACY_PROVENANCE" } };
    }
    if (proposal.proposal_type === "paper-version-update") {
      const payload = JSON.parse(proposal.payload_json) as { candidateVersionId?: string };
      if (!payload.candidateVersionId) return { status: 409, body: { code: "paper-version-candidate-missing" } };
      const candidate = this.#database.prepare(`SELECT v.id,v.paper_id,v.source_version,v.source_url,j.id job_id,j.import_request_id,j.attempt
        FROM paper_versions v JOIN import_requests i ON json_extract(i.frozen_input_json,'$.versionId')=v.id
        JOIN job_runs j ON j.import_request_id=i.id AND j.job_type='paper-import'
        WHERE v.id=? AND v.paper_id=? ORDER BY j.queued_at DESC LIMIT 1`).get(payload.candidateVersionId, proposal.paper_id) as
        { id: string; paper_id: string; source_version: string; source_url: string; job_id: string; import_request_id: string; attempt: number } | undefined;
      if (!candidate) return { status: 409, body: { code: "paper-version-candidate-missing" } };
      const now = this.#now().toISOString();
      const decisionId = `review-decision:${randomUUID()}`;
      const body = { reviewDecision: { id: decisionId, action: "accept" }, paperVersion: { id: candidate.id, sourceVersion: candidate.source_version } };
      this.#database.transaction(() => {
        this.#database.prepare("UPDATE paper_versions SET processing_status='processing',accepted_at=?,updated_at=? WHERE id=?").run(now, now, candidate.id);
        this.#database.prepare("UPDATE job_runs SET state='running',progress=0.1,error_json=NULL,completed_at=NULL,heartbeat_at=? WHERE id=?").run(now, candidate.job_id);
        this.#database.prepare("UPDATE proposals SET review_status='accepted',decided_at=? WHERE id=?").run(now, proposalId);
        this.#database.prepare("INSERT INTO review_decisions(id,proposal_id,action,idempotency_key,result_json,created_at) VALUES (?,?,'accept',?,?,?)")
          .run(decisionId, proposalId, idempotencyKey, JSON.stringify(body), now);
      })();
      const currentPaper = this.listPapers().find((item) => item.id === proposal.paper_id)!;
      const paper: StoredPaper = { ...currentPaper, version: 1, versionId: candidate.id,
        versionLabel: candidate.source_version, sourceType: "direct-pdf", sourceUrl: candidate.source_url };
      this.#event(candidate.import_request_id, "job-progress", { jobId: candidate.job_id, jobType: "paper-import", state: "running", progress: 0.1,
        attempt: candidate.attempt });
      return { status: 202, body, execution: { paper, version: 1,
        importRequest: { id: candidate.import_request_id, paperId: proposal.paper_id, status: "resolved" },
        job: { id: candidate.job_id, attempt: candidate.attempt, state: "running" } } };
    }
    const payload = JSON.parse(proposal.payload_json) as { contractVersion?: string; title?: string; kind?: TakeawayKind;
      claim: string; epistemicStatus?: EpistemicStatus; evidenceRationale?: string; caveat?: string | null;
      receiptIds?: string[]; distillationJobRunId?: string; trigger?: string };
    if (!payload.contractVersion || !payload.title || !payload.kind || !payload.epistemicStatus ||
        !payload.evidenceRationale || !payload.receiptIds?.length || !payload.distillationJobRunId || !payload.trigger) {
      return { status: 409, body: { code: "takeaway-v2-upgrade-required" } };
    }
    const edited = reviewInput.edited ?? {};
    if (action === "edit-and-accept" && Object.keys(edited).length === 0) {
      return { status: 400, body: { code: "structured-edit-required" } };
    }
    const candidate = { title: edited.title?.trim() || payload.title,
      claim: edited.claim?.trim() || payload.claim,
      evidenceRationale: edited.evidenceRationale?.trim() || payload.evidenceRationale,
      caveat: edited.caveat === undefined ? payload.caveat ?? null : edited.caveat?.trim() || null,
      receiptIds: edited.receiptIds ?? payload.receiptIds,
      epistemicStatus: edited.epistemicStatus ?? payload.epistemicStatus };
    if (!candidate.title || candidate.title.length > 160 || candidate.claim.length < 40 || candidate.claim.length > 2000 ||
        candidate.evidenceRationale.length < 10 || candidate.evidenceRationale.length > 2000 ||
        !EPISTEMIC_STATUSES.includes(candidate.epistemicStatus) || !TAKEAWAY_KINDS.includes(payload.kind)) {
      return { status: 400, body: { code: "takeaway-structured-edit-invalid" } };
    }
    const evidenceSensitiveEdit = edited.claim !== undefined || edited.evidenceRationale !== undefined ||
      edited.receiptIds !== undefined || edited.epistemicStatus !== undefined;
    if ((evidenceSensitiveEdit || candidate.epistemicStatus !== "evidence-backed") && !reviewInput.evidenceReviewed) {
      return { status: 409, body: { code: "full-evidence-review-required" } };
    }
    if (candidate.receiptIds.length === 0) return { status: 409, body: { code: "takeaway-receipt-unverified" } };
    const verifiedCount = (this.#database.prepare(`SELECT count(*) count FROM all_evidence_receipts
      WHERE message_id=(SELECT source_message_id FROM proposals WHERE id=?)
      AND verification_status='verified' AND id IN (${candidate.receiptIds.map(() => "?").join(",")})`)
      .get(proposalId, ...candidate.receiptIds) as { count: number }).count;
    if (verifiedCount !== new Set(candidate.receiptIds).size) {
      return { status: 409, body: { code: "takeaway-receipt-unverified" } };
    }
    const liveDuplicateIds = liveDuplicateRevisionIds(this.#database, proposal.paper_id, candidate.claim);
    if (liveDuplicateIds.length > 0 && !reviewInput.duplicateAcknowledged) {
      return { status: 409, body: { code: "duplicate-acknowledgement-required", duplicateIds: liveDuplicateIds } };
    }
    const paper = this.listPapers().find((candidate) => candidate.id === proposal.paper_id)!;
    const sourceMessageId = (this.#database.prepare("SELECT source_message_id FROM proposals WHERE id=?")
      .pluck().get(proposalId) as string);
    this.#database.prepare(`UPDATE takeaway_review_requirements SET evidence_review_required=?,
      duplicate_acknowledged=?,live_duplicate_warning=?,live_duplicate_ids_json=?,
      reviewed_receipt_ids_json=?,updated_at=? WHERE proposal_id=?`).run(
      evidenceSensitiveEdit ? 1 : 0, reviewInput.duplicateAcknowledged ? 1 : 0,
      liveDuplicateIds.length > 0 ? 1 : 0, JSON.stringify(liveDuplicateIds),
      JSON.stringify(reviewInput.evidenceReviewed ? candidate.receiptIds : []), this.#now().toISOString(), proposalId);
    const write = this.#knowledgeWriter.commitTakeaway({ paperId: proposal.paper_id, paperTitle: paper.title,
      proposalId, idempotencyKey, action, title: candidate.title, kind: payload.kind, claim: candidate.claim,
      epistemicStatus: candidate.epistemicStatus, evidenceRationale: candidate.evidenceRationale,
      caveat: candidate.caveat, receiptIds: candidate.receiptIds, contractVersion: payload.contractVersion,
      sourceMessageId, distillationJobRunId: payload.distillationJobRunId, trigger: payload.trigger,
      editedFields: Object.keys(edited) });
    if (!write.complete) return { status: 409, body: { code: "knowledge-write-conflicted" } };
    return { status: 201, body: write.body };
  }

  isDirectVersionProposal(proposalId: string): boolean {
    const row = this.#database.prepare("SELECT proposal_type,payload_json FROM proposals WHERE id=?").get(proposalId) as
      { proposal_type: string; payload_json: string } | undefined;
    return Boolean(row?.proposal_type === "paper-version-update" &&
      (JSON.parse(row.payload_json) as { sourceType?: string }).sourceType === "direct-pdf");
  }

  issueProposalSourceOpen(proposalId: string): { pdfUrl: string; page: number } | null {
    const row = this.#database.prepare(`SELECT p.payload_json,cs.paper_version_id source_version_id
      FROM proposals p
      LEFT JOIN messages m ON m.id=p.source_message_id
      LEFT JOIN context_snapshots cs ON cs.id=m.context_snapshot_id
      WHERE p.id=? AND p.review_status='pending'`).get(proposalId) as
      { payload_json: string; source_version_id: string | null } | undefined;
    if (!row) return null;
    const payload = JSON.parse(row.payload_json) as { sourceHandles?: string[]; receiptIds?: string[]; candidateVersionId?: string };
    if (payload.candidateVersionId) {
      const candidate = this.#database.prepare("SELECT id FROM paper_versions WHERE id=?").get(payload.candidateVersionId);
      if (!candidate) return null;
      const token = randomUUID();
      this.#database.prepare("INSERT INTO source_open_tokens(token,proposal_id,paper_version_id,source_handle,issued_at) VALUES (?,?,?,?,?)")
        .run(token, proposalId, payload.candidateVersionId, "pdf-page:1", new Date().toISOString());
      return { pdfUrl: `/api/paper-versions/${encodeURIComponent(payload.candidateVersionId)}/pdf?openToken=${token}#page=1`, page: 1 };
    }
    const pdfReceipt = payload.receiptIds?.map((id) => this.#database.prepare(`SELECT source_id,locator_json FROM all_evidence_receipts
      WHERE id=? AND evidence_kind='pdf' AND verification_status='verified'`).get(id) as
      { source_id: string; locator_json: string } | undefined).find(Boolean);
    if (pdfReceipt && row.source_version_id) {
      const page = Number((JSON.parse(pdfReceipt.locator_json) as { page?: number }).page ?? 1);
      const token = randomUUID();
      this.#database.prepare("INSERT INTO source_open_tokens(token,proposal_id,paper_version_id,source_handle,issued_at) VALUES (?,?,?,?,?)")
        .run(token, proposalId, row.source_version_id, `pdf-page:${page}`, new Date().toISOString());
      return { pdfUrl: `/api/paper-versions/${encodeURIComponent(row.source_version_id)}/pdf?openToken=${token}#page=${page}`, page };
    }
    const handle = payload.sourceHandles?.find((candidate) => candidate.startsWith("pdf-page:"));
    if (!handle || !row.source_version_id) return null;
    const token = randomUUID();
    this.#database.prepare("INSERT INTO source_open_tokens(token,proposal_id,paper_version_id,source_handle,issued_at) VALUES (?,?,?,?,?)")
      .run(token, proposalId, row.source_version_id, handle, new Date().toISOString());
    const page = Number.parseInt(handle.slice(9), 10);
    return { pdfUrl: `/api/paper-versions/${encodeURIComponent(row.source_version_id)}/pdf?openToken=${token}#page=${page}`, page };
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
  }> }) => Promise<EntryResult>, request: EntryResolutionRequest = { mode: "enabled" }): Promise<unknown> {
    // Provenance is current-state authority. Refresh before retrieval so a source
    // that became inactive cannot remain usable through a stale broad FTS row.
    this.#topicKnowledge.refreshEligibility();
    const bypassed = request.resolutionMode === "off" || request.mode === "off";
    const resolution = this.#paperResolver.resolve(question);
    if (bypassed) this.#paperResolver.record(question, request.mode, resolution, "bypassed");
    else this.#paperResolver.record(question, request.mode, resolution);

    let effectiveResolution: PaperResolution | null = null;
    let paperIds: string[] | null = null;
    if (!bypassed && request.mode === "enabled" && resolution.state !== "normalization-mismatch") {
      if (request.resolutionSelection &&
          request.resolutionSelection.snapshotHash !== resolution.snapshotHash) {
        throw new PaperResolverError("entry-paper-resolution-stale");
      }
      if (resolution.state === "ambiguous") {
        if (!request.resolutionSelection) return this.#entryResolutionRequired(resolution);
        const ambiguousGroups = resolution.groups.filter((group) => group.candidates.length > 1);
        const provided = Object.keys(request.resolutionSelection.groups).sort();
        const expected = ambiguousGroups.map((group) => group.id).sort();
        if (JSON.stringify(provided) !== JSON.stringify(expected)) {
          throw new PaperResolverError("entry-paper-resolution-invalid");
        }
        const selected = ambiguousGroups.map((group) => {
          const paperId = request.resolutionSelection!.groups[group.id];
          if (!paperId || !group.candidates.some((candidate) => candidate.paperId === paperId)) {
            throw new PaperResolverError("entry-paper-resolution-invalid");
          }
          return paperId;
        });
        paperIds = [...new Set([
          ...resolution.groups.filter((group) => group.candidates.length === 1)
            .map((group) => group.candidates[0]!.paperId),
          ...selected,
        ])].sort();
        if (paperIds.length > 5) return this.#entryResolutionRequired({ ...resolution, state: "too-many" });
        effectiveResolution = { ...resolution, state: "resolved", paperIds,
          groups: resolution.groups.map((group) => group.candidates.length === 1 ? group : {
            ...group,
            candidates: group.candidates.filter((candidate) =>
              candidate.paperId === request.resolutionSelection!.groups[group.id]),
          }) };
      } else {
        if (request.resolutionSelection) throw new PaperResolverError("entry-paper-resolution-invalid");
        if (resolution.state === "too-many") return this.#entryResolutionRequired(resolution);
        if (resolution.state === "resolved") {
          effectiveResolution = resolution;
          paperIds = resolution.paperIds;
        }
      }
    } else if (request.resolutionSelection) {
      throw new PaperResolverError("entry-paper-resolution-invalid");
    }

    const sources = paperIds ? this.#scopedEntrySources(question, paperIds) : this.#broadEntrySources(question);
    const publicResolution = effectiveResolution ? this.#publicEntryResolution(effectiveResolution) : { state: "none", matches: [] };
    if (paperIds && sources.length === 0) {
      return { answerStatus: "insufficient_evidence", answer: "已解析到 Paper，但当前没有可用于回答的已确认知识。",
        uncertainty: "该 Paper 尚无 active Summary 或 confirmed knowledge。", sources: [],
        projection: this.#entryProjectionState(), resolution: publicResolution };
    }
    const entryContext = { question, sources };
    const output = await runEntry(entryContext);
    try { validateEntryOutput(output, sources.map((source) => source.handle)); }
    catch { throw new Error("codex-output-invalid"); }
    this.#recordAgentRun("entry-answer", null, null, entryContext, output, null);
    const selected = output.sourceHandles.map((handle) => sources.find((source) => source.handle === handle)!)
      .map(({ body: _body, handle, ...source }) => {
        const paperId = this.#entrySourcePaperId(source.sourceType, source.sourceId);
        return { handle, ...source, paperId,
          href: source.sourceType === "topic-knowledge"
            ? `/papers?direction=${encodeURIComponent(source.sourceId)}#topic-knowledge`
            : `/papers/${encodeURIComponent(paperId)}#${source.sourceType}=${encodeURIComponent(source.sourceId)}` };
      });
    return { answerStatus: output.answerStatus, answer: output.answer, uncertainty: output.uncertainty,
      sources: selected, projection: this.#entryProjectionState(), resolution: publicResolution };
  }

  #broadEntrySources(question: string): Array<{
    handle: string; sourceType: string; sourceId: string; title: string; body: string;
  }> {
    const terms = question.trim().split(/\s+/).filter((term) => [...term].length >= 3);
    const byId = new Map<string, {
      id: string; source_type: string; source_id: string; title: string; body: string;
    }>();
    for (const term of terms) {
      const rows = this.#database.prepare(`SELECT d.id,d.source_type,d.source_id,d.title,d.body
        FROM curated_search_fts f JOIN curated_search_documents d ON d.rowid=f.rowid
        WHERE curated_search_fts MATCH ? ORDER BY rank LIMIT 8`).all(`"${term.replaceAll('"', '""')}"`) as
        Array<{ id: string; source_type: string; source_id: string; title: string; body: string }>;
      rows.forEach((row) => byId.set(row.id, row));
    }
    return [...byId.values()].sort((left, right) =>
      left.source_type.localeCompare(right.source_type) || left.id.localeCompare(right.id))
      .slice(0, 8).map((row) => ({ handle: `curated:${row.source_id}`,
        sourceType: row.source_type, sourceId: row.source_id, title: row.title, body: row.body }));
  }

  #scopedEntrySources(question: string, paperIds: string[]): Array<{
    handle: string; sourceType: string; sourceId: string; title: string; body: string;
  }> {
    const placeholders = paperIds.map(() => "?").join(",");
    const rows = this.#database.prepare(`SELECT d.id,d.source_type,d.source_id,d.title,d.body,s.paper_id
      FROM curated_search_documents d JOIN summary_revisions s ON s.id=d.source_id
      WHERE d.source_type='summary' AND s.paper_id IN (${placeholders})
      UNION ALL
      SELECT d.id,d.source_type,d.source_id,d.title,d.body,t.paper_id
      FROM curated_search_documents d JOIN takeaway_revisions tr ON tr.id=d.source_id
      JOIN takeaways t ON t.id=tr.takeaway_id
      WHERE d.source_type='takeaway' AND t.paper_id IN (${placeholders})`)
      .all(...paperIds, ...paperIds) as Array<{ id: string; source_type: string; source_id: string;
        title: string; body: string; paper_id: string }>;
    const terms = question.toLocaleLowerCase().split(/[^\p{Letter}\p{Number}]+/u)
      .filter((term) => [...term].length >= 2);
    const score = (row: typeof rows[number]) => terms.reduce((total, term) => {
      const haystack = `${row.title}\n${row.body}`.toLocaleLowerCase();
      return total + (haystack.includes(term) ? 1 : 0);
    }, 0);
    const selected: typeof rows = [];
    for (const paperId of paperIds) {
      const summary = rows.filter((row) => row.paper_id === paperId && row.source_type === "summary")
        .sort((left, right) => left.id.localeCompare(right.id))[0];
      if (summary) selected.push(summary);
    }
    const buckets = new Map(paperIds.map((paperId) => [paperId, rows.filter((row) =>
      row.paper_id === paperId && !selected.some((selectedRow) => selectedRow.id === row.id))
      .sort((left, right) => score(right) - score(left) || left.source_type.localeCompare(right.source_type) ||
        left.id.localeCompare(right.id))]));
    while (selected.length < 8 && [...buckets.values()].some((bucket) => bucket.length > 0)) {
      for (const paperId of paperIds) {
        if (selected.length >= 8) break;
        const next = buckets.get(paperId)?.shift();
        if (next) selected.push(next);
      }
    }
    const topicRows = this.#database.prepare(`SELECT DISTINCT d.id,d.source_type,d.source_id,d.title,d.body
      FROM curated_search_documents d JOIN topic_knowledge_revisions r
        ON d.source_type='topic-knowledge' AND d.source_id=r.topic_id
      JOIN topic_knowledge_paper_scope ps ON ps.topic_revision_id=r.id
      WHERE r.active=1 AND r.usage_level='knowledge-ready' AND r.eligibility_status='eligible'
        AND ps.paper_id IN (${placeholders})
        AND EXISTS (
          SELECT 1 FROM topic_knowledge_provenance kp
          WHERE kp.topic_revision_id=r.id AND (
            (kp.source_type='summary' AND EXISTS (
              SELECT 1 FROM summary_revisions s WHERE s.id=kp.source_id AND s.status='active' AND s.paper_id=ps.paper_id
            )) OR
            (kp.source_type='takeaway' AND EXISTS (
              SELECT 1 FROM takeaway_revisions tr JOIN takeaways t ON t.active_revision_id=tr.id
              WHERE tr.id=kp.source_id AND tr.review_status='confirmed' AND t.paper_id=ps.paper_id
            ))
          )
        )`).all(...paperIds) as Array<{ id: string; source_type: string; source_id: string; title: string; body: string }>;
    const traditional = selected.map((row) => ({ handle: `curated:${row.source_id}`,
      sourceType: row.source_type, sourceId: row.source_id, title: row.title, body: row.body }));
    if (traditional.length >= 8 || topicRows.length === 0) return traditional;
    const topic = topicRows.sort((left, right) => score({ ...left, paper_id: "" }) - score({ ...right, paper_id: "" }) ||
      left.id.localeCompare(right.id)).at(-1)!;
    return [...traditional, { handle: `curated:${topic.source_id}`, sourceType: topic.source_type,
      sourceId: topic.source_id, title: topic.title, body: topic.body }];
  }

  #entryResolutionRequired(resolution: PaperResolution) {
    return {
      answerStatus: "resolution_required",
      answer: resolution.state === "too-many"
        ? "识别到的 Paper 超过 5 篇，请缩小问题范围。"
        : "同一名称可能指向多篇 Paper，请先选择要检索的 Paper。",
      uncertainty: null,
      sources: [],
      projection: this.#entryProjectionState(),
      resolution: {
        state: "ambiguous",
        reason: resolution.state === "too-many" ? "too-many-papers" : "collision",
        snapshotHash: resolution.snapshotHash,
        groups: resolution.groups.filter((group) => group.candidates.length > 1).map((group) => ({
          id: group.id,
          matchedText: group.matchedText,
          candidates: group.candidates,
        })),
      },
    };
  }

  #publicEntryResolution(resolution: PaperResolution) {
    return {
      state: "resolved",
      matches: resolution.groups.flatMap((group) => group.candidates.slice(0, 1).map((candidate) => ({
        text: group.matchedText,
        paperId: candidate.paperId,
        kind: candidate.matchKind,
        canonicalTitle: candidate.canonicalTitle,
      }))),
    };
  }

  #entryProjectionState() {
    const state = this.#database.prepare(`SELECT last_successful_at FROM projection_state
      WHERE projection='global-curated'`).get() as { last_successful_at: string | null };
    const pending = Number(this.#database.prepare(`SELECT count(*) FROM index_outbox
      WHERE projection='global-curated' AND state='pending'`).pluck().get());
    return { stale: pending > 0, lastSuccessfulAt: state.last_successful_at,
      ...(pending > 0 ? { notice: "知识索引更新中" } : {}) };
  }

  #entrySourcePaperId(sourceType: string, sourceId: string): string {
    if (sourceType === "summary") {
      const row = this.#database.prepare("SELECT paper_id FROM summary_revisions WHERE id=?")
        .get(sourceId) as { paper_id: string } | undefined;
      if (row) return row.paper_id;
    }
    if (sourceType === "takeaway") {
      const row = this.#database.prepare(`SELECT t.paper_id FROM takeaway_revisions tr
        JOIN takeaways t ON t.id=tr.takeaway_id WHERE tr.id=?`).get(sourceId) as
        { paper_id: string } | undefined;
      if (row) return row.paper_id;
    }
    if (sourceType === "topic-knowledge") {
      const row = this.#database.prepare(`SELECT ps.paper_id FROM topic_knowledge_revisions r
        JOIN topic_knowledge_paper_scope ps ON ps.topic_revision_id=r.id
        WHERE r.topic_id=? AND r.active=1 ORDER BY ps.paper_id LIMIT 1`).get(sourceId) as
        { paper_id: string } | undefined;
      if (row) return row.paper_id;
    }
    throw new Error("entry-source-paper-unavailable");
  }

  recordEntrySourceOpen(sourceType: "summary" | "takeaway" | "topic-knowledge", sourceId: string): boolean {
    const source = this.#database.prepare("SELECT 1 FROM curated_search_documents WHERE source_type=? AND source_id=?")
      .get(sourceType, sourceId);
    if (!source) return false;
    this.#database.prepare(`INSERT INTO entry_source_open_events(id,source_type,source_id,opened_at)
      VALUES (?,?,?,?)`).run(`entry-source-open:${randomUUID()}`, sourceType, sourceId, this.#now().toISOString());
    return true;
  }

  listProposals(): unknown[] {
    return (this.#database.prepare(`SELECT p.id,p.proposal_type,p.paper_id,p.review_status,p.one_click_eligible,
      p.created_at,p.archived_at,p.payload_json,c.snapshot_integrity,c.id source_conversation_id,
      j.state distillation_state
      FROM proposals p LEFT JOIN messages m ON m.id=p.source_message_id
      LEFT JOIN conversations c ON c.id=m.conversation_id
      LEFT JOIN job_runs j ON j.id=json_extract(p.payload_json,'$.distillationJobRunId')
      ORDER BY p.created_at,p.id`).all() as Array<{
      id: string; proposal_type: string; review_status: string; paper_id: string | null; one_click_eligible: number;
      created_at: string; archived_at: string | null; payload_json: string; snapshot_integrity: string | null;
      source_conversation_id: string | null; distillation_state: string | null;
    }>).map((row) => {
      const payload = JSON.parse(row.payload_json) as { claim?: string };
      const liveDuplicateIds = row.paper_id && payload.claim
        ? liveDuplicateRevisionIds(this.#database, row.paper_id, payload.claim) : [];
      return {
        id: row.id, proposalType: row.proposal_type, paperId: row.paper_id, reviewStatus: row.review_status,
        oneClickEligible: row.one_click_eligible === 1 && row.snapshot_integrity !== "legacy" && liveDuplicateIds.length === 0,
        legacySource: row.snapshot_integrity === "legacy",
        liveDuplicateIds, duplicateAcknowledgementRequired: liveDuplicateIds.length > 0,
        sourceConversationHref: row.paper_id && row.source_conversation_id
          ? `/papers/${encodeURIComponent(row.paper_id)}/conversations/${encodeURIComponent(row.source_conversation_id)}` : null,
        distillationState: row.distillation_state,
        createdAt: row.created_at, archivedAt: row.archived_at, payload,
      };
    });
  }

  reopenProposal(id: string): boolean {
    return this.#database.prepare(`UPDATE proposals SET review_status='pending',archived_at=NULL
      WHERE id=? AND proposal_type='reconciliation' AND review_status='archived'`).run(id).changes === 1;
  }

  rebuildCuratedProjection(): { count: number; rebuiltAt: string } {
    this.#paperOrganization.rebuildCatalog();
    this.#topicKnowledge.syncObservedDirections();
    this.#topicKnowledge.refreshEligibility();
    const now = this.#now().toISOString();
    return this.#database.transaction(() => {
      this.#database.prepare("DELETE FROM curated_search_documents").run();
      const summaries = this.#database.prepare(`SELECT s.id,p.title,s.markdown_path,s.markdown_hash FROM summary_revisions s
        JOIN papers p ON p.id=s.paper_id WHERE s.status='active' ORDER BY s.id`).all() as
        Array<{ id: string; title: string; markdown_path: string; markdown_hash: string }>;
      for (const summary of summaries) {
        const markdown = this.#readAuthoritativeMarkdown(summary.id, summary.markdown_path, summary.markdown_hash);
        this.#database.prepare(`INSERT INTO curated_search_documents(id,source_type,source_id,title,body,updated_at)
          VALUES (?,'summary',?,?,?,?)`).run(`curated:${summary.id}`, summary.id, summary.title,
            summaryProjectionBody(markdown), now);
      }
      const takeaways = this.#database.prepare(`SELECT tr.id,tr.markdown_path,tr.markdown_hash FROM takeaway_revisions tr
        JOIN takeaways t ON t.active_revision_id=tr.id WHERE tr.review_status='confirmed' ORDER BY tr.id`).all() as
        Array<{ id: string; markdown_path: string; markdown_hash: string }>;
      for (const takeaway of takeaways) {
        const markdown = this.#readAuthoritativeMarkdown(takeaway.id, takeaway.markdown_path, takeaway.markdown_hash);
        const projection = takeawayProjection(markdown);
        this.#database.prepare(`INSERT INTO curated_search_documents(id,source_type,source_id,title,body,updated_at)
          VALUES (?,'takeaway',?,?,?,?)`).run(`curated:${takeaway.id}`, takeaway.id,
            projection.title, projection.body, now);
      }
      const topics = this.#database.prepare(`SELECT d.topic_id,d.revision_id,d.markdown_path,d.markdown_hash
        FROM direction_catalog d JOIN topic_knowledge_revisions r ON r.id=d.revision_id
        WHERE d.lifecycle_status='active' AND d.review_status='confirmed' AND r.active=1
          AND r.usage_level='knowledge-ready' AND r.eligibility_status='eligible'
        ORDER BY d.topic_id`).all() as Array<{
          topic_id: string; revision_id: string; markdown_path: string; markdown_hash: string;
        }>;
      let topicCount = 0;
      for (const topic of topics) {
        const projection = this.#topicKnowledge.validateForCurated({
          topicId: topic.topic_id, revisionId: topic.revision_id,
          markdownPath: topic.markdown_path, markdownHash: topic.markdown_hash,
        });
        if (!projection) continue;
        this.#database.prepare(`INSERT INTO curated_search_documents(id,source_type,source_id,title,body,updated_at)
          VALUES (?,'topic-knowledge',?,?,?,?)`).run(`curated-topic:${topic.topic_id}`, topic.topic_id,
            projection.title, projection.body, now);
        topicCount += 1;
      }
      this.#database.prepare(`UPDATE projection_state SET last_successful_at=?,rebuilt_at=?,updated_at=? WHERE projection='global-curated'`).run(now, now, now);
      this.#database.prepare("UPDATE index_outbox SET state='complete',completed_at=? WHERE projection='global-curated' AND state='pending'").run(now);
      return { count: summaries.length + takeaways.length + topicCount, rebuiltAt: now };
    })();
  }

  #readAuthoritativeMarkdown(sourceId: string, relativePath: string, expectedHash: string): string {
    const path = this.#knowledgePath(relativePath);
    if (!existsSync(path)) throw new Error(`authoritative-markdown-missing:${sourceId}`);
    const markdown = readFileSync(path, "utf8");
    const actualHash = createHash("sha256").update(markdown).digest("hex");
    if (actualHash !== expectedHash) throw new Error(`authoritative-markdown-drift:${sourceId}`);
    return markdown;
  }

  diagnostics(): unknown {
    const access = inspectDataRootAccess(this.#layout);
    const integrity = (this.#database.pragma("integrity_check") as Array<{ integrity_check: string }>).map((row) => row.integrity_check);
    const foreignKeys = this.#database.pragma("foreign_key_check") as unknown[];
    const schemaVersion = (this.#database.prepare("SELECT max(version) version FROM schema_migrations").get() as { version: number }).version;
    const interruptedJobs = (this.#database.prepare("SELECT count(*) count FROM job_runs WHERE state='interrupted'").get() as { count: number }).count;
    const openWrites = (this.#database.prepare("SELECT count(*) count FROM knowledge_write_requests WHERE phase NOT IN ('complete','failed','conflicted')").get() as { count: number }).count;
    const pendingIndex = (this.#database.prepare("SELECT count(*) count FROM index_outbox WHERE state='pending'").get() as { count: number }).count;
    const artifactGaps = (this.#database.prepare("SELECT storage_ref,retention_class FROM artifacts").all() as
      Array<{ storage_ref: string; retention_class: string }>).filter((row) => !existsSync(join(this.#artifactRoot, row.storage_ref)));
    const missingArtifacts = artifactGaps.filter((row) => row.retention_class === "irreplaceable").map((row) => row.storage_ref);
    const missingRebuildableArtifacts = artifactGaps.filter((row) => row.retention_class !== "irreplaceable").map((row) => row.storage_ref);
    const missingMarkdown = [
      ...(this.#database.prepare("SELECT markdown_path FROM summary_revisions").all() as Array<{ markdown_path: string }>),
      ...(this.#database.prepare("SELECT markdown_path FROM takeaway_revisions").all() as Array<{ markdown_path: string }>),
    ].filter((row) => !existsSync(join(this.#knowledgeRoot, row.markdown_path))).map((row) => row.markdown_path);
    return { schemaVersion, integrity, foreignKeyViolations: foreignKeys, interruptedJobs, openWrites, pendingIndex,
      missingArtifacts, missingRebuildableArtifacts, missingMarkdown,
      unwritablePaths: access.unwritablePaths,
      healthy: access.writable && integrity.every((value) => value === "ok") && foreignKeys.length === 0 && missingArtifacts.length === 0 && missingMarkdown.length === 0 };
  }

  #recordAgentRun(taskKind: AgentTaskKind, paperId: string | null, contextSnapshotId: string | null,
    context: unknown, output: unknown, skillPath: string | null): string {
    const now = new Date().toISOString();
    const jobId = `job:${randomUUID()}`;
    const outputJson = JSON.stringify(output);
    const promptHash = createHash("sha256").update(JSON.stringify(context)).digest("hex");
    const schemaHash = createHash("sha256").update(`${taskKind}:schema:v1`).digest("hex");
    const skillHash = skillPath ? createHash("sha256").update(readFileSync(join(process.cwd(), skillPath))).digest("hex") : null;
    const execution = this.#agentExecutionMetadata?.(taskKind) ?? null;
    this.#database.transaction(() => {
      this.#database.prepare(`INSERT INTO job_runs(id,job_type,paper_id,state,progress,idempotency_key,input_json,output_json,queued_at,started_at,completed_at,heartbeat_at)
        VALUES (?,?,?,'succeeded',1,?,'{}',?,?,?,?,?)`).run(jobId, taskKind, paperId, `${taskKind}:${jobId}`, outputJson, now, now, now, now);
      this.#database.prepare(`INSERT INTO agent_runs(job_run_id,task_kind,model,reasoning_effort,codex_version,
        configuration_version,skill_path,skill_content_hash,context_snapshot_id,output_schema_hash,prompt_hash,output_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(jobId, taskKind, execution?.model ?? null,
          execution?.reasoningEffort ?? null, execution?.codexVersion ?? "unknown", execution?.configurationVersion ?? null,
          skillPath, skillHash, contextSnapshotId, schemaHash, promptHash, outputJson);
    })();
    return jobId;
  }

  #storeArtifact(id: string, artifactType: string, bytes: Uint8Array, extension: string, createdByKind: string,
    createdById: string | null, parentArtifactId: string | null): string {
    const hash = createHash("sha256").update(bytes).digest("hex");
    const storageRef = join("derived", artifactType, hash.slice(0, 2), `${hash}.${extension}`);
    const absolute = join(this.#artifactRoot, storageRef);
    mkdirSync(dirname(absolute), { recursive: true });
    const existingValid = this.#fileMatches(absolute, hash, bytes.byteLength);
    if (!existingValid) {
      const staged = `${absolute}.staged-${randomUUID()}`;
      writeFileSync(staged, bytes);
      renameSync(staged, absolute);
    }
    this.#database.prepare(`INSERT OR IGNORE INTO artifacts(id,artifact_type,content_hash,storage_ref,media_type,byte_size,created_by_kind,retention_class,integrity_status,created_at,created_by_id)
      VALUES (?,?,?,?,?,?,?,'historical','verified',?,?)`).run(id, artifactType, hash, storageRef,
        extension === "json" ? "application/json" : "text/markdown", bytes.byteLength, createdByKind, new Date().toISOString(), createdById);
    const storedId = (this.#database.prepare("SELECT id FROM artifacts WHERE artifact_type=? AND content_hash=?")
      .get(artifactType, hash) as { id: string }).id;
    if (parentArtifactId) this.#database.prepare(`INSERT OR IGNORE INTO artifact_parents(artifact_id,parent_artifact_id,relationship,ordinal)
      VALUES (?,?,'derived-from',0)`).run(storedId, parentArtifactId);
    return storedId;
  }

  #artifactIsValid(id: string): boolean {
    const artifact = this.#database.prepare("SELECT storage_ref,content_hash,byte_size FROM artifacts WHERE id=?").get(id) as
      { storage_ref: string; content_hash: string; byte_size: number } | undefined;
    if (!artifact) return false;
    return this.#fileMatches(join(this.#artifactRoot, artifact.storage_ref), artifact.content_hash, artifact.byte_size);
  }

  #fileMatches(path: string, expectedHash: string, expectedSize: number): boolean {
    if (!existsSync(path)) return false;
    const bytes = readFileSync(path);
    return bytes.byteLength === expectedSize && createHash("sha256").update(bytes).digest("hex") === expectedHash;
  }

  #knowledgePath(relativePath: string): string { return join(this.#knowledgeRoot, relativePath); }

  importPaper(input: { originalInput: string; resolved: ResolvedPaper; version: number; processing?: boolean; importRequestId?: string }): {
    paper: StoredPaper; importRequest: StoredImportRequest; job: ImportJobHandle;
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
      this.#database.prepare("UPDATE papers SET current_version_id=?,updated_at=? WHERE id=?").run(versionId, now, paperId);

      const importId = input.importRequestId ?? `import:${randomUUID()}`;
      if (input.importRequestId) this.#database.prepare(`UPDATE import_requests SET normalized_input=?,resolution_status='resolved',
        resolved_paper_id=?,error_code=NULL,error_detail=NULL,completed_at=? WHERE id=?`).run(input.resolved.arxivId, paperId, now, importId);
      else this.#database.prepare(`INSERT INTO import_requests
        (id,original_input,normalized_input,submitted_at,resolution_status,resolved_paper_id,completed_at)
        VALUES (?,?,?,?, 'resolved',?,?)`).run(importId, input.originalInput, input.resolved.arxivId, now, paperId, now);
      const jobId = `job:${randomUUID()}`;
      this.#database.prepare(`INSERT INTO job_runs
        (id,job_type,import_request_id,paper_id,state,progress,idempotency_key,input_json,output_json,queued_at,started_at,completed_at,heartbeat_at)
        VALUES (?,'paper-import',?,?,?, ?,?,?,'{}',?,?,?,?)`)
        .run(jobId, importId, paperId, input.processing ? "running" : "succeeded", input.processing ? 0.1 : 1,
          `paper-import:${importId}`, JSON.stringify({ versionId, arxivId: input.resolved.arxivId, version: input.version }),
          now, now, input.processing ? null : now, now);
      this.#event(importId, "job-progress", { jobId, jobType: "paper-import", state: input.processing ? "running" : "succeeded", progress: input.processing ? 0.1 : 1 });

      return {
        paper: { id: paperId, arxivId: input.resolved.arxivId, title: input.resolved.title,
          authors: input.resolved.authors, year: input.resolved.year, version: input.version,
          versionId, versionLabel: `v${input.version}`, sourceType: "arxiv", sourceUrl: `https://arxiv.org/abs/${input.resolved.arxivId}v${input.version}` } as StoredPaper,
        importRequest: { id: importId, paperId, status: "resolved" as const },
        job: { id: jobId, attempt: 1, state: "running" as const },
      };
    })();
  }

  importDirectPdf(input: { originalInput: string; prepared: PreparedDirectPdfImport; processing?: boolean; importRequestId?: string; sourceJobId?: string }): {
    paper: StoredPaper; importRequest: StoredImportRequest; job: ImportJobHandle; versionProposal: boolean;
  } {
    const now = this.#now().toISOString();
    const existingIdentity = this.#database.prepare(`SELECT i.paper_id,p.current_version_id FROM paper_external_identities i
      JOIN papers p ON p.id=i.paper_id WHERE i.identity_type='direct-pdf-url' AND i.normalized_value=?`).get(input.prepared.sourceIdentity) as
      { paper_id: string; current_version_id: string } | undefined;
    const identityContentVersion = existingIdentity ? this.#database.prepare(`SELECT id FROM paper_versions
      WHERE paper_id=? AND source_content_hash=? ORDER BY created_at LIMIT 1`).get(existingIdentity.paper_id, input.prepared.contentHash) as
      { id: string } | undefined : undefined;
    const contentPaper = this.#database.prepare(`SELECT paper_id,id FROM paper_versions WHERE source_content_hash=?
      ORDER BY created_at LIMIT 1`).get(input.prepared.contentHash) as { paper_id: string; id: string } | undefined;
    const paperId = existingIdentity?.paper_id ?? contentPaper?.paper_id ?? `paper:pdf:${input.prepared.contentHash.slice(0, 24)}`;
    const versionId = identityContentVersion?.id ?? (!existingIdentity ? contentPaper?.id : undefined) ??
      `paper-version:${paperId}:direct-pdf:sha256:${input.prepared.contentHash}`;
    const changedAtSameUrl = Boolean(existingIdentity && !identityContentVersion && existingIdentity.current_version_id !== versionId);
    const artifactId = `artifact:pdf:${input.prepared.contentHash}`;
    const storageRef = join("originals", "papers", input.prepared.contentHash.slice(0, 2), `${input.prepared.contentHash}.pdf`);
    const absolutePdf = join(this.#artifactRoot, storageRef);
    mkdirSync(dirname(absolutePdf), { recursive: true });
    if (!this.#fileMatches(absolutePdf, input.prepared.contentHash, input.prepared.byteSize)) {
      const staged = `${absolutePdf}.staged-${randomUUID()}`;
      writeFileSync(staged, input.prepared.bytes);
      renameSync(staged, absolutePdf);
      chmodSync(absolutePdf, 0o400);
    }
    return this.#database.transaction(() => {
      this.#database.prepare(`INSERT INTO artifacts(id,artifact_type,content_hash,storage_ref,media_type,byte_size,created_by_kind,retention_class,created_at)
        VALUES (?,'paper-pdf',?,?,?,?,'external-source','irreplaceable',?) ON CONFLICT(artifact_type,content_hash) DO NOTHING`)
        .run(artifactId, input.prepared.contentHash, storageRef, input.prepared.mediaType, input.prepared.byteSize, now);
      this.#database.prepare(`INSERT INTO papers(id,title,acquisition_status,origin,lifecycle_status,current_version_id,created_at,updated_at)
        VALUES (?,?,'ingested','manual-import','active',?,?,?) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at`)
        .run(paperId, input.prepared.metadata.title, changedAtSameUrl ? existingIdentity!.current_version_id : versionId, now, now);
      this.#database.prepare(`INSERT INTO paper_external_identities(id,paper_id,identity_type,normalized_value,canonical_url,metadata_json,created_at)
        VALUES (?,?,'direct-pdf-url',?,?,?,?) ON CONFLICT(identity_type,normalized_value) DO UPDATE SET canonical_url=excluded.canonical_url`)
        .run(`identity:direct-pdf:${createHash("sha256").update(input.prepared.sourceIdentity).digest("hex")}`, paperId,
          input.prepared.sourceIdentity, input.prepared.canonicalUrl,
          JSON.stringify({ authors: input.prepared.metadata.authors, year: input.prepared.metadata.year, actualMediaType: input.prepared.mediaType }), now);
      this.#database.prepare(`INSERT INTO paper_versions(id,paper_id,source_type,source_version,source_url,resolved_at,processing_status,accepted_at,created_at,updated_at,source_content_hash,source_media_type,pdf_artifact_id)
        VALUES (?,?,'direct-pdf',?,?,?, ?,?,?,?, ?,?,?) ON CONFLICT(id) DO NOTHING`)
        .run(versionId, paperId, input.prepared.sourceVersion, input.prepared.canonicalUrl, now,
          changedAtSameUrl ? "detected" : "accepted", changedAtSameUrl ? null : now, now, now,
          input.prepared.contentHash, input.prepared.mediaType, artifactId);
      if (changedAtSameUrl) this.#database.prepare(`INSERT OR IGNORE INTO proposals(id,proposal_type,paper_id,payload_json,review_status,one_click_eligible,created_at)
        VALUES (?,'paper-version-update',?,?,'pending',0,?)`).run(`proposal:direct-pdf-version:${paperId}:${input.prepared.contentHash}`,
          paperId, JSON.stringify({ sourceType: "direct-pdf", sourceIdentity: input.prepared.sourceIdentity,
            currentVersion: existingIdentity!.current_version_id, candidateVersionId: versionId,
            latestVersion: input.prepared.sourceVersion, contentHash: input.prepared.contentHash }), now);
      const importId = input.importRequestId ?? `import:${randomUUID()}`;
      const frozenInput = JSON.stringify({ canonicalUrl: input.prepared.canonicalUrl, contentHash: input.prepared.contentHash, versionId, artifactId });
      if (input.importRequestId) this.#database.prepare(`UPDATE import_requests SET normalized_input=?,resolution_status='resolved',
        resolved_paper_id=?,error_code=NULL,error_detail=NULL,completed_at=?,reference_kind='direct-pdf',frozen_input_json=? WHERE id=?`)
        .run(input.prepared.sourceIdentity, paperId, now, frozenInput, importId);
      else this.#database.prepare(`INSERT INTO import_requests(id,original_input,normalized_input,submitted_at,resolution_status,resolved_paper_id,completed_at,reference_kind,frozen_input_json)
        VALUES (?,?,?,?,'resolved',?,?, 'direct-pdf',?)`).run(importId, input.originalInput, input.prepared.sourceIdentity, now, paperId, now, frozenInput);
      const jobId = input.sourceJobId ?? `job:${randomUUID()}`;
      const runProcessing = Boolean(input.processing && !changedAtSameUrl && !identityContentVersion && !contentPaper);
      const jobInput = JSON.stringify({ versionId, sourceType: "direct-pdf", sourceIdentity: input.prepared.sourceIdentity,
        canonicalUrl: input.prepared.canonicalUrl, contentHash: input.prepared.contentHash });
      if (input.sourceJobId) this.#database.prepare(`UPDATE job_runs SET paper_id=?,state=?,progress=?,input_json=?,error_json=NULL,
        completed_at=?,heartbeat_at=? WHERE id=?`).run(paperId, runProcessing ? "running" : "succeeded", runProcessing ? 0.1 : 1,
          jobInput, runProcessing ? null : now, now, jobId);
      else this.#database.prepare(`INSERT INTO job_runs(id,job_type,import_request_id,paper_id,state,progress,idempotency_key,input_json,output_json,queued_at,started_at,completed_at,heartbeat_at)
        VALUES (?,'paper-import',?,?,?, ?,?,?,'{}',?,?,?,?)`).run(jobId, importId, paperId,
          runProcessing ? "running" : "succeeded", runProcessing ? 0.1 : 1, `paper-import:${importId}`, jobInput,
          now, now, runProcessing ? null : now, now);
      this.#event(importId, "job-progress", { jobId, jobType: "paper-import", state: runProcessing ? "running" : "succeeded", progress: runProcessing ? 0.1 : 1 });
      const jobAttempt = input.sourceJobId ? (this.#database.prepare("SELECT attempt FROM job_runs WHERE id=?").get(jobId) as { attempt: number }).attempt : 1;
      return { paper: { id: paperId, title: input.prepared.metadata.title, authors: input.prepared.metadata.authors,
        year: input.prepared.metadata.year, version: 1, versionId,
        versionLabel: input.prepared.sourceVersion, sourceType: "direct-pdf", sourceUrl: input.prepared.canonicalUrl } as StoredPaper,
        importRequest: { id: importId, paperId, status: "resolved" as const }, job: { id: jobId, attempt: jobAttempt,
          state: (runProcessing ? "running" : "succeeded") as ImportJobState },
        versionProposal: changedAtSameUrl };
    })();
  }

  recordFailedImport(input: { originalInput: string; normalizedInput: string; code: string; detail: string }): {
    id: string; status: "failed";
  } {
    const id = `import:${randomUUID()}`;
    const now = this.#now().toISOString();
    this.#database.prepare(`INSERT INTO import_requests
      (id,original_input,normalized_input,submitted_at,resolution_status,error_code,error_detail,completed_at)
      VALUES (?,?,?,?,'failed',?,?,?)`)
      .run(id, input.originalInput, input.normalizedInput, now, input.code, input.detail, now);
    return { id, status: "failed" };
  }

  beginImport(input: { originalInput: string; normalizedInput: string; referenceKind: "arxiv" | "direct-pdf" }): { id: string; status: "pending" } {
    const id = `import:${randomUUID()}`;
    const now = this.#now().toISOString();
    this.#database.prepare(`INSERT INTO import_requests(id,original_input,normalized_input,submitted_at,resolution_status,reference_kind)
      VALUES (?,?,?,?,'pending',?)`).run(id, input.originalInput, input.normalizedInput, now, input.referenceKind);
    return { id, status: "pending" };
  }

  beginDirectSourceJob(importRequestId: string, sourceIdentity: string): ImportJobHandle {
    const id = `job:${randomUUID()}`;
    const now = this.#now().toISOString();
    this.#database.prepare(`INSERT INTO job_runs(id,job_type,import_request_id,state,progress,idempotency_key,input_json,output_json,queued_at,started_at,heartbeat_at)
      VALUES (?,'paper-import',?,'running',0.05,?,?,'{}',?,?,?)`).run(id, importRequestId, `paper-import:${importRequestId}`,
        JSON.stringify({ sourceType: "direct-pdf", sourceIdentity }), now, now, now);
    return { id, attempt: 1, state: "running" };
  }

  failImport(id: string, input: { code: string; detail: string; downloaded?: DownloadedPdf; jobId?: string }): { id: string; status: "failed" } {
    const now = this.#now().toISOString();
    let frozenInput: string | null = null;
    if (input.downloaded) {
      const artifactId = `artifact:pdf:${input.downloaded.contentHash}`;
      const storageRef = join("originals", "papers", input.downloaded.contentHash.slice(0, 2), `${input.downloaded.contentHash}.pdf`);
      const absolutePdf = join(this.#artifactRoot, storageRef);
      mkdirSync(dirname(absolutePdf), { recursive: true });
      if (!this.#fileMatches(absolutePdf, input.downloaded.contentHash, input.downloaded.byteSize)) {
        const staged = `${absolutePdf}.staged-${randomUUID()}`;
        writeFileSync(staged, input.downloaded.bytes);
        renameSync(staged, absolutePdf);
        chmodSync(absolutePdf, 0o400);
      }
      this.#database.prepare(`INSERT INTO artifacts(id,artifact_type,content_hash,storage_ref,media_type,byte_size,created_by_kind,retention_class,created_at)
        VALUES (?,'paper-pdf',?,?,?,?,'external-source','irreplaceable',?) ON CONFLICT(artifact_type,content_hash) DO NOTHING`)
        .run(artifactId, input.downloaded.contentHash, storageRef, input.downloaded.mediaType, input.downloaded.byteSize, now);
      frozenInput = JSON.stringify({ canonicalUrl: input.downloaded.canonicalUrl, contentHash: input.downloaded.contentHash, artifactId });
    }
    this.#database.prepare(`UPDATE import_requests SET resolution_status='failed',error_code=?,error_detail=?,completed_at=?,
      frozen_input_json=COALESCE(?,frozen_input_json) WHERE id=?`).run(input.code, input.detail, now, frozenInput, id);
    if (input.jobId) this.#database.prepare(`UPDATE job_runs SET state='failed',error_json=?,completed_at=?,heartbeat_at=? WHERE id=?`)
      .run(JSON.stringify({ code: input.code, message: input.detail, stage: input.code === "paper-metadata-incomplete" ? "pdf-extraction" : "pdf-download",
        retryable: true, action: "retry" }), now, now, input.jobId);
    return { id, status: "failed" };
  }

  finishImport(jobId: string, error?: unknown, stage: ImportStage = "knowledge-write"): void {
    const now = new Date().toISOString();
    const state = error ? "failed" : "succeeded";
    const progress = error ? 0.1 : 1;
    const jobError = error ? classifyImportError(error, stage) : null;
    const errorJson = jobError ? JSON.stringify(jobError) : null;
    const job = this.#database.prepare(`UPDATE job_runs SET state=?,progress=?,error_json=?,completed_at=?,heartbeat_at=?
      WHERE id=? AND job_type='paper-import' RETURNING id,import_request_id,paper_id,input_json`).get(state, progress, errorJson, now, now, jobId) as
      { id: string; import_request_id: string; paper_id: string; input_json: string } | undefined;
    if (job) {
      if (error) {
        const input = JSON.parse(job.input_json) as { versionId?: string };
        const versionId = input.versionId ?? (this.#database.prepare("SELECT current_version_id FROM papers WHERE id=?")
          .get(job.paper_id) as { current_version_id: string }).current_version_id;
        this.#database.prepare("UPDATE paper_versions SET processing_status='failed',updated_at=? WHERE id=?").run(now, versionId);
      }
      this.#event(job.import_request_id, "job-progress", { jobId: job.id, jobType: "paper-import", state, progress, error: jobError });
    }
  }

  retryImportJob(jobId: string, idempotencyKey: string): RetryImportResult {
    const row = this.#database.prepare(`SELECT j.state,j.import_request_id,j.paper_id,j.input_json,i.resolution_status,p.title,
      (SELECT normalized_value FROM paper_external_identities WHERE paper_id=p.id AND identity_type='arxiv' LIMIT 1) arxiv_id,p.current_version_id
      FROM job_runs j JOIN import_requests i ON i.id=j.import_request_id JOIN papers p ON p.id=j.paper_id
      WHERE j.id=? AND j.job_type='paper-import'`).get(jobId) as
      { state: string; import_request_id: string; paper_id: string; input_json: string; resolution_status: string; title: string;
        arxiv_id: string | null; current_version_id: string } | undefined;
    if (!row) return { ok: false, code: "job-not-found" };
    const input = JSON.parse(row.input_json) as { versionId?: string; arxivId?: string; version?: number; sourceType?: string; canonicalUrl?: string };
    const versionId = input.versionId ?? row.current_version_id;
    const versionRow = this.#database.prepare("SELECT source_version,source_type,source_url FROM paper_versions WHERE id=? AND paper_id=?").get(versionId, row.paper_id) as
      { source_version: string; source_type: "arxiv" | "direct-pdf"; source_url: string } | undefined;
    if (!versionRow) return { ok: false, code: "job-not-retryable" };
    const version = versionRow.source_type === "arxiv" ? input.version ?? Number.parseInt(versionRow.source_version.replace(/^v/, ""), 10) : 1;
    const arxivId = input.arxivId ?? row.arxiv_id ?? undefined;
    const storedPaper = this.listPapers().find((candidate) => candidate.id === row.paper_id)!;
    const paper: StoredPaper = { id: row.paper_id, title: row.title, authors: storedPaper.authors, year: storedPaper.year,
      version, versionId, versionLabel: versionRow.source_version,
      sourceType: versionRow.source_type, sourceUrl: versionRow.source_url, ...(arxivId ? { arxivId } : {}) };
    const replay = this.#database.prepare(`SELECT id,attempt,state,import_request_id FROM job_runs
      WHERE idempotency_key=?`).get(idempotencyKey) as
      { id: string; attempt: number; state: string; import_request_id: string | null } | undefined;
    if (replay && replay.import_request_id !== row.import_request_id) return { ok: false, code: "idempotency-key-conflict" };
    if (replay) return { ok: true, replayed: true, execution: {
      paper, ...(arxivId ? { arxivId } : {}), version,
      importRequest: { id: row.import_request_id, paperId: row.paper_id, status: "resolved" },
      job: { id: replay.id, attempt: replay.attempt, state: requireImportJobState(replay.state) },
    } };
    if (!isRetryableImportJobState(row.state)) return { ok: false, code: "job-not-retryable" };
    const completed = this.#database.prepare("SELECT 1 FROM job_runs WHERE import_request_id=? AND job_type='paper-import' AND state='succeeded'").get(row.import_request_id);
    if (completed) return { ok: false, code: "job-not-retryable" };
    const active = this.#database.prepare("SELECT 1 FROM job_runs WHERE import_request_id=? AND job_type='paper-import' AND state IN ('queued','running')").get(row.import_request_id);
    if (active) return { ok: false, code: "job-already-active" };
    const attempt = (this.#database.prepare("SELECT max(attempt) attempt FROM job_runs WHERE import_request_id=? AND job_type='paper-import'").get(row.import_request_id) as { attempt: number }).attempt + 1;
    const retryId = `job:${randomUUID()}`;
    const now = this.#now().toISOString();
    this.#database.prepare(`INSERT INTO job_runs
      (id,job_type,import_request_id,paper_id,state,progress,attempt,idempotency_key,input_json,output_json,queued_at,started_at,heartbeat_at)
      VALUES (?,'paper-import',?,?,'running',0.1,?,?,?,'{}',?,?,?)`)
      .run(retryId, row.import_request_id, row.paper_id, attempt, idempotencyKey,
        JSON.stringify({ ...input, versionId, ...(arxivId ? { arxivId } : {}), version }), now, now, now);
    this.#database.prepare("UPDATE paper_versions SET processing_status='processing',updated_at=? WHERE id=?").run(now, versionId);
    this.#event(row.import_request_id, "job-progress", { jobId: retryId, jobType: "paper-import", state: "running", progress: 0.1, attempt });
    return { ok: true, replayed: false, execution: {
      paper, ...(arxivId ? { arxivId } : {}), version,
      importRequest: { id: row.import_request_id, paperId: row.paper_id, status: "resolved" },
      job: { id: retryId, attempt, state: "running" },
    } };
  }

  isDirectPdfImportJob(jobId: string): boolean {
    const row = this.#database.prepare("SELECT input_json FROM job_runs WHERE id=? AND job_type='paper-import'").get(jobId) as
      { input_json: string } | undefined;
    if (!row) return false;
    return (JSON.parse(row.input_json) as { sourceType?: string }).sourceType === "direct-pdf";
  }

  isPrePaperDirectImportJob(jobId: string): boolean {
    const row = this.#database.prepare("SELECT paper_id,input_json FROM job_runs WHERE id=? AND job_type='paper-import'").get(jobId) as
      { paper_id: string | null; input_json: string } | undefined;
    return Boolean(row && row.paper_id === null && (JSON.parse(row.input_json) as { sourceType?: string }).sourceType === "direct-pdf");
  }

  retryDirectSourceJob(jobId: string, idempotencyKey: string): { ok: true; replayed: boolean; job: ImportJobHandle;
    importRequestId: string; originalInput: string; sourceIdentity: string; downloaded?: DownloadedPdf } |
    { ok: false; code: "job-not-found" | "job-not-retryable" | "job-already-active" | "idempotency-key-conflict" } {
    const row = this.#database.prepare(`SELECT j.state,j.import_request_id,j.attempt,i.original_input,i.normalized_input,i.frozen_input_json
      FROM job_runs j JOIN import_requests i ON i.id=j.import_request_id WHERE j.id=? AND j.paper_id IS NULL`).get(jobId) as
      { state: string; import_request_id: string; attempt: number; original_input: string; normalized_input: string;
        frozen_input_json: string | null } | undefined;
    if (!row) return { ok: false, code: "job-not-found" };
    const replay = this.#database.prepare("SELECT id,attempt,state,import_request_id FROM job_runs WHERE idempotency_key=?").get(idempotencyKey) as
      { id: string; attempt: number; state: string; import_request_id: string } | undefined;
    if (replay && replay.import_request_id !== row.import_request_id) return { ok: false, code: "idempotency-key-conflict" };
    const downloaded = this.#frozenDownload(row.frozen_input_json);
    if (replay) return { ok: true, replayed: true, job: { id: replay.id, attempt: replay.attempt, state: requireImportJobState(replay.state) },
      importRequestId: row.import_request_id, originalInput: row.original_input, sourceIdentity: row.normalized_input, ...(downloaded ? { downloaded } : {}) };
    if (!["failed", "interrupted"].includes(row.state)) return { ok: false, code: row.state === "running" ? "job-already-active" : "job-not-retryable" };
    const active = this.#database.prepare("SELECT 1 FROM job_runs WHERE import_request_id=? AND state IN ('queued','running') LIMIT 1").get(row.import_request_id);
    if (active) return { ok: false, code: "job-already-active" };
    const retryId = `job:${randomUUID()}`;
    const attempt = (this.#database.prepare("SELECT COALESCE(MAX(attempt),0)+1 next FROM job_runs WHERE import_request_id=?").get(row.import_request_id) as
      { next: number }).next;
    const now = this.#now().toISOString();
    this.#database.transaction(() => {
      this.#database.prepare(`INSERT INTO job_runs(id,job_type,import_request_id,state,progress,attempt,idempotency_key,input_json,output_json,queued_at,started_at,heartbeat_at)
        VALUES (?,'paper-import',?,'running',0.05,?,?,?,'{}',?,?,?)`).run(retryId, row.import_request_id, attempt, idempotencyKey,
          JSON.stringify({ sourceType: "direct-pdf", sourceIdentity: row.normalized_input }), now, now, now);
      this.#database.prepare(`UPDATE import_requests SET resolution_status='pending',error_code=NULL,error_detail=NULL,completed_at=NULL
        WHERE id=?`).run(row.import_request_id);
    })();
    return { ok: true, replayed: false, job: { id: retryId, attempt, state: "running" }, importRequestId: row.import_request_id,
      originalInput: row.original_input, sourceIdentity: row.normalized_input, ...(downloaded ? { downloaded } : {}) };
  }

  #frozenDownload(frozenInput: string | null): DownloadedPdf | undefined {
    if (!frozenInput) return undefined;
    const frozen = JSON.parse(frozenInput) as { canonicalUrl?: string; contentHash?: string; artifactId?: string };
    if (!frozen.canonicalUrl || !frozen.contentHash || !frozen.artifactId || !this.#artifactIsValid(frozen.artifactId)) return undefined;
    const artifact = this.#database.prepare("SELECT storage_ref,media_type,byte_size FROM artifacts WHERE id=?").get(frozen.artifactId) as
      { storage_ref: string; media_type: string; byte_size: number };
    return { bytes: readFileSync(join(this.#artifactRoot, artifact.storage_ref)), contentHash: frozen.contentHash,
      byteSize: artifact.byte_size, canonicalUrl: frozen.canonicalUrl, mediaType: artifact.media_type };
  }

  getImport(id: string): ImportStatus | null {
    const row = this.#database.prepare(`SELECT id,resolved_paper_id,resolution_status,error_code,error_detail
      FROM import_requests WHERE id=?`).get(id) as
      { id: string; resolved_paper_id: string | null; resolution_status: string; error_code: string | null; error_detail: string | null } | undefined;
    if (!row) return null;
    const jobs = this.#database.prepare(`SELECT id,job_type,state,progress,attempt,error_json FROM job_runs WHERE import_request_id=? ORDER BY attempt,queued_at,id`).all(id) as
      Array<{ id: string; job_type: string; state: string; progress: number; attempt: number; error_json: string | null }>;
    return { importRequest: { id: row.id, paperId: row.resolved_paper_id, resolutionStatus: row.resolution_status,
      error: row.error_code && row.error_detail ? { code: row.error_code, detail: row.error_detail } : null },
      jobs: jobs.map((job) => ({ id: job.id, jobType: job.job_type, state: requireImportJobState(job.state), progress: job.progress,
        attempt: job.attempt, error: parseStoredImportError(job.error_json) })) };
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

  listPapers(filters: {
    q?: string;
    view?: "all" | "unclassified";
    direction?: string;
    domain?: string;
    relation?: "all" | "primary";
    pending?: boolean;
  } = {}): StoredPaper[] {
    const papers = (this.#database.prepare(`SELECT p.id,p.title,p.updated_at,v.id version_id,v.source_type,
      CASE WHEN v.source_type='direct-pdf' THEN COALESCE((SELECT normalized_value FROM paper_external_identities
        WHERE paper_id=p.id AND identity_type='direct-pdf-url' ORDER BY created_at LIMIT 1),v.source_url) ELSE v.source_url END source_url,
      v.source_version,
      COALESCE((SELECT metadata_json FROM paper_external_identities WHERE paper_id=p.id AND identity_type='arxiv' LIMIT 1),
        (SELECT metadata_json FROM paper_external_identities WHERE paper_id=p.id AND identity_type='direct-pdf-url' ORDER BY created_at LIMIT 1)) metadata_json,
      (SELECT i.normalized_value FROM paper_external_identities i WHERE i.paper_id=p.id AND i.identity_type='arxiv' LIMIT 1) arxiv_id,
      (SELECT j.state FROM job_runs j WHERE j.paper_id=p.id AND j.job_type='paper-import'
        ORDER BY j.attempt DESC,j.queued_at DESC,j.id DESC LIMIT 1) job_state,
      (SELECT j.progress FROM job_runs j WHERE j.paper_id=p.id AND j.job_type='paper-import'
        ORDER BY j.attempt DESC,j.queued_at DESC,j.id DESC LIMIT 1) job_progress,
      (SELECT j.error_json FROM job_runs j WHERE j.paper_id=p.id AND j.job_type='paper-import'
        ORDER BY j.attempt DESC,j.queued_at DESC,j.id DESC LIMIT 1) job_error_json,
      CASE WHEN EXISTS (SELECT 1 FROM summary_revisions s WHERE s.paper_id=p.id AND s.status='active') THEN 'ready'
        WHEN v.processing_status='failed' THEN 'failed' ELSE 'processing' END summary_status,
      CASE WHEN EXISTS (SELECT 1 FROM paper_code_links pcl WHERE pcl.paper_id=p.id AND pcl.status='confirmed') THEN 'ready'
        WHEN EXISTS (SELECT 1 FROM proposals pr WHERE pr.paper_id=p.id AND pr.proposal_type='repository-retry'
          AND pr.review_status='pending') THEN 'failed'
        ELSE 'not-linked' END code_status,
      (SELECT count(*) FROM proposals pr WHERE pr.paper_id=p.id AND pr.review_status='pending'
        AND pr.proposal_type<>'paper-organization') pending_review_count
      FROM papers p
      JOIN paper_versions v ON v.id=p.current_version_id ORDER BY p.updated_at DESC,p.id`).all() as
      Array<{ id: string; title: string; updated_at: string; version_id: string; source_type: "arxiv" | "direct-pdf";
        source_url: string; source_version: string; arxiv_id: string | null; metadata_json: string;
        job_state: string | null; job_progress: number | null; job_error_json: string | null;
        summary_status: "ready" | "processing" | "failed";
        code_status: "ready" | "failed" | "not-linked"; pending_review_count: number }>).map((row) => ({
        id: row.id, ...(row.arxiv_id ? { arxivId: row.arxiv_id } : {}), title: row.title,
        authors: (JSON.parse(row.metadata_json) as { authors: string[] }).authors,
        year: (JSON.parse(row.metadata_json) as { year: number }).year,
        version: row.source_type === "arxiv" ? Number.parseInt(row.source_version.slice(1), 10) : 1,
        versionId: row.version_id, versionLabel: row.source_version, sourceType: row.source_type, sourceUrl: row.source_url,
        updatedAt: row.updated_at,
        processing: row.job_state ? { state: requireImportJobState(row.job_state), progress: row.job_progress ?? 0,
          needsAttention: isRetryableImportJobState(row.job_state), error: parseStoredImportError(row.job_error_json) } : null,
        summaryStatus: row.summary_status,
        codeStatus: row.code_status,
        pendingReviewCount: row.pending_review_count,
      }));
    return this.#paperOrganization.decoratePapers(papers, filters);
  }

  listResearchDirections(): ReturnType<PaperOrganizationStore["listDirections"]> {
    return this.#paperOrganization.listDirections();
  }

  researchDirectionHierarchy() { return this.#paperOrganization.hierarchy(); }

  createResearchDomain(input: unknown, idempotencyKey: string): unknown {
    return this.#paperOrganization.createDomain(input, idempotencyKey);
  }

  renameResearchDomain(topicId: string, input: unknown, idempotencyKey: string): unknown {
    const result = this.#paperOrganization.renameDomain(topicId, input, idempotencyKey);
    this.#topicKnowledge.syncObservedDirections();
    return result;
  }

  setResearchDirectionDomain(topicId: string, input: unknown, idempotencyKey: string): unknown {
    const result = this.#paperOrganization.setDirectionDomain(topicId, input, idempotencyKey);
    this.#topicKnowledge.syncObservedDirections();
    return result;
  }

  setTaxonomyHierarchyEnabled(enabled: boolean, idempotencyKey: string): unknown {
    return this.#paperOrganization.setHierarchyEnabled(enabled, idempotencyKey);
  }

  resolveResearchDirection(topicId: string) {
    return this.#paperOrganization.resolveDirection(topicId);
  }

  createResearchDirection(input: unknown, idempotencyKey: string): unknown {
    return this.#paperOrganization.createDirection(input, idempotencyKey);
  }

  renameResearchDirection(topicId: string, input: unknown, idempotencyKey: string): unknown {
    const result = this.#paperOrganization.renameDirection(topicId, input, idempotencyKey);
    this.#topicKnowledge.syncObservedDirections();
    return result;
  }

  getTopicKnowledge(topicId: string) { return this.#topicKnowledge.get(topicId); }

  listTopicKnowledgeProvenanceOptions(topicId: string) {
    return this.#topicKnowledge.provenanceOptions(topicId);
  }

  previewTopicKnowledge(topicId: string, input: unknown) {
    return this.#topicKnowledge.preview(topicId, input);
  }

  commitTopicKnowledge(topicId: string, input: unknown, idempotencyKey: string) {
    return this.#topicKnowledge.commit(topicId, input, idempotencyKey);
  }

  auditTopicKnowledgeHistory() { return this.#topicKnowledge.auditHistory(); }

  directionMergePreview(sourceTopicId: string, targetTopicId: string) {
    return this.#paperOrganization.mergeDirectionPreview(sourceTopicId, targetTopicId);
  }

  reserveDirectionMerge(sourceTopicId: string, targetTopicId: string, idempotencyKey: string) {
    return this.#paperOrganization.reserveDirectionMerge(sourceTopicId, targetTopicId, idempotencyKey);
  }

  commitDirectionMergeSource(mergeId: string): void {
    this.#paperOrganization.commitDirectionMergeSource(mergeId);
    this.#topicKnowledge.syncObservedDirections();
    this.#topicKnowledge.refreshEligibility();
  }

  applyDirectionMergeMember(mergeId: string, ordinal: number): unknown {
    return this.#paperOrganization.applyDirectionMergeMember(mergeId, ordinal);
  }

  readDirectionMerge(mergeId: string) {
    const command = this.#database.prepare("SELECT * FROM direction_merge_commands WHERE id=?")
      .get(mergeId) as Record<string, unknown> | undefined;
    if (!command) throw new PaperOrganizationStoreError("direction-merge-not-found", 404);
    const members = this.#database.prepare(`SELECT * FROM direction_merge_members
      WHERE merge_id=? ORDER BY ordinal`).all(mergeId) as Array<Record<string, unknown>>;
    return {
      merge: {
        id: String(command.id),
        sourceTopicId: String(command.source_topic_id),
        targetTopicId: String(command.target_topic_id),
        state: String(command.state),
        errorCode: command.error_code ? String(command.error_code) : null,
        createdAt: String(command.created_at),
        completedAt: command.completed_at ? String(command.completed_at) : null,
      },
      preview: JSON.parse(String(command.preview_json)),
      members: members.map((member) => ({
        ordinal: Number(member.ordinal),
        paperId: String(member.paper_id),
        state: String(member.member_state),
        attempt: Number(member.attempt),
        errorCode: member.error_code ? String(member.error_code) : null,
      })),
    };
  }

  retryDirectionMerge(mergeId: string) {
    const command = this.#database.prepare("SELECT state FROM direction_merge_commands WHERE id=?")
      .get(mergeId) as { state: string } | undefined;
    if (!command || !["failed", "complete-with-exceptions"].includes(command.state)) {
      throw new PaperOrganizationStoreError("direction-merge-not-retryable", 409);
    }
    const now = this.#now().toISOString();
    if (command.state === "failed") {
      this.#database.prepare(`UPDATE direction_merge_commands SET state='reserved',error_code=NULL,
        completed_at=NULL,updated_at=? WHERE id=?`).run(now, mergeId);
    } else {
      this.#database.prepare(`UPDATE direction_merge_members SET member_state='pending',
        error_code=NULL,updated_at=? WHERE merge_id=? AND member_state IN ('failed','conflicted')`)
        .run(now, mergeId);
      this.#database.prepare(`UPDATE direction_merge_commands SET state='migrating',completed_at=NULL,
        updated_at=? WHERE id=?`).run(now, mergeId);
    }
    return this.readDirectionMerge(mergeId);
  }

  savePaperOrganization(paperId: string, input: unknown, idempotencyKey: string): unknown {
    return this.#paperOrganization.savePaperOrganization(paperId, input, idempotencyKey);
  }

  snapshotForOrganizationAgent(paperId: string, summaryRevisionId: string,
    scope: PaperOrganizationScope = "all") {
    return this.#paperOrganization.snapshotForOrganizationAgent(paperId, summaryRevisionId, scope);
  }

  decidePaperOrganizationProposal(proposalId: string,
    input: { action?: unknown; value?: unknown; automation?: unknown },
    idempotencyKey: string) {
    return this.#paperOrganization.decideAgentProposal(proposalId, input, idempotencyKey);
  }

  paperOrganizationProposalState(proposalId: string) {
    return this.#paperOrganization.organizationProposalState(proposalId);
  }

  readOrganizationForPaper(paperId: string, verifyLive = true) {
    return this.#paperOrganization.readOrganizationForPaper(paperId, verifyLive);
  }

  paperOrganizationQueue(query: OrganizationQueueQuery) {
    return this.#paperOrganization.organizationQueue(query);
  }

  paperOrganizationStatuses(input: { jobRunIds: string[]; proposalIds: string[] }) {
    return this.#paperOrganization.organizationStatuses(input);
  }

  paperOrganizationBatchPreview(action: PaperOrganizationBatchAction, proposalIds: string[]) {
    return this.#paperOrganizationBatches.preview(action, proposalIds);
  }

  reservePaperOrganizationBatch(action: PaperOrganizationBatchAction, proposalIds: string[],
    idempotencyKey: string) {
    return this.#paperOrganizationBatches.reserve(action, proposalIds, idempotencyKey);
  }

  readPaperOrganizationBatch(batchId: string) {
    return this.#paperOrganizationBatches.read(batchId);
  }

  retryPaperOrganizationBatch(batchId: string) {
    return this.#paperOrganizationBatches.retry(batchId);
  }

  abandonPaperOrganizationBatch(batchId: string) {
    return this.#paperOrganizationBatches.abandon(batchId);
  }

  paperTaxonomyPreview(mode: "next" | "regenerate" | "refresh" = "next",
    limit = 100, priorManifestId?: string) {
    return this.#paperTaxonomy.bootstrapPreview(mode, limit, priorManifestId);
  }

  buildPaperTaxonomyManifest(input: Parameters<PaperTaxonomyStore["buildTaxonomyManifest"]>[0]) {
    return this.#paperTaxonomy.buildTaxonomyManifest(input);
  }

  readPaperTaxonomy() {
    return this.#paperTaxonomy.listTaxonomy();
  }

  decideDirectionTaxonomyProposal(proposalId: string, input: { action?: unknown; value?: unknown },
    idempotencyKey: string) {
    return this.#paperTaxonomy.decideProposal(proposalId, input, idempotencyKey);
  }

  directionTaxonomyCollision(value: Parameters<PaperTaxonomyStore["directionCollision"]>[0]) {
    return this.#paperTaxonomy.directionCollision(value, null);
  }

  paperOrganizationBackfillPreview(limit = 50) {
    return this.#paperTaxonomy.backfillPreview(limit);
  }

  reservePaperOrganizationBackfill(limit: number, idempotencyKey: string) {
    return this.#paperTaxonomy.reserveBackfill(limit, idempotencyKey);
  }

  readPaperOrganizationBackfill(campaignId: string) {
    return this.#paperTaxonomy.backfill(campaignId);
  }

  abandonPaperOrganizationBackfill(campaignId: string) {
    return this.#paperTaxonomy.abandonBackfill(campaignId);
  }

  rebuildPaperCatalog(): { count: number; rebuiltAt: string; blocked?: boolean } {
    return this.#paperOrganization.rebuildCatalog();
  }

  findFrozenArxiv(arxivId: string): StoredPaper | null {
    return this.listPapers().find((paper) => paper.arxivId === arxivId) ?? null;
  }

  getResolvedMetadata(paperId: string): ResolvedPaper | null {
    const paper = this.listPapers().find((candidate) => candidate.id === paperId);
    if (!paper?.arxivId) return null;
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

function renderSummary(input: { summaryId: string; paper: StoredPaper; versionId: string; extractionId: string; agentRunId: string; skillHash: string;
  result: Omit<SummaryResult, "claims"> & { claims: Array<SummaryResult["claims"][number] & { page: number }> }; date: string }): string {
  const sections = input.result.sections.map((section, index) => `## ${index + 1}. ${section.title}\n\n${section.body}`).join("\n\n");
  const claims = input.result.claims.map((claim) => `| ${claim.voice} | ${claim.claim} | p. ${claim.page} |`).join("\n");
  return `---\nartifact_id: "artifact:${input.summaryId}"\ntype: paper-summary\npaper_id: "${input.paper.id}"\npaper_version_id: "${input.versionId}"\nextraction_run_id: "${input.extractionId}"\nsummary_revision_id: "${input.summaryId}"\nrevision: 1\nstatus: active\nread_status: ${input.result.readStatus}\nskill_path: skills/paper-reading/SKILL.md\nskill_content_hash: "${input.skillHash}"\nagent_run_id: "${input.agentRunId}"\ngenerated_at: ${input.date}\ncreated: ${input.date}\nupdated: ${input.date}\n---\n\n# ${input.paper.title} — Paper Summary\n\n${sections}\n\n## Key Claims\n\n| Voice | Claim | Evidence Anchor |\n|---|---|---|\n${claims}\n`;
}

function markdownWithoutFrontmatter(markdown: string): string {
  return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();
}

function summaryProjectionBody(markdown: string): string {
  const body = markdownWithoutFrontmatter(markdown).replace(/^# .*(?:\r?\n)+/, "");
  return body.split(/\r?\n## Key Claims\r?\n/)[0]!.trim();
}

function markdownSection(markdown: string, heading: string): string | null {
  const marker = `## ${heading}`;
  const start = markdown.indexOf(marker);
  if (start < 0) return null;
  const contentStart = start + marker.length;
  const next = markdown.indexOf("\n## ", contentStart);
  return markdown.slice(contentStart, next < 0 ? undefined : next).trim();
}

function takeawayProjection(markdown: string): { title: string; body: string } {
  const authoritative = markdownWithoutFrontmatter(markdown);
  const title = authoritative.match(/^# (.+)$/m)?.[1]?.trim();
  const claim = markdownSection(authoritative, "Claim");
  const evidence = markdownSection(authoritative, "Evidence")?.split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("|")).join("\n").trim();
  const interpretation = markdownSection(authoritative, "Interpretation");
  const caveat = markdownSection(authoritative, "Challenges or conflicts");
  if (!title || !claim || !evidence) throw new Error("authoritative-takeaway-markdown-invalid");
  return { title, body: [claim, evidence, interpretation, caveat].filter(Boolean).join("\n\n") };
}

function classifyImportError(error: unknown, stage: ImportStage): ImportJobError {
  const message = error instanceof Error ? error.message : "import-failed";
  const filesystemCode = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
  if (filesystemCode === "EACCES" || filesystemCode === "EPERM" || /permission denied/i.test(message)) {
    return { code: "storage-permission-denied", message, stage, retryable: false, action: "repair-data-root-permissions" };
  }
  const code = stage === "pdf-download" ? "pdf-download-failed"
    : stage === "pdf-storage" ? "pdf-storage-failed"
      : stage === "pdf-extraction" ? "pdf-extraction-failed"
        : stage === "paper-summary" ? "summary-generation-failed" : "knowledge-write-failed";
  return { code, message, stage, retryable: true, action: "retry" };
}

function parseStoredImportError(errorJson: string | null): ImportJobError | null {
  if (!errorJson) return null;
  const parsed = JSON.parse(errorJson) as Partial<ImportJobError> & { message?: string };
  if (parsed.code && parsed.stage && typeof parsed.retryable === "boolean") return parsed as ImportJobError;
  const message = parsed.message ?? "import-failed";
  const stage: ImportStage = /originals[\\/]papers|pdf/i.test(message) ? "pdf-storage" : "knowledge-write";
  return classifyImportError(new Error(message), stage);
}
