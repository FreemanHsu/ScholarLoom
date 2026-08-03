import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type Database from "better-sqlite3";

import {
  DIRECTION_TAXONOMY_DECISION_VERSION,
  PAPER_LOOKUP_NORMALIZATION_VERSION,
  PAPER_TAXONOMY_CONTRACT_VERSION,
  TAXONOMY_EXCERPT_VERSION,
  TAXONOMY_SELECTION_VERSION,
  type PaperTaxonomyFact,
  type PaperTaxonomyManifest,
} from "../agent/paper-taxonomy.js";
import { normalizePaperLookup } from "../domain/paper-organization.js";
import type { StorageLayout } from "./layout.js";
import type { KnowledgeWriter } from "./knowledge-writer.js";
import { PaperOrganizationStoreError, type PaperOrganizationStore } from "./paper-organization-store.js";

type SelectionMode = "next" | "regenerate" | "refresh";
type DirectionValue = { topicId: string; title: string; aliases: string[]; scope: string; exclusions: string[] };

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const stableJson = (value: unknown) => JSON.stringify(value);

export class PaperTaxonomyStore {
  constructor(
    private readonly database: Database.Database,
    private readonly layout: StorageLayout,
    private readonly now: () => Date,
    private readonly writer: KnowledgeWriter,
    private readonly organization: PaperOrganizationStore,
  ) {}

  bootstrapPreview(mode: SelectionMode = "next", limit = 100, priorManifestId?: string): {
    eligibleCount: number; selectedCount: number; remainingCount: number; paperIds: string[];
  } {
    const papers = this.taxonomyFacts(mode, limit, priorManifestId);
    const eligibleCount = this.taxonomyEligible(mode === "refresh").length;
    return {
      eligibleCount,
      selectedCount: papers.length,
      remainingCount: Math.max(0, eligibleCount - papers.length),
      paperIds: papers.map((paper) => paper.paperId),
    };
  }

  buildTaxonomyManifest(input: {
    mode: SelectionMode;
    limit: number;
    priorManifestId?: string;
    promptHash: string;
    schemaHash: string;
    skillHash: string;
  }): PaperTaxonomyManifest {
    const papers = this.taxonomyFacts(input.mode, input.limit, input.priorManifestId);
    if (papers.length === 0) throw new PaperOrganizationStoreError("paper-taxonomy-cohort-empty", 409);
    const eligibleCount = this.taxonomyEligible(input.mode === "refresh").length;
    const directions = this.directionSnapshots();
    const cohortHash = sha256(stableJson(papers.map((paper) =>
      [paper.paperId, paper.summaryRevisionId, paper.summaryHash])));
    const manifest: PaperTaxonomyManifest = {
      contractVersion: PAPER_TAXONOMY_CONTRACT_VERSION,
      selectionMode: input.mode,
      selectionVersion: TAXONOMY_SELECTION_VERSION,
      excerptVersion: TAXONOMY_EXCERPT_VERSION,
      normalizationVersion: PAPER_LOOKUP_NORMALIZATION_VERSION,
      cohortHash,
      eligibleCount,
      selectedCount: papers.length,
      remainingCount: Math.max(0, eligibleCount - papers.length),
      papers,
      directions,
      promptHash: input.promptHash,
      schemaHash: input.schemaHash,
      skillHash: input.skillHash,
    };
    if ([...stableJson(manifest)].length > 180_000) {
      throw new PaperOrganizationStoreError("paper-taxonomy-manifest-too-large", 409);
    }
    return manifest;
  }

