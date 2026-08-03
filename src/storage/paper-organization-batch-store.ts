import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import { PaperOrganizationStoreError, type PaperOrganizationStore } from "./paper-organization-store.js";

export type PaperOrganizationBatchAction = "accept" | "reject";

type PreviewItem = {
  proposalId: string;
  paperId: string;
  paperTitle: string;
  sectionKind: "alias" | "primary-direction" | "secondary-direction";
  eligible: boolean;
  reason: "ready" | "stale" | "blocked" | "ambiguous" | "collision-warning" | "already-decided";
};

export class PaperOrganizationBatchStore {
  constructor(
    private readonly database: Database.Database,
    private readonly now: () => Date,
    private readonly organization: PaperOrganizationStore,
  ) {}

  preview(action: PaperOrganizationBatchAction, proposalIds: string[]) {
    if (!["accept", "reject"].includes(action) || proposalIds.length < 1 || proposalIds.length > 500 ||
        new Set(proposalIds).size !== proposalIds.length ||
        proposalIds.some((id) => typeof id !== "string" || !id.trim())) {
      throw new PaperOrganizationStoreError("paper-organization-batch-invalid");
    }
    const items = proposalIds.map((proposalId): PreviewItem => {
      const row = this.database.prepare(`SELECT p.paper_id,p.payload_json,p.review_status,pa.title
        FROM proposals p JOIN papers pa ON pa.id=p.paper_id
        WHERE p.id=? AND p.proposal_type='paper-organization'
          AND json_extract(p.payload_json,'$.sourceKind')='agent'`).get(proposalId) as {
          paper_id: string; payload_json: string; review_status: string; title: string;
        } | undefined;
      if (!row) throw new PaperOrganizationStoreError("paper-organization-proposal-not-found", 404);
      const payload = JSON.parse(row.payload_json) as {
        changeKind: PreviewItem["sectionKind"];
        ambiguous?: boolean;
        collisionWarnings?: string[];
      };
      let reason: PreviewItem["reason"] = "ready";
      if (row.review_status !== "pending") reason = "already-decided";
      else {
        const state = this.organization.organizationProposalState(proposalId);
        if (state.applicability === "stale") reason = "stale";
        else if (state.applicability === "blocked") reason = action === "reject" ? "ready" : "blocked";
        else if (action === "accept" && payload.ambiguous) reason = "ambiguous";
        else if (action === "accept" && (payload.collisionWarnings?.length ?? 0) > 0) {
          reason = "collision-warning";
        }
      }
      return {
        proposalId,
        paperId: row.paper_id,
        paperTitle: row.title,
        sectionKind: payload.changeKind,
        eligible: reason === "ready",
        reason,
      };
    });
    const eligible = items.filter((item) => item.eligible);
    const sectionCounts = {
      alias: eligible.filter((item) => item.sectionKind === "alias").length,
      primary: eligible.filter((item) => item.sectionKind === "primary-direction").length,
      secondary: eligible.filter((item) => item.sectionKind === "secondary-direction").length,
    };
    return {
      action,
      selectedProposalCount: items.length,
      selectedPaperCount: new Set(items.map((item) => item.paperId)).size,
      eligibleProposalCount: eligible.length,
      eligiblePaperCount: new Set(eligible.map((item) => item.paperId)).size,
      sectionCounts,
      samples: [...eligible].sort((left, right) => left.proposalId.localeCompare(right.proposalId))
        .slice(0, 5).map(({ proposalId, paperId, paperTitle, sectionKind }) =>
          ({ proposalId, paperId, paperTitle, sectionKind })),
      excluded: items.filter((item) => !item.eligible).map(({ proposalId, reason }) => ({ proposalId, reason })),
      eligibleProposalIds: eligible.map((item) => item.proposalId),
      items,
    };
  }

