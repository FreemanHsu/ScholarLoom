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
      "repository-runner-unavailable" | "repository-association-not-found" | "repository-job-not-retryable" }
  | { ok: true; replayed: boolean; association: RepositoryAssociationView };

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
      WHERE pcl.paper_id=? ORDER BY pcl.created_at,pcl.id`).all(paperId) as Array<{
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

  detectPaperExplicit(paperId: string, canonicalUrl: string): void {
    const identity = parseGitHubRepositoryUrl(canonicalUrl);
    if (!identity) return;
    const timestamp = this.options.now().toISOString();
    const digest = createHash("sha256").update(identity.canonicalUrl).digest("hex").slice(0, 16);
    const repositoryId = `repository:${digest}`;
    this.database.transaction(() => {
      this.database.prepare(`INSERT INTO code_repositories
        (id,canonical_url,host,owner_name,repository_name,availability_status,created_at,updated_at)
        VALUES (?,?,?,?,?,'unavailable',?,?) ON CONFLICT(canonical_url) DO NOTHING`)
        .run(repositoryId, identity.canonicalUrl, identity.host, identity.owner, identity.repository, timestamp, timestamp);
      this.database.prepare(`INSERT INTO paper_code_links
        (id,paper_id,code_repository_id,link_type,origin,status,repository_snapshot_id,created_at)
        VALUES (?,?,?,'unknown','detected','candidate',NULL,?)
        ON CONFLICT(paper_id,code_repository_id) DO NOTHING`)
        .run(`paper-code-link:${paperId}:${repositoryId}`, paperId, repositoryId, timestamp);
    })();
  }

  confirm(paperId: string, associationId: string, idempotencyKey: string): AddRepositoryAssociationResult {
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
      return { ok: true, replayed: true, association: this.#read(associationId)! };
    }
    const timestamp = this.options.now().toISOString();
    const shared = this.#sharedSnapshot(association.code_repository_id);
    if (shared?.ready) {
      this.database.prepare(`UPDATE paper_code_links SET status='confirmed',repository_snapshot_id=?
        WHERE id=? AND status='candidate'`).run(shared.id, associationId);
      return { ok: true, replayed: true, association: this.#read(associationId)! };
    }
    if (!this.options.adapter) return { ok: false, code: "repository-runner-unavailable" };
    const digest = createHash("sha256").update(association.canonical_url).digest("hex").slice(0, 16);
    const jobId = `job:repository-materialization:${associationId}:1`;
    this.database.transaction(() => {
      this.database.prepare(`UPDATE paper_code_links SET status='confirmed',repository_snapshot_id=?
        WHERE id=? AND status='candidate'`).run(shared?.id ?? null, associationId);
      this.database.prepare(`INSERT INTO job_runs
        (id,job_type,paper_id,state,progress,attempt,idempotency_key,input_json,queued_at,started_at,heartbeat_at)
        VALUES (?,'repository-materialization',?,'running',0.1,1,?,?,?,?,?)`)
        .run(jobId, paperId, idempotencyKey,
          JSON.stringify({ associationId, repositoryId: association.code_repository_id,
            canonicalUrl: association.canonical_url,
            ...(shared ? { expectedCommitSha: shared.commitSha } : {}) }), timestamp, timestamp, timestamp);
    })();
    this.options.schedule(this.#materialize({
      associationId,
      repositoryId: association.code_repository_id,
      canonicalUrl: association.canonical_url,
      digest,
      jobId,
      timestamp,
      ...(shared ? { expectedCommitSha: shared.commitSha } : {}),
    }));
    return { ok: true, replayed: false, association: this.#read(associationId)! };
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
    const attempt = previous.attempt + 1;
    const timestamp = this.options.now().toISOString();
    const digest = createHash("sha256").update(association.canonical_url).digest("hex").slice(0, 16);
    const jobId = `job:repository-materialization:${associationId}:${attempt}`;
    this.database.prepare(`INSERT INTO job_runs
      (id,job_type,paper_id,state,progress,attempt,idempotency_key,input_json,queued_at,started_at,heartbeat_at)
      VALUES (?,'repository-materialization',?,'running',0.1,?,?,?,?,?,?)`)
      .run(jobId, paperId, attempt, idempotencyKey,
        JSON.stringify({ associationId, repositoryId: association.code_repository_id,
          canonicalUrl: association.canonical_url,
          ...(association.commit_sha ? { expectedCommitSha: association.commit_sha } : {}) }),
        timestamp, timestamp, timestamp);
    this.options.schedule(this.#materialize({
      associationId,
      repositoryId: association.code_repository_id,
      canonicalUrl: association.canonical_url,
      digest,
      jobId,
      timestamp,
      expectedCommitSha: association.commit_sha,
    }));
    return { ok: true, replayed: false, association: this.#read(associationId)! };
  }

  addManual(paperId: string, submittedUrl: string, idempotencyKey: string): AddRepositoryAssociationResult {
    const identity = parseGitHubRepositoryUrl(submittedUrl);
    if (!identity) {
      return { ok: false, code: "invalid-github-repository-url" };
    }
    const paper = this.database.prepare("SELECT lifecycle_status FROM papers WHERE id=?").get(paperId) as
      { lifecycle_status: string } | undefined;
    if (!paper) return { ok: false, code: "paper-not-found" };
    if (paper.lifecycle_status !== "active") return { ok: false, code: "paper-not-active" };
    const existing = this.database.prepare(`SELECT pcl.id,pcl.status FROM paper_code_links pcl
      JOIN code_repositories cr ON cr.id=pcl.code_repository_id
      WHERE pcl.paper_id=? AND cr.canonical_url=?`).get(paperId, identity.canonicalUrl) as
      { id: string; status: string } | undefined;
    if (existing) {
      return existing.status === "candidate"
        ? this.confirm(paperId, existing.id, idempotencyKey)
        : { ok: true, replayed: true, association: this.#read(existing.id)! };
    }

    const timestamp = this.options.now().toISOString();
    const digest = createHash("sha256").update(identity.canonicalUrl).digest("hex").slice(0, 16);
    const repository = this.database.prepare("SELECT id FROM code_repositories WHERE canonical_url=?")
      .get(identity.canonicalUrl) as { id: string } | undefined;
    const repositoryId = repository?.id ?? `repository:${digest}`;
    const shared = this.#sharedSnapshot(repositoryId);
    const associationId = `paper-code-link:${paperId}:${repositoryId}`;
    if (shared?.ready) {
      this.database.prepare(`INSERT INTO paper_code_links
        (id,paper_id,code_repository_id,link_type,origin,status,repository_snapshot_id,created_at)
        VALUES (?,?,?,'unknown','manual','confirmed',?,?)`)
        .run(associationId, paperId, repositoryId, shared.id, timestamp);
      return { ok: true, replayed: true, association: this.#read(associationId)! };
    }
    if (!this.options.adapter) return { ok: false, code: "repository-runner-unavailable" };
    const jobId = `job:repository-materialization:${associationId}:1`;
    this.database.transaction(() => {
      this.database.prepare(`INSERT INTO code_repositories
        (id,canonical_url,host,owner_name,repository_name,availability_status,created_at,updated_at)
        VALUES (?,?,?,?,?,'unavailable',?,?) ON CONFLICT(canonical_url) DO NOTHING`)
        .run(repositoryId, identity.canonicalUrl, identity.host, identity.owner, identity.repository, timestamp, timestamp);
      this.database.prepare(`INSERT INTO paper_code_links
        (id,paper_id,code_repository_id,link_type,origin,status,repository_snapshot_id,created_at)
        VALUES (?,?,?,'unknown','manual','confirmed',?,?)`)
        .run(associationId, paperId, repositoryId, shared?.id ?? null, timestamp);
      this.database.prepare(`INSERT INTO job_runs
        (id,job_type,paper_id,state,progress,attempt,idempotency_key,input_json,queued_at,started_at,heartbeat_at)
        VALUES (?,'repository-materialization',?,'running',0.1,1,?,?,?,?,?)`)
        .run(jobId, paperId, idempotencyKey,
          JSON.stringify({ associationId, repositoryId, canonicalUrl: identity.canonicalUrl,
            ...(shared ? { expectedCommitSha: shared.commitSha } : {}) }), timestamp, timestamp, timestamp);
    })();
    this.options.schedule(this.#materialize({
      associationId, repositoryId, canonicalUrl: identity.canonicalUrl, digest, jobId, timestamp,
      ...(shared ? { expectedCommitSha: shared.commitSha } : {}),
    }));
    return { ok: true, replayed: false, association: this.#read(associationId)! };
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
