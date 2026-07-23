import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type Database from "better-sqlite3";

import type { RepositoryAdapter } from "../adapters/git-repository.js";
import { parseGitHubRepositoryUrl } from "../domain/github-repository-url.js";
import { isRepositoryMaterialized } from "./repository-materialization.js";

export type RepositoryAssociationView = {
  id: string;
  repositoryId: string;
  owner: string;
  repository: string;
  canonicalUrl: string;
  origin: string;
  associationStatus: string;
  materializationStatus: string;
  commitSha: string | null;
  failureReason: string | null;
};

export type AddRepositoryAssociationResult =
  | { ok: false; code: "invalid-github-repository-url" | "paper-not-found" | "paper-not-active" |
      "repository-runner-unavailable" | "repository-association-not-found" | "repository-job-not-retryable" |
      "repository-association-not-confirmable" | "idempotency-key-conflict" }
  | { ok: true; replayed: boolean; association: RepositoryAssociationView | null };

export type RemoveRepositoryAssociationResult =
  | { ok: false; code: "paper-not-found" | "paper-not-active" | "repository-association-not-found" |
      "repository-association-not-removable" | "idempotency-key-conflict" }
  | { ok: true; replayed: boolean };

export class RepositoryAssociations {
  constructor(
    private readonly database: Database.Database,
    private readonly options: {
      repositoryRoot: string;
      adapter?: RepositoryAdapter;
      schedule(task: Promise<void>): void;
      now(): Date;
    },
  ) {}

  list(paperId: string): RepositoryAssociationView[] {
    const rows = this.database.prepare(`SELECT pcl.id,pcl.code_repository_id,pcl.origin,pcl.status,
      cr.canonical_url,cr.owner_name,cr.repository_name,rs.commit_sha,rs.local_path,
      (SELECT j.state FROM job_runs j WHERE j.job_type='repository-materialization'
        AND json_extract(j.input_json,'$.associationId')=pcl.id
        ORDER BY j.attempt DESC,j.queued_at DESC,j.id DESC LIMIT 1) job_state,
      (SELECT j.error_json FROM job_runs j WHERE j.job_type='repository-materialization'
        AND json_extract(j.input_json,'$.associationId')=pcl.id
        ORDER BY j.attempt DESC,j.queued_at DESC,j.id DESC LIMIT 1) job_error
      FROM paper_code_links pcl
      JOIN code_repositories cr ON cr.id=pcl.code_repository_id
      LEFT JOIN repository_snapshots rs ON rs.id=pcl.repository_snapshot_id
      WHERE pcl.paper_id=? AND pcl.status<>'rejected' ORDER BY pcl.created_at,pcl.id`).all(paperId) as Array<{
        id: string; code_repository_id: string; origin: string; status: string; canonical_url: string;
        owner_name: string | null; repository_name: string | null; commit_sha: string | null; local_path: string | null;
        job_state: string | null; job_error: string | null;
      }>;
    return rows.map((row) => {
      let failureReason: string | null = null;
      if (row.job_error) {
        try {
          const error = JSON.parse(row.job_error) as { message?: unknown; code?: unknown };
          failureReason = typeof error.message === "string" ? error.message : typeof error.code === "string" ? error.code : null;
        } catch { /* Malformed operational detail does not hide the association. */ }
      }
      const materializationPresent = isRepositoryMaterialized(
        this.options.repositoryRoot,
        row.local_path,
        row.commit_sha,
      );
      const activeOrFailedJob = row.job_state && !["succeeded"].includes(row.job_state) ? row.job_state : null;
      return {
        id: row.id,
        repositoryId: row.code_repository_id,
        owner: row.owner_name ?? "",
        repository: row.repository_name ?? "",
        canonicalUrl: row.canonical_url,
        origin: row.origin,
        associationStatus: row.status,
        materializationStatus: materializationPresent ? "ready"
          : activeOrFailedJob ?? (row.commit_sha ? "materialization-missing" : "not-started"),
        commitSha: row.commit_sha,
        failureReason: failureReason ?? (row.commit_sha && !materializationPresent
          ? "固定 Repository Snapshot 的本地物化缺失。" : null),
      };
    });
  }

