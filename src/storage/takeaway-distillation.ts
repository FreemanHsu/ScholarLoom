import { createHash, randomUUID } from "node:crypto";

import Database from "better-sqlite3";

import {
  ABSTENTION_REASONS,
  deriveTakeawayTitle,
  EPISTEMIC_STATUSES,
  TAKEAWAY_CONTRACT_VERSION,
  TAKEAWAY_KINDS,
  type DistillationSelection,
  type FrozenDistillationContext,
  type TakeawayCandidateV2,
  type TakeawaySelectionRunner,
} from "../agent/takeaway-distillation.js";
import {
  getAgentConfiguration,
  type AgentExecutionMetadataProvider,
} from "../agent/agent-configuration.js";
import type { StorageLayout } from "./layout.js";

type Trigger = "automatic" | "explicit-save";
type DistillationOptions = { concurrency?: number; hardTimeoutMs?: number; now?: () => Date;
  agentExecutionMetadata?: AgentExecutionMetadataProvider };

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const stableJson = (value: unknown) => JSON.stringify(value);

export function enqueueAutomaticDistillation(database: Database.Database, assistantMessageId: string, now: Date): string | null {
  return enqueueDistillation(database, { assistantMessageId, trigger: "automatic", focus: null, now });
}

function enqueueDistillation(database: Database.Database, input: {
  assistantMessageId: string;
  trigger: Trigger;
  focus: string | null;
  now: Date;
  idempotencyKey?: string;
}): string | null {
  const eligible = database.prepare(`SELECT m.id,m.content,m.grounding_status,m.in_reply_to_message_id,
    m.context_snapshot_id,c.paper_id,c.snapshot_integrity,cs.paper_version_id,cs.summary_revision_id
    FROM messages m JOIN conversations c ON c.id=m.conversation_id
    JOIN context_snapshots cs ON cs.id=m.context_snapshot_id
    WHERE m.id=? AND m.role='assistant'`).get(input.assistantMessageId) as {
      id: string; content: string; grounding_status: string | null; in_reply_to_message_id: string;
      context_snapshot_id: string; paper_id: string; snapshot_integrity: string; paper_version_id: string;
      summary_revision_id: string | null;
    } | undefined;
  if (!eligible || eligible.snapshot_integrity !== "frozen" ||
      !["answered", "partially_answered"].includes(eligible.grounding_status ?? "")) return null;
  const receipts = database.prepare(`SELECT id,evidence_kind,source_id,source_revision,content_hash,locator_json
    FROM all_evidence_receipts WHERE message_id=? AND verification_status='verified' ORDER BY ordinal,id`)
    .all(input.assistantMessageId) as Array<{ id: string; evidence_kind: string; source_id: string;
      source_revision: string | null; content_hash: string; locator_json: string }>;
  if (receipts.length === 0) return null;
  const user = database.prepare("SELECT content FROM messages WHERE id=? AND role='user'")
    .get(eligible.in_reply_to_message_id) as { content: string } | undefined;
  if (!user) return null;
  const summary = eligible.summary_revision_id ? database.prepare("SELECT markdown_hash FROM summary_revisions WHERE id=?")
    .get(eligible.summary_revision_id) as { markdown_hash: string } | undefined : undefined;
  const confirmed = database.prepare(`SELECT tr.id,tr.markdown_hash FROM takeaways t
    JOIN takeaway_revisions tr ON tr.id=t.active_revision_id
    WHERE t.paper_id=? AND tr.review_status='confirmed' ORDER BY tr.id`).all(eligible.paper_id) as
    Array<{ id: string; markdown_hash: string }>;
  const focus = input.focus?.trim().slice(0, 500) || null;
  const focusHash = focus ? sha256(focus) : "";
  const contractHash = sha256(stableJson({ contractVersion: TAKEAWAY_CONTRACT_VERSION, kinds: TAKEAWAY_KINDS,
    epistemicStatuses: EPISTEMIC_STATUSES, abstentionReasons: ABSTENTION_REASONS }));
  const promptHash = sha256("takeaway-selection-prompt:v2:abstention-first:single-candidate:no-critic:no-semantic-prefilter");
  const manifest: FrozenDistillationContext = {
    contractVersion: TAKEAWAY_CONTRACT_VERSION,
    paper: { id: eligible.paper_id, versionId: eligible.paper_version_id },
    source: { userMessageId: eligible.in_reply_to_message_id, userMessageHash: sha256(user.content),
      assistantMessageId: eligible.id, assistantMessageHash: sha256(eligible.content) },
    receipts: receipts.map((receipt) => ({ id: receipt.id, evidenceKind: receipt.evidence_kind,
      sourceId: receipt.source_id, sourceRevision: receipt.source_revision, contentHash: receipt.content_hash,
      locatorHash: sha256(receipt.locator_json) })),
    summary: eligible.summary_revision_id && summary
      ? { revisionId: eligible.summary_revision_id, contentHash: summary.markdown_hash } : null,
    confirmedTakeaways: confirmed.map((item) => ({ revisionId: item.id, contentHash: item.markdown_hash })),
    trigger: input.trigger,
    focus,
    focusHash,
    contractHash,
    promptHash,
  };
  const manifestJson = stableJson(manifest);
  const manifestHash = sha256(manifestJson);
  const existing = database.prepare(`SELECT job_run_id FROM takeaway_distillation_runs
    WHERE assistant_message_id=? AND contract_version=? AND trigger=? AND focus_hash=?`)
    .pluck().get(input.assistantMessageId, TAKEAWAY_CONTRACT_VERSION, input.trigger, focusHash) as string | undefined;
  if (existing) return existing;
  const timestamp = input.now.toISOString();
  const manifestId = `distillation-manifest:${manifestHash}`;
  const jobRunId = `job:${randomUUID()}`;
  database.prepare(`INSERT OR IGNORE INTO takeaway_distillation_manifests(id,manifest_hash,manifest_json,created_at)
    VALUES (?,?,?,?)`).run(manifestId, manifestHash, manifestJson, timestamp);
  database.prepare(`INSERT INTO job_runs
    (id,job_type,paper_id,state,progress,attempt,idempotency_key,input_json,queued_at,run_epoch)
    VALUES (?,'takeaway-distillation',?,'queued',0,1,?,?,?,1)`).run(jobRunId, eligible.paper_id,
      input.idempotencyKey ?? `takeaway-distillation:${input.assistantMessageId}:${TAKEAWAY_CONTRACT_VERSION}:${input.trigger}:${focusHash}`,
      stableJson({ manifestId, assistantMessageId: input.assistantMessageId, trigger: input.trigger, focusHash }), timestamp);
  database.prepare(`INSERT INTO takeaway_distillation_runs
    (job_run_id,assistant_message_id,manifest_id,contract_version,trigger,focus_hash,created_at)
    VALUES (?,?,?,?,?,?,?)`).run(jobRunId, input.assistantMessageId, manifestId, TAKEAWAY_CONTRACT_VERSION,
      input.trigger, focusHash, timestamp);
  return jobRunId;
}

