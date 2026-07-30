import { createHash, randomUUID } from "node:crypto";

import Database from "better-sqlite3";

import type { AgentActivity, AgenticEvidenceRunner, AgentUsage } from "../agent/agentic-evidence-runner.js";
import {
  getAgentConfiguration,
  type AgentExecutionMetadataProvider,
} from "../agent/agent-configuration.js";
import { AnswerGroundingGate } from "./answer-grounding-gate.js";
import { EvidenceWorkspaceBuilder } from "./evidence-workspace-builder.js";
import { FrozenPdfSourceResolver } from "./frozen-pdf-source-resolver.js";
import type { StorageLayout } from "./layout.js";
import { PDF_RENDERER_FINGERPRINT, PdfPageRenderer } from "./pdf-page-renderer.js";
import { VisualEvidenceStore } from "./visual-evidence-store.js";
import { enqueueAutomaticDistillation } from "./takeaway-distillation.js";

type CoordinatorOptions = { concurrency?: number; hardTimeoutMs?: number; now?: () => Date;
  automaticDistillation?: boolean; agentExecutionMetadata?: AgentExecutionMetadataProvider };

export class AgentRunCoordinator {
  readonly #database: Database.Database;
  readonly #workspaceBuilder: EvidenceWorkspaceBuilder;
  readonly #active = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  readonly #concurrency: number;
  readonly #hardTimeoutMs: number;
  readonly #now: () => Date;
  readonly #automaticDistillation: boolean;
  readonly #agentExecutionMetadata: AgentExecutionMetadataProvider | undefined;
  #closed = false;