  listTaxonomy(): {
    runs: unknown[];
    proposals: unknown[];
  } {
    const runs = (this.database.prepare(`SELECT j.id,j.state,j.error_json,j.completed_at,
      r.sequence,r.manifest_id,r.outcome_json,m.cohort_hash,m.selection_mode
      FROM paper_taxonomy_runs r JOIN job_runs j ON j.id=r.job_run_id
      JOIN paper_taxonomy_manifests m ON m.id=r.manifest_id
      ORDER BY r.sequence DESC LIMIT 20`).all() as Array<Record<string, unknown>>).map((row) => ({
        id: String(row.id),
        state: String(row.state),
        error: row.error_json ? JSON.parse(String(row.error_json)) : null,
        completedAt: row.completed_at ? String(row.completed_at) : null,
        sequence: Number(row.sequence),
        manifestId: String(row.manifest_id),
        outcome: row.outcome_json ? JSON.parse(String(row.outcome_json)) : null,
        cohortHash: String(row.cohort_hash),
        selectionMode: String(row.selection_mode),
      }));
    const proposals = (this.database.prepare(`SELECT id,payload_json,review_status,created_at,decided_at
      FROM proposals WHERE proposal_type='direction-taxonomy'
        AND json_extract(payload_json,'$.sourceKind')='agent'
      ORDER BY created_at DESC,id LIMIT 240`).all() as Array<{
        id: string; payload_json: string; review_status: string; created_at: string; decided_at: string | null;
      }>).map((row) => ({
        id: row.id,
        ...JSON.parse(row.payload_json) as Record<string, unknown>,
        reviewStatus: row.review_status,
        createdAt: row.created_at,
        decidedAt: row.decided_at,
      }));
    return { runs, proposals };
  }

  decideProposal(proposalId: string, input: { action?: unknown; value?: unknown },
    idempotencyKey: string): unknown {
    const replay = this.database.prepare("SELECT result_json FROM review_decisions WHERE idempotency_key LIKE ? LIMIT 1")
      .get(`${idempotencyKey}:%`) as { result_json: string } | undefined;
    if (replay) return JSON.parse(replay.result_json) as unknown;
    const row = this.database.prepare(`SELECT payload_json,review_status FROM proposals
      WHERE id=? AND proposal_type='direction-taxonomy'
        AND json_extract(payload_json,'$.sourceKind')='agent'`).get(proposalId) as
      { payload_json: string; review_status: string } | undefined;
    if (!row) throw new PaperOrganizationStoreError("direction-taxonomy-proposal-not-found", 404);
    if (row.review_status !== "pending") {
      throw new PaperOrganizationStoreError("direction-taxonomy-proposal-decided", 409);
    }
    const action = String(input.action);
    if (!["accept", "accept-with-edit", "reject"].includes(action)) {
      throw new PaperOrganizationStoreError("direction-taxonomy-decision-invalid");
    }
    const payload = JSON.parse(row.payload_json) as {
      suggested: DirectionValue;
      manifestId: string;
      representativePaperIds: string[];
    };
    if (action === "reject") {
      const decision = {
        schemaVersion: DIRECTION_TAXONOMY_DECISION_VERSION,
        action: "reject",
        agentProposed: payload.suggested,
        userAccepted: null,
        edited: false,
        editedFields: [],
        resultingDirection: null,
      };
      const now = this.now().toISOString();
      this.database.transaction(() => {
        this.database.prepare(`UPDATE proposals SET review_status='rejected',decided_at=?
          WHERE id=? AND review_status='pending'`).run(now, proposalId);
        this.database.prepare(`INSERT INTO review_decisions
          (id,proposal_id,action,idempotency_key,result_json,created_at)
          VALUES (?,?,?,?,?,?)`).run(`review-decision:${sha256(idempotencyKey).slice(0, 24)}`,
            proposalId, "reject", idempotencyKey, stableJson(decision), now);
      })();
      return decision;
    }
    const chosen = (input.value ?? payload.suggested) as DirectionValue;
    const value = validateDirectionValue(chosen);
    const frozenManifest = this.database.prepare(
      "SELECT manifest_json FROM paper_taxonomy_manifests WHERE id=?",
    ).pluck().get(payload.manifestId) as string | undefined;
    const frozenPaperIds = new Set((frozenManifest
      ? (JSON.parse(frozenManifest) as PaperTaxonomyManifest).papers : [])
      .map((paper) => paper.paperId));
    if (!frozenManifest || !payload.representativePaperIds.length ||
        payload.representativePaperIds.some((paperId) => !frozenPaperIds.has(paperId))) {
      throw new PaperOrganizationStoreError("direction-taxonomy-proposal-stale", 409);
    }
    if (this.directionCollision(value, null)) {
      throw new PaperOrganizationStoreError("direction-taxonomy-proposal-stale", 409);
    }
    const now = this.now().toISOString();
    const relativePath = join("knowledge", "topics", `${value.topicId.slice("topic:".length)}.md`);
    const target = join(this.layout.vaultRoot, relativePath);
    if (existsSync(target)) throw new PaperOrganizationStoreError("direction-taxonomy-proposal-stale", 409);
    const markdown = renderTopic(value, now);
    const editedFields = (["topicId", "title", "aliases", "scope", "exclusions"] as const)
      .filter((field) => stableJson(value[field]) !== stableJson(payload.suggested[field]));
    const decision = {
      schemaVersion: DIRECTION_TAXONOMY_DECISION_VERSION,
      action: editedFields.length ? "accept-with-edit" : "accept",
      agentProposed: payload.suggested,
      userAccepted: value,
      edited: editedFields.length > 0,
      editedFields,
      resultingDirection: {
        id: value.topicId,
        title: value.title,
        aliases: value.aliases,
        scope: value.scope,
        usageLevel: "classification",
      },
    };
    this.writer.commitOrganization({
      requestType: "direction-taxonomy",
      targetPath: relativePath,
      markdown,
      expectedHash: null,
      proposalIds: [proposalId],
      idempotencyKey,
      response: decision,
      topicId: value.topicId,
    });
    return decision;
  }

