import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import type { StorageLayout } from "./layout.js";
import { FrozenPdfSourceResolver } from "./frozen-pdf-source-resolver.js";
import type { StoredVisualRender, VisualEvidenceStore } from "./visual-evidence-store.js";

export const VISUAL_EVIDENCE_LIMITS = {
  pageLimit: 4,
  infrastructureFailureLimit: 3,
} as const;

type AttemptAuthority = {
  state: string;
  run_epoch: number;
  paper_version_id: string;
  page_count: number;
  artifact_id: string;
  content_hash: string;
  storage_ref: string;
  byte_size: number;
};

export class VisualEvidenceShim {
  constructor(private readonly input: { attemptId: string; runEpoch: number; layout: StorageLayout;
    database: Database.Database; store: VisualEvidenceStore }) {}

  async inspectPdfPage(request: { sourceId: string; page: number }): Promise<StoredVisualRender & {
    budget: { used: number; remaining: number; limit: number };
  }> {
    const authority = this.#authority(request.sourceId, request.page);
    const existing = this.#inspection(authority.artifact_id, request.page);
    const budget = this.budgetStatus();
    if (!existing && budget.used >= VISUAL_EVIDENCE_LIMITS.pageLimit) throw new Error("visual-page-budget-exhausted");
    if (!existing || existing.inspection_status !== "ready") {
      if (this.#failureCount() >= VISUAL_EVIDENCE_LIMITS.infrastructureFailureLimit) {
        throw new Error("visual-render-failure-budget-exhausted");
      }
    }
    const source = new FrozenPdfSourceResolver(this.input.layout).open({ artifactId: authority.artifact_id,
      contentHash: authority.content_hash, storageRef: authority.storage_ref, byteSize: authority.byte_size });
    let rendered: StoredVisualRender;
    try { rendered = await this.input.store.renderPage(source, request.page); }
    catch (error) {
      if (error instanceof Error && error.message === "visual-render-drift") throw error;
      this.#recordFailure(authority, request.page, error);
      throw new Error(`visual-render-failed:${error instanceof Error ? error.message : String(error)}`);
    }
    this.#recordSuccess(authority, request.page, rendered);
    return { ...rendered, budget: this.budgetStatus() };
  }

  budgetStatus(): { used: number; remaining: number; limit: number } {
    this.#activeAttempt();
    const used = this.input.database.prepare(`SELECT count(*) FROM visual_page_inspections
      WHERE job_run_id=? AND run_epoch=?`).pluck()
      .get(this.input.attemptId, this.input.runEpoch) as number;
    return { used, remaining: Math.max(0, VISUAL_EVIDENCE_LIMITS.pageLimit - used),
      limit: VISUAL_EVIDENCE_LIMITS.pageLimit };
  }

