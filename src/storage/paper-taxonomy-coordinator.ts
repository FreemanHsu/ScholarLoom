import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import Database from "better-sqlite3";

import {
  createPaperTaxonomySchema,
  validatePaperTaxonomyResult,
  type PaperTaxonomyManifest,
  type PaperTaxonomyResult,
  type PaperTaxonomyRunner,
} from "../agent/paper-taxonomy.js";
import { getAgentConfiguration, type AgentExecutionMetadataProvider } from "../agent/agent-configuration.js";
import { codexOutputSchema } from "../agent/codex-output-schema.js";
import { normalizePaperLookup } from "../domain/paper-organization.js";
import type { ImportStore } from "./import-store.js";
import type { StorageLayout } from "./layout.js";
import { PaperOrganizationStoreError } from "./paper-organization-store.js";
import type { PaperOrganizationCoordinator } from "./paper-organization-coordinator.js";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const stableJson = (value: unknown) => JSON.stringify(value);

export class PaperTaxonomyCoordinator {
  readonly #database: Database.Database;
  readonly #poll: ReturnType<typeof setInterval>;
  readonly #now: () => Date;
  readonly #timeoutMs: number;
  readonly #metadata: AgentExecutionMetadataProvider | undefined;
  #active: { id: string; controller: AbortController; promise: Promise<void> } | null = null;
  #closed = false;