  constructor(private readonly layout: StorageLayout, private readonly runner: AgenticEvidenceRunner, options: CoordinatorOptions = {}) {
    const configuration = getAgentConfiguration("agentic-evidence");
    this.#database = new Database(layout.databasePath);
    this.#database.pragma("foreign_keys = ON");
    this.#database.pragma("busy_timeout = 5000");
    this.#workspaceBuilder = EvidenceWorkspaceBuilder.open(layout);
    this.#concurrency = options.concurrency ?? configuration.execution.concurrency!;
    this.#hardTimeoutMs = options.hardTimeoutMs ?? configuration.execution.timeoutMs;
    this.#now = options.now ?? (() => new Date());
    this.#automaticDistillation = options.automaticDistillation ?? false;
    this.#agentExecutionMetadata = options.agentExecutionMetadata;
    queueMicrotask(() => this.#pump());
  }

  submit(conversationId: string, content: string, idempotencyKey: string): { jobRunId: string; userMessageId: string; replayed: boolean } {
    const now = this.#now().toISOString();
    const jobRunId = `job:${randomUUID()}`;
    const userMessageId = `message:${randomUUID()}`;
    const result = this.#database.transaction(() => {
      const replay = this.#database.prepare(`SELECT j.id,a.user_message_id FROM job_runs j
        JOIN conversation_turn_attempts a ON a.job_run_id=j.id WHERE j.idempotency_key=?`).get(idempotencyKey) as
        { id: string; user_message_id: string } | undefined;
      if (replay) return { jobRunId: replay.id, userMessageId: replay.user_message_id, replayed: true };
      const conversation = this.#database.prepare(`SELECT paper_id,active_context_snapshot_id,status,snapshot_integrity
        FROM conversations WHERE id=?`).get(conversationId) as { paper_id: string; active_context_snapshot_id: string;
          status: string; snapshot_integrity: string } | undefined;
      if (!conversation) throw new Error("conversation-not-found");
      if (conversation.status !== "active") throw new Error("conversation-archived");
      if (conversation.snapshot_integrity !== "frozen") throw new Error("conversation-legacy-read-only");
      const active = this.#database.prepare(`SELECT 1 FROM conversation_turn_attempts a JOIN job_runs j ON j.id=a.job_run_id
        WHERE a.conversation_id=? AND j.state IN ('queued','running','canceling') LIMIT 1`).get(conversationId);
      if (active) throw new Error("conversation-turn-active");
      const ordinal = (this.#database.prepare("SELECT COALESCE(MAX(ordinal),0)+1 next FROM messages WHERE conversation_id=?")
        .get(conversationId) as { next: number }).next;
      this.#database.prepare(`INSERT INTO messages
        (id,conversation_id,context_snapshot_id,role,content,citations_json,created_at,ordinal)
        VALUES (?,?,?,'user',?,'[]',?,?)`).run(userMessageId, conversationId, conversation.active_context_snapshot_id, content, now, ordinal);
      this.#database.prepare(`INSERT INTO job_runs
        (id,job_type,paper_id,state,progress,attempt,idempotency_key,input_json,queued_at,run_epoch,runner_kind)
        VALUES (?,'paper-chat',?,'queued',0,1,?,?,?,1,'agentic_evidence')`)
        .run(jobRunId, conversation.paper_id, idempotencyKey,
          JSON.stringify({ content, contextSnapshotId: conversation.active_context_snapshot_id }), now);
      this.#database.prepare(`INSERT INTO conversation_turn_attempts(job_run_id,conversation_id,user_message_id,attempt_no,created_at)
        VALUES (?,?,?,?,?)`).run(jobRunId, conversationId, userMessageId, 1, now);
      this.#database.prepare("INSERT INTO durable_events(scope,event_type,data_json,created_at) VALUES (?,'message-queued',?,?)")
        .run(conversationId, JSON.stringify({ jobRunId, userMessageId }), now);
      this.#database.prepare(`UPDATE conversations SET title=CASE WHEN title='新对话' THEN ? ELSE title END,updated_at=? WHERE id=?`)
        .run(content.trim().slice(0, 40), now, conversationId);
      return { jobRunId, userMessageId, replayed: false };
    })();
    queueMicrotask(() => this.#pump());
    return result;
  }

  readReceipt(id: string): unknown | null {
    const row = this.#database.prepare(`SELECT id,evidence_kind,source_id,source_revision,workspace_path,locator_json,
      content_hash,quote_text,verification_status,visual_observation,page_number,renderer_name,renderer_version,
      renderer_fingerprint,render_settings_json,render_artifact_id,image_content_hash,created_at FROM all_evidence_receipts WHERE id=?`).get(id) as
      { id: string; evidence_kind: string; source_id: string; source_revision: string | null; workspace_path: string;
        locator_json: string; content_hash: string; quote_text: string | null; verification_status: string;
        visual_observation: string | null; page_number: number | null; renderer_name: string | null;
        renderer_version: string | null; renderer_fingerprint: string | null; render_settings_json: string | null;
        render_artifact_id: string | null; image_content_hash: string | null; created_at: string } | undefined;
    if (!row) return null;
    let runtimeStatus = row.verification_status;
    if (row.evidence_kind === "visual") {
      const artifactState = this.#database.prepare("SELECT cache_state FROM visual_render_artifacts WHERE id=?")
        .pluck().get(row.render_artifact_id) as string | undefined;
      if (row.renderer_fingerprint !== PDF_RENDERER_FINGERPRINT) runtimeStatus = "renderer-unavailable";
      else if (artifactState === "render-drift") runtimeStatus = "render-drift";
    }
    return { id: row.id, evidenceKind: row.evidence_kind, sourceId: row.source_id, sourceRevision: row.source_revision,
      workspacePath: row.workspace_path, locator: JSON.parse(row.locator_json) as unknown, contentHash: row.content_hash,
      quote: row.quote_text, verificationStatus: runtimeStatus, visualObservation: row.visual_observation,
      page: row.page_number, rendererName: row.renderer_name, rendererVersion: row.renderer_version,
      rendererFingerprint: row.renderer_fingerprint,
      renderSettings: row.render_settings_json ? JSON.parse(row.render_settings_json) as unknown : null,
      imageHash: row.image_content_hash,
      imageUrl: row.evidence_kind === "visual" ? `/api/evidence/${encodeURIComponent(row.id)}/image` : null,
      createdAt: row.created_at };
  }

  async readReceiptImage(id: string): Promise<{ status: "verified"; imageBytes: Buffer } |
    { status: "renderer-unavailable" | "render-drift" } | null> {
    const row = this.#database.prepare(`SELECT receipt.source_artifact_id,receipt.source_content_hash,receipt.page_number,
      receipt.render_artifact_id,receipt.renderer_fingerprint,receipt.render_settings_json,receipt.image_content_hash,
      source.storage_ref,source.byte_size
      FROM visual_evidence_receipts receipt JOIN artifacts source ON source.id=receipt.source_artifact_id
      WHERE receipt.id=?`).get(id) as { source_artifact_id: string; source_content_hash: string; page_number: number;
        render_artifact_id: string; renderer_fingerprint: string; render_settings_json: string; image_content_hash: string;
        storage_ref: string; byte_size: number } | undefined;
    if (!row) return null;
    const source = new FrozenPdfSourceResolver(this.layout).open({ artifactId: row.source_artifact_id,
      contentHash: row.source_content_hash, storageRef: row.storage_ref, byteSize: row.byte_size });
    return new VisualEvidenceStore(this.layout, this.#database, new PdfPageRenderer()).recoverReceiptImage({ source,
      page: row.page_number, renderArtifactId: row.render_artifact_id, rendererFingerprint: row.renderer_fingerprint,
      renderSettings: JSON.parse(row.render_settings_json) as Record<string, unknown>, imageHash: row.image_content_hash });
  }

  cancel(jobRunId: string): boolean {
    const now = this.#now().toISOString();
    const canceled = this.#database.transaction(() => {
      const row = this.#database.prepare(`SELECT state,run_epoch FROM job_runs
        WHERE id=? AND runner_kind='agentic_evidence'`).get(jobRunId) as { state: string; run_epoch: number } | undefined;
      if (!row || !["queued", "running"].includes(row.state)) return false;
      const nextEpoch = row.run_epoch + 1;
      const changed = this.#database.prepare(`UPDATE job_runs SET state='canceled',progress=1,cancel_requested_at=?,
        run_epoch=?,completed_at=?,heartbeat_at=?,lease_owner=NULL,lease_expires_at=NULL
        WHERE id=? AND state=? AND run_epoch=?`).run(now, nextEpoch, now, now, jobRunId, row.state, row.run_epoch).changes;
      if (!changed) return false;
      this.#database.prepare(`INSERT INTO agent_run_usage(job_run_id,run_epoch,status,elapsed_ms,recorded_at)
        VALUES (?,?,'unavailable',0,?)`).run(jobRunId, nextEpoch, now);
      const scope = (this.#database.prepare("SELECT conversation_id FROM conversation_turn_attempts WHERE job_run_id=?")
        .get(jobRunId) as { conversation_id: string }).conversation_id;
      this.#database.prepare("INSERT INTO durable_events(scope,event_type,data_json,created_at) VALUES (?,'message-canceled',?,?)")
        .run(scope, JSON.stringify({ jobRunId }), now);
      return true;
    })();
    if (canceled) this.#active.get(jobRunId)?.controller.abort(new Error("agent-canceled"));
    return canceled;
  }

  ownsMessage(messageId: string): boolean {
    return Boolean(this.#database.prepare(`SELECT 1 FROM conversation_turn_attempts a JOIN job_runs j ON j.id=a.job_run_id
      WHERE a.user_message_id=? AND j.runner_kind='agentic_evidence' LIMIT 1`).get(messageId));
  }

  retry(messageId: string, idempotencyKey: string): { jobRunId: string; userMessageId: string; replayed: boolean } {
    const now = this.#now().toISOString();
    const result = this.#database.transaction(() => {
      const replay = this.#database.prepare(`SELECT j.id,a.user_message_id FROM job_runs j JOIN conversation_turn_attempts a ON a.job_run_id=j.id
        WHERE j.idempotency_key=?`).get(idempotencyKey) as { id: string; user_message_id: string } | undefined;
      if (replay) return { jobRunId: replay.id, userMessageId: replay.user_message_id, replayed: true };
      const message = this.#database.prepare(`SELECT m.conversation_id,m.content,c.paper_id,m.context_snapshot_id
        FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.id=? AND m.role='user'`).get(messageId) as
        { conversation_id: string; content: string; paper_id: string; context_snapshot_id: string } | undefined;
      if (!message) throw new Error("message-not-found");
      const latest = this.#database.prepare(`SELECT j.state,j.evidence_workspace_id FROM conversation_turn_attempts a
        JOIN job_runs j ON j.id=a.job_run_id WHERE a.user_message_id=? AND j.runner_kind='agentic_evidence'
        ORDER BY a.attempt_no DESC LIMIT 1`).get(messageId) as { state: string; evidence_workspace_id: string | null } | undefined;
      if (!latest || !["failed", "timed_out", "canceled", "interrupted"].includes(latest.state) ||
          this.#database.prepare("SELECT 1 FROM messages WHERE in_reply_to_message_id=?").get(messageId)) {
        throw new Error("message-not-retryable");
      }
      const active = this.#database.prepare(`SELECT 1 FROM conversation_turn_attempts a JOIN job_runs j ON j.id=a.job_run_id
        WHERE a.conversation_id=? AND j.state IN ('queued','running','canceling')`).get(message.conversation_id);
      if (active) throw new Error("conversation-turn-active");
      const attemptNo = (this.#database.prepare("SELECT COALESCE(MAX(attempt_no),0)+1 next FROM conversation_turn_attempts WHERE user_message_id=?")
        .get(messageId) as { next: number }).next;
      const jobRunId = `job:${randomUUID()}`;
      this.#database.prepare(`INSERT INTO job_runs
        (id,job_type,paper_id,state,progress,attempt,idempotency_key,input_json,queued_at,run_epoch,runner_kind,evidence_workspace_id)
        VALUES (?,'paper-chat',?,'queued',0,?,?,?, ?,1,'agentic_evidence',?)`)
        .run(jobRunId, message.paper_id, attemptNo, idempotencyKey,
          JSON.stringify({ content: message.content, contextSnapshotId: message.context_snapshot_id }), now, latest.evidence_workspace_id);
      this.#database.prepare(`INSERT INTO conversation_turn_attempts(job_run_id,conversation_id,user_message_id,attempt_no,created_at)
        VALUES (?,?,?,?,?)`).run(jobRunId, message.conversation_id, messageId, attemptNo, now);
      this.#database.prepare("INSERT INTO durable_events(scope,event_type,data_json,created_at) VALUES (?,'message-queued',?,?)")
        .run(message.conversation_id, JSON.stringify({ jobRunId, userMessageId: messageId, retry: true }), now);
      return { jobRunId, userMessageId: messageId, replayed: false };
    })();
    queueMicrotask(() => this.#pump());
    return result;
  }

  async close(): Promise<void> {
    this.#closed = true;
    const now = this.#now().toISOString();
    for (const [jobRunId, active] of this.#active) {
      this.#database.prepare(`UPDATE job_runs SET state='interrupted',failure_kind='process_interrupted',progress=1,
        error_json='{"code":"application-closing"}',completed_at=?,heartbeat_at=?,run_epoch=run_epoch+1,
        lease_owner=NULL,lease_expires_at=NULL WHERE id=? AND state='running'`).run(now, now, jobRunId);
      active.controller.abort(new Error("application-closing"));
    }
    await Promise.allSettled([...this.#active.values()].map((active) => active.promise));
    this.#workspaceBuilder.close();
    this.#database.close();
  }

  #pump(): void {
    if (this.#closed) return;
    while (this.#active.size < this.#concurrency) {
      const queued = this.#database.prepare(`SELECT j.id,j.run_epoch,j.input_json,a.conversation_id,a.user_message_id
        FROM job_runs j JOIN conversation_turn_attempts a ON a.job_run_id=j.id
        WHERE j.job_type='paper-chat' AND j.runner_kind='agentic_evidence' AND j.state='queued'
        ORDER BY j.queued_at,j.id LIMIT 1`).get() as { id: string; run_epoch: number; input_json: string;
          conversation_id: string; user_message_id: string } | undefined;
      if (!queued) return;
      const now = this.#now();
      const leaseOwner = `coordinator:${process.pid}:${randomUUID()}`;
      const changed = this.#database.prepare(`UPDATE job_runs SET state='running',progress=.05,started_at=?,heartbeat_at=?,
        lease_owner=?,lease_expires_at=? WHERE id=? AND state='queued' AND run_epoch=?`).run(now.toISOString(), now.toISOString(), leaseOwner,
          new Date(now.getTime() + 30_000).toISOString(), queued.id, queued.run_epoch).changes;
      if (!changed) continue;
      const controller = new AbortController();
      const promise = this.#run(queued, controller).finally(() => {
        this.#active.delete(queued.id);
        this.#pump();
      });
      this.#active.set(queued.id, { controller, promise });
    }
  }

  async #run(attempt: { id: string; run_epoch: number; input_json: string; conversation_id: string; user_message_id: string },
    controller: AbortController): Promise<void> {
    const input = JSON.parse(attempt.input_json) as { content: string; contextSnapshotId: string };
    const started = this.#now().getTime();
    const timer = setTimeout(() => controller.abort(new Error("agent-hard-timeout")), this.#hardTimeoutMs);
    const heartbeat = setInterval(() => this.#heartbeat(attempt.id, attempt.run_epoch), 5_000);
    const convergence = setTimeout(() => this.#activity(attempt.id, attempt.run_epoch,
      { type: "budget", text: "已进入 150 秒收敛窗口，正在整理可验证的最终结果" }), 150_000);
    try {
      const workspace = this.#workspaceBuilder.ensure(input.contextSnapshotId);
      const bound = this.#database.prepare(`UPDATE job_runs SET evidence_workspace_id=?,heartbeat_at=?
        WHERE id=? AND state='running' AND run_epoch=?`).run(workspace.id, this.#now().toISOString(), attempt.id, attempt.run_epoch).changes;
      if (!bound) return;
      const result = await this.runner.run({ attemptId: attempt.id, runEpoch: attempt.run_epoch,
        workspaceRoot: workspace.root, question: input.content, signal: controller.signal,
        onActivity: (activity) => this.#activity(attempt.id, attempt.run_epoch, activity) });
      this.#assertVisualInfraHealthy(attempt.id, attempt.run_epoch);
      if (!result.answer) throw new Error("codex-output-invalid");
      const gate = AnswerGroundingGate.open(workspace.root, this.#database, input.contextSnapshotId,
        { attemptId: attempt.id, runEpoch: attempt.run_epoch, layout: this.layout });
      let receipts: ReturnType<AnswerGroundingGate["verify"]>;
      try { receipts = gate.verify(result.citations); }
      catch { receipts = gate.repair(result.citations); }
      if (result.groundingStatus === "answered" && receipts.length === 0) throw new Error("grounding-required");
      this.#commitSuccess(attempt, result.answer, result.groundingStatus, receipts, result.usage,
        this.#now().getTime() - started);
    } catch (error) {
      const timedOut = controller.signal.aborted && controller.signal.reason instanceof Error &&
        controller.signal.reason.message === "agent-hard-timeout";
      this.#commitFailure(attempt, timedOut ? "timed_out" : "failed", error);
    } finally { clearTimeout(timer); clearTimeout(convergence); clearInterval(heartbeat); }
  }

  #assertVisualInfraHealthy(jobRunId: string, epoch: number): void {
    const unhealthy = this.#database.prepare(`SELECT 1 FROM visual_page_inspections inspection
      LEFT JOIN visual_render_artifacts artifact ON artifact.id=inspection.render_artifact_id
      WHERE inspection.job_run_id=? AND inspection.run_epoch=?
        AND (inspection.inspection_status='failed_infra' OR artifact.cache_state='render-drift') LIMIT 1`)
      .get(jobRunId, epoch);
    if (unhealthy) throw new Error("visual-render-inspection-failed");
  }

  #heartbeat(jobRunId: string, epoch: number): void {
    const now = this.#now();
    this.#database.prepare(`UPDATE job_runs SET heartbeat_at=?,lease_expires_at=?
      WHERE id=? AND state='running' AND run_epoch=?`).run(now.toISOString(), new Date(now.getTime() + 30_000).toISOString(), jobRunId, epoch);
  }

  #activity(jobRunId: string, epoch: number, activity: AgentActivity): void {
    if (!activity.type || !activity.text) return;
    this.#database.prepare(`INSERT INTO agent_run_activities(job_run_id,run_epoch,event_type,display_text,metadata_json,created_at)
      SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM job_runs WHERE id=? AND state='running' AND run_epoch=?)`)
      .run(jobRunId, epoch, activity.type, activity.text.slice(0, 500), JSON.stringify(activity.metadata ?? {}),
        this.#now().toISOString(), jobRunId, epoch);
    this.#heartbeat(jobRunId, epoch);
  }

  #commitSuccess(attempt: { id: string; run_epoch: number; conversation_id: string; user_message_id: string }, answer: string,
    groundingStatus: string, receipts: ReturnType<AnswerGroundingGate["verify"]>, usage: AgentUsage, elapsedMs: number): void {
    const now = this.#now().toISOString();
    const assistantId = `message:${randomUUID()}`;
    const receiptIds = receipts.map(() => `evidence-receipt:${randomUUID()}`);
    this.#database.transaction(() => {
      const active = this.#database.prepare("SELECT 1 FROM job_runs WHERE id=? AND state='running' AND run_epoch=?")
        .get(attempt.id, attempt.run_epoch);
      if (!active) return;
      const snapshotId = (this.#database.prepare("SELECT context_snapshot_id FROM messages WHERE id=?").get(attempt.user_message_id) as
        { context_snapshot_id: string }).context_snapshot_id;
      const ordinal = (this.#database.prepare("SELECT COALESCE(MAX(ordinal),0)+1 next FROM messages WHERE conversation_id=?")
        .get(attempt.conversation_id) as { next: number }).next;
      this.#database.prepare(`INSERT INTO messages
        (id,conversation_id,context_snapshot_id,role,content,citations_json,created_at,ordinal,in_reply_to_message_id,grounding_status)
        VALUES (?,?,?,'assistant',?,'[]',?,?,?,?)`).run(assistantId, attempt.conversation_id, snapshotId, answer, now, ordinal,
          attempt.user_message_id, groundingStatus);
      receipts.forEach((receipt, index) => {
        if (receipt.evidenceKind === "visual") {
          this.#database.prepare(`INSERT INTO visual_evidence_receipts
            (id,job_run_id,run_epoch,message_id,ordinal,source_id,source_revision,source_artifact_id,source_content_hash,
             page_number,renderer_name,renderer_version,renderer_fingerprint,render_settings_json,render_artifact_id,
             image_content_hash,visual_observation,verification_status,created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'verified',?)`).run(receiptIds[index], attempt.id, attempt.run_epoch,
              assistantId, index + 1, receipt.sourceId, receipt.sourceRevision, receipt.sourceArtifactId,
              receipt.sourceContentHash, receipt.page, receipt.rendererName, receipt.rendererVersion,
              receipt.rendererFingerprint, JSON.stringify(receipt.renderSettings), receipt.renderArtifactId,
              receipt.imageHash, receipt.observation, now);
        } else {
          this.#database.prepare(`INSERT INTO evidence_receipts
            (id,job_run_id,run_epoch,message_id,ordinal,evidence_kind,source_id,source_revision,workspace_path,locator_json,
              content_hash,quote_text,verification_status,created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'verified',?)`).run(receiptIds[index], attempt.id, attempt.run_epoch,
              assistantId, index + 1, receipt.evidenceKind, receipt.sourceId, receipt.sourceRevision, receipt.workspacePath,
              JSON.stringify(receipt.locator), receipt.contentHash, receipt.quote, now);
        }
      });
      if (this.#automaticDistillation) enqueueAutomaticDistillation(this.#database, assistantId, this.#now());
      const execution = this.#agentExecutionMetadata?.("agentic-evidence") ?? null;
      this.#database.prepare(`INSERT INTO agent_runs(job_run_id,task_kind,model,reasoning_effort,codex_version,
        configuration_version,context_snapshot_id,output_schema_hash,prompt_hash,output_json)
        VALUES (?,'paper-chat',?,?,?,?,?,?,?,?)`)
        .run(attempt.id, execution?.model ?? null, execution?.reasoningEffort ?? null,
          execution?.codexVersion ?? "unknown", execution?.configurationVersion ?? null, snapshotId,
          createHash("sha256").update("agentic-evidence-result:v1").digest("hex"),
          createHash("sha256").update(attempt.user_message_id).digest("hex"), JSON.stringify({ answer, groundingStatus }));
      this.#insertUsage(attempt.id, attempt.run_epoch, usage, elapsedMs, now);
      const changed = this.#database.prepare(`UPDATE job_runs SET state='succeeded',progress=1,output_json=?,completed_at=?,heartbeat_at=?,
        lease_owner=NULL,lease_expires_at=NULL WHERE id=? AND state='running' AND run_epoch=?`)
        .run(JSON.stringify({ groundingStatus, receiptCount: receipts.length }), now, now, attempt.id, attempt.run_epoch).changes;
      if (!changed) throw new Error("attempt-epoch-lost");
      this.#database.prepare("UPDATE conversations SET updated_at=? WHERE id=?").run(now, attempt.conversation_id);
      this.#database.prepare("INSERT INTO durable_events(scope,event_type,data_json,created_at) VALUES (?,'message-complete',?,?)")
        .run(attempt.conversation_id, JSON.stringify({ jobRunId: attempt.id, messageId: assistantId }), now);
    })();
  }

  #insertUsage(jobRunId: string, epoch: number, usage: AgentUsage, elapsedMs: number, now: string): void {
    this.#database.prepare(`INSERT INTO agent_run_usage(job_run_id,run_epoch,status,input_tokens,cached_input_tokens,
      output_tokens,total_tokens,elapsed_ms,recorded_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(jobRunId, epoch, usage.status, usage.inputTokens ?? null, usage.cachedInputTokens ?? null,
        usage.outputTokens ?? null, usage.totalTokens ?? null, elapsedMs, now);
  }

  #commitFailure(attempt: { id: string; run_epoch: number; conversation_id: string; user_message_id: string }, state: string,
    error: unknown): void {
    const now = this.#now().toISOString();
    this.#database.transaction(() => {
      const detail = error instanceof Error ? error.message : String(error);
      const infraFailure = ["evidence-workspace-", "visual-render-", "renderer-", "visual-source-drift",
        "agentic-codex-failed", "discussion-capability-"].some((prefix) => detail.startsWith(prefix));
      const failureKind = infraFailure ? "failed_infra" : state === "timed_out" ? "timed_out" : "runner_failed";
      const changed = this.#database.prepare(`UPDATE job_runs SET state=?,progress=1,error_json=?,failure_kind=?,completed_at=?,heartbeat_at=?,
        lease_owner=NULL,lease_expires_at=NULL WHERE id=? AND state='running' AND run_epoch=?`)
        .run(state, JSON.stringify({ code: detail }), failureKind, now, now, attempt.id, attempt.run_epoch).changes;
      if (changed) {
        this.#database.prepare(`INSERT OR IGNORE INTO agent_run_usage(job_run_id,run_epoch,status,elapsed_ms,recorded_at)
          VALUES (?,?,'unavailable',0,?)`).run(attempt.id, attempt.run_epoch, now);
        this.#database.prepare("INSERT INTO durable_events(scope,event_type,data_json,created_at) VALUES (?,'message-failed',?,?)")
          .run(attempt.conversation_id, JSON.stringify({ jobRunId: attempt.id, userMessageId: attempt.user_message_id, state }), now);
      }
    })();
  }
}