  #activeAttempt(): void {
    const active = this.input.database.prepare(`SELECT 1 FROM job_runs
      WHERE id=? AND state='running' AND run_epoch=? AND runner_kind='agentic_evidence'`)
      .get(this.input.attemptId, this.input.runEpoch);
    if (!active) throw new Error("visual-attempt-inactive-or-stale");
  }

  #authority(sourceId: string, page: number): AttemptAuthority {
    if (!sourceId || !Number.isInteger(page) || page < 1) throw new Error("visual-request-invalid");
    const row = this.input.database.prepare(`SELECT j.state,j.run_epoch,cs.paper_version_id,er.page_count,
      artifact.id artifact_id,artifact.content_hash,artifact.storage_ref,artifact.byte_size
      FROM job_runs j JOIN conversation_turn_attempts attempt ON attempt.job_run_id=j.id
      JOIN messages user_message ON user_message.id=attempt.user_message_id
      JOIN context_snapshots cs ON cs.id=user_message.context_snapshot_id
      JOIN paper_versions version ON version.id=cs.paper_version_id
      JOIN artifacts artifact ON artifact.id=version.pdf_artifact_id
      JOIN extraction_runs er ON er.id=cs.extraction_run_id AND er.paper_version_id=version.id
      WHERE j.id=?`).get(this.input.attemptId) as AttemptAuthority | undefined;
    if (!row || row.state !== "running" || row.run_epoch !== this.input.runEpoch) {
      throw new Error("visual-attempt-inactive-or-stale");
    }
    if (row.paper_version_id !== sourceId) throw new Error("visual-source-foreign");
    if (page > row.page_count) throw new Error("visual-page-out-of-bounds");
    return row;
  }

  #inspection(artifactId: string, page: number): { inspection_status: string } | undefined {
    return this.input.database.prepare(`SELECT inspection_status FROM visual_page_inspections
      WHERE job_run_id=? AND run_epoch=? AND source_artifact_id=? AND page_number=?`)
      .get(this.input.attemptId, this.input.runEpoch, artifactId, page) as { inspection_status: string } | undefined;
  }

  #failureCount(): number {
    return this.input.database.prepare(`SELECT COALESCE(sum(failure_count),0) FROM visual_page_inspections
      WHERE job_run_id=? AND run_epoch=?`).pluck().get(this.input.attemptId, this.input.runEpoch) as number;
  }

  #recordSuccess(authority: AttemptAuthority, page: number, rendered: StoredVisualRender): void {
    const now = new Date().toISOString();
    this.input.database.transaction(() => {
      this.#activeAttempt();
      const existing = this.#inspection(authority.artifact_id, page);
      const used = this.input.database.prepare(`SELECT count(*) FROM visual_page_inspections
        WHERE job_run_id=? AND run_epoch=?`).pluck()
        .get(this.input.attemptId, this.input.runEpoch) as number;
      if (!existing && used >= VISUAL_EVIDENCE_LIMITS.pageLimit) throw new Error("visual-page-budget-exhausted");
      this.input.database.prepare(`INSERT INTO visual_page_inspections
        (id,job_run_id,run_epoch,source_artifact_id,source_content_hash,page_number,render_artifact_id,
         inspection_status,failure_count,first_inspected_at,last_inspected_at)
        VALUES (?,?,?,?,?,?,?,'ready',0,?,?)
        ON CONFLICT(job_run_id,run_epoch,source_artifact_id,page_number) DO UPDATE SET
          render_artifact_id=excluded.render_artifact_id,inspection_status='ready',last_inspected_at=excluded.last_inspected_at`)
        .run(`visual-inspection:${randomUUID()}`, this.input.attemptId, this.input.runEpoch, authority.artifact_id,
          authority.content_hash, page, rendered.artifactId, now, now);
      this.input.database.prepare(`INSERT INTO agent_run_activities
        (job_run_id,run_epoch,event_type,display_text,metadata_json,created_at)
        VALUES (?,?,'visual-page-inspected',?,?,?)`)
        .run(this.input.attemptId, this.input.runEpoch, `已检查 PDF 第 ${page} 页`,
          JSON.stringify({ sourceId: authority.paper_version_id, page, imageHash: rendered.imageHash, reused: rendered.reused }), now);
    })();
  }

  #recordFailure(authority: AttemptAuthority, page: number, error: unknown): void {
    const now = new Date().toISOString();
    this.input.database.transaction(() => {
      this.#activeAttempt();
      this.input.database.prepare(`INSERT INTO visual_page_inspections
        (id,job_run_id,run_epoch,source_artifact_id,source_content_hash,page_number,render_artifact_id,
         inspection_status,failure_count,first_inspected_at,last_inspected_at)
        VALUES (?,?,?,?,?,?,NULL,'failed_infra',1,?,?)
        ON CONFLICT(job_run_id,run_epoch,source_artifact_id,page_number) DO UPDATE SET
          inspection_status='failed_infra',failure_count=failure_count+1,last_inspected_at=excluded.last_inspected_at`)
        .run(`visual-inspection:${randomUUID()}`, this.input.attemptId, this.input.runEpoch, authority.artifact_id,
          authority.content_hash, page, now, now);
      this.input.database.prepare(`INSERT INTO agent_run_activities
        (job_run_id,run_epoch,event_type,display_text,metadata_json,created_at)
        VALUES (?,?,'visual-page-failed',?,?,?)`)
        .run(this.input.attemptId, this.input.runEpoch, `PDF 第 ${page} 页检查失败`,
          JSON.stringify({ sourceId: authority.paper_version_id, page,
            code: error instanceof Error ? error.message.split(":", 1)[0] : "renderer-failed" }), now);
    })();
  }
}
