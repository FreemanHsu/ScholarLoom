import { createHash, randomUUID } from "node:crypto";

import Database from "better-sqlite3";

import { normalizePaperLookup, type PaperAlias } from "../domain/paper-organization.js";
import type { StorageLayout } from "./layout.js";
import { PaperOrganizationStoreError } from "./paper-organization-store.js";

const MINIMUM_LABELS = 75;
const MATURITY_DAYS = 30;
const HOLDOUT_MODULUS = 10;
const DAILY_CAP = 10;
const NORMALIZATION_VERSION = "paper-lookup.v1";
const PREDICATE_VERSION = "alias-auto-accept.v1";

const stableJson = (value: unknown) => JSON.stringify(value, (_key, item) => {
  if (!item || typeof item !== "object" || Array.isArray(item)) return item;
  return Object.fromEntries(Object.entries(item as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right)));
});
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const plusDays = (value: string, days: number) =>
  new Date(new Date(value).getTime() + days * 86_400_000).toISOString();

function localDay(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function wilsonLowerBound(successes: number, total: number): number {
  if (total <= 0) return 0;
  const z = 1.959963984540054;
  const ratio = successes / total;
  const z2 = z * z;
  const center = ratio + z2 / (2 * total);
  const spread = z * Math.sqrt((ratio * (1 - ratio) + z2 / (4 * total)) / total);
  return (center - spread) / (1 + z2 / total);
}

type AutomationSource = {
  paperOrganizationProposalState(proposalId: string): {
    applicability: "ready" | "blocked" | "stale";
    materialization: "not-started" | "applying" | "succeeded" | "failed" | "conflicted";
  };
  decidePaperOrganizationProposal(proposalId: string, input: {
    action?: unknown;
    value?: unknown;
    automation?: unknown;
  }, idempotencyKey: string): unknown;
  savePaperOrganization(paperId: string, input: unknown, idempotencyKey: string): unknown;
};

type PolicyTuple = {
  modelIdentity: string;
  promptHash: string;
  schemaHash: string;
  normalizationVersion: typeof NORMALIZATION_VERSION;
  predicateVersion: typeof PREDICATE_VERSION;
};

export class PaperOrganizationAutomation {
  readonly #database: Database.Database;
  readonly #now: () => Date;

  constructor(layout: StorageLayout, private readonly source: AutomationSource, now: () => Date = () => new Date()) {
    this.#database = new Database(layout.databasePath);
    this.#database.pragma("foreign_keys = ON");
    this.#database.pragma("busy_timeout = 5000");
    this.#now = now;
    this.reconcileOrphans();
  }

  close(): void {
    this.#database.close();
  }

  syncLabels(): { synchronized: number } {
    const rows = this.#database.prepare(`SELECT p.id,p.paper_id,p.payload_json,p.review_status,p.decided_at,
      d.id decision_id,d.result_json,m.manifest_json,a.model
      FROM proposals p
      LEFT JOIN review_decisions d ON d.proposal_id=p.id
      LEFT JOIN paper_organization_manifests m ON m.id=json_extract(p.payload_json,'$.manifestId')
      LEFT JOIN agent_runs a ON a.job_run_id=json_extract(p.payload_json,'$.jobRunId')
      WHERE p.proposal_type='paper-organization'
        AND json_extract(p.payload_json,'$.sourceKind')='agent'
        AND json_extract(p.payload_json,'$.changeKind')='alias'
        AND p.review_status IN ('accepted','rejected')
        AND p.decided_at IS NOT NULL
      ORDER BY p.decided_at,p.id`).all() as Array<{
        id: string; paper_id: string; payload_json: string; review_status: string; decided_at: string;
        decision_id: string | null; result_json: string | null; manifest_json: string | null; model: string | null;
      }>;
    let synchronized = 0;
    const now = this.#now().toISOString();
    const upsert = this.#database.prepare(`INSERT INTO paper_organization_calibration_labels
      (proposal_id,paper_id,normalized_alias,outcome,exclusion_reason,review_decision_id,
       proposal_hash,resulting_hash,policy_tuple_hash,terminal_at,matures_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(proposal_id) DO UPDATE SET outcome=excluded.outcome,
        exclusion_reason=excluded.exclusion_reason,resulting_hash=excluded.resulting_hash,
        updated_at=excluded.updated_at`);
    this.#database.transaction(() => {
      for (const row of rows) {
        const payload = JSON.parse(row.payload_json) as {
          after?: PaperAlias[]; collisionWarnings?: string[]; jobRunId?: string;
        };
        const decision = row.result_json ? JSON.parse(row.result_json) as {
          edited?: boolean; resultingOrganization?: unknown;
        } : null;
        const manifest = row.manifest_json ? JSON.parse(row.manifest_json) as {
          promptHash?: string; schemaHash?: string;
        } : null;
        const tuple = this.#tuple({
          modelIdentity: row.model ?? "unknown",
          promptHash: manifest?.promptHash ?? "unknown",
          schemaHash: manifest?.schemaHash ?? "unknown",
        });
        const alias = this.#normalizedAlias(payload.after ?? []);
        const exclusionReason = (payload.collisionWarnings?.length ?? 0) > 0
          ? "collision-warning" : !alias ? "empty-alias" : null;
        const outcome = exclusionReason ? "excluded"
          : row.review_status === "rejected" ? "rejected"
            : decision?.edited ? "accepted-edited" : "accepted-unchanged";
        upsert.run(row.id, row.paper_id, alias || "excluded", outcome, exclusionReason,
          row.decision_id, sha256(row.payload_json), decision?.resultingOrganization
            ? sha256(stableJson(decision.resultingOrganization)) : null,
          sha256(stableJson(tuple)), row.decided_at, plusDays(row.decided_at, MATURITY_DAYS), now, now);
        synchronized += 1;
      }
    })();
    return { synchronized };
  }

  evaluate(): ReturnType<PaperOrganizationAutomation["readEvaluation"]> {
    this.syncLabels();
    const tuple = this.#currentTuple();
    const tupleHash = sha256(stableJson(tuple));
    const windowEnd = this.#now().toISOString();
    const rows = this.#database.prepare(`SELECT proposal_id,outcome,proposal_hash,resulting_hash,
      exclusion_reason,matures_at FROM paper_organization_calibration_labels
      WHERE policy_tuple_hash=? AND terminal_at<=? ORDER BY terminal_at,proposal_id`)
      .all(tupleHash, windowEnd) as Array<{ proposal_id: string; outcome: string; proposal_hash: string;
        resulting_hash: string | null; exclusion_reason: string | null; matures_at: string }>;
    const mature = rows.filter((row) => row.matures_at <= windowEnd);
    const included = mature.filter((row) => row.outcome !== "excluded");
    const accepted = included.filter((row) => row.outcome === "accepted-unchanged").length;
    const excluded = mature.length - included.length;
    const lower = wilsonLowerBound(accepted, included.length);
    const exclusionRate = mature.length ? excluded / mature.length : 0;
    const reasons = [
      ...(included.length < MINIMUM_LABELS ? [`minimum-labels:${included.length}/${MINIMUM_LABELS}`] : []),
      ...(mature.length < rows.length ? [`immature-labels:${rows.length - mature.length}`] : []),
      ...(lower < .95 ? [`wilson-lower:${lower.toFixed(6)}`] : []),
      ...(included.length !== accepted ? [`non-unchanged:${included.length - accepted}`] : []),
      ...(exclusionRate > .1 ? [`exclusion-rate:${exclusionRate.toFixed(6)}`] : []),
    ];
    const sampleHash = sha256(stableJson(mature.map((row) => ({
      proposalId: row.proposal_id,
      outcome: row.outcome,
      proposalHash: row.proposal_hash,
      resultingHash: row.resulting_hash,
      exclusionReason: row.exclusion_reason,
    }))));
    const payload = { tupleHash, windowEnd, populationCount: rows.length, labelCount: included.length,
      acceptedCount: accepted, excludedCount: excluded, wilsonLower: lower, exclusionRate,
      sampleHash, passed: reasons.length === 0, reasons };
    const evaluationHash = sha256(stableJson(payload));
    const id = `paper-organization-evaluation:${evaluationHash}`;
    this.#database.prepare(`INSERT OR IGNORE INTO paper_organization_policy_evaluations
      (id,evaluation_hash,policy_tuple_hash,window_end,population_count,label_count,accepted_count,
       excluded_count,wilson_lower,exclusion_rate,sample_hash,passed,reasons_json,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, evaluationHash, tupleHash, windowEnd,
        rows.length, included.length, accepted, excluded, lower, exclusionRate, sampleHash,
        reasons.length ? 0 : 1, stableJson(reasons), windowEnd);
    return this.readEvaluation(id);
  }

  createPolicy(evaluationId: string, actor = "owner") {
    const evaluation = this.readEvaluation(evaluationId);
    if (!evaluation.passed) throw new PaperOrganizationStoreError("alias-automation-evaluation-not-passing", 409);
    const tuple = this.#currentTuple();
    if (sha256(stableJson(tuple)) !== evaluation.policyTupleHash) {
      throw new PaperOrganizationStoreError("alias-automation-policy-drift", 409);
    }
    const version = Number(this.#database.prepare("SELECT coalesce(max(version),0)+1 FROM paper_organization_auto_policies")
      .pluck().get());
    const id = `paper-organization-auto-policy:v${version}`;
    const now = this.#now().toISOString();
    this.#database.prepare(`INSERT INTO paper_organization_auto_policies
      (id,version,status,evaluation_id,policy_tuple_hash,model_identity,prompt_hash,schema_hash,
       normalization_version,predicate_version,minimum_labels,maturity_days,holdout_modulus,daily_cap,
       created_by,created_at) VALUES (?,?, 'eligible',?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, version, evaluationId, evaluation.policyTupleHash, tuple.modelIdentity, tuple.promptHash,
        tuple.schemaHash, tuple.normalizationVersion, tuple.predicateVersion, MINIMUM_LABELS,
        MATURITY_DAYS, HOLDOUT_MODULUS, DAILY_CAP, actor, now);
    return this.readPolicy(id);
  }

  enablePolicy(id: string, actor = "owner") {
    const policy = this.readPolicy(id);
    if (!['eligible', 'suspended'].includes(policy.status)) {
      throw new PaperOrganizationStoreError("alias-automation-policy-not-enableable", 409);
    }
    const fresh = this.evaluate();
    if (!fresh.passed || fresh.policyTupleHash !== policy.policyTupleHash) {
      throw new PaperOrganizationStoreError("alias-automation-fresh-evaluation-required", 409);
    }
    const now = this.#now().toISOString();
    this.#database.transaction(() => {
      this.#database.prepare(`UPDATE paper_organization_auto_policies SET status='retired'
        WHERE status='enabled' AND id<>?`).run(id);
      this.#database.prepare(`UPDATE paper_organization_auto_policies SET status='enabled',enabled_by=?,
        enabled_at=?,suspended_at=NULL,suspension_reason=NULL WHERE id=?`).run(actor, now, id);
    })();
    return this.readPolicy(id);
  }

  suspendPolicy(id: string, reason = "owner-request") {
    const changed = this.#database.prepare(`UPDATE paper_organization_auto_policies
      SET status='suspended',suspended_at=?,suspension_reason=? WHERE id=? AND status='enabled'`)
      .run(this.#now().toISOString(), reason, id).changes;
    if (!changed && this.readPolicy(id).status !== "suspended") {
      throw new PaperOrganizationStoreError("alias-automation-policy-not-enabled", 409);
    }
    return this.readPolicy(id);
  }

  processPending(): { observed: number; automatic: number } {
    const proposals = this.#database.prepare(`SELECT p.id FROM proposals p
      JOIN paper_organization_runs r ON r.job_run_id=json_extract(p.payload_json,'$.jobRunId')
      WHERE p.proposal_type='paper-organization' AND p.review_status='pending'
        AND json_extract(p.payload_json,'$.sourceKind')='agent'
        AND json_extract(p.payload_json,'$.changeKind')='alias'
        AND r.trigger_id IS NOT NULL
      ORDER BY p.created_at,p.id LIMIT 32`).all() as Array<{ id: string }>;
    let observed = 0;
    let automatic = 0;
    for (const proposal of proposals) {
      try {
        const result = this.#processProposal(proposal.id);
        if (result) observed += 1;
        if (result === "automatic") automatic += 1;
      } catch (error) {
        if (!(error instanceof PaperOrganizationStoreError)) throw error;
      }
    }
    return { observed, automatic };
  }

  automationModel() {
    this.syncLabels();
    const policies = this.#database.prepare(`SELECT id FROM paper_organization_auto_policies
      ORDER BY version DESC`).all().map((row) => this.readPolicy((row as { id: string }).id));
    const latestEvaluationId = this.#database.prepare(`SELECT id FROM paper_organization_policy_evaluations
      ORDER BY created_at DESC,id DESC LIMIT 1`).pluck().get() as string | undefined;
    const counts = Object.fromEntries((this.#database.prepare(`SELECT state,count(*) count
      FROM paper_organization_auto_events GROUP BY state`).all() as Array<{ state: string; count: number }>)
      .map((row) => [row.state, row.count]));
    const active = policies.find((policy) => policy.status === "enabled") ?? null;
    const labelCount = Number(this.#database.prepare("SELECT count(*) FROM paper_organization_calibration_labels").pluck().get());
    return {
      mode: active ? "enabled" : policies[0]?.status === "suspended" ? "suspended"
        : latestEvaluationId ? "insufficient-evidence" : "disabled",
      aliasOnly: true,
      gates: { minimumLabels: MINIMUM_LABELS, maturityDays: MATURITY_DAYS,
        wilsonLower: .95, holdoutRate: .1, dailyCap: DAILY_CAP },
      labelCount,
      latestEvaluation: latestEvaluationId ? this.readEvaluation(latestEvaluationId) : null,
      policies,
      eventCounts: counts,
      events: this.listEvents(20),
    };
  }

  listEvents(limit = 50) {
    return (this.#database.prepare(`SELECT * FROM paper_organization_auto_events
      ORDER BY created_at DESC,id DESC LIMIT ?`).all(Math.max(1, Math.min(200, limit))) as Array<Record<string, unknown>>)
      .map((row) => ({ id: row.id, proposalId: row.proposal_id, paperId: row.paper_id,
        policyId: row.policy_id, kind: row.event_kind, state: row.state, errorCode: row.error_code,
        createdAt: row.created_at, completedAt: row.completed_at }));
  }

  undoPreview(eventId: string) {
    const event = this.#event(eventId);
    const safe = event.state === "succeeded" && this.#currentAliases(event.paper_id) === event.after_json;
    return { eventId, safe, before: JSON.parse(event.before_json), after: JSON.parse(event.after_json),
      reason: safe ? null : "alias-section-changed" };
  }

  undo(eventId: string) {
    const event = this.#event(eventId);
    const preview = this.undoPreview(eventId);
    if (!preview.safe) throw new PaperOrganizationStoreError("alias-automation-undo-stale", 409);
    const directions = (this.#database.prepare(`SELECT topic_id,assignment_role FROM paper_direction_assignments
      WHERE paper_id=? ORDER BY ordinal`).all(event.paper_id) as Array<{
        topic_id: string; assignment_role: "primary" | "secondary";
      }>).map((row) => ({ topicId: row.topic_id, role: row.assignment_role }));
    const result = this.source.savePaperOrganization(event.paper_id, {
      aliases: JSON.parse(event.before_json), directions,
    }, `alias-automation-undo:${event.id}`);
    const now = this.#now().toISOString();
    this.#database.transaction(() => {
      this.#database.prepare(`UPDATE paper_organization_auto_events SET state='undone',result_json=?,
        updated_at=?,completed_at=? WHERE id=? AND state='succeeded'`).run(stableJson(result), now, now, event.id);
      this.#database.prepare(`INSERT OR IGNORE INTO paper_organization_auto_ineligibility
        (paper_id,normalized_alias,reason,source_event_id,created_at) VALUES (?,?,'owner-undo',?,?)`)
        .run(event.paper_id, event.normalized_alias, event.id, now);
      if (event.policy_id) this.#database.prepare(`UPDATE paper_organization_auto_policies
        SET status='suspended',suspended_at=?,suspension_reason='owner-undo'
        WHERE id=? AND status='enabled'`).run(now, event.policy_id);
      this.#database.prepare(`UPDATE paper_organization_calibration_labels SET outcome='reversed',
        exclusion_reason=NULL,updated_at=? WHERE proposal_id=?`).run(now, event.proposal_id);
    })();
    return { eventId, state: "undone", policySuspended: Boolean(event.policy_id), result };
  }

  reconcileOrphans(): void {
    const now = this.#now().toISOString();
    const rows = this.#database.prepare(`SELECT e.id,e.proposal_id FROM paper_organization_auto_events e
      WHERE e.state IN ('reserved','applying')`).all() as Array<{ id: string; proposal_id: string }>;
    for (const row of rows) {
      const decision = this.#database.prepare(`SELECT result_json FROM review_decisions WHERE proposal_id=?
        ORDER BY created_at DESC LIMIT 1`).get(row.proposal_id) as { result_json: string } | undefined;
      const result = decision ? JSON.parse(decision.result_json) as { automation?: { eventId?: string } } : null;
      const succeeded = result?.automation?.eventId === row.id;
      this.#database.prepare(`UPDATE paper_organization_auto_events SET state=?,result_json=?,error_code=?,
        updated_at=?,completed_at=? WHERE id=?`).run(succeeded ? "succeeded" : "skipped",
          decision?.result_json ?? null, succeeded ? null : "orphaned-reservation-manual",
          now, now, row.id);
    }
  }

  readEvaluation(id: string) {
    const row = this.#database.prepare("SELECT * FROM paper_organization_policy_evaluations WHERE id=?")
      .get(id) as Record<string, unknown> | undefined;
    if (!row) throw new PaperOrganizationStoreError("alias-automation-evaluation-not-found", 404);
    return { id: String(row.id), evaluationHash: String(row.evaluation_hash),
      policyTupleHash: String(row.policy_tuple_hash), windowEnd: String(row.window_end),
      populationCount: Number(row.population_count), labelCount: Number(row.label_count),
      acceptedCount: Number(row.accepted_count), excludedCount: Number(row.excluded_count),
      wilsonLower: Number(row.wilson_lower), exclusionRate: Number(row.exclusion_rate),
      sampleHash: String(row.sample_hash), passed: Boolean(row.passed),
      reasons: JSON.parse(String(row.reasons_json)) as string[] };
  }

  readPolicy(id: string) {
    const row = this.#database.prepare("SELECT * FROM paper_organization_auto_policies WHERE id=?")
      .get(id) as Record<string, unknown> | undefined;
    if (!row) throw new PaperOrganizationStoreError("alias-automation-policy-not-found", 404);
    return { id: String(row.id), version: Number(row.version), status: String(row.status),
      evaluationId: String(row.evaluation_id), policyTupleHash: String(row.policy_tuple_hash),
      modelIdentity: String(row.model_identity), promptHash: String(row.prompt_hash),
      schemaHash: String(row.schema_hash), normalizationVersion: String(row.normalization_version),
      predicateVersion: String(row.predicate_version), minimumLabels: Number(row.minimum_labels),
      maturityDays: Number(row.maturity_days), holdoutModulus: Number(row.holdout_modulus),
      dailyCap: Number(row.daily_cap), createdAt: String(row.created_at),
      enabledAt: row.enabled_at ? String(row.enabled_at) : null,
      suspendedAt: row.suspended_at ? String(row.suspended_at) : null,
      suspensionReason: row.suspension_reason ? String(row.suspension_reason) : null };
  }

  #processProposal(proposalId: string): "shadow" | "holdout" | "automatic" | null {
    const row = this.#database.prepare(`SELECT p.paper_id,p.payload_json,m.manifest_json,a.model
      FROM proposals p
      JOIN paper_organization_manifests m ON m.id=json_extract(p.payload_json,'$.manifestId')
      LEFT JOIN agent_runs a ON a.job_run_id=json_extract(p.payload_json,'$.jobRunId')
      WHERE p.id=? AND p.review_status='pending'`).get(proposalId) as {
        paper_id: string; payload_json: string; manifest_json: string; model: string | null;
      } | undefined;
    if (!row) return null;
    const payload = JSON.parse(row.payload_json) as { sourceKind?: string; changeKind?: string;
      after?: PaperAlias[]; before?: PaperAlias[]; rationales?: Array<{ rationale?: string }>;
      collisionWarnings?: string[] };
    if (payload.sourceKind !== "agent" || payload.changeKind !== "alias" ||
        !payload.after?.length || payload.collisionWarnings?.length ||
        !payload.rationales?.length || payload.rationales.some((item) => !item.rationale?.trim())) return null;
    const normalizedAlias = this.#normalizedAlias(payload.after);
    if (!normalizedAlias || this.#database.prepare(`SELECT 1 FROM paper_organization_auto_ineligibility
      WHERE paper_id=? AND normalized_alias=?`).get(row.paper_id, normalizedAlias)) return null;
    if (this.#hasLiveCollision(row.paper_id, payload.after)) return null;
    const state = this.source.paperOrganizationProposalState(proposalId);
    if (state.applicability !== "ready" || state.materialization !== "not-started") return null;
    const proposalHash = sha256(row.payload_json);
    const snapshotHash = sha256(stableJson({ proposalHash, state }));
    const now = this.#now();
    const day = localDay(now);
    const policyRow = this.#database.prepare(`SELECT id,evaluation_id,policy_tuple_hash,version
      FROM paper_organization_auto_policies WHERE status='enabled'`).get() as {
        id: string; evaluation_id: string; policy_tuple_hash: string; version: number;
      } | undefined;
    if (!policyRow) {
      this.#insertEvent({ proposalId, paperId: row.paper_id, normalizedAlias, policyId: null,
        kind: "shadow", state: "would-accept", proposalHash, snapshotHash, evaluationHash: null,
        before: payload.before ?? [], after: payload.after, rationale: payload.rationales.map((item) => item.rationale).join(" "), day });
      return "shadow";
    }
    const tuple = this.#tupleFromManifest(row.model, row.manifest_json);
    if (sha256(stableJson(tuple)) !== policyRow.policy_tuple_hash) {
      this.suspendPolicy(policyRow.id, "semantic-drift");
      return null;
    }
    const evaluation = this.readEvaluation(policyRow.evaluation_id);
    if (Number.parseInt(sha256(proposalId).slice(0, 8), 16) % HOLDOUT_MODULUS === 0) {
      this.#insertEvent({ proposalId, paperId: row.paper_id, normalizedAlias, policyId: policyRow.id,
        kind: "holdout", state: "skipped", proposalHash, snapshotHash,
        evaluationHash: evaluation.evaluationHash, before: payload.before ?? [], after: payload.after,
        rationale: "deterministic-manual-holdout", day });
      return "holdout";
    }
    const acceptedToday = Number(this.#database.prepare(`SELECT count(*) FROM paper_organization_auto_events
      WHERE event_kind='automatic' AND state='succeeded' AND local_day=?`).pluck().get(day));
    if (acceptedToday >= DAILY_CAP) return null;
    const event = this.#insertEvent({ proposalId, paperId: row.paper_id, normalizedAlias, policyId: policyRow.id,
      kind: "automatic", state: "reserved", proposalHash, snapshotHash,
      evaluationHash: evaluation.evaluationHash, before: payload.before ?? [], after: payload.after,
      rationale: payload.rationales.map((item) => item.rationale).join(" "), day });
    if (!event.created) return null;
    const metadata = { actor: "agent-auto", eventId: event.id, policyId: policyRow.id,
      policyVersion: policyRow.version, evaluationHash: evaluation.evaluationHash,
      proposalHash, predicateVersion: PREDICATE_VERSION, snapshotHash };
    try {
      this.#database.prepare(`UPDATE paper_organization_auto_events SET state='applying',updated_at=? WHERE id=?`)
        .run(now.toISOString(), event.id);
      const result = this.source.decidePaperOrganizationProposal(proposalId,
        { action: "accept", automation: metadata }, event.idempotencyKey);
      const completed = this.#now().toISOString();
      this.#database.prepare(`UPDATE paper_organization_auto_events SET state='succeeded',result_json=?,
        updated_at=?,completed_at=? WHERE id=?`).run(stableJson(result), completed, completed, event.id);
      return "automatic";
    } catch (error) {
      const code = error instanceof Error ? error.message : String(error);
      const stateValue = code.includes("conflict") || code.includes("stale") ? "conflicted" : "failed";
      const completed = this.#now().toISOString();
      this.#database.prepare(`UPDATE paper_organization_auto_events SET state=?,error_code=?,
        updated_at=?,completed_at=? WHERE id=?`).run(stateValue, code, completed, completed, event.id);
      this.suspendPolicy(policyRow.id, `execution-${stateValue}`);
      return null;
    }
  }

  #insertEvent(input: { proposalId: string; paperId: string; normalizedAlias: string; policyId: string | null;
    kind: "shadow" | "holdout" | "automatic"; state: string; proposalHash: string; snapshotHash: string;
    evaluationHash: string | null; before: PaperAlias[]; after: PaperAlias[]; rationale: string; day: string }) {
    const identity = stableJson({ proposalId: input.proposalId, proposalHash: input.proposalHash,
      policyId: input.policyId, kind: input.kind, snapshotHash: input.snapshotHash });
    const key = `alias-automation:${sha256(identity)}`;
    const existing = this.#database.prepare("SELECT id FROM paper_organization_auto_events WHERE idempotency_key=?")
      .pluck().get(key) as string | undefined;
    if (existing) return { id: existing, idempotencyKey: key, created: false };
    const id = `paper-organization-auto-event:${randomUUID()}`;
    const now = this.#now().toISOString();
    this.#database.prepare(`INSERT INTO paper_organization_auto_events
      (id,proposal_id,paper_id,normalized_alias,policy_id,event_kind,state,proposal_hash,snapshot_hash,
       evaluation_hash,idempotency_key,before_json,after_json,rationale,local_day,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, input.proposalId, input.paperId,
        input.normalizedAlias, input.policyId, input.kind, input.state, input.proposalHash,
        input.snapshotHash, input.evaluationHash, key, stableJson(input.before), stableJson(input.after),
        input.rationale.slice(0, 2_000), input.day, now, now);
    return { id, idempotencyKey: key, created: true };
  }

  #event(id: string) {
    const row = this.#database.prepare("SELECT * FROM paper_organization_auto_events WHERE id=?")
      .get(id) as Record<string, unknown> | undefined;
    if (!row) throw new PaperOrganizationStoreError("alias-automation-event-not-found", 404);
    return row as { id: string; proposal_id: string; paper_id: string; normalized_alias: string;
      policy_id: string | null; state: string; before_json: string; after_json: string };
  }

  #normalizedAlias(aliases: PaperAlias[]): string {
    const alias = aliases.find((item) => item.preferred) ?? aliases[0];
    return alias ? normalizePaperLookup(alias.name) : "";
  }

  #hasLiveCollision(paperId: string, aliases: PaperAlias[]): boolean {
    return aliases.some((alias) => Boolean(this.#database.prepare(`SELECT 1 FROM paper_aliases
      WHERE normalized_name=? AND paper_id<>? LIMIT 1`).get(normalizePaperLookup(alias.name), paperId)) ||
      Boolean(this.#database.prepare(`SELECT 1 FROM paper_catalog_documents
        WHERE lower(canonical_title)=lower(?) AND paper_id<>? LIMIT 1`).get(alias.name, paperId)));
  }

  #currentAliases(paperId: string): string {
    const aliases = (this.#database.prepare(`SELECT name,alias_kind,preferred FROM paper_aliases
      WHERE paper_id=? ORDER BY ordinal`).all(paperId) as Array<{
        name: string; alias_kind: PaperAlias["kind"]; preferred: number;
      }>)
      .map((alias) => ({ name: alias.name, kind: alias.alias_kind, preferred: Boolean(alias.preferred) }));
    return stableJson(aliases);
  }

  #tuple(input: Pick<PolicyTuple, "modelIdentity" | "promptHash" | "schemaHash">): PolicyTuple {
    return { ...input, normalizationVersion: NORMALIZATION_VERSION, predicateVersion: PREDICATE_VERSION };
  }

  #tupleFromManifest(model: string | null, manifestJson: string): PolicyTuple {
    const manifest = JSON.parse(manifestJson) as { promptHash?: string; schemaHash?: string };
    return this.#tuple({ modelIdentity: model ?? "unknown", promptHash: manifest.promptHash ?? "unknown",
      schemaHash: manifest.schemaHash ?? "unknown" });
  }

  #currentTuple(): PolicyTuple {
    const row = this.#database.prepare(`SELECT a.model,m.manifest_json
      FROM paper_organization_runs r
      JOIN paper_organization_manifests m ON m.id=r.manifest_id
      LEFT JOIN agent_runs a ON a.job_run_id=r.job_run_id
      JOIN job_runs j ON j.id=r.job_run_id AND j.state='succeeded'
      ORDER BY r.sequence DESC LIMIT 1`).get() as { model: string | null; manifest_json: string } | undefined;
    if (row) return this.#tupleFromManifest(row.model, row.manifest_json);
    const fallback = this.#database.prepare(`SELECT policy_tuple_hash FROM paper_organization_calibration_labels
      ORDER BY terminal_at DESC LIMIT 1`).pluck().get() as string | undefined;
    if (fallback) throw new PaperOrganizationStoreError("alias-automation-runtime-tuple-unavailable", 409);
    return this.#tuple({ modelIdentity: "unknown", promptHash: "unknown", schemaHash: "unknown" });
  }
}

export class PaperOrganizationAutoAcceptCoordinator {
  readonly #timer: ReturnType<typeof setInterval>;
  #running = false;

  constructor(readonly automation: PaperOrganizationAutomation) {
    this.#timer = setInterval(() => this.wake(), 250);
    this.#timer.unref();
    queueMicrotask(() => this.wake());
  }

  wake(): void {
    if (this.#running) return;
    this.#running = true;
    try { this.automation.processPending(); } finally { this.#running = false; }
  }

  close(): void {
    clearInterval(this.#timer);
    this.automation.close();
  }
}