  directionCollision(value: DirectionValue, ignoreTopicId: string | null): boolean {
    const keys = new Set([value.topicId, value.title, ...value.aliases].map(normalizePaperLookup));
    return this.organization.listDirections().some((direction) =>
      direction.id !== ignoreTopicId &&
      [direction.id, direction.title, ...direction.aliases]
        .some((candidate) => keys.has(normalizePaperLookup(candidate))));
  }

  backfillPreview(limit = 50): {
    eligibleCount: number; selectedCount: number; remainingCount: number;
    staleOldSummaryCount: number; activeCampaign: unknown | null;
  } {
    const eligible = this.backfillEligible();
    const activeCampaign = this.database.prepare(`SELECT id,state FROM paper_organization_backfills
      WHERE state IN ('reserved','scheduling','monitoring') LIMIT 1`).get() ?? null;
    return {
      eligibleCount: eligible.length,
      selectedCount: Math.min(limit, eligible.length),
      remainingCount: Math.max(0, eligible.length - limit),
      staleOldSummaryCount: eligible.filter((paper) => paper.hasOldRun).length,
      activeCampaign,
    };
  }

  reserveBackfill(limit: number, idempotencyKey: string): { campaignId: string; replayed: boolean } {
    const replay = this.database.prepare("SELECT id FROM paper_organization_backfills WHERE idempotency_key=?")
      .pluck().get(idempotencyKey) as string | undefined;
    if (replay) return { campaignId: replay, replayed: true };
    if (![25, 50, 100, 250, 500].includes(limit)) {
      throw new PaperOrganizationStoreError("paper-organization-backfill-limit-invalid");
    }
    const eligible = this.backfillEligible();
    if (eligible.length === 0) throw new PaperOrganizationStoreError("paper-organization-backfill-empty", 409);
    const selected = eligible.slice(0, limit);
    const campaignId = `paper-organization-backfill:${randomUUID()}`;
    const now = this.now().toISOString();
    const catalogHash = sha256(stableJson(this.directionSnapshots()));
    try {
      this.database.transaction(() => {
        this.database.prepare(`INSERT INTO paper_organization_backfills
          (id,idempotency_key,selector,catalog_hash,requested_limit,state,eligible_count,
           remaining_count,created_at,updated_at)
          VALUES (?,?,'zero-run',?,?,'reserved',?,?,?,?)`).run(campaignId, idempotencyKey,
            catalogHash, limit, eligible.length, Math.max(0, eligible.length - selected.length), now, now);
        selected.forEach((paper, ordinal) => this.database.prepare(`INSERT INTO
          paper_organization_backfill_members
          (campaign_id,ordinal,paper_id,summary_revision_id,member_state,child_idempotency_key,created_at,updated_at)
          VALUES (?,?,?,?,'pending',?,?,?)`).run(campaignId, ordinal, paper.paperId,
            paper.summaryRevisionId,
            `paper-organization-backfill:${campaignId}:${paper.paperId}:${paper.summaryRevisionId}`, now, now));
        this.database.prepare("UPDATE paper_organization_backfills SET state='scheduling' WHERE id=?")
          .run(campaignId);
      })();
    } catch (error) {
      if (String(error).includes("one_active_paper_organization_backfill")) {
        throw new PaperOrganizationStoreError("paper-organization-backfill-active", 409);
      }
      throw error;
    }
    return { campaignId, replayed: false };
  }