  remove(paperId: string, associationId: string, idempotencyKey: string): RemoveRepositoryAssociationResult {
    const replay = this.database.prepare("SELECT job_type,input_json FROM job_runs WHERE idempotency_key=?")
      .get(idempotencyKey) as { job_type: string; input_json: string } | undefined;
    if (replay) {
      const replayInput = JSON.parse(replay.input_json) as { paperId?: unknown; associationId?: unknown };
      return replay.job_type === "repository-association-remove" &&
        replayInput.paperId === paperId && replayInput.associationId === associationId
        ? { ok: true, replayed: true }
        : { ok: false, code: "idempotency-key-conflict" };
    }
    const paper = this.database.prepare("SELECT lifecycle_status FROM papers WHERE id=?").get(paperId) as
      { lifecycle_status: string } | undefined;
    if (!paper) return { ok: false, code: "paper-not-found" };
    if (paper.lifecycle_status !== "active") return { ok: false, code: "paper-not-active" };
    const association = this.database.prepare(`SELECT status,repository_snapshot_id FROM paper_code_links
      WHERE id=? AND paper_id=?`).get(associationId, paperId) as
      { status: string; repository_snapshot_id: string | null } | undefined;
    if (!association) return { ok: false, code: "repository-association-not-found" };
    if (!["candidate", "confirmed"].includes(association.status)) {
      return { ok: false, code: "repository-association-not-removable" };
    }
    const timestamp = this.options.now().toISOString();
    const jobId = `job:repository-association-remove:${
      createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 24)
    }`;
    const output = {
      previousStatus: association.status,
      repositorySnapshotId: association.repository_snapshot_id,
      status: "rejected",
    };
    this.database.transaction(() => {
      this.database.prepare("UPDATE paper_code_links SET status='rejected' WHERE id=?").run(associationId);
      this.database.prepare(`INSERT INTO job_runs
        (id,job_type,paper_id,state,progress,attempt,idempotency_key,input_json,output_json,
          queued_at,started_at,completed_at,heartbeat_at)
        VALUES (?,'repository-association-remove',?,'succeeded',1,1,?,?,?,?,?,?,?)`)
        .run(jobId, paperId, idempotencyKey, JSON.stringify({ paperId, associationId }),
          JSON.stringify(output), timestamp, timestamp, timestamp, timestamp);
    })();
    return { ok: true, replayed: false };
  }