export class TakeawayDistillationCoordinator {
  readonly #database: Database.Database;
  readonly #active = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  readonly #concurrency: number;
  readonly #hardTimeoutMs: number;
  readonly #now: () => Date;
  readonly #poll: ReturnType<typeof setInterval>;
  readonly #agentExecutionMetadata: AgentExecutionMetadataProvider | undefined;
  #closed = false;

  constructor(layout: StorageLayout, private readonly runner: TakeawaySelectionRunner, options: DistillationOptions = {}) {
    const configuration = getAgentConfiguration("takeaway-distillation");
    this.#database = new Database(layout.databasePath);
    this.#database.pragma("foreign_keys = ON");
    this.#database.pragma("busy_timeout = 5000");
    this.#concurrency = options.concurrency ?? configuration.execution.concurrency!;
    this.#hardTimeoutMs = options.hardTimeoutMs ?? configuration.execution.timeoutMs;
    this.#now = options.now ?? (() => new Date());
    this.#agentExecutionMetadata = options.agentExecutionMetadata;
    this.#poll = setInterval(() => this.#pump(), 100);
    this.#poll.unref();
    queueMicrotask(() => this.#pump());
  }

  request(input: { assistantMessageId: string; idempotencyKey: string; trigger: Trigger; focus?: string }): {
    jobRunId: string; replayed: boolean;
  } {
    const replay = this.#database.prepare("SELECT id FROM job_runs WHERE idempotency_key=?").pluck()
      .get(input.idempotencyKey) as string | undefined;
    if (replay) return { jobRunId: replay, replayed: true };
    const jobRunId = this.#database.transaction(() => enqueueDistillation(this.#database, {
      assistantMessageId: input.assistantMessageId,
      trigger: input.trigger,
      focus: input.focus ?? null,
      idempotencyKey: input.idempotencyKey,
      now: this.#now(),
    }))();
    if (!jobRunId) throw new Error("takeaway-distillation-ineligible");
    queueMicrotask(() => this.#pump());
    return { jobRunId, replayed: false };
  }

  retry(jobRunId: string, idempotencyKey: string): { jobRunId: string; replayed: boolean } {
    const replay = this.#database.prepare("SELECT id FROM job_runs WHERE idempotency_key=?").pluck()
      .get(idempotencyKey) as string | undefined;
    if (replay) return { jobRunId: replay, replayed: true };
    const row = this.#database.prepare(`SELECT j.state,j.paper_id,j.attempt,d.assistant_message_id,d.manifest_id,
      d.contract_version,d.trigger,d.focus_hash FROM job_runs j JOIN takeaway_distillation_runs d ON d.job_run_id=j.id
      WHERE j.id=?`).get(jobRunId) as { state: string; paper_id: string; attempt: number; assistant_message_id: string;
        manifest_id: string; contract_version: string; trigger: Trigger; focus_hash: string } | undefined;
    if (!row || !["failed", "timed_out", "interrupted"].includes(row.state)) throw new Error("distillation-not-retryable");
    const nextId = `job:${randomUUID()}`;
    const now = this.#now().toISOString();
    this.#database.transaction(() => {
      this.#database.prepare(`INSERT INTO job_runs
        (id,job_type,parent_job_id,paper_id,state,progress,attempt,idempotency_key,input_json,queued_at,run_epoch)
        VALUES (?,'takeaway-distillation',?,?,'queued',0,?,?,?, ?,1)`).run(nextId, jobRunId, row.paper_id,
          row.attempt + 1, idempotencyKey, stableJson({ manifestId: row.manifest_id,
            assistantMessageId: row.assistant_message_id, trigger: row.trigger, focusHash: row.focus_hash }), now);
      this.#database.prepare(`INSERT INTO takeaway_distillation_runs
        (job_run_id,assistant_message_id,manifest_id,contract_version,trigger,focus_hash,created_at)
        VALUES (?,?,?,?,?,?,?)`).run(nextId, row.assistant_message_id, row.manifest_id, row.contract_version,
          row.trigger, row.focus_hash, now);
    })();
    queueMicrotask(() => this.#pump());
    return { jobRunId: nextId, replayed: false };
  }

  readForMessage(assistantMessageId: string): unknown[] {
    return (this.#database.prepare(`SELECT j.id,j.state,j.error_json,j.started_at,j.completed_at,d.contract_version,
      d.trigger,d.outcome_kind,d.reason_code,d.proposal_id,m.manifest_json,u.status usage_status,u.input_tokens,
      u.output_tokens,u.total_tokens,u.elapsed_ms
      FROM takeaway_distillation_runs d JOIN job_runs j ON j.id=d.job_run_id
      JOIN takeaway_distillation_manifests m ON m.id=d.manifest_id
      LEFT JOIN agent_run_usage u ON u.job_run_id=j.id AND u.run_epoch=j.run_epoch
      WHERE d.assistant_message_id=? ORDER BY d.created_at,d.job_run_id`).all(assistantMessageId) as Array<{
        id: string; state: string; error_json: string | null; started_at: string | null; completed_at: string | null;
        contract_version: string; trigger: Trigger; outcome_kind: string | null; reason_code: string | null;
        proposal_id: string | null; manifest_json: string; usage_status: string | null; input_tokens: number | null;
        output_tokens: number | null; total_tokens: number | null; elapsed_ms: number | null;
      }>).map((row) => {
        const manifest = JSON.parse(row.manifest_json) as FrozenDistillationContext;
        return { id: row.id, state: row.state, contractVersion: row.contract_version, trigger: row.trigger,
          focus: manifest.focus, outcome: row.outcome_kind, reasonCode: row.reason_code, proposalId: row.proposal_id,
          error: row.error_json ? JSON.parse(row.error_json) as unknown : null,
          startedAt: row.started_at, completedAt: row.completed_at,
          usage: row.usage_status ? { status: row.usage_status, inputTokens: row.input_tokens,
            outputTokens: row.output_tokens, totalTokens: row.total_tokens, elapsedMs: row.elapsed_ms } : null };
      });
  }

  metrics(): unknown {
    const eligibleGroundedTurns = (this.#database.prepare(`SELECT count(*) count FROM messages m
      JOIN conversations c ON c.id=m.conversation_id WHERE m.role='assistant'
      AND m.grounding_status IN ('answered','partially_answered') AND c.snapshot_integrity='frozen'
      AND EXISTS (SELECT 1 FROM all_evidence_receipts receipt WHERE receipt.message_id=m.id
        AND receipt.verification_status='verified')`).get() as { count: number }).count;
    const outcomes = this.#database.prepare(`SELECT COALESCE(d.outcome_kind,j.state) outcome,
      d.reason_code reason,count(*) count FROM takeaway_distillation_runs d JOIN job_runs j ON j.id=d.job_run_id
      GROUP BY outcome,reason ORDER BY outcome,reason`).all();
    const review = this.#database.prepare(`SELECT COALESCE(rd.action,p.review_status) action,
      json_extract(rd.result_json,'$.reviewDecision.reason') reason,count(*) count FROM proposals p
      JOIN takeaway_distillation_runs d ON d.proposal_id=p.id
      LEFT JOIN review_decisions rd ON rd.proposal_id=p.id GROUP BY action,reason ORDER BY action,reason`).all();
    const timing = this.#database.prepare(`SELECT count(*) runs,round(avg(u.elapsed_ms)) average_elapsed_ms,
      sum(CASE WHEN u.status='unavailable' THEN 1 ELSE 0 END) usage_unavailable
      FROM takeaway_distillation_runs d JOIN agent_run_usage u ON u.job_run_id=d.job_run_id`).get();
    const qualityBase = this.#database.prepare(`SELECT
      sum(CASE WHEN json_array_length(json_extract(p.payload_json,'$.duplicateHints'))>0 THEN 1 ELSE 0 END) frozen_duplicate_warnings,
      sum(CASE WHEN rr.duplicate_acknowledged=1 THEN 1 ELSE 0 END) duplicate_acknowledgements,
      sum(CASE WHEN rr.evidence_review_required=1 THEN 1 ELSE 0 END) evidence_sensitive_edits,
      sum(CASE WHEN rr.live_duplicate_warning=1 THEN 1 ELSE 0 END) live_duplicate_warnings
      FROM proposals p JOIN takeaway_distillation_runs d ON d.proposal_id=p.id
      LEFT JOIN takeaway_review_requirements rr ON rr.proposal_id=p.id`).get();
    const acceptedReceiptCoverage = (this.#database.prepare(`SELECT round(avg(
      1.0 * json_array_length(json_extract(tr.structured_json,'$.receiptIds')) /
      nullif((SELECT count(*) FROM all_evidence_receipts er
        WHERE er.message_id=tr.source_message_id AND er.verification_status='verified'),0)),3) value
      FROM takeaway_revisions tr WHERE tr.review_status='confirmed'
      AND tr.contract_version=?`).get(TAKEAWAY_CONTRACT_VERSION) as { value: number | null }).value;
    const duplicateRejections = (this.#database.prepare(`SELECT count(*) count FROM review_decisions
      WHERE action='reject' AND json_extract(result_json,'$.reviewDecision.reason')='duplicate'`).get() as
      { count: number }).count;
    const warnedDuplicateRejections = (this.#database.prepare(`SELECT count(*) count FROM review_decisions rd
      JOIN takeaway_review_requirements rr ON rr.proposal_id=rd.proposal_id
      WHERE rr.live_duplicate_warning=1 AND rd.action='reject'
      AND json_extract(rd.result_json,'$.reviewDecision.reason')='duplicate'`).get() as { count: number }).count;
    const editedFields = this.#database.prepare(`SELECT fields.value field,count(*) count FROM review_decisions rd,
      json_each(COALESCE(json_extract(rd.result_json,'$.reviewDecision.editedFields'),'[]')) fields
      GROUP BY fields.value ORDER BY fields.value`).all();
    const entrySourceOpens = this.#database.prepare(`SELECT source_type,count(*) count FROM entry_source_open_events
      GROUP BY source_type ORDER BY source_type`).all();
    const operations = this.#database.prepare(`SELECT
      sum(CASE WHEN j.state IN ('failed','timed_out','interrupted') THEN 1 ELSE 0 END) failures,
      sum(CASE WHEN j.parent_job_id IS NOT NULL THEN 1 ELSE 0 END) retries
      FROM job_runs j WHERE j.job_type='takeaway-distillation'`).get();
    const historicalWarnings = Number((qualityBase as { live_duplicate_warnings?: number | null }).live_duplicate_warnings ?? 0);
    return { eligibleGroundedTurns, outcomes, review, timing,
      quality: { ...(qualityBase as Record<string, unknown>), accepted_receipt_coverage: acceptedReceiptCoverage,
        duplicateRejections, warnedDuplicateRejections,
        duplicateRejectionRate: historicalWarnings > 0 ? warnedDuplicateRejections / historicalWarnings : null,
        editedFields, entrySourceOpens }, operations };
  }

  async close(): Promise<void> {
    this.#closed = true;
    clearInterval(this.#poll);
    for (const active of this.#active.values()) active.controller.abort(new Error("application-closing"));
    await Promise.allSettled([...this.#active.values()].map((item) => item.promise));
    this.#database.close();
  }

  #pump(): void {
    if (this.#closed) return;
    while (this.#active.size < this.#concurrency) {
      const queued = this.#database.prepare(`SELECT j.id,j.run_epoch,d.manifest_id
        FROM job_runs j JOIN takeaway_distillation_runs d ON d.job_run_id=j.id
        WHERE j.job_type='takeaway-distillation' AND j.state='queued' ORDER BY j.queued_at,j.id LIMIT 1`)
        .get() as { id: string; run_epoch: number; manifest_id: string } | undefined;
      if (!queued) return;
      const now = this.#now();
      const changed = this.#database.prepare(`UPDATE job_runs SET state='running',progress=.1,started_at=?,heartbeat_at=?,
        lease_owner=?,lease_expires_at=? WHERE id=? AND state='queued' AND run_epoch=?`).run(now.toISOString(),
          now.toISOString(), `distillation:${process.pid}`, new Date(now.getTime() + 30_000).toISOString(),
          queued.id, queued.run_epoch).changes;
      if (!changed) continue;
      const controller = new AbortController();
      const promise = this.#run(queued, controller).finally(() => { this.#active.delete(queued.id); this.#pump(); });
      this.#active.set(queued.id, { controller, promise });
    }
  }

  async #run(run: { id: string; run_epoch: number; manifest_id: string }, controller: AbortController): Promise<void> {
    const started = this.#now().getTime();
    const timer = setTimeout(() => controller.abort(new Error("distillation-hard-timeout")), this.#hardTimeoutMs);
    const heartbeat = setInterval(() => {
      const now = this.#now();
      this.#database.prepare(`UPDATE job_runs SET heartbeat_at=?,lease_expires_at=?
        WHERE id=? AND state='running' AND run_epoch=?`).run(now.toISOString(),
          new Date(now.getTime() + 30_000).toISOString(), run.id, run.run_epoch);
    }, 10_000);
    heartbeat.unref();
    try {
      const manifest = JSON.parse((this.#database.prepare("SELECT manifest_json FROM takeaway_distillation_manifests WHERE id=?")
        .pluck().get(run.manifest_id) as string)) as FrozenDistillationContext;
      const material = this.#loadAndVerifyMaterial(manifest);
      const result = await this.runner.select({ context: manifest, material, signal: controller.signal,
        onActivity: (activity) => this.#activity(run.id, run.run_epoch, activity) });
      const selection = validateSelection(result.selection, manifest);
      this.#commitSuccess(run, manifest, selection, result.usage, this.#now().getTime() - started);
    } catch (error) {
      const timedOut = controller.signal.aborted &&
        controller.signal.reason instanceof Error && controller.signal.reason.message === "distillation-hard-timeout";
      const interrupted = controller.signal.aborted &&
        controller.signal.reason instanceof Error && controller.signal.reason.message === "application-closing";
      this.#commitFailure(run, timedOut ? "timed_out" : interrupted ? "interrupted" : "failed", error);
    } finally {
      clearTimeout(timer);
      clearInterval(heartbeat);
    }
  }

  #loadAndVerifyMaterial(manifest: FrozenDistillationContext): Parameters<TakeawaySelectionRunner["select"]>[0]["material"] {
    const messages = this.#database.prepare("SELECT id,content FROM messages WHERE id IN (?,?)").all(
      manifest.source.userMessageId, manifest.source.assistantMessageId) as Array<{ id: string; content: string }>;
    const byId = new Map(messages.map((message) => [message.id, message.content]));
    const question = byId.get(manifest.source.userMessageId);
    const answer = byId.get(manifest.source.assistantMessageId);
    if (!question || !answer || sha256(question) !== manifest.source.userMessageHash ||
        sha256(answer) !== manifest.source.assistantMessageHash) throw new Error("takeaway-manifest-message-drift");
    const receipts = manifest.receipts.map((frozen) => {
      const row = this.#database.prepare(`SELECT evidence_kind,source_id,source_revision,verification_status,
        locator_json,quote_text,visual_observation,content_hash
        FROM all_evidence_receipts WHERE id=? AND message_id=?`).get(frozen.id, manifest.source.assistantMessageId) as
        { evidence_kind: string; source_id: string; source_revision: string | null; verification_status: string;
          locator_json: string; quote_text: string | null; visual_observation: string | null; content_hash: string } | undefined;
      if (!row || row.verification_status !== "verified" || row.evidence_kind !== frozen.evidenceKind ||
          row.source_id !== frozen.sourceId || row.source_revision !== frozen.sourceRevision ||
          row.content_hash !== frozen.contentHash || sha256(row.locator_json) !== frozen.locatorHash) {
        throw new Error("takeaway-manifest-receipt-drift");
      }
      return { id: frozen.id, evidenceKind: row.evidence_kind, locator: JSON.parse(row.locator_json) as unknown,
        quote: row.quote_text, observation: row.visual_observation };
    });
    let summary: string | null = null;
    if (manifest.summary) {
      const row = this.#database.prepare("SELECT structured_json,markdown_hash FROM summary_revisions WHERE id=?")
        .get(manifest.summary.revisionId) as { structured_json: string; markdown_hash: string } | undefined;
      if (!row || row.markdown_hash !== manifest.summary.contentHash) throw new Error("takeaway-manifest-summary-drift");
      summary = row.structured_json;
    }
    const confirmedTakeaways = manifest.confirmedTakeaways.map((frozen) => {
      const row = this.#database.prepare("SELECT claim,markdown_hash FROM takeaway_revisions WHERE id=?")
        .get(frozen.revisionId) as { claim: string; markdown_hash: string } | undefined;
      if (!row || row.markdown_hash !== frozen.contentHash) throw new Error("takeaway-manifest-knowledge-drift");
      return { revisionId: frozen.revisionId, claim: row.claim };
    });
    return { question, answer, receipts, summary, confirmedTakeaways };
  }

  #activity(jobRunId: string, epoch: number, activity: { type: string; text: string; metadata?: Record<string, unknown> }): void {
    if (!activity.type || !activity.text) return;
    this.#database.prepare(`INSERT INTO agent_run_activities
      (job_run_id,run_epoch,event_type,display_text,metadata_json,created_at)
      SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM job_runs WHERE id=? AND state='running' AND run_epoch=?)`)
      .run(jobRunId, epoch, activity.type, activity.text.slice(0, 500), stableJson(activity.metadata ?? {}),
        this.#now().toISOString(), jobRunId, epoch);
  }

  #commitSuccess(run: { id: string; run_epoch: number }, manifest: FrozenDistillationContext,
    selection: DistillationSelection, usage: { status: string; inputTokens?: number; cachedInputTokens?: number;
      outputTokens?: number; totalTokens?: number }, elapsedMs: number): void {
    const now = this.#now().toISOString();
    this.#database.transaction(() => {
      const active = this.#database.prepare("SELECT 1 FROM job_runs WHERE id=? AND state='running' AND run_epoch=?")
        .get(run.id, run.run_epoch);
      if (!active) return;
      let proposalId: string | null = null;
      if (selection.decision === "candidate") {
        proposalId = `proposal:${randomUUID()}`;
        const candidate = selection.candidate;
        const title = deriveTakeawayTitle(candidate.claim);
        this.#database.prepare(`INSERT INTO proposals
          (id,proposal_type,paper_id,source_message_id,payload_json,review_status,one_click_eligible,created_at)
          VALUES (?,'takeaway',?,?,?,'pending',?,?)`).run(proposalId, manifest.paper.id,
            manifest.source.assistantMessageId, stableJson({ contractVersion: TAKEAWAY_CONTRACT_VERSION,
              distillationJobRunId: run.id, trigger: manifest.trigger, title, ...candidate }),
            candidate.epistemicStatus === "evidence-backed" ? 1 : 0, now);
        const liveDuplicateIds = liveDuplicateRevisionIds(this.#database, manifest.paper.id, candidate.claim);
        this.#database.prepare(`INSERT INTO takeaway_review_requirements
          (proposal_id,evidence_review_required,duplicate_acknowledged,live_duplicate_warning,
           live_duplicate_ids_json,reviewed_receipt_ids_json,updated_at)
          VALUES (?,0,0,?,?,'[]',?)`).run(proposalId, liveDuplicateIds.length > 0 ? 1 : 0,
            stableJson(liveDuplicateIds), now);
      }
      this.#database.prepare(`UPDATE takeaway_distillation_runs SET outcome_kind=?,reason_code=?,proposal_id=?
        WHERE job_run_id=?`).run(selection.decision === "candidate" ? "candidate" : "no-proposal",
          selection.decision === "no-proposal" ? selection.reasonCode : null, proposalId, run.id);
      const execution = this.#agentExecutionMetadata?.("takeaway-distillation") ?? null;
      this.#database.prepare(`INSERT INTO agent_runs(job_run_id,task_kind,model,reasoning_effort,codex_version,
        configuration_version,context_snapshot_id,output_schema_hash,prompt_hash,output_json)
        VALUES (?,'takeaway-distillation',?,?,?,?,NULL,?,?,?)`)
        .run(run.id, execution?.model ?? null, execution?.reasoningEffort ?? null,
          execution?.codexVersion ?? "unknown", execution?.configurationVersion ?? null,
          manifest.contractHash, manifest.promptHash, stableJson(selection));
      this.#database.prepare(`INSERT INTO agent_run_usage(job_run_id,run_epoch,status,input_tokens,cached_input_tokens,
        output_tokens,total_tokens,elapsed_ms,recorded_at) VALUES (?,?,?,?,?,?,?,?,?)`).run(run.id, run.run_epoch,
          usage.status, usage.inputTokens ?? null, usage.cachedInputTokens ?? null, usage.outputTokens ?? null,
          usage.totalTokens ?? null, elapsedMs, now);
      this.#database.prepare(`UPDATE job_runs SET state='succeeded',progress=1,output_json=?,completed_at=?,heartbeat_at=?,
        lease_owner=NULL,lease_expires_at=NULL WHERE id=? AND state='running' AND run_epoch=?`).run(stableJson(selection),
          now, now, run.id, run.run_epoch);
      this.#database.prepare(`INSERT INTO durable_events(scope,event_type,data_json,created_at)
        SELECT m.conversation_id,'takeaway-distillation-complete',?,? FROM messages m WHERE m.id=?`)
        .run(stableJson({ jobRunId: run.id, assistantMessageId: manifest.source.assistantMessageId,
          decision: selection.decision, proposalId }), now, manifest.source.assistantMessageId);
    })();
  }

  #commitFailure(run: { id: string; run_epoch: number }, state: "failed" | "timed_out" | "interrupted", error: unknown): void {
    const now = this.#now().toISOString();
    const code = error instanceof Error ? error.message : String(error);
    this.#database.transaction(() => {
      const changed = this.#database.prepare(`UPDATE job_runs SET state=?,progress=1,error_json=?,failure_kind=?,
        completed_at=?,heartbeat_at=?,lease_owner=NULL,lease_expires_at=NULL
        WHERE id=? AND state='running' AND run_epoch=?`).run(state, stableJson({ code }),
          state === "timed_out" ? "timed_out" : state === "interrupted" ? "process_interrupted"
            : code.startsWith("takeaway-lint-") ? "output_invalid" : "runner_failed",
          now, now, run.id, run.run_epoch).changes;
      if (changed) this.#database.prepare(`INSERT INTO agent_run_usage
        (job_run_id,run_epoch,status,elapsed_ms,recorded_at) VALUES (?,?,'unavailable',0,?)`)
        .run(run.id, run.run_epoch, now);
    })();
  }
}

export function validateSelection(selection: DistillationSelection, manifest: FrozenDistillationContext): DistillationSelection {
  if (selection.decision === "no-proposal") {
    if (!ABSTENTION_REASONS.includes(selection.reasonCode) || !selection.rationale.trim() ||
        selection.rationale.length > 1200) throw new Error("takeaway-lint-abstention-invalid");
    return { ...selection, rationale: selection.rationale.trim() };
  }
  const candidate = selection.candidate;
  if (!TAKEAWAY_KINDS.includes(candidate.kind) || !EPISTEMIC_STATUSES.includes(candidate.epistemicStatus)) {
    throw new Error("takeaway-lint-enum-invalid");
  }
  const claim = candidate.claim.trim();
  if (claim.length < 40 || claim.length > 2000) throw new Error("takeaway-lint-claim-bounds");
  if (/^(?:it|its|this method|this approach|this result|其|该方法|这种方法|该结果)(?:\s|，|,)/iu.test(claim)) {
    throw new Error("takeaway-lint-referential-fragment");
  }
  if (candidate.evidenceRationale.trim().length < 10 || candidate.evidenceRationale.length > 2000 ||
      candidate.selectionRationale.trim().length < 10 || candidate.selectionRationale.length > 1200 ||
      (candidate.caveat !== null && candidate.caveat.length > 1000)) throw new Error("takeaway-lint-field-bounds");
  const allowedReceipts = new Set(manifest.receipts.map((receipt) => receipt.id));
  if (candidate.receiptIds.length === 0 || new Set(candidate.receiptIds).size !== candidate.receiptIds.length ||
      candidate.receiptIds.some((id) => !allowedReceipts.has(id))) throw new Error("takeaway-lint-receipt-ownership");
  const allowedDuplicates = new Set(manifest.confirmedTakeaways.map((item) => item.revisionId));
  if (candidate.duplicateHints.some((id) => !allowedDuplicates.has(id))) throw new Error("takeaway-lint-duplicate-ownership");
  return { decision: "candidate", candidate: { ...candidate, claim,
    evidenceRationale: candidate.evidenceRationale.trim(),
    caveat: candidate.caveat?.trim() || null,
    selectionRationale: candidate.selectionRationale.trim() } };
}

export function liveDuplicateRevisionIds(database: Database.Database, paperId: string, claim: string): string[] {
  const normalized = normalizeClaim(claim);
  if (!normalized) return [];
  return (database.prepare(`SELECT tr.id,tr.claim FROM takeaways t JOIN takeaway_revisions tr ON tr.id=t.active_revision_id
    WHERE t.paper_id=? AND tr.review_status='confirmed' ORDER BY tr.id`).all(paperId) as Array<{ id: string; claim: string }>)
    .filter((row) => {
      const existing = normalizeClaim(row.claim);
      return existing === normalized || (Math.min(existing.length, normalized.length) >= 60 &&
        (existing.includes(normalized) || normalized.includes(existing)));
    }).map((row) => row.id);
}

function normalizeClaim(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}