  backfill(campaignId: string): unknown {
    const campaign = this.database.prepare("SELECT * FROM paper_organization_backfills WHERE id=?")
      .get(campaignId) as Record<string, unknown> | undefined;
    if (!campaign) throw new PaperOrganizationStoreError("paper-organization-backfill-not-found", 404);
    const members = this.database.prepare(`SELECT m.*,
      j.state job_state,j.error_json job_error
      FROM paper_organization_backfill_members m LEFT JOIN job_runs j ON j.id=m.job_run_id
      WHERE m.campaign_id=? ORDER BY m.ordinal`).all(campaignId) as Array<Record<string, unknown>>;
    const counts = members.reduce<{
      scheduled: number; completed: number; failed: number; skipped: number; remaining: number;
    }>((result, member) => {
      if (member.member_state === "skipped") result.skipped += 1;
      else if (member.job_state === "succeeded") result.completed += 1;
      else if (["failed", "timed_out", "interrupted", "cancelled"].includes(String(member.job_state))) {
        result.failed += 1;
      } else if (member.member_state === "scheduled") result.scheduled += 1;
      else result.remaining += 1;
      return result;
    }, { scheduled: 0, completed: 0, failed: 0, skipped: 0, remaining: 0 });
    const newestCatalogHash = [...members].reverse().find((member) => member.catalog_hash)?.catalog_hash ?? null;
    return {
      campaign: {
        id: String(campaign.id),
        state: String(campaign.state),
        requestedLimit: Number(campaign.requested_limit),
        eligibleCount: Number(campaign.eligible_count),
        remainingCount: Number(campaign.remaining_count),
        createdAt: String(campaign.created_at),
        updatedAt: String(campaign.updated_at),
        completedAt: campaign.completed_at ? String(campaign.completed_at) : null,
      },
      counts,
      olderCatalogCount: newestCatalogHash
        ? members.filter((member) => member.catalog_hash && member.catalog_hash !== newestCatalogHash).length : 0,
      members: members.map((member) => ({
        ordinal: Number(member.ordinal),
        paperId: String(member.paper_id),
        summaryRevisionId: String(member.summary_revision_id),
        state: String(member.member_state),
        skipReason: member.skip_reason ? String(member.skip_reason) : null,
        jobRunId: member.job_run_id ? String(member.job_run_id) : null,
        jobState: member.job_state ? String(member.job_state) : null,
        error: member.job_error ? JSON.parse(String(member.job_error)) : null,
        catalogHash: member.catalog_hash ? String(member.catalog_hash) : null,
      })),
    };
  }

  abandonBackfill(campaignId: string): unknown {
    const now = this.now().toISOString();
    const changed = this.database.prepare(`UPDATE paper_organization_backfills
      SET state='abandoned',updated_at=?,completed_at=?
      WHERE id=? AND state IN ('reserved','scheduling','monitoring')`).run(now, now, campaignId).changes;
    if (!changed) throw new PaperOrganizationStoreError("paper-organization-backfill-not-active", 409);
    this.database.prepare(`UPDATE paper_organization_backfill_members
      SET member_state='skipped',skip_reason='work-in-progress',updated_at=?
      WHERE campaign_id=? AND member_state='pending'`).run(now, campaignId);
    return this.backfill(campaignId);
  }