  confirm(paperId: string, associationId: string, idempotencyKey: string): AddRepositoryAssociationResult {
    const replay = this.#commandReplay(idempotencyKey, {
      paperId,
      associationId,
      jobTypes: ["repository-materialization", "repository-association-confirm"],
    });
    if (replay.found) {
      return replay.matches
        ? { ok: true, replayed: true, association: this.#read(associationId) }
        : { ok: false, code: "idempotency-key-conflict" };
    }
    const paper = this.database.prepare("SELECT lifecycle_status FROM papers WHERE id=?").get(paperId) as
      { lifecycle_status: string } | undefined;
    if (!paper) return { ok: false, code: "paper-not-found" };
    if (paper.lifecycle_status !== "active") return { ok: false, code: "paper-not-active" };
    const association = this.database.prepare(`SELECT pcl.id,pcl.status,pcl.code_repository_id,cr.canonical_url
      FROM paper_code_links pcl JOIN code_repositories cr ON cr.id=pcl.code_repository_id
      WHERE pcl.id=? AND pcl.paper_id=?`).get(associationId, paperId) as {
        id: string; status: string; code_repository_id: string; canonical_url: string;
      } | undefined;
    if (!association) return { ok: false, code: "repository-association-not-found" };
    if (association.status === "confirmed") {
      this.#recordSynchronousCommand({
        jobType: "repository-association-confirm",
        paperId,
        associationId,
        canonicalUrl: association.canonical_url,
        idempotencyKey,
        mutate() {},
      });
      return { ok: true, replayed: true, association: this.#read(associationId)! };
    }
    if (association.status !== "candidate") {
      return { ok: false, code: "repository-association-not-confirmable" };
    }
    const shared = this.#sharedSnapshot(association.code_repository_id);
    if (shared?.ready) {
      this.#recordSynchronousCommand({
        jobType: "repository-association-confirm",
        paperId,
        associationId,
        canonicalUrl: association.canonical_url,
        idempotencyKey,
        mutate: () => {
          this.database.prepare(`UPDATE paper_code_links SET status='confirmed',repository_snapshot_id=?
            WHERE id=? AND status='candidate'`).run(shared.id, associationId);
        },
      });
      return { ok: true, replayed: true, association: this.#read(associationId)! };
    }
    if (!this.options.adapter) return { ok: false, code: "repository-runner-unavailable" };
    const started = this.#startMaterialization({
      paperId,
      associationId,
      repositoryId: association.code_repository_id,
      canonicalUrl: association.canonical_url,
      idempotencyKey,
      ...(shared ? { expectedCommitSha: shared.commitSha } : {}),
      activate: () => {
        this.database.prepare(`UPDATE paper_code_links SET status='confirmed',repository_snapshot_id=?
          WHERE id=? AND status='candidate'`).run(shared?.id ?? null, associationId);
      },
    });
    return started.ok
      ? { ok: true, replayed: started.replayed, association: this.#read(associationId)! }
      : started;
  }

  retry(paperId: string, associationId: string, idempotencyKey: string): AddRepositoryAssociationResult {
    const paper = this.database.prepare("SELECT lifecycle_status FROM papers WHERE id=?").get(paperId) as
      { lifecycle_status: string } | undefined;
    if (!paper) return { ok: false, code: "paper-not-found" };
    if (paper.lifecycle_status !== "active") return { ok: false, code: "paper-not-active" };
    if (!this.options.adapter) return { ok: false, code: "repository-runner-unavailable" };
    const association = this.database.prepare(`SELECT pcl.code_repository_id,cr.canonical_url,rs.commit_sha,rs.local_path
      FROM paper_code_links pcl JOIN code_repositories cr ON cr.id=pcl.code_repository_id
      LEFT JOIN repository_snapshots rs ON rs.id=pcl.repository_snapshot_id
      WHERE pcl.id=? AND pcl.paper_id=? AND pcl.status='confirmed'`).get(associationId, paperId) as {
        code_repository_id: string; canonical_url: string; commit_sha: string | null; local_path: string | null;
      } | undefined;
    if (!association) return { ok: false, code: "repository-association-not-found" };
    const replay = this.database.prepare(`SELECT 1 FROM job_runs WHERE idempotency_key=? AND job_type='repository-materialization'
      AND json_extract(input_json,'$.associationId')=?`).get(idempotencyKey, associationId);
    if (replay) return { ok: true, replayed: true, association: this.#read(associationId)! };
    const previous = this.database.prepare(`SELECT state,attempt FROM job_runs
      WHERE job_type='repository-materialization' AND json_extract(input_json,'$.associationId')=?
      ORDER BY attempt DESC,queued_at DESC,id DESC LIMIT 1`).get(associationId) as
      { state: string; attempt: number } | undefined;
    const materializationMissing = Boolean(association.commit_sha &&
      !isRepositoryMaterialized(this.options.repositoryRoot, association.local_path, association.commit_sha));
    if (!previous || (!["failed", "interrupted"].includes(previous.state) && !materializationMissing)) {
      return { ok: false, code: "repository-job-not-retryable" };
    }
    const started = this.#startMaterialization({
      paperId,
      associationId,
      repositoryId: association.code_repository_id,
      canonicalUrl: association.canonical_url,
      idempotencyKey,
      expectedCommitSha: association.commit_sha,
      activate() {},
    });
    return started.ok
      ? { ok: true, replayed: started.replayed, association: this.#read(associationId)! }
      : started;
  }

  addManual(paperId: string, submittedUrl: string, idempotencyKey: string): AddRepositoryAssociationResult {
    const identity = parseGitHubRepositoryUrl(submittedUrl);
    if (!identity) {
      return { ok: false, code: "invalid-github-repository-url" };
    }
    const replay = this.#commandReplay(idempotencyKey, {
      paperId,
      canonicalUrl: identity.canonicalUrl,
      jobTypes: ["repository-materialization", "repository-association-add", "repository-association-confirm"],
    });
    if (replay.found) {
      return replay.matches
        ? { ok: true, replayed: true, association: this.#readByCanonicalUrl(paperId, identity.canonicalUrl) }
        : { ok: false, code: "idempotency-key-conflict" };
    }
    const paper = this.database.prepare("SELECT lifecycle_status FROM papers WHERE id=?").get(paperId) as
      { lifecycle_status: string } | undefined;
    if (!paper) return { ok: false, code: "paper-not-found" };
    if (paper.lifecycle_status !== "active") return { ok: false, code: "paper-not-active" };
    const existing = this.database.prepare(`SELECT pcl.id,pcl.status,pcl.code_repository_id,pcl.repository_snapshot_id,
      rs.commit_sha,rs.local_path
      FROM paper_code_links pcl
      JOIN code_repositories cr ON cr.id=pcl.code_repository_id
      LEFT JOIN repository_snapshots rs ON rs.id=pcl.repository_snapshot_id
      WHERE pcl.paper_id=? AND cr.canonical_url=?`).get(paperId, identity.canonicalUrl) as
      { id: string; status: string; code_repository_id: string; repository_snapshot_id: string | null;
        commit_sha: string | null; local_path: string | null } | undefined;
    if (existing) {
      if (existing.status === "candidate") return this.confirm(paperId, existing.id, idempotencyKey);
      if (existing.status !== "rejected") {
        this.#recordSynchronousCommand({
          jobType: "repository-association-add",
          paperId,
          associationId: existing.id,
          canonicalUrl: identity.canonicalUrl,
          idempotencyKey,
          mutate() {},
        });
        return { ok: true, replayed: true, association: this.#read(existing.id)! };
      }
      const ownSnapshotReady = Boolean(existing.repository_snapshot_id && existing.commit_sha &&
        isRepositoryMaterialized(this.options.repositoryRoot, existing.local_path, existing.commit_sha));
      const shared = existing.repository_snapshot_id ? null : this.#sharedSnapshot(existing.code_repository_id);
      if (ownSnapshotReady || shared?.ready) {
        this.#recordSynchronousCommand({
          jobType: "repository-association-add",
          paperId,
          associationId: existing.id,
          canonicalUrl: identity.canonicalUrl,
          idempotencyKey,
          mutate: () => {
            this.database.prepare(`UPDATE paper_code_links
              SET status='confirmed',origin='manual',link_type='unknown',repository_snapshot_id=?
              WHERE id=? AND status='rejected'`).run(existing.repository_snapshot_id ?? shared!.id, existing.id);
          },
        });
        return { ok: true, replayed: true, association: this.#read(existing.id)! };
      }
      if (!this.options.adapter) return { ok: false, code: "repository-runner-unavailable" };
      const expectedCommitSha = existing.repository_snapshot_id ? existing.commit_sha : shared?.commitSha;
      const started = this.#startMaterialization({
        paperId,
        associationId: existing.id,
        repositoryId: existing.code_repository_id,
        canonicalUrl: identity.canonicalUrl,
        idempotencyKey,
        ...(expectedCommitSha !== undefined ? { expectedCommitSha } : {}),
        activate: () => {
          this.database.prepare(`UPDATE paper_code_links
            SET status='confirmed',origin='manual',link_type='unknown',repository_snapshot_id=?
            WHERE id=? AND status='rejected'`)
            .run(existing.repository_snapshot_id ?? shared?.id ?? null, existing.id);
        },
      });
      return started.ok
        ? { ok: true, replayed: started.replayed, association: this.#read(existing.id)! }
        : started;
    }

    const timestamp = this.options.now().toISOString();
    const digest = createHash("sha256").update(identity.canonicalUrl).digest("hex").slice(0, 16);
    const repository = this.database.prepare("SELECT id FROM code_repositories WHERE canonical_url=?")
      .get(identity.canonicalUrl) as { id: string } | undefined;
    const repositoryId = repository?.id ?? `repository:${digest}`;
    const shared = this.#sharedSnapshot(repositoryId);
    const associationId = `paper-code-link:${paperId}:${repositoryId}`;
    if (shared?.ready) {
      this.#recordSynchronousCommand({
        jobType: "repository-association-add",
        paperId,
        associationId,
        canonicalUrl: identity.canonicalUrl,
        idempotencyKey,
        mutate: () => {
          this.database.prepare(`INSERT INTO paper_code_links
            (id,paper_id,code_repository_id,link_type,origin,status,repository_snapshot_id,created_at)
            VALUES (?,?,?,'unknown','manual','confirmed',?,?)`)
            .run(associationId, paperId, repositoryId, shared.id, timestamp);
        },
      });
      return { ok: true, replayed: true, association: this.#read(associationId)! };
    }
    if (!this.options.adapter) return { ok: false, code: "repository-runner-unavailable" };
    const started = this.#startMaterialization({
      paperId,
      associationId,
      repositoryId,
      canonicalUrl: identity.canonicalUrl,
      idempotencyKey,
      ...(shared ? { expectedCommitSha: shared.commitSha } : {}),
      activate: () => {
        this.database.prepare(`INSERT INTO code_repositories
          (id,canonical_url,host,owner_name,repository_name,availability_status,created_at,updated_at)
          VALUES (?,?,?,?,?,'unavailable',?,?) ON CONFLICT(canonical_url) DO NOTHING`)
          .run(repositoryId, identity.canonicalUrl, identity.host, identity.owner, identity.repository, timestamp, timestamp);
        this.database.prepare(`INSERT INTO paper_code_links
          (id,paper_id,code_repository_id,link_type,origin,status,repository_snapshot_id,created_at)
          VALUES (?,?,?,'unknown','manual','confirmed',?,?)`)
          .run(associationId, paperId, repositoryId, shared?.id ?? null, timestamp);
      },
    });
    return started.ok
      ? { ok: true, replayed: started.replayed, association: this.#read(associationId)! }
      : started;
  }

  #sharedSnapshot(repositoryId: string): {
    id: string;
    commitSha: string;
    ready: boolean;
  } | null {
    const snapshots = this.database.prepare(`SELECT id,commit_sha,local_path
      FROM repository_snapshots WHERE code_repository_id=? ORDER BY created_at,id`).all(repositoryId) as Array<{
        id: string; commit_sha: string; local_path: string;
      }>;
    const snapshot = snapshots[0];
    return snapshot ? {
      id: snapshot.id,
      commitSha: snapshot.commit_sha,
      ready: isRepositoryMaterialized(this.options.repositoryRoot, snapshot.local_path, snapshot.commit_sha),
    } : null;
  }

  #read(associationId: string): RepositoryAssociationView | null {
    const paper = this.database.prepare("SELECT paper_id FROM paper_code_links WHERE id=?").get(associationId) as
      { paper_id: string } | undefined;
    return paper ? this.list(paper.paper_id).find((association) => association.id === associationId) ?? null : null;
  }

  #readByCanonicalUrl(paperId: string, canonicalUrl: string): RepositoryAssociationView | null {
    return this.list(paperId).find((association) => association.canonicalUrl === canonicalUrl) ?? null;
  }

  #commandReplay(idempotencyKey: string, expected: {
    paperId: string;
    associationId?: string;
    canonicalUrl?: string;
    jobTypes: string[];
  }): { found: false } | { found: true; matches: boolean } {
    const row = this.database.prepare("SELECT job_type,paper_id,input_json FROM job_runs WHERE idempotency_key=?")
      .get(idempotencyKey) as { job_type: string; paper_id: string | null; input_json: string } | undefined;
    if (!row) return { found: false };
    const input = JSON.parse(row.input_json) as { associationId?: unknown; canonicalUrl?: unknown };
    return {
      found: true,
      matches: expected.jobTypes.includes(row.job_type) && row.paper_id === expected.paperId &&
        (expected.associationId === undefined || input.associationId === expected.associationId) &&
        (expected.canonicalUrl === undefined || input.canonicalUrl === expected.canonicalUrl),
    };
  }

  #recordSynchronousCommand(input: {
    jobType: "repository-association-add" | "repository-association-confirm";
    paperId: string;
    associationId: string;
    canonicalUrl: string;
    idempotencyKey: string;
    mutate(): void;
  }): void {
    const timestamp = this.options.now().toISOString();
    const jobId = `job:${input.jobType}:${
      createHash("sha256").update(input.idempotencyKey).digest("hex").slice(0, 24)
    }`;
    this.database.transaction(() => {
      input.mutate();
      this.database.prepare(`INSERT INTO job_runs
        (id,job_type,paper_id,state,progress,attempt,idempotency_key,input_json,output_json,
          queued_at,started_at,completed_at,heartbeat_at)
        VALUES (?,?,?,'succeeded',1,1,?,?,?,?,?,?,?)`)
        .run(jobId, input.jobType, input.paperId, input.idempotencyKey,
          JSON.stringify({ paperId: input.paperId, associationId: input.associationId,
            canonicalUrl: input.canonicalUrl }),
          JSON.stringify({ associationId: input.associationId }), timestamp, timestamp, timestamp, timestamp);
    })();
  }

  #startMaterialization(input: {
    paperId: string;
    associationId: string;
    repositoryId: string;
    canonicalUrl: string;
    idempotencyKey: string;
    expectedCommitSha?: string | null;
    activate(): void;
  }): { ok: true; replayed: boolean } | { ok: false; code: "idempotency-key-conflict" } {
    const replay = this.database.prepare("SELECT job_type,input_json FROM job_runs WHERE idempotency_key=?")
      .get(input.idempotencyKey) as { job_type: string; input_json: string } | undefined;
    if (replay) {
      const replayInput = JSON.parse(replay.input_json) as { associationId?: unknown };
      return replay.job_type === "repository-materialization" && replayInput.associationId === input.associationId
        ? { ok: true, replayed: true }
        : { ok: false, code: "idempotency-key-conflict" };
    }
    const latest = this.database.prepare(`SELECT state,attempt,input_json FROM job_runs
      WHERE job_type='repository-materialization' AND json_extract(input_json,'$.associationId')=?
      ORDER BY attempt DESC,queued_at DESC,id DESC LIMIT 1`).get(input.associationId) as
      { state: string; attempt: number; input_json: string } | undefined;
    if (latest?.state === "running") {
      const runningInput = JSON.parse(latest.input_json) as { expectedCommitSha?: unknown };
      const runningCommit = typeof runningInput.expectedCommitSha === "string" ? runningInput.expectedCommitSha : null;
      const requestedCommit = input.expectedCommitSha ?? null;
      if (runningCommit !== requestedCommit) return { ok: false, code: "idempotency-key-conflict" };
      this.database.transaction(input.activate)();
      return { ok: true, replayed: true };
    }
    const attempt = (latest?.attempt ?? 0) + 1;
    const timestamp = this.options.now().toISOString();
    const digest = createHash("sha256").update(input.canonicalUrl).digest("hex").slice(0, 16);
    const jobId = `job:repository-materialization:${input.associationId}:${attempt}`;
    this.database.transaction(() => {
      input.activate();
      this.database.prepare(`INSERT INTO job_runs
        (id,job_type,paper_id,state,progress,attempt,idempotency_key,input_json,queued_at,started_at,heartbeat_at)
        VALUES (?,'repository-materialization',?,'running',0.1,?,?,?,?,?,?)`)
        .run(jobId, input.paperId, attempt, input.idempotencyKey,
          JSON.stringify({ associationId: input.associationId, repositoryId: input.repositoryId,
            canonicalUrl: input.canonicalUrl,
            ...(input.expectedCommitSha ? { expectedCommitSha: input.expectedCommitSha } : {}) }),
          timestamp, timestamp, timestamp);
    })();
    this.options.schedule(this.#materialize({
      associationId: input.associationId,
      repositoryId: input.repositoryId,
      canonicalUrl: input.canonicalUrl,
      digest,
      jobId,
      timestamp,
      ...(input.expectedCommitSha !== undefined ? { expectedCommitSha: input.expectedCommitSha } : {}),
    }));
    return { ok: true, replayed: false };
  }

  async #materialize(input: {
    associationId: string;
    repositoryId: string;
    canonicalUrl: string;
    digest: string;
    jobId: string;
    timestamp: string;
    expectedCommitSha?: string | null;
  }): Promise<void> {
    try {
      mkdirSync(this.options.repositoryRoot, { recursive: true });
      const { commitSha } = await this.options.adapter!.materialize(
        input.canonicalUrl,
        join(this.options.repositoryRoot, input.digest),
        input.expectedCommitSha ?? undefined,
      );
      const codeElements = collectTextFiles(join(this.options.repositoryRoot, input.digest));
      const snapshotId = `repository-snapshot:${input.repositoryId}:${commitSha}`;
      const completedAt = this.options.now().toISOString();
      this.database.transaction(() => {
        const claimed = this.database.prepare(`UPDATE job_runs SET state='succeeded',progress=1,output_json=?,completed_at=?,heartbeat_at=?
          WHERE id=? AND state='running'`).run(JSON.stringify({ snapshotId, commitSha }), completedAt, completedAt, input.jobId).changes;
        if (!claimed) return;
        this.database.prepare(`INSERT INTO repository_snapshots
          (id,code_repository_id,commit_sha,local_path,created_at)
          VALUES (?,?,?,?,?) ON CONFLICT(code_repository_id,commit_sha) DO NOTHING`)
          .run(snapshotId, input.repositoryId, commitSha, input.digest, input.timestamp);
        this.database.prepare(`UPDATE paper_code_links SET repository_snapshot_id=?
          WHERE id=? AND status='confirmed'`).run(snapshotId, input.associationId);
        for (const file of codeElements) {
          this.database.prepare(`INSERT INTO code_elements
            (id,repository_snapshot_id,relative_path,start_line,end_line,text_content,content_hash)
            VALUES (?,?,?,?,?,?,?) ON CONFLICT(repository_snapshot_id,relative_path,start_line,end_line) DO NOTHING`)
            .run(`code-element:${snapshotId}:${file.relative}`, snapshotId, file.relative, 1, file.lineCount,
              file.text, createHash("sha256").update(file.text).digest("hex"));
        }
        this.database.prepare(`UPDATE code_repositories SET availability_status='available',updated_at=?
          WHERE id=?`).run(completedAt, input.repositoryId);
      })();
    } catch (error) {
      const completedAt = this.options.now().toISOString();
      const message = error instanceof Error ? error.message : "repository-materialization-failed";
      this.database.transaction(() => {
        const claimed = this.database.prepare(`UPDATE job_runs SET state='failed',progress=1,error_json=?,completed_at=?,heartbeat_at=?
          WHERE id=? AND state='running'`).run(JSON.stringify({ code: "repository-materialization-failed", message }),
          completedAt, completedAt, input.jobId).changes;
        if (!claimed) return;
        this.database.prepare(`UPDATE code_repositories SET availability_status='unavailable',updated_at=?
          WHERE id=?`).run(completedAt, input.repositoryId);
      })();
    }
  }
}

function collectTextFiles(root: string): Array<{ relative: string; text: string; lineCount: number }> {
  const tracked = execFileSync("git", ["-C", root, "ls-files", "-z"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
    .split("\0").filter(Boolean);
  return tracked.flatMap((relative) => {
    try {
      const absolute = join(root, relative);
      const stats = lstatSync(absolute);
      if (!stats.isFile() || stats.size > 256_000) return [];
      const bytes = readFileSync(absolute);
      if (bytes.includes(0)) return [];
      const text = bytes.toString("utf8");
      return [{ relative, text, lineCount: Math.max(1, text.split("\n").length) }];
    } catch {
      return [];
    }
  });
}