  constructor(
    layout: StorageLayout,
    private readonly runner: PaperTaxonomyRunner,
    private readonly source: Pick<ImportStore,
      "buildPaperTaxonomyManifest" | "directionTaxonomyCollision">,
    private readonly organizationCoordinator: PaperOrganizationCoordinator | null,
    options: { now?: () => Date; hardTimeoutMs?: number;
      agentExecutionMetadata?: AgentExecutionMetadataProvider } = {},
  ) {
    this.#database = new Database(layout.databasePath);
    this.#database.pragma("foreign_keys = ON");
    this.#database.pragma("busy_timeout = 5000");
    this.#now = options.now ?? (() => new Date());
    this.#timeoutMs = options.hardTimeoutMs ?? getAgentConfiguration("paper-taxonomy").execution.timeoutMs;
    this.#metadata = options.agentExecutionMetadata;
    this.#poll = setInterval(() => this.#pump(), 100);
    this.#poll.unref();
    queueMicrotask(() => this.#pump());
  }

  request(input: { mode: "next" | "regenerate" | "refresh"; limit: number; priorManifestId?: string },
    idempotencyKey: string): { jobRunId: string; replayed: boolean } {
    const replay = this.#database.prepare("SELECT id FROM job_runs WHERE idempotency_key=?").pluck()
      .get(idempotencyKey) as string | undefined;
    if (replay) return { jobRunId: replay, replayed: true };
    const skill = readFileSync(join(process.cwd(), "skills", "paper-taxonomy", "SKILL.md"), "utf8");
    const preliminary = this.source.buildPaperTaxonomyManifest({
      ...input,
      promptHash: sha256("paper-taxonomy-prompt.v1"),
      schemaHash: "",
      skillHash: sha256(skill),
    });
    const manifest = this.source.buildPaperTaxonomyManifest({
      ...input,
      promptHash: preliminary.promptHash,
      schemaHash: sha256(stableJson(codexOutputSchema(createPaperTaxonomySchema(preliminary)))),
      skillHash: preliminary.skillHash,
    });
    const manifestJson = stableJson(manifest);
    const manifestHash = sha256(manifestJson);
    const manifestId = `paper-taxonomy-manifest:${manifestHash}`;
    const jobRunId = `job:${randomUUID()}`;
    const now = this.#now().toISOString();
    this.#database.transaction(() => {
      this.#database.prepare(`INSERT OR IGNORE INTO paper_taxonomy_manifests
        (id,manifest_hash,cohort_hash,selection_mode,selection_version,excerpt_version,
         normalization_version,prior_manifest_id,manifest_json,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(manifestId, manifestHash, manifest.cohortHash,
          manifest.selectionMode, manifest.selectionVersion, manifest.excerptVersion,
          manifest.normalizationVersion, input.priorManifestId ?? null, manifestJson, now);
      this.#database.prepare(`INSERT INTO job_runs
        (id,job_type,state,progress,attempt,idempotency_key,input_json,queued_at,run_epoch)
        VALUES (?,'paper-taxonomy','queued',0,1,?,?,?,1)`).run(jobRunId, idempotencyKey,
          stableJson({ manifestId }), now);
      this.#database.prepare(`INSERT INTO paper_taxonomy_runs(job_run_id,manifest_id,created_at)
        VALUES (?,?,?)`).run(jobRunId, manifestId, now);
    })();
    queueMicrotask(() => this.#pump());
    return { jobRunId, replayed: false };
  }

  retry(jobRunId: string, idempotencyKey: string): { jobRunId: string; replayed: boolean } {
    const replay = this.#database.prepare("SELECT id FROM job_runs WHERE idempotency_key=?").pluck()
      .get(idempotencyKey) as string | undefined;
    if (replay) return { jobRunId: replay, replayed: true };
    const prior = this.#database.prepare(`SELECT j.state,j.attempt,r.manifest_id
      FROM job_runs j JOIN paper_taxonomy_runs r ON r.job_run_id=j.id WHERE j.id=?`).get(jobRunId) as
      { state: string; attempt: number; manifest_id: string } | undefined;
    if (!prior || !["failed", "timed_out", "interrupted"].includes(prior.state)) {
      throw new PaperOrganizationStoreError("paper-taxonomy-job-not-retryable", 409);
    }
    const nextId = `job:${randomUUID()}`;
    const now = this.#now().toISOString();
    this.#database.transaction(() => {
      this.#database.prepare(`INSERT INTO job_runs
        (id,job_type,parent_job_id,state,progress,attempt,idempotency_key,input_json,queued_at,run_epoch)
        VALUES (?,'paper-taxonomy',?,'queued',0,?,?,?, ?,1)`).run(nextId, jobRunId,
          prior.attempt + 1, idempotencyKey, stableJson({ manifestId: prior.manifest_id }), now);
      this.#database.prepare(`INSERT INTO paper_taxonomy_runs(job_run_id,manifest_id,created_at)
        VALUES (?,?,?)`).run(nextId, prior.manifest_id, now);
    })();
    queueMicrotask(() => this.#pump());
    return { jobRunId: nextId, replayed: false };
  }

  async close(): Promise<void> {
    this.#closed = true;
    clearInterval(this.#poll);
    this.#active?.controller.abort(new Error("application-closing"));
    if (this.#active) await Promise.allSettled([this.#active.promise]);
    this.#database.close();
  }

  #pump(): void {
    if (this.#closed) return;
    this.#pumpBackfill();
    if (this.#active) return;
    const queued = this.#database.prepare(`SELECT j.id,j.run_epoch,r.manifest_id
      FROM job_runs j JOIN paper_taxonomy_runs r ON r.job_run_id=j.id
      WHERE j.state='queued' ORDER BY j.queued_at,j.id LIMIT 1`).get() as
      { id: string; run_epoch: number; manifest_id: string } | undefined;
    if (!queued) return;
    const now = this.#now().toISOString();
    const changed = this.#database.prepare(`UPDATE job_runs SET state='running',progress=.1,
      started_at=?,heartbeat_at=? WHERE id=? AND state='queued' AND run_epoch=?`)
      .run(now, now, queued.id, queued.run_epoch).changes;
    if (!changed) return;
    const controller = new AbortController();
    const promise = this.#run(queued, controller).finally(() => {
      this.#active = null;
      this.#pump();
    });
    this.#active = { id: queued.id, controller, promise };
  }

  async #run(run: { id: string; run_epoch: number; manifest_id: string },
    controller: AbortController): Promise<void> {
    const started = this.#now().getTime();
    const timer = setTimeout(() => controller.abort(new Error("paper-taxonomy-hard-timeout")), this.#timeoutMs);
    try {
      const manifest = JSON.parse(this.#database.prepare(
        "SELECT manifest_json FROM paper_taxonomy_manifests WHERE id=?",
      ).pluck().get(run.manifest_id) as string) as PaperTaxonomyManifest;
      const result = await this.runner.propose({
        context: manifest,
        signal: controller.signal,
        onActivity: (activity) => {
          if (!activity.type || !activity.text) return;
          this.#database.prepare(`INSERT INTO agent_run_activities
            (job_run_id,run_epoch,event_type,display_text,metadata_json,created_at)
            VALUES (?,?,?,?,?,?)`).run(run.id, run.run_epoch, activity.type,
              activity.text.slice(0, 500), stableJson(activity.metadata ?? {}), this.#now().toISOString());
        },
      });
      validatePaperTaxonomyResult(result, manifest);
      this.#commit(run, manifest, result, this.#now().getTime() - started);
    } catch (error) {
      const interrupted = controller.signal.aborted &&
        (controller.signal.reason as Error | undefined)?.message === "application-closing";
      const timedOut = controller.signal.aborted && !interrupted;
      const now = this.#now().toISOString();
      this.#database.prepare(`UPDATE job_runs SET state=?,progress=1,failure_kind='failed_infra',
        error_json=?,completed_at=? WHERE id=? AND state='running' AND run_epoch=?`)
        .run(timedOut ? "timed_out" : interrupted ? "interrupted" : "failed",
          stableJson({ code: error instanceof Error ? error.message : "paper-taxonomy-failed" }),
          now, run.id, run.run_epoch);
    } finally {
      clearTimeout(timer);
    }
  }

  #commit(run: { id: string; run_epoch: number; manifest_id: string },
    manifest: PaperTaxonomyManifest, result: PaperTaxonomyResult, elapsedMs: number): void {
    const now = this.#now().toISOString();
    const groupId = `direction-taxonomy-group:${run.id}`;
    const seen = new Set<string>();
    const emitted: Array<{
      candidate: PaperTaxonomyResult["candidates"][number];
      suggested: { topicId: string; title: string; aliases: string[]; scope: string; exclusions: string[] };
    }> = [];
    const dropped: Array<{ suggestedTopicId: string; reason: "exact-collision" }> = [];
    for (const candidate of result.candidates) {
      const suggested = {
        topicId: candidate.suggestedTopicId,
        title: candidate.title.trim(),
        aliases: candidate.aliases.map((alias) => alias.trim()),
        scope: candidate.scope.trim(),
        exclusions: candidate.exclusions.map((item) => item.trim()),
      };
      const keys = [suggested.topicId, suggested.title, ...suggested.aliases].map(normalizePaperLookup);
      const internalCollision = keys.some((key) => seen.has(key));
      const catalogCollision = this.source.directionTaxonomyCollision(suggested);
      if (internalCollision || catalogCollision) {
        dropped.push({ suggestedTopicId: suggested.topicId, reason: "exact-collision" });
        continue;
      }
      keys.forEach((key) => seen.add(key));
      emitted.push({ candidate, suggested });
    }
    this.#database.transaction(() => {
      if (!this.#database.prepare("SELECT 1 FROM job_runs WHERE id=? AND state='running' AND run_epoch=?")
        .get(run.id, run.run_epoch)) return;
      for (const { candidate, suggested } of emitted) {
        this.#database.prepare(`INSERT INTO proposals
          (id,proposal_type,paper_id,payload_json,review_status,one_click_eligible,created_at)
          VALUES (?,'direction-taxonomy',NULL,?,'pending',?,?)`).run(`proposal:${randomUUID()}`,
            stableJson({
              contractVersion: "direction-taxonomy.v1",
              sourceKind: "agent",
              operation: "create",
              groupId,
              jobRunId: run.id,
              manifestId: run.manifest_id,
              suggested,
              representativePaperIds: candidate.representativePaperIds,
              rationale: candidate.rationale,
              ambiguous: candidate.overlaps.length > 0,
              overlaps: candidate.overlaps,
            }), Number(candidate.overlaps.length === 0), now);
      }
      const outcome = {
        cohortCovered: true,
        noNewDirection: emitted.length === 0,
        emitted: emitted.length,
        dropped: dropped.length,
        ambiguous: emitted.filter(({ candidate }) => candidate.overlaps.length > 0).length,
        droppedCandidates: dropped,
      };
      this.#database.prepare(`UPDATE paper_taxonomy_runs SET proposal_group_id=?,outcome_json=?
        WHERE job_run_id=?`).run(groupId, stableJson(outcome), run.id);
      const priorManifestId = this.#database.prepare(
        "SELECT prior_manifest_id FROM paper_taxonomy_manifests WHERE id=?",
      ).pluck().get(run.manifest_id) as string | null;
      if (manifest.selectionMode === "regenerate" && priorManifestId) {
        this.#database.prepare(`UPDATE proposals SET review_status='superseded',decided_at=?
          WHERE proposal_type='direction-taxonomy' AND review_status='pending'
            AND json_extract(payload_json,'$.manifestId')=?`).run(now, priorManifestId);
      }
      const execution = this.#metadata?.("paper-taxonomy") ?? null;
      this.#database.prepare(`INSERT INTO agent_runs(job_run_id,task_kind,model,reasoning_effort,codex_version,
        configuration_version,skill_path,skill_content_hash,context_snapshot_id,output_schema_hash,prompt_hash,output_json)
        VALUES (?,'paper-taxonomy',?,?,?,?,'skills/paper-taxonomy/SKILL.md',?,NULL,?,?,?)`)
        .run(run.id, execution?.model ?? null, execution?.reasoningEffort ?? null,
          execution?.codexVersion ?? "unknown", execution?.configurationVersion ?? null,
          manifest.skillHash, manifest.schemaHash, manifest.promptHash, stableJson(result));
      this.#database.prepare(`INSERT INTO agent_run_usage(job_run_id,run_epoch,status,input_tokens,cached_input_tokens,
        output_tokens,total_tokens,elapsed_ms,recorded_at) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(run.id, run.run_epoch, result.usage.status, result.usage.inputTokens ?? null,
          result.usage.cachedInputTokens ?? null, result.usage.outputTokens ?? null,
          result.usage.totalTokens ?? null, elapsedMs, now);
      this.#database.prepare(`UPDATE job_runs SET state='succeeded',progress=1,output_json=?,completed_at=?
        WHERE id=? AND state='running' AND run_epoch=?`).run(stableJson(result), now, run.id, run.run_epoch);
    })();
  }

  #pumpBackfill(): void {
    if (!this.organizationCoordinator) return;
    const campaign = this.#database.prepare(`SELECT id,state FROM paper_organization_backfills
      WHERE state IN ('reserved','scheduling','monitoring') LIMIT 1`).get() as
      { id: string; state: string } | undefined;
    if (!campaign) return;
    const now = this.#now().toISOString();
    if (campaign.state === "reserved") {
      this.#database.prepare("UPDATE paper_organization_backfills SET state='scheduling',updated_at=? WHERE id=?")
        .run(now, campaign.id);
    }
    const activeOrganization = this.#database.prepare(`SELECT 1 FROM job_runs
      WHERE job_type='paper-organization' AND state IN ('queued','running') LIMIT 1`).get();
    if (!activeOrganization) {
      const member = this.#database.prepare(`SELECT ordinal,paper_id,summary_revision_id,child_idempotency_key
        FROM paper_organization_backfill_members
        WHERE campaign_id=? AND member_state='pending' ORDER BY ordinal LIMIT 1`).get(campaign.id) as
        { ordinal: number; paper_id: string; summary_revision_id: string; child_idempotency_key: string } | undefined;
      if (member) {
        try {
          const scheduled = this.organizationCoordinator.requestPinned(
            member.paper_id, member.summary_revision_id, member.child_idempotency_key);
          const catalogHash = this.#database.prepare(`SELECT c.catalog_hash
            FROM paper_organization_runs r JOIN paper_organization_manifests m ON m.id=r.manifest_id
            JOIN paper_organization_catalog_snapshots c ON c.id=m.catalog_snapshot_id
            WHERE r.job_run_id=?`).pluck().get(scheduled.jobRunId) as string;
          this.#database.prepare(`UPDATE paper_organization_backfill_members
            SET member_state='scheduled',job_run_id=?,catalog_hash=?,updated_at=?
            WHERE campaign_id=? AND ordinal=? AND member_state='pending'`)
            .run(scheduled.jobRunId, catalogHash, now, campaign.id, member.ordinal);
        } catch (error) {
          const code = error instanceof PaperOrganizationStoreError ? error.code : "";
          const reason = code.includes("summary") ? "summary-replaced"
            : code.includes("drift") || code.includes("manifest") ? "manifest-drift"
              : code.includes("busy") ? "work-in-progress" : "paper-inactive";
          this.#database.prepare(`UPDATE paper_organization_backfill_members
            SET member_state='skipped',skip_reason=?,updated_at=?
            WHERE campaign_id=? AND ordinal=? AND member_state='pending'`)
            .run(reason, now, campaign.id, member.ordinal);
        }
      }
    }
    const pending = this.#database.prepare(`SELECT 1 FROM paper_organization_backfill_members
      WHERE campaign_id=? AND member_state='pending' LIMIT 1`).get(campaign.id);
    if (pending) return;
    this.#database.prepare(`UPDATE paper_organization_backfills SET state='monitoring',updated_at=?
      WHERE id=? AND state IN ('reserved','scheduling')`).run(now, campaign.id);
    const nonterminal = this.#database.prepare(`SELECT 1 FROM paper_organization_backfill_members m
      JOIN job_runs j ON j.id=m.job_run_id WHERE m.campaign_id=? AND j.state NOT IN
      ('succeeded','failed','timed_out','interrupted','cancelled') LIMIT 1`).get(campaign.id);
    if (nonterminal) return;
    const issues = this.#database.prepare(`SELECT 1 FROM paper_organization_backfill_members m
      LEFT JOIN job_runs j ON j.id=m.job_run_id WHERE m.campaign_id=?
      AND (m.member_state='skipped' OR j.state<>'succeeded') LIMIT 1`).get(campaign.id);
    this.#database.prepare(`UPDATE paper_organization_backfills SET state=?,updated_at=?,completed_at=?
      WHERE id=? AND state='monitoring'`).run(issues ? "complete-with-issues" : "complete",
        now, now, campaign.id);
  }
}