  private taxonomyFacts(mode: SelectionMode, limit: number, priorManifestId?: string): PaperTaxonomyFact[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new PaperOrganizationStoreError("paper-taxonomy-limit-invalid");
    }
    if (mode === "regenerate") {
      if (!priorManifestId) throw new PaperOrganizationStoreError("paper-taxonomy-prior-manifest-required");
      const raw = this.database.prepare("SELECT manifest_json FROM paper_taxonomy_manifests WHERE id=?")
        .pluck().get(priorManifestId) as string | undefined;
      if (!raw) throw new PaperOrganizationStoreError("paper-taxonomy-manifest-not-found", 404);
      return (JSON.parse(raw) as PaperTaxonomyManifest).papers;
    }
    return this.taxonomyEligible(mode === "refresh").slice(0, limit).map((paper) => this.taxonomyFact(paper));
  }

  private taxonomyEligible(refresh: boolean): Array<{ paperId: string; summaryRevisionId: string }> {
    return (this.database.prepare(`SELECT p.id paper_id,s.id summary_revision_id
      FROM papers p JOIN summary_revisions s ON s.paper_id=p.id AND s.paper_version_id=p.current_version_id
      LEFT JOIN paper_direction_assignments a ON a.paper_id=p.id AND a.assignment_role='primary'
      WHERE p.lifecycle_status='active' AND s.status='active' AND a.paper_id IS NULL
        AND (?=1 OR NOT EXISTS (
          SELECT 1 FROM paper_taxonomy_runs r JOIN job_runs j ON j.id=r.job_run_id
          JOIN paper_taxonomy_manifests m ON m.id=r.manifest_id,
          json_each(m.manifest_json,'$.papers') fact
          WHERE j.state='succeeded'
            AND json_extract(fact.value,'$.paperId')=p.id
            AND json_extract(fact.value,'$.summaryRevisionId')=s.id
        ))
      ORDER BY p.created_at,p.id`).all(Number(refresh)) as Array<{ paper_id: string; summary_revision_id: string }>)
      .map((row) => ({ paperId: row.paper_id, summaryRevisionId: row.summary_revision_id }));
  }

  private taxonomyFact(row: { paperId: string; summaryRevisionId: string }): PaperTaxonomyFact {
    const paper = this.database.prepare(`SELECT p.title,s.markdown_hash,s.structured_json,
      d.authors_json,d.external_identities_json
      FROM papers p JOIN summary_revisions s ON s.id=? JOIN paper_catalog_documents d ON d.paper_id=p.id
      WHERE p.id=?`).get(row.summaryRevisionId, row.paperId) as {
        title: string; markdown_hash: string; structured_json: string;
        authors_json: string; external_identities_json: string;
      };
    const manifest = this.database.prepare("SELECT markdown_path,markdown_hash FROM paper_manifests WHERE paper_id=?")
      .get(row.paperId) as { markdown_path: string; markdown_hash: string } | undefined;
    const path = manifest ? join(this.layout.vaultRoot, manifest.markdown_path) : "";
    if (!manifest || !existsSync(path) || sha256(readFileSync(path)) !== manifest.markdown_hash) {
      throw new PaperOrganizationStoreError("paper-taxonomy-manifest-drift", 409);
    }
    const sections = (JSON.parse(paper.structured_json) as {
      sections?: Array<{ title?: string; body?: string }>;
    }).sections ?? [];
    const excerpt = [...sections.map((section) => `${section.title ?? ""}\n${section.body ?? ""}`).join("\n\n")]
      .slice(0, 1_200).join("");
    const organization = this.database.prepare(`SELECT
      (SELECT json_group_array(json_object('name',name,'kind',alias_kind,'preferred',preferred))
       FROM paper_aliases WHERE paper_id=? ORDER BY ordinal) aliases,
      (SELECT json_group_array(json_object('topicId',topic_id,'role',assignment_role))
       FROM paper_direction_assignments WHERE paper_id=? ORDER BY ordinal) directions`).get(row.paperId, row.paperId) as
      { aliases: string; directions: string };
    return {
      paperId: row.paperId,
      title: paper.title,
      authors: JSON.parse(paper.authors_json) as string[],
      externalIdentities: JSON.parse(paper.external_identities_json) as string[],
      summaryRevisionId: row.summaryRevisionId,
      summaryHash: paper.markdown_hash,
      excerpt,
      aliases: JSON.parse(organization.aliases ?? "[]"),
      directions: JSON.parse(organization.directions ?? "[]"),
    };
  }

  private directionSnapshots() {
    return (this.database.prepare(`SELECT topic_id,title,aliases_json,scope,revision_id,markdown_hash,
      usage_level,lifecycle_status,superseded_by,review_status FROM direction_catalog
      WHERE lifecycle_status='active' AND review_status='confirmed'
      ORDER BY title COLLATE NOCASE,topic_id`).all() as Array<Record<string, unknown>>).map((row) => ({
      topicId: String(row.topic_id),
      title: String(row.title),
      aliases: JSON.parse(String(row.aliases_json)) as string[],
      scope: String(row.scope),
      revisionId: String(row.revision_id),
      markdownHash: String(row.markdown_hash),
      semanticHash: sha256(stableJson({
        scope: row.scope, usageLevel: row.usage_level, lifecycleStatus: row.lifecycle_status,
        supersededBy: row.superseded_by, reviewStatus: row.review_status,
      })),
    }));
  }

  private backfillEligible(): Array<{ paperId: string; summaryRevisionId: string; hasOldRun: boolean }> {
    return (this.database.prepare(`SELECT p.id paper_id,s.id summary_revision_id,
      EXISTS(SELECT 1 FROM paper_organization_runs old WHERE old.paper_id=p.id) has_old_run
      FROM papers p JOIN summary_revisions s ON s.paper_id=p.id AND s.paper_version_id=p.current_version_id
      WHERE p.lifecycle_status='active' AND s.status='active' AND NOT EXISTS (
        SELECT 1 FROM paper_organization_runs r JOIN paper_organization_manifests m ON m.id=r.manifest_id
        WHERE r.paper_id=p.id AND m.summary_revision_id=s.id
      ) ORDER BY p.created_at,p.id`).all() as Array<{
        paper_id: string; summary_revision_id: string; has_old_run: number;
      }>).map((row) => ({
        paperId: row.paper_id,
        summaryRevisionId: row.summary_revision_id,
        hasOldRun: Boolean(row.has_old_run),
      }));
  }
}

