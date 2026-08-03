import Database from "better-sqlite3";

import type { ImportStore } from "./import-store.js";
import type { StorageLayout } from "./layout.js";
import { PaperOrganizationStoreError } from "./paper-organization-store.js";

export class PaperOrganizationBatchCoordinator {
  readonly #database: Database.Database;
  readonly #poll: ReturnType<typeof setInterval>;
  #closed = false;
  #active = false;

  constructor(
    layout: StorageLayout,
    private readonly source: Pick<ImportStore, "decidePaperOrganizationProposal">,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.#database = new Database(layout.databasePath);
    this.#database.pragma("foreign_keys = ON");
    this.#database.pragma("busy_timeout = 5000");
    this.#reconcileApplying();
    this.#poll = setInterval(() => this.#pump(), 100);
    this.#poll.unref();
    queueMicrotask(() => this.#pump());
  }

  close(): void {
    this.#closed = true;
    clearInterval(this.#poll);
    this.#database.close();
  }

  wake(): void {
    queueMicrotask(() => this.#pump());
  }

  #reconcileApplying(): void {
    const applying = this.#database.prepare(`SELECT batch_id,ordinal,proposal_id
      FROM paper_organization_batch_members WHERE member_state='applying'
      ORDER BY batch_id,ordinal`).all() as Array<{
        batch_id: string; ordinal: number; proposal_id: string;
      }>;
    for (const member of applying) this.#reconcileMember(member);
  }

  #reconcileMember(member: { batch_id: string; ordinal: number; proposal_id: string }): boolean {
    const action = this.#database.prepare("SELECT action FROM paper_organization_batches WHERE id=?")
      .pluck().get(member.batch_id) as "accept" | "reject";
    const proposal = this.#database.prepare("SELECT review_status FROM proposals WHERE id=?")
      .get(member.proposal_id) as { review_status: string } | undefined;
    const now = this.now().toISOString();
    const expected = action === "accept" ? "accepted" : "rejected";
    if (proposal?.review_status === expected) {
      const result = this.#database.prepare(`SELECT result_json FROM review_decisions
        WHERE proposal_id=? ORDER BY created_at DESC LIMIT 1`).pluck().get(member.proposal_id) as string | undefined;
      this.#database.prepare(`UPDATE paper_organization_batch_members
        SET member_state='succeeded',result_json=?,error_code=NULL,updated_at=?
        WHERE batch_id=? AND ordinal=?`).run(result ?? "{}", now, member.batch_id, member.ordinal);
      return true;
    }
    if (proposal?.review_status !== "pending") {
      this.#database.prepare(`UPDATE paper_organization_batch_members
        SET member_state='skipped-external',error_code='proposal-decided-externally',updated_at=?
        WHERE batch_id=? AND ordinal=?`).run(now, member.batch_id, member.ordinal);
      return true;
    }
    return false;
  }

  #pump(): void {
    if (this.#closed || this.#active) return;
    const batch = this.#database.prepare(`SELECT id,action FROM paper_organization_batches
      WHERE state IN ('reserved','applying') ORDER BY created_at,id LIMIT 1`).get() as
      { id: string; action: "accept" | "reject" } | undefined;
    if (!batch) return;
    const now = this.now().toISOString();
    this.#database.prepare(`UPDATE paper_organization_batches SET state='applying',updated_at=?
      WHERE id=? AND state='reserved'`).run(now, batch.id);
    const member = this.#database.prepare(`SELECT batch_id,ordinal,proposal_id
      FROM paper_organization_batch_members WHERE batch_id=? AND member_state='pending'
      ORDER BY ordinal LIMIT 1`).get(batch.id) as
      { batch_id: string; ordinal: number; proposal_id: string } | undefined;
    if (!member) {
      const issue = this.#database.prepare(`SELECT 1 FROM paper_organization_batch_members
        WHERE batch_id=? AND member_state<>'succeeded' LIMIT 1`).get(batch.id);
      this.#database.prepare(`UPDATE paper_organization_batches SET state=?,completed_at=?,updated_at=?
        WHERE id=? AND state='applying'`).run(issue ? "complete-with-issues" : "complete",
          now, now, batch.id);
      return;
    }
    if (this.#reconcileMember(member)) return;
    this.#active = true;
    this.#database.prepare(`UPDATE paper_organization_batch_members SET member_state='applying',
      attempt=attempt+1,updated_at=? WHERE batch_id=? AND ordinal=? AND member_state='pending'`)
      .run(now, member.batch_id, member.ordinal);
    try {
      const attempt = this.#database.prepare(`SELECT attempt FROM paper_organization_batch_members
        WHERE batch_id=? AND ordinal=?`).pluck().get(member.batch_id, member.ordinal) as number;
      const result = this.source.decidePaperOrganizationProposal(member.proposal_id,
        { action: batch.action }, `batch:${member.batch_id}:${member.ordinal}:${attempt}`);
      this.#database.prepare(`UPDATE paper_organization_batch_members
        SET member_state='succeeded',result_json=?,error_code=NULL,updated_at=?
        WHERE batch_id=? AND ordinal=?`).run(JSON.stringify(result), this.now().toISOString(),
          member.batch_id, member.ordinal);
    } catch (error) {
      const code = error instanceof PaperOrganizationStoreError ? error.code
        : error instanceof Error ? error.message : "paper-organization-batch-member-failed";
      const state = code.includes("conflict") ? "conflicted"
        : code.includes("stale") || code.includes("blocked") || code.includes("decided")
          ? "skipped-stale" : "failed";
      this.#database.prepare(`UPDATE paper_organization_batch_members
        SET member_state=?,error_code=?,updated_at=? WHERE batch_id=? AND ordinal=?`)
        .run(state, code, this.now().toISOString(), member.batch_id, member.ordinal);
    } finally {
      this.#active = false;
      queueMicrotask(() => this.#pump());
    }
  }
}
