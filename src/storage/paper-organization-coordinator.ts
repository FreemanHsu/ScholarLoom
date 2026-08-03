import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import Database from "better-sqlite3";

import {
  createPaperOrganizationSchema,
  normalizePaperOrganizationAgentResult,
  PAPER_ORGANIZATION_CONTRACT_VERSION,
  PAPER_ORGANIZATION_DIRECTION_LIMIT,
  validatePaperOrganizationAgentResult,
  type OrganizationDirectionSnapshot,
  type PaperOrganizationAgentResult,
  type PaperOrganizationManifest,
  type PaperOrganizationRunner,
  type PaperOrganizationScope,
} from "../agent/paper-organization.js";
import { getAgentConfiguration, type AgentExecutionMetadataProvider } from "../agent/agent-configuration.js";
import { codexOutputSchema } from "../agent/codex-output-schema.js";
import { normalizePaperLookup } from "../domain/paper-organization.js";
import type { StorageLayout } from "./layout.js";
import type { ImportStore } from "./import-store.js";
import { PaperOrganizationStoreError } from "./paper-organization-store.js";

type CoordinatorOptions = {
  concurrency?: number;
  hardTimeoutMs?: number;
  now?: () => Date;
  agentExecutionMetadata?: AgentExecutionMetadataProvider;
};