function validateDirectionValue(input: DirectionValue): DirectionValue {
  const topicId = typeof input?.topicId === "string" ? input.topicId.trim() : "";
  const title = typeof input?.title === "string" ? input.title.trim() : "";
  const scope = typeof input?.scope === "string" ? input.scope.trim() : "";
  const aliases = Array.isArray(input?.aliases) ? input.aliases.map((value) => String(value).trim()).filter(Boolean) : [];
  const exclusions = Array.isArray(input?.exclusions)
    ? input.exclusions.map((value) => String(value).trim()).filter(Boolean) : [];
  if (!/^topic:[a-z0-9]+(?:-[a-z0-9]+)*$/.test(topicId) || !title || !scope || exclusions.length < 1 ||
      new Set(aliases.map(normalizePaperLookup)).size !== aliases.length) {
    throw new PaperOrganizationStoreError("direction-taxonomy-decision-invalid");
  }
  return { topicId, title, aliases, scope, exclusions };
}

function renderTopic(value: DirectionValue, now: string): string {
  const date = now.slice(0, 10);
  return `---
id: ${JSON.stringify(value.topicId)}
type: topic
title: ${JSON.stringify(value.title)}
aliases: ${JSON.stringify(value.aliases)}
revision_id: ${JSON.stringify(`${value.topicId}:r1`)}
revision: 1
review_status: confirmed
usage_level: classification
epistemic_status: evidence-backed
superseded_by: null
provenance: []
semantic_relations: []
tags: []
created: ${date}
updated: ${date}
---

# ${value.title}

## Scope

${value.scope}

### Excludes

${value.exclusions.map((item) => `- ${item}`).join("\n")}

## Map of concepts

## Representative papers

## Schools of thought and disagreements

## Open questions

## Syntheses

## Suggested reading path
`;
}
