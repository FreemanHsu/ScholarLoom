import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type Database from "better-sqlite3";
import type { EpistemicStatus, TakeawayKind } from "../agent/takeaway-distillation.js";

type KnowledgeWritePorts = {
  now(): Date;
  stagedFileExists(relativePath: string): boolean;
  afterTakeawayPhase?(phase: "staged" | "renamed" | "metadata-committed"): void;
  advanceSummary(id: string): void;
  advancePaperManifest(id: string): void;
  knowledgePath(relativePath: string): string;
  storeArtifact(id: string, bytes: Uint8Array, reviewDecisionId: string, parentArtifactId: string | null): void;
  createWriteConflict(writeId: string, paperId: string, targetPath: string, expectedHash: string, actualHash: string): void;
};

export class KnowledgeWriter {
  constructor(private readonly database: Database.Database, private readonly ports: KnowledgeWritePorts) {}

  recover(): void {
    const rows = this.database.prepare(`SELECT id,request_type,phase,staged_path
      FROM knowledge_write_requests
      WHERE phase NOT IN ('complete','failed','conflicted')
      ORDER BY created_at,id`).all() as Array<{
        id: string;
        request_type: string;
        phase: string;
        staged_path: string;
      }>;
    for (const row of rows) {
      if (row.request_type === "takeaway") this.advanceTakeaway(row.id);
      else if (row.phase === "reserved" && !this.ports.stagedFileExists(row.staged_path)) {
        this.database.prepare(`UPDATE knowledge_write_requests
          SET phase='failed',error_code='staged-file-missing',updated_at=? WHERE id=?`)
          .run(this.ports.now().toISOString(), row.id);
      }
      else if (row.request_type === "summary") this.ports.advanceSummary(row.id);
      else if (row.request_type === "paper-manifest") this.ports.advancePaperManifest(row.id);
    }
  }

  commitTakeaway(command: { paperId: string; paperTitle: string; proposalId: string; idempotencyKey: string;
    action: "accept" | "edit-and-accept"; title: string; kind: TakeawayKind; claim: string;
    epistemicStatus: EpistemicStatus; evidenceRationale: string; caveat: string | null; receiptIds: string[];
    contractVersion: string; sourceMessageId: string; distillationJobRunId: string; trigger: string;
    editedFields: string[] }): { complete: boolean; body: {
      reviewDecision: { id: string; action: "accept" | "accept-with-edit"; editedFields: string[] };
      takeaway: { id: string; revisionId: string; revision: number; reviewStatus: string; markdownPath: string };
    } } {
    const now = this.ports.now().toISOString();
    const canonicalAction: "accept" | "accept-with-edit" = command.action === "edit-and-accept" ? "accept-with-edit" : "accept";
    const slug = command.title.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-").slice(0, 48).replace(/-$/, "") || "takeaway";
    const takeawayId = `takeaway:${command.paperId}:${createHash("sha256").update(command.proposalId).digest("hex").slice(0, 12)}`;
    const revisionId = `${takeawayId}:r1`;
    const paperSlug = command.paperTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const relativePath = join("library", "papers", paperSlug, "takeaways", `${slug}-${takeawayId.slice(-8)}.md`);
    const receipts = command.receiptIds.map((id) => this.database.prepare(`SELECT id,evidence_kind,source_id,
      source_revision,locator_json FROM all_evidence_receipts WHERE id=? AND message_id=? AND verification_status='verified'`)
      .get(id, command.sourceMessageId) as { id: string; evidence_kind: string; source_id: string;
        source_revision: string | null; locator_json: string } | undefined);
    if (receipts.some((receipt) => !receipt)) throw new Error("takeaway-receipt-unverified");
    const evidenceRows = receipts.map((receipt) => {
      const item = receipt!;
      const source = item.source_revision ? `${item.source_id}@${item.source_revision}` : item.source_id;
      return `| ${escapeCell(source)} | ${escapeCell(item.id)} | supports |`;
    }).join("\n");
    const interpretation = command.epistemicStatus === "evidence-backed" ? ""
      : `\n## Interpretation\n\n${command.epistemicStatus === "hypothesis" ? "Hypothesis" : "Interpretation"}: ${command.claim}\n`;
    const structured = { title: command.title, kind: command.kind, claim: command.claim,
      epistemicStatus: command.epistemicStatus, evidenceRationale: command.evidenceRationale,
      caveat: command.caveat, receiptIds: command.receiptIds, contractVersion: command.contractVersion,
      sourceMessageId: command.sourceMessageId, distillationJobRunId: command.distillationJobRunId,
      trigger: command.trigger };
    const markdown = `---\nid: "${takeawayId}"\ntype: takeaway\ncontract_version: "${command.contractVersion}"\nkind: "${command.kind}"\npaper_id: "${command.paperId}"\nrevision_id: "${revisionId}"\nrevision: 1\nreview_status: confirmed\nepistemic_status: "${command.epistemicStatus}"\nreceipt_ids: ${JSON.stringify(command.receiptIds)}\nsource_message_id: "${command.sourceMessageId}"\nproposal_id: "${command.proposalId}"\ndistillation_run_id: "${command.distillationJobRunId}"\ntrigger: "${command.trigger}"\nsemantic_relations: []\nconfirmed_at: ${now}\ncreated: ${now}\nupdated: ${now}\n---\n\n# ${command.title}\n\n## Claim\n\n${command.claim}\n\n## Evidence\n\n| Source | Evidence Receipt | Relationship |\n|---|---|---|\n${evidenceRows}\n\n${command.evidenceRationale}\n${interpretation}\n## Challenges or conflicts\n\n${command.caveat ?? "当前没有已知且有证据支持的 material caveat。"}\n\n## Revision note\n\nConfirmed from Proposal ${command.proposalId}.\n`;
    const hash = createHash("sha256").update(markdown).digest("hex");
    const body: { reviewDecision: { id: string; action: "accept" | "accept-with-edit"; editedFields: string[] };
      takeaway: { id: string; revisionId: string; revision: number; reviewStatus: string; markdownPath: string } } = {
      reviewDecision: { id: `review-decision:${randomUUID()}`, action: canonicalAction,
        editedFields: [...command.editedFields].sort() },
      takeaway: { id: takeawayId, revisionId, revision: 1, reviewStatus: "confirmed", markdownPath: relativePath } };
    const writeId = `knowledge-write:${revisionId}`;
    const writePayload = { paperId: command.paperId, proposalId: command.proposalId,
      idempotencyKey: command.idempotencyKey, claim: command.claim, title: command.title,
      receiptIds: command.receiptIds, structured,
      takeawayId, revisionId, relativePath, hash, now, body };
    this.database.prepare(`INSERT INTO knowledge_write_requests
      (id,request_type,target_path,staged_path,result_hash,phase,created_at,updated_at,payload_json)
      VALUES (?,'takeaway',?,?,?,'reserved',?,?,?) ON CONFLICT(id) DO NOTHING`)
      .run(writeId, relativePath, `${relativePath}.staged`, hash, now, now, JSON.stringify(writePayload));
    const staged = this.ports.knowledgePath(`${relativePath}.staged`);
    mkdirSync(dirname(staged), { recursive: true });
    writeFileSync(staged, markdown, "utf8");
    this.database.prepare("UPDATE knowledge_write_requests SET phase='staged',updated_at=? WHERE id=?")
      .run(now, writeId);
    this.ports.afterTakeawayPhase?.("staged");
    this.advanceTakeaway(writeId);
    const phase = (this.database.prepare("SELECT phase FROM knowledge_write_requests WHERE id=?").get(writeId) as { phase: string }).phase;
    return { complete: phase === "complete", body };
  }

