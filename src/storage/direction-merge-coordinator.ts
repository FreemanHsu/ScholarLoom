import Database from "better-sqlite3";

import type { ImportStore } from "./import-store.js";
import type { StorageLayout } from "./layout.js";
import { PaperOrganizationStoreError } from "./paper-organization-store.js";

export class DirectionMergeCoordinator {
  readonly #database: Database.Database;
  readonly #poll: ReturnType<typeof setInterval>;
  #closed = false;
  #active = false;

  constructor(
    layout: StorageLayout,
    private readonly source: Pick<ImportStore,
      "commitDirectionMergeSource" | "applyDirectionMergeMember">,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.#database = new Database(layout.databasePath);
    this.#database.pragma("foreign_keys = ON");
    this.#database.pragma("busy_timeout = 5000");
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

  #pump(): void {
    if (this.#closed || this.#active) return;
    const command = this.#database.prepare(`SELECT id,state FROM direction_merge_commands
      WHERE state IN ('reserved','superseding','migrating') ORDER BY created_at,id LIMIT 1`).get() as
      { id: string; state: string } | undefined;
    if (!command) return;
    this.#active = true;
    try {
      if (command.state === "reserved" || command.state === "superseding") {
        this.source.commitDirectionMergeSource(command.id);
        return;
      }
      const member = this.#database.prepare(`SELECT ordinal,paper_id,expected_manifest_hash,member_state
        FROM direction_merge_members WHERE merge_id=? AND member_state IN ('pending','applying')
        ORDER BY ordinal LIMIT 1`).get(command.id) as {
          ordinal: number; paper_id: string; expected_manifest_hash: string; member_state: string;
        } | undefined;
      if (!member) {
        const issues = this.#database.prepare(`SELECT 1 FROM direction_merge_members
          WHERE merge_id=? AND member_state<>'succeeded' LIMIT 1`).get(command.id);
        const now = this.now().toISOString();
        this.#database.prepare(`UPDATE direction_merge_commands SET state=?,completed_at=?,updated_at=?
          WHERE id=? AND state='migrating'`).run(issues ? "complete-with-exceptions" : "complete",
            now, now, command.id);
        return;
      }
      const currentHash = this.#database.prepare("SELECT markdown_hash FROM paper_manifests WHERE paper_id=?")
        .pluck().get(member.paper_id) as string | undefined;
      if (member.member_state === "pending" && currentHash !== member.expected_manifest_hash) {
        this.#database.prepare(`UPDATE direction_merge_members SET member_state='conflicted',
          error_code='paper-manifest-drift',updated_at=? WHERE merge_id=? AND ordinal=?`)
          .run(this.now().toISOString(), command.id, member.ordinal);
        return;
      }
      this.#database.prepare(`UPDATE direction_merge_members SET member_state='applying',
        attempt=attempt+1,updated_at=? WHERE merge_id=? AND ordinal=?`)
        .run(this.now().toISOString(), command.id, member.ordinal);
      const result = this.source.applyDirectionMergeMember(command.id, member.ordinal);
      this.#database.prepare(`UPDATE direction_merge_members SET member_state='succeeded',
        result_json=?,error_code=NULL,updated_at=? WHERE merge_id=? AND ordinal=?`)
        .run(JSON.stringify(result), this.now().toISOString(), command.id, member.ordinal);
    } catch (error) {
      const code = error instanceof PaperOrganizationStoreError ? error.code
        : error instanceof Error ? error.message : "direction-merge-failed";
      const commandState = this.#database.prepare("SELECT state FROM direction_merge_commands WHERE id=?")
        .pluck().get(command.id) as string;
      if (commandState === "migrating") {
        this.#database.prepare(`UPDATE direction_merge_members SET member_state=?,
          error_code=?,updated_at=? WHERE merge_id=? AND member_state='applying'`)
          .run(code.includes("conflict") || code.includes("stale") ? "conflicted" : "failed",
            code, this.now().toISOString(), command.id);
      } else {
        const now = this.now().toISOString();
        this.#database.prepare(`UPDATE direction_merge_commands SET state='failed',error_code=?,
          completed_at=?,updated_at=? WHERE id=?`).run(code, now, now, command.id);
      }
    } finally {
      this.#active = false;
      queueMicrotask(() => this.#pump());
    }
  }
}