  reserve(action: PaperOrganizationBatchAction, proposalIds: string[], idempotencyKey: string) {
    const replay = this.database.prepare("SELECT id FROM paper_organization_batches WHERE idempotency_key=?")
      .pluck().get(idempotencyKey) as string | undefined;
    if (replay) return { batchId: replay, replayed: true };
    const preview = this.preview(action, proposalIds);
    if (preview.eligibleProposalCount === 0) {
      throw new PaperOrganizationStoreError("paper-organization-batch-empty", 409);
    }
    const eligible = new Set(preview.eligibleProposalIds);
    const batchId = `paper-organization-batch:${randomUUID()}`;
    const now = this.now().toISOString();
    try {
      this.database.transaction(() => {
        this.database.prepare(`INSERT INTO paper_organization_batches
          (id,idempotency_key,action,state,preview_json,created_at,updated_at)
          VALUES (?,?,?,'reserved',?,?,?)`).run(batchId, idempotencyKey, action,
            JSON.stringify(preview), now, now);
        preview.items.filter((item) => eligible.has(item.proposalId)).forEach((item, ordinal) => {
          const activeOwner = this.database.prepare(`SELECT 1 FROM paper_organization_batch_members m
            JOIN paper_organization_batches b ON b.id=m.batch_id
            WHERE m.proposal_id=? AND b.state IN ('reserved','applying') LIMIT 1`).get(item.proposalId);
          if (activeOwner) throw new PaperOrganizationStoreError("paper-organization-batch-member-active", 409);
          this.database.prepare(`INSERT INTO paper_organization_batch_members
            (batch_id,ordinal,proposal_id,paper_id,section_kind,member_state,created_at,updated_at)
            VALUES (?,?,?,?,?,'pending',?,?)`).run(batchId, ordinal, item.proposalId,
              item.paperId, item.sectionKind, now, now);
        });
      })();
    } catch (error) {
      if (error instanceof PaperOrganizationStoreError) throw error;
      if (String(error).includes("one_active_paper_organization_batch")) {
        throw new PaperOrganizationStoreError("paper-organization-batch-active", 409);
      }
      throw error;
    }
    return { batchId, replayed: false };
  }

  read(batchId: string) {
    const batch = this.database.prepare("SELECT * FROM paper_organization_batches WHERE id=?")
      .get(batchId) as Record<string, unknown> | undefined;
    if (!batch) throw new PaperOrganizationStoreError("paper-organization-batch-not-found", 404);
    const members = this.database.prepare(`SELECT m.*,p.review_status
      FROM paper_organization_batch_members m JOIN proposals p ON p.id=m.proposal_id
      WHERE m.batch_id=? ORDER BY m.ordinal`).all(batchId) as Array<Record<string, unknown>>;
    const papers = new Map<string, { paperId: string; sections: Array<Record<string, unknown>> }>();
    for (const member of members) {
      const paperId = String(member.paper_id);
      const group = papers.get(paperId) ?? { paperId, sections: [] };
      group.sections.push({
        proposalId: String(member.proposal_id),
        sectionKind: String(member.section_kind),
        state: String(member.member_state),
        attempt: Number(member.attempt),
        errorCode: member.error_code ? String(member.error_code) : null,
        reviewStatus: String(member.review_status),
      });
      papers.set(paperId, group);
    }
    const counts = Object.fromEntries([
      "pending", "applying", "succeeded", "failed", "conflicted", "skipped-stale", "skipped-external",
    ].map((state) => [state.replace("-", "_"),
      members.filter((member) => member.member_state === state).length]));
    return {
      batch: {
        id: String(batch.id),
        action: String(batch.action),
        state: String(batch.state),
        createdAt: String(batch.created_at),
        completedAt: batch.completed_at ? String(batch.completed_at) : null,
      },
      preview: JSON.parse(String(batch.preview_json)),
      counts,
      papers: [...papers.values()],
    };
  }

  retry(batchId: string) {
    const batch = this.database.prepare("SELECT state FROM paper_organization_batches WHERE id=?")
      .get(batchId) as { state: string } | undefined;
    if (!batch || !["complete-with-issues", "abandoned"].includes(batch.state)) {
      throw new PaperOrganizationStoreError("paper-organization-batch-not-retryable", 409);
    }
    const now = this.now().toISOString();
    const changed = this.database.prepare(`UPDATE paper_organization_batch_members
      SET member_state='pending',error_code=NULL,updated_at=?
      WHERE batch_id=? AND member_state IN ('failed','conflicted') AND EXISTS (
        SELECT 1 FROM proposals p WHERE p.id=proposal_id AND p.review_status='pending'
      )`).run(now, batchId).changes;
    if (!changed) throw new PaperOrganizationStoreError("paper-organization-batch-no-retryable-members", 409);
    this.database.prepare(`UPDATE paper_organization_batches SET state='applying',
      completed_at=NULL,updated_at=? WHERE id=?`).run(now, batchId);
    return this.read(batchId);
  }

  abandon(batchId: string) {
    const now = this.now().toISOString();
    const changed = this.database.prepare(`UPDATE paper_organization_batches
      SET state='abandoned',completed_at=?,updated_at=?
      WHERE id=? AND state IN ('reserved','applying')`).run(now, now, batchId).changes;
    if (!changed) throw new PaperOrganizationStoreError("paper-organization-batch-not-active", 409);
    this.database.prepare(`UPDATE paper_organization_batch_members
      SET member_state='skipped-stale',error_code='batch-abandoned',updated_at=?
      WHERE batch_id=? AND member_state='pending'`).run(now, batchId);
    return this.read(batchId);
  }
}