type QueuedRun = { id: string; run_epoch: number; manifest_id: string; trigger_id: number | null };
const stableJson = (value: unknown) => JSON.stringify(value);
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export class PaperOrganizationCoordinator {
  readonly #database: Database.Database;
  readonly #active = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  readonly #concurrency: number;
  readonly #hardTimeoutMs: number;
  readonly #now: () => Date;
  readonly #poll: ReturnType<typeof setInterval>;
  readonly #agentExecutionMetadata: AgentExecutionMetadataProvider | undefined;
  #closed = false;

  constructor(
    layout: StorageLayout,
    private readonly runner: PaperOrganizationRunner,
    private readonly source: Pick<ImportStore,
      "snapshotForOrganizationAgent" | "readOrganizationForPaper">,
    options: CoordinatorOptions = {},
  ) {
    const configuration = getAgentConfiguration("paper-organization");
    this.#database = new Database(layout.databasePath);
    this.#database.pragma("foreign_keys = ON");
    this.#database.pragma("busy_timeout = 5000");
    this.#concurrency = options.concurrency ?? configuration.execution.concurrency ?? 1;
    this.#hardTimeoutMs = options.hardTimeoutMs ?? configuration.execution.timeoutMs;
    this.#now = options.now ?? (() => new Date());
    this.#agentExecutionMetadata = options.agentExecutionMetadata;
    this.#poll = setInterval(() => this.#pump(), 100);
    this.#poll.unref();
    queueMicrotask(() => this.#pump());
  }

  request(paperId: string, scope: Exclude<PaperOrganizationScope, "all">, idempotencyKey: string): {
    jobRunId: string;
    replayed: boolean;
  } {
    const replay = this.#database.prepare("SELECT id FROM job_runs WHERE idempotency_key=?").pluck()
      .get(idempotencyKey) as string | undefined;
    if (replay) return { jobRunId: replay, replayed: true };
    const summaryRevisionId = this.#database.prepare(`SELECT s.id FROM summary_revisions s JOIN papers p
      ON p.current_version_id=s.paper_version_id
      WHERE p.id=? AND s.paper_id=p.id AND s.status='active'
      ORDER BY s.created_at DESC,s.id DESC LIMIT 1`).pluck().get(paperId) as string | undefined;
    if (!summaryRevisionId) throw new PaperOrganizationStoreError("paper-organization-summary-not-current", 409);
    const snapshot = this.source.snapshotForOrganizationAgent(paperId, summaryRevisionId, scope);
    const jobRunId = this.#schedule(snapshot, scope, null, idempotencyKey);
    queueMicrotask(() => this.#pump());
    return { jobRunId, replayed: false };
  }

  requestPinned(paperId: string, summaryRevisionId: string, idempotencyKey: string): {
    jobRunId: string;
    replayed: boolean;
  } {
    const replay = this.#database.prepare("SELECT id FROM job_runs WHERE idempotency_key=?").pluck()
      .get(idempotencyKey) as string | undefined;
    if (replay) return { jobRunId: replay, replayed: true };
    const snapshot = this.source.snapshotForOrganizationAgent(paperId, summaryRevisionId, "all");
    const jobRunId = this.#schedule(snapshot, "all", null, idempotencyKey);
    queueMicrotask(() => this.#pump());
    return { jobRunId, replayed: false };
  }

  retryGeneration(jobRunId: string, idempotencyKey: string): { jobRunId: string; replayed: boolean } {
    const replay = this.#database.prepare("SELECT id FROM job_runs WHERE idempotency_key=?").pluck()
      .get(idempotencyKey) as string | undefined;
    if (replay) return { jobRunId: replay, replayed: true };
    const previous = this.#database.prepare(`SELECT j.state,j.paper_id,j.attempt,r.manifest_id,r.scope
      FROM job_runs j JOIN paper_organization_runs r ON r.job_run_id=j.id WHERE j.id=?`)
      .get(jobRunId) as { state: string; paper_id: string; attempt: number;
        manifest_id: string; scope: PaperOrganizationScope } | undefined;
    if (!previous || !["failed", "timed_out", "interrupted"].includes(previous.state)) {
      throw new PaperOrganizationStoreError("paper-organization-generation-not-retryable", 409);
    }
    const nextId = `job:${randomUUID()}`;
    const now = this.#now().toISOString();
    this.#database.transaction(() => {
      this.#database.prepare(`INSERT INTO job_runs
        (id,job_type,parent_job_id,paper_id,state,progress,attempt,idempotency_key,input_json,queued_at,run_epoch)
        VALUES (?,'paper-organization',?,?,'queued',0,?,?,?, ?,1)`)
        .run(nextId, jobRunId, previous.paper_id, previous.attempt + 1, idempotencyKey,
          stableJson({ manifestId: previous.manifest_id, scope: previous.scope }), now);
      this.#database.prepare(`INSERT INTO paper_organization_runs
        (job_run_id,trigger_id,paper_id,manifest_id,contract_version,scope,created_at)
        VALUES (?,NULL,?,?,?,?,?)`).run(nextId, previous.paper_id, previous.manifest_id,
          PAPER_ORGANIZATION_CONTRACT_VERSION, previous.scope, now);
    })();
    queueMicrotask(() => this.#pump());
    return { jobRunId: nextId, replayed: false };
  }

  readForPaper(paperId: string): {
    runs: unknown[];
    suggestions: unknown[];
  } {
    return this.source.readOrganizationForPaper(paperId, true);
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
    this.#schedulePendingTriggers();
    while (this.#active.size < this.#concurrency) {
      const queued = this.#database.prepare(`SELECT j.id,j.run_epoch,r.manifest_id,r.trigger_id
        FROM job_runs j JOIN paper_organization_runs r ON r.job_run_id=j.id
        WHERE j.job_type='paper-organization' AND j.state='queued'
        ORDER BY j.queued_at,j.id LIMIT 1`).get() as QueuedRun | undefined;
      if (!queued) return;
      const now = this.#now();
      const changed = this.#database.prepare(`UPDATE job_runs SET state='running',progress=.1,started_at=?,
        heartbeat_at=?,lease_owner=?,lease_expires_at=? WHERE id=? AND state='queued' AND run_epoch=?`)
        .run(now.toISOString(), now.toISOString(), `paper-organization:${process.pid}`,
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

  #schedulePendingTriggers(): void {
    const triggers = this.#database.prepare(`SELECT id,paper_id,summary_revision_id
      FROM paper_organization_triggers WHERE state='pending' ORDER BY id LIMIT 8`).all() as Array<{
        id: number;
        paper_id: string;
        summary_revision_id: string;
      }>;
    for (const trigger of triggers) {
      try {
        const snapshot = this.source.snapshotForOrganizationAgent(
          trigger.paper_id,
          trigger.summary_revision_id,
          "all",
        );
        this.#schedule(snapshot, "all", trigger.id,
          `paper-organization-trigger:${trigger.id}`);
      } catch (error) {
        if (error instanceof PaperOrganizationStoreError &&
            ["paper-organization-source-busy", "paper-organization-source-unavailable"].includes(error.code)) continue;
        const now = this.#now().toISOString();
        this.#database.prepare(`UPDATE paper_organization_triggers SET state='failed',consumed_at=?
          WHERE id=? AND state='pending'`).run(now, trigger.id);
      }
    }
  }

  #schedule(
    snapshot: ReturnType<ImportStore["snapshotForOrganizationAgent"]>,
    scope: PaperOrganizationScope,
    triggerId: number | null,
    idempotencyKey: string,
  ): string {
    const replay = this.#database.prepare("SELECT id FROM job_runs WHERE idempotency_key=?").pluck()
      .get(idempotencyKey) as string | undefined;
    if (replay) return replay;
    const now = this.#now().toISOString();
    const catalogJson = stableJson(snapshot.directions);
    const catalogHash = sha256(catalogJson);
    const catalogSnapshotId = `paper-organization-catalog:${catalogHash}`;
    const skill = readFileSync(join(process.cwd(), "skills", "paper-organization", "SKILL.md"), "utf8");
    const schema = createPaperOrganizationSchema(
      { requestedSections: snapshot.requestedSections },
      snapshot.directions.map((direction) => direction.topicId),
    );
    const manifest: PaperOrganizationManifest = {
      contractVersion: PAPER_ORGANIZATION_CONTRACT_VERSION,
      scope,
      requestedSections: snapshot.requestedSections,
      paper: snapshot.paper,
      summary: snapshot.summary,
      organization: snapshot.organization,
      paperManifest: snapshot.paperManifest,
      catalogSnapshotId,
      catalogHash,
      promptHash: sha256("paper-organization-prompt.v1"),
      schemaHash: sha256(stableJson(codexOutputSchema(schema))),
      skillHash: sha256(skill),
      lockedPrimaryTopicId: snapshot.lockedPrimaryTopicId,
    };
    const manifestJson = stableJson(manifest);
    const manifestHash = sha256(manifestJson);
    const manifestId = `paper-organization-manifest:${manifestHash}`;
    const jobRunId = `job:${randomUUID()}`;
    this.#database.transaction(() => {
      this.#database.prepare(`INSERT OR IGNORE INTO paper_organization_catalog_snapshots
        (id,catalog_hash,direction_count,catalog_json,created_at) VALUES (?,?,?,?,?)`)
        .run(catalogSnapshotId, catalogHash, snapshot.directions.length, catalogJson, now);
      this.#database.prepare(`INSERT OR IGNORE INTO paper_organization_manifests
        (id,manifest_hash,paper_id,paper_version_id,summary_revision_id,catalog_snapshot_id,
         contract_version,scope,manifest_json,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(manifestId, manifestHash, snapshot.paper.id,
          snapshot.paper.versionId, snapshot.summary.revisionId, catalogSnapshotId,
          PAPER_ORGANIZATION_CONTRACT_VERSION, scope, manifestJson, now);
      this.#database.prepare(`INSERT INTO job_runs
        (id,job_type,paper_id,state,progress,attempt,idempotency_key,input_json,queued_at,run_epoch)
        VALUES (?,'paper-organization',?,'queued',0,1,?,?,?,1)`).run(jobRunId, snapshot.paper.id,
          idempotencyKey, stableJson({ manifestId, triggerId, scope }), now);
      this.#database.prepare(`INSERT INTO paper_organization_runs
        (job_run_id,trigger_id,paper_id,manifest_id,contract_version,scope,created_at)
        VALUES (?,?,?,?,?,?,?)`).run(jobRunId, triggerId, snapshot.paper.id, manifestId,
          PAPER_ORGANIZATION_CONTRACT_VERSION, scope, now);
      if (triggerId !== null) {
        this.#database.prepare(`UPDATE paper_organization_triggers SET state='scheduled',consumed_at=?
          WHERE id=? AND state='pending'`).run(now, triggerId);
      }
      if (snapshot.directions.length > PAPER_ORGANIZATION_DIRECTION_LIMIT) {
        this.#database.prepare(`UPDATE job_runs SET state='failed',progress=1,failure_kind='input_invalid',
          error_json=?,completed_at=? WHERE id=?`).run(stableJson({ code: "direction-catalog-too-large" }),
            now, jobRunId);
        if (triggerId !== null) {
          this.#database.prepare("UPDATE paper_organization_triggers SET state='failed' WHERE id=?")
            .run(triggerId);
        }
      }
    })();
    return jobRunId;
  }

  async #run(run: QueuedRun, controller: AbortController): Promise<void> {
    const started = this.#now().getTime();
    const timer = setTimeout(() => controller.abort(new Error("paper-organization-hard-timeout")),
      this.#hardTimeoutMs);
    const heartbeat = setInterval(() => {
      const now = this.#now();
      this.#database.prepare(`UPDATE job_runs SET heartbeat_at=?,lease_expires_at=?
        WHERE id=? AND state='running' AND run_epoch=?`).run(now.toISOString(),
          new Date(now.getTime() + 30_000).toISOString(), run.id, run.run_epoch);
    }, 10_000);
    heartbeat.unref();
    try {
      const manifest = JSON.parse(this.#database.prepare(
        "SELECT manifest_json FROM paper_organization_manifests WHERE id=?",
      ).pluck().get(run.manifest_id) as string) as PaperOrganizationManifest;
      const directions = JSON.parse(this.#database.prepare(`SELECT c.catalog_json
        FROM paper_organization_catalog_snapshots c JOIN paper_organization_manifests m
          ON m.catalog_snapshot_id=c.id WHERE m.id=?`).pluck().get(run.manifest_id) as string) as
        OrganizationDirectionSnapshot[];
      const rawResult = await this.runner.analyze({
        context: manifest,
        directions,
        signal: controller.signal,
        onActivity: (activity) => this.#activity(run.id, run.run_epoch, activity),
      });
      const result = normalizePaperOrganizationAgentResult(rawResult);
      validatePaperOrganizationAgentResult(result, manifest, directions);
      this.#commitSuccess(run, manifest, directions, result, this.#now().getTime() - started);
    } catch (error) {
      const reason = controller.signal.reason;
      const timedOut = controller.signal.aborted && reason instanceof Error &&
        reason.message === "paper-organization-hard-timeout";
      const interrupted = controller.signal.aborted && reason instanceof Error &&
        reason.message === "application-closing";
      this.#commitFailure(run, timedOut ? "timed_out" : interrupted ? "interrupted" : "failed", error);
    } finally {
      clearTimeout(timer);
      clearInterval(heartbeat);
    }
  }

  #activity(jobRunId: string, epoch: number, activity: { type: string; text: string;
    metadata?: Record<string, unknown> }): void {
    if (!activity.type || !activity.text) return;
    this.#database.prepare(`INSERT INTO agent_run_activities
      (job_run_id,run_epoch,event_type,display_text,metadata_json,created_at)
      SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM job_runs WHERE id=? AND state='running' AND run_epoch=?)`)
      .run(jobRunId, epoch, activity.type, activity.text.slice(0, 500),
        stableJson(activity.metadata ?? {}), this.#now().toISOString(), jobRunId, epoch);
  }

  #commitSuccess(
    run: QueuedRun,
    manifest: PaperOrganizationManifest,
    directions: OrganizationDirectionSnapshot[],
    result: PaperOrganizationAgentResult,
    elapsedMs: number,
  ): void {
    const now = this.#now().toISOString();
    const groupId = `paper-organization-group:${run.id}`;
    const semanticHashes = new Map(directions.map((direction) => [direction.topicId, direction.semanticHash]));
    const beforePrimary = manifest.organization.directions.find((direction) => direction.role === "primary") ?? null;
    const beforeSecondary = manifest.organization.directions.filter((direction) => direction.role === "secondary");
    const outcomes: Record<string, unknown> = {
      coreProblem: result.coreProblem,
      mainContribution: result.mainContribution,
      alias: result.alias?.outcome ?? "out-of-scope",
      primary: result.primary?.outcome ?? (manifest.lockedPrimaryTopicId ? "locked" : "out-of-scope"),
      secondary: result.secondary?.outcome ?? "out-of-scope",
    };
    const proposals: Array<{ section: string; payload: Record<string, unknown> }> = [];
    if (result.alias?.outcome === "proposal") {
      const after = result.alias.candidates.map((candidate) => ({
        name: candidate.name.trim(),
        kind: candidate.kind,
        preferred: candidate.preferred,
      }));
      const collisions = after.filter((alias) => {
        const normalized = normalizePaperLookup(alias.name);
        return Boolean(this.#database.prepare(`SELECT 1 FROM paper_aliases
          WHERE normalized_name=? AND paper_id<>? LIMIT 1`).get(normalized, manifest.paper.id)) ||
          Boolean(this.#database.prepare(`SELECT 1 FROM paper_catalog_documents
            WHERE lower(canonical_title)=lower(?) AND paper_id<>? LIMIT 1`).get(alias.name, manifest.paper.id));
      }).map((alias) => alias.name);
      proposals.push({ section: "alias", payload: {
        before: manifest.organization.aliases,
        after,
        rationales: result.alias.candidates.map((candidate) => ({
          name: candidate.name.trim(),
          rationale: candidate.rationale,
        })),
        collisionWarnings: collisions,
      } });
    }
    if (result.primary && ["proposal", "ambiguous"].includes(result.primary.outcome)) {
      proposals.push({ section: "primary-direction", payload: {
        before: beforePrimary,
        after: result.primary.recommendedTopicId
          ? { topicId: result.primary.recommendedTopicId, role: "primary" } : null,
        rationale: result.primary.rationale,
        alternatives: result.primary.alternatives,
        targetSemanticHashes: Object.fromEntries([
          result.primary.recommendedTopicId,
          ...result.primary.alternatives.map((alternative) => alternative.topicId),
        ].filter((id): id is string => Boolean(id)).map((id) => [id, semanticHashes.get(id)])),
        ambiguous: result.primary.outcome === "ambiguous",
      } });
    }
    const conditionedOnPrimaryTopicId = manifest.lockedPrimaryTopicId ??
      (result.primary?.outcome === "proposal" ? result.primary.recommendedTopicId : null);
    if (result.primary?.outcome === "ambiguous") {
      outcomes.secondary = "blocked-on-primary-ambiguity";
    } else if (result.secondary && ["proposal", "ambiguous"].includes(result.secondary.outcome) &&
        conditionedOnPrimaryTopicId) {
      proposals.push({ section: "secondary-direction", payload: {
        before: beforeSecondary,
        after: result.secondary.candidates.map((candidate) => ({
          topicId: candidate.topicId,
          role: "secondary",
        })),
        rationales: result.secondary.candidates,
        ambiguous: result.secondary.outcome === "ambiguous",
        conditionedOnPrimaryTopicId,
        targetSemanticHashes: Object.fromEntries(result.secondary.candidates.map((candidate) =>
          [candidate.topicId, semanticHashes.get(candidate.topicId)])),
      } });
    }
    this.#database.transaction(() => {
      const active = this.#database.prepare("SELECT 1 FROM job_runs WHERE id=? AND state='running' AND run_epoch=?")
        .get(run.id, run.run_epoch);
      if (!active) return;
      for (const proposal of proposals) {
        this.#database.prepare(`UPDATE proposals SET review_status='superseded',decided_at=?
          WHERE paper_id=? AND proposal_type='paper-organization' AND review_status='pending'
            AND json_extract(payload_json,'$.sourceKind')='agent'
            AND json_extract(payload_json,'$.changeKind')=?`).run(now, manifest.paper.id, proposal.section);
        const proposalId = `proposal:${randomUUID()}`;
        this.#database.prepare(`INSERT INTO proposals
          (id,proposal_type,paper_id,payload_json,review_status,one_click_eligible,created_at)
          VALUES (?,'paper-organization',?,?,'pending',1,?)`).run(proposalId, manifest.paper.id,
            stableJson({
              contractVersion: PAPER_ORGANIZATION_CONTRACT_VERSION,
              sourceKind: "agent",
              changeKind: proposal.section,
              operation: "replace",
              groupId,
              jobRunId: run.id,
              manifestId: run.manifest_id,
              summaryRevisionId: manifest.summary.revisionId,
              paperManifestHash: manifest.paperManifest.hash,
              ...proposal.payload,
            }), now);
      }
      this.#database.prepare(`UPDATE paper_organization_runs SET proposal_group_id=?,outcome_json=?
        WHERE job_run_id=?`).run(groupId, stableJson(outcomes), run.id);
      const execution = this.#agentExecutionMetadata?.("paper-organization") ?? null;
      this.#database.prepare(`INSERT INTO agent_runs(job_run_id,task_kind,model,reasoning_effort,codex_version,
        configuration_version,skill_path,skill_content_hash,context_snapshot_id,output_schema_hash,prompt_hash,output_json)
        VALUES (?,'paper-organization',?,?,?,?,'skills/paper-organization/SKILL.md',?,NULL,?,?,?)`)
        .run(run.id, execution?.model ?? null, execution?.reasoningEffort ?? null,
          execution?.codexVersion ?? "unknown", execution?.configurationVersion ?? null,
          manifest.skillHash, manifest.schemaHash, manifest.promptHash, stableJson(result));
      this.#database.prepare(`INSERT INTO agent_run_usage(job_run_id,run_epoch,status,input_tokens,cached_input_tokens,
        output_tokens,total_tokens,elapsed_ms,recorded_at) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(run.id, run.run_epoch, result.usage.status, result.usage.inputTokens ?? null,
          result.usage.cachedInputTokens ?? null, result.usage.outputTokens ?? null,
          result.usage.totalTokens ?? null, elapsedMs, now);
      this.#database.prepare(`UPDATE job_runs SET state='succeeded',progress=1,output_json=?,completed_at=?,
        heartbeat_at=?,lease_owner=NULL,lease_expires_at=NULL
        WHERE id=? AND state='running' AND run_epoch=?`).run(stableJson(result), now, now, run.id, run.run_epoch);
      if (run.trigger_id !== null) {
        this.#database.prepare("UPDATE paper_organization_triggers SET state='complete' WHERE id=?")
          .run(run.trigger_id);
      }
      this.#database.prepare(`INSERT INTO durable_events(scope,event_type,data_json,created_at)
        VALUES (?,'paper-organization-complete',?,?)`).run(manifest.paper.id,
          stableJson({ jobRunId: run.id, groupId, proposalCount: proposals.length }), now);
    })();
  }

  #commitFailure(run: QueuedRun, state: "failed" | "timed_out" | "interrupted", error: unknown): void {
    const now = this.#now().toISOString();
    const code = error instanceof Error ? error.message : String(error);
    this.#database.transaction(() => {
      const changed = this.#database.prepare(`UPDATE job_runs SET state=?,progress=1,error_json=?,failure_kind=?,
        completed_at=?,heartbeat_at=?,lease_owner=NULL,lease_expires_at=NULL
        WHERE id=? AND state='running' AND run_epoch=?`).run(state, stableJson({ code }),
          state === "timed_out" ? "timed_out" : state === "interrupted" ? "process_interrupted"
            : code.startsWith("organization-agent-") ? "output_invalid" : "runner_failed",
          now, now, run.id, run.run_epoch).changes;
      if (!changed) return;
      this.#database.prepare(`INSERT OR IGNORE INTO agent_run_usage
        (job_run_id,run_epoch,status,elapsed_ms,recorded_at) VALUES (?,?,'unavailable',0,?)`)
        .run(run.id, run.run_epoch, now);
      if (run.trigger_id !== null) {
        this.#database.prepare("UPDATE paper_organization_triggers SET state='failed' WHERE id=?")
          .run(run.trigger_id);
      }
    })();
  }
}