  advanceTakeaway(writeId: string): void {
    const row = this.database.prepare("SELECT target_path,staged_path,result_hash,phase,payload_json FROM knowledge_write_requests WHERE id=?").get(writeId) as
      { target_path: string; staged_path: string; result_hash: string; phase: string; payload_json: string };
    const payload = JSON.parse(row.payload_json) as { paperId: string; proposalId: string; idempotencyKey: string; claim: string;
      title: string; receiptIds: string[]; structured: { contractVersion: string; kind: string; epistemicStatus: string;
        evidenceRationale: string; caveat: string | null; sourceMessageId: string; distillationJobRunId: string; trigger: string };
      takeawayId: string; revisionId: string; relativePath: string; hash: string; now: string;
      body: { reviewDecision: { id: string; action: string }; takeaway: unknown } };
    let phase = row.phase;
    const targetPath = this.ports.knowledgePath(row.target_path);
    const stagedPath = this.ports.knowledgePath(row.staged_path);
    if (phase === "reserved" && !existsSync(stagedPath) && !existsSync(targetPath)) {
      this.database.prepare(`UPDATE knowledge_write_requests
        SET phase='failed',error_code='staged-file-missing',updated_at=? WHERE id=?`)
        .run(this.ports.now().toISOString(), writeId);
      return;
    }
    if (phase === "reserved" && existsSync(stagedPath)) {
      const stagedHash = createHash("sha256").update(readFileSync(stagedPath)).digest("hex");
      if (stagedHash !== row.result_hash) {
        this.database.prepare(`UPDATE knowledge_write_requests
          SET phase='failed',error_code='staged-hash-mismatch',updated_at=? WHERE id=?`)
          .run(this.ports.now().toISOString(), writeId);
        return;
      }
      this.database.prepare("UPDATE knowledge_write_requests SET phase='staged',updated_at=? WHERE id=?")
        .run(this.ports.now().toISOString(), writeId);
      phase = "staged";
    }
    if (phase === "staged") {
      if (existsSync(targetPath)) {
        const actualHash = createHash("sha256").update(readFileSync(targetPath)).digest("hex");
        if (actualHash !== row.result_hash) {
          this.ports.createWriteConflict(writeId, payload.paperId, row.target_path, row.result_hash, actualHash);
          return;
        }
        if (existsSync(stagedPath)) unlinkSync(stagedPath);
      } else renameSync(stagedPath, targetPath);
      this.database.prepare("UPDATE knowledge_write_requests SET phase='renamed',updated_at=? WHERE id=?")
        .run(this.ports.now().toISOString(), writeId);
      phase = "renamed";
      this.ports.afterTakeawayPhase?.("renamed");
    }
    if (phase === "renamed") {
      const actualHash = existsSync(targetPath)
        ? createHash("sha256").update(readFileSync(targetPath)).digest("hex") : "";
      if (actualHash !== row.result_hash) {
        this.ports.createWriteConflict(writeId, payload.paperId, row.target_path, row.result_hash, actualHash);
        return;
      }
      const summaryArtifact = this.database.prepare(`SELECT a.id artifact_id FROM summary_revisions s JOIN artifacts a
        ON a.artifact_type='paper-summary' AND a.content_hash=s.markdown_hash WHERE s.paper_id=? AND s.status='active'`)
        .get(payload.paperId) as { artifact_id: string } | undefined;
      this.ports.storeArtifact(`artifact:${payload.revisionId}`, readFileSync(targetPath), payload.body.reviewDecision.id,
        summaryArtifact?.artifact_id ?? null);
      this.database.transaction(() => {
        this.database.prepare("INSERT OR IGNORE INTO takeaways(id,paper_id,active_revision_id,created_at) VALUES (?,?,?,?)")
          .run(payload.takeawayId, payload.paperId, payload.revisionId, payload.now);
        this.database.prepare(`INSERT OR IGNORE INTO takeaway_revisions
          (id,takeaway_id,revision,title,claim,review_status,provenance_json,markdown_path,markdown_hash,confirmed_at,
           contract_version,structured_json,source_message_id,distillation_job_run_id)
          VALUES (?,?,1,?,?,'confirmed',?,?,?,?,?,?,?,?)`).run(payload.revisionId, payload.takeawayId,
            payload.title, payload.claim, JSON.stringify(payload.receiptIds), payload.relativePath, payload.hash, payload.now,
            payload.structured.contractVersion, JSON.stringify(payload.structured), payload.structured.sourceMessageId,
            payload.structured.distillationJobRunId);
        this.database.prepare("UPDATE proposals SET review_status='accepted',decided_at=? WHERE id=?")
          .run(payload.now, payload.proposalId);
        this.database.prepare(`INSERT OR IGNORE INTO review_decisions
          (id,proposal_id,action,idempotency_key,result_json,created_at) VALUES (?,?,?,?,?,?)`)
          .run(payload.body.reviewDecision.id, payload.proposalId, payload.body.reviewDecision.action,
            payload.idempotencyKey, JSON.stringify(payload.body), payload.now);
        this.database.prepare(`INSERT OR IGNORE INTO index_outbox(projection,source_id,operation,state,created_at)
          VALUES ('global-curated',?,'upsert','pending',?)`).run(payload.revisionId, payload.now);
        this.database.prepare("UPDATE knowledge_write_requests SET phase='metadata-committed',updated_at=? WHERE id=?")
          .run(this.ports.now().toISOString(), writeId);
      })();
      phase = "metadata-committed";
      this.ports.afterTakeawayPhase?.("metadata-committed");
    }
    if (phase === "metadata-committed" || phase === "indexed") this.database.transaction(() => {
      this.database.prepare(`INSERT INTO curated_search_documents(id,source_type,source_id,title,body,updated_at)
        VALUES (?,'takeaway',?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET title=excluded.title,body=excluded.body,updated_at=excluded.updated_at`)
        .run(`curated:${payload.revisionId}`, payload.revisionId, payload.title,
          [payload.claim, payload.structured.evidenceRationale,
            payload.structured.epistemicStatus !== "evidence-backed" ? payload.claim : null,
            payload.structured.caveat].filter(Boolean).join("\n\n"), payload.now);
      this.database.prepare("UPDATE projection_state SET last_successful_at=?,updated_at=? WHERE projection='global-curated'")
        .run(payload.now, payload.now);
      this.database.prepare(`UPDATE index_outbox SET state='complete',completed_at=?
        WHERE projection='global-curated' AND source_id=? AND operation='upsert'`).run(payload.now, payload.revisionId);
      this.database.prepare("UPDATE knowledge_write_requests SET phase='complete',updated_at=? WHERE id=?")
        .run(this.ports.now().toISOString(), writeId);
    })();
  }
}

function escapeCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}
