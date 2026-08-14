import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

export type PaperVersionObservation = {
  paperId: string;
  arxivId: string;
  latestVersion: number;
  title: string;
  authors: string[];
  year: number;
};

export class PaperVersionReview {
  constructor(private readonly database: Database.Database, private readonly now: () => Date) {}

  observe(input: PaperVersionObservation): unknown | null {
    const current = this.database.prepare(`SELECT p.current_version_id,p.title,v.source_type,v.source_version,v.metadata_json,
      (SELECT metadata_json FROM paper_external_identities i WHERE i.paper_id=p.id AND i.identity_type='arxiv' LIMIT 1) identity_metadata_json
      FROM papers p JOIN paper_versions v ON v.id=p.current_version_id WHERE p.id=?`).get(input.paperId) as
      { current_version_id: string; title: string; source_type: string; source_version: string;
        metadata_json: string | null; identity_metadata_json: string | null } | undefined;
    if (!current || current.source_type !== "arxiv") return null;
    const currentVersion = Number.parseInt(current.source_version.replace(/^v/, ""), 10);
    if (!Number.isInteger(currentVersion)) return null;
    this.#supersedeStale(input.paperId, current.current_version_id, currentVersion);
    if (input.latestVersion <= currentVersion) return null;
    const candidateVersionId = `paper-version:${input.paperId}:arxiv:v${input.latestVersion}`;
    const proposalId = `proposal:paper-version-update:${input.paperId}:v${input.latestVersion}`;
    const sourceUrl = `https://arxiv.org/abs/${input.arxivId}v${input.latestVersion}`;
    const timestamp = this.now().toISOString();
    const metadata = { title: input.title, authors: input.authors, year: input.year };
    const payload = { contractVersion: "paper-version-update.v1", sourceType: "arxiv", arxivId: input.arxivId,
      currentVersionId: current.current_version_id, currentVersion, candidateVersionId,
      candidateVersion: input.latestVersion, latestVersion: input.latestVersion, sourceUrl, metadata, detectedAt: timestamp };
    this.database.transaction(() => {
      if (!current.metadata_json) {
        const identityMetadata = current.identity_metadata_json ? JSON.parse(current.identity_metadata_json) as
          { authors?: string[]; year?: number } : {};
        this.database.prepare("UPDATE paper_versions SET metadata_json=? WHERE id=? AND metadata_json IS NULL")
          .run(JSON.stringify({ title: current.title, authors: identityMetadata.authors ?? [], year: identityMetadata.year ?? input.year }),
            current.current_version_id);
      }
      const pending = this.database.prepare(`SELECT id,payload_json FROM proposals
        WHERE paper_id=? AND proposal_type='paper-version-update' AND review_status='pending'`).all(input.paperId) as
        Array<{ id: string; payload_json: string }>;
      for (const row of pending) {
        const previous = JSON.parse(row.payload_json) as { sourceType?: string; candidateVersion?: number; latestVersion?: number };
        const version = previous.candidateVersion ?? previous.latestVersion;
        if (previous.sourceType !== "direct-pdf" && typeof version === "number" && version < input.latestVersion) {
          this.database.prepare("UPDATE proposals SET review_status='superseded',decided_at=? WHERE id=? AND review_status='pending'")
            .run(timestamp, row.id);
          this.database.prepare(`UPDATE paper_version_candidates SET preparation_status='superseded',updated_at=?
            WHERE proposal_id=? AND preparation_status NOT IN ('accepted','rejected')`).run(timestamp, row.id);
        }
      }
      this.database.prepare(`INSERT INTO paper_versions
        (id,paper_id,source_type,source_version,source_url,resolved_at,processing_status,accepted_at,created_at,updated_at,metadata_json)
        VALUES (?,?,'arxiv',?,?,?,'detected',NULL,?,?,?)
        ON CONFLICT(paper_id,source_type,source_version) DO UPDATE SET
          source_url=excluded.source_url,metadata_json=COALESCE(paper_versions.metadata_json,excluded.metadata_json)`)
        .run(candidateVersionId, input.paperId, `v${input.latestVersion}`, sourceUrl, timestamp, timestamp, timestamp,
          JSON.stringify(metadata));
      this.database.prepare(`INSERT INTO proposals(id,proposal_type,paper_id,payload_json,review_status,one_click_eligible,created_at)
        VALUES (?,'paper-version-update',?,?,'pending',1,?)
        ON CONFLICT(id) DO NOTHING`)
        .run(proposalId, input.paperId, JSON.stringify(payload), timestamp);
      this.database.prepare(`INSERT INTO paper_version_candidates
        (proposal_id,paper_id,before_version_id,candidate_version_id,preparation_status,created_at,updated_at)
        VALUES (?,?,?,?, 'detected',?,?) ON CONFLICT(proposal_id) DO NOTHING`)
        .run(proposalId, input.paperId, current.current_version_id, candidateVersionId, timestamp, timestamp);
    })();
    const status = (this.database.prepare("SELECT review_status FROM proposals WHERE id=?").get(proposalId) as
      { review_status: string }).review_status;
    if (status !== "pending") return null;
    return { id: proposalId, proposalType: "paper-version-update", paperId: input.paperId,
      currentVersion, currentVersionId: current.current_version_id, candidateVersion: input.latestVersion,
      candidateVersionId, sourceUrl, reviewStatus: "pending" };
  }

  prepare(proposalId: string, idempotencyKey: string): { status: number; body: unknown; execution?: {
    paperId: string; arxivId: string; version: number; versionId: string; sourceUrl: string;
    title: string; authors: string[]; year: number; importRequestId: string; jobId: string;
  } } {
    const proposal = this.database.prepare(`SELECT p.paper_id,p.payload_json,p.review_status,c.preparation_status,
      c.material_diff_json FROM proposals p JOIN paper_version_candidates c ON c.proposal_id=p.id WHERE p.id=?`)
      .get(proposalId) as { paper_id: string; payload_json: string; review_status: string;
        preparation_status: string; material_diff_json: string | null } | undefined;
    if (!proposal) return { status: 404, body: { code: "paper-version-proposal-not-found" } };
    if (proposal.review_status !== "pending") return { status: 409, body: { code: "paper-version-proposal-decided" } };
    if (proposal.preparation_status === "ready") return { status: 200, body: { preparation: {
      status: "ready", materialDiff: proposal.material_diff_json ? JSON.parse(proposal.material_diff_json) : null } } };
    const payload = JSON.parse(proposal.payload_json) as { sourceType?: string; arxivId?: string; currentVersionId?: string;
      candidateVersionId?: string; candidateVersion?: number; sourceUrl?: string;
      metadata?: { title: string; authors: string[]; year: number } };
    if (payload.sourceType !== "arxiv" || !payload.arxivId || !payload.currentVersionId ||
        !payload.candidateVersionId || !payload.candidateVersion || !payload.sourceUrl || !payload.metadata) {
      return { status: 409, body: { code: "paper-version-candidate-missing" } };
    }
    const currentVersionId = (this.database.prepare("SELECT current_version_id FROM papers WHERE id=?")
      .get(proposal.paper_id) as { current_version_id: string }).current_version_id;
    if (currentVersionId !== payload.currentVersionId) {
      this.supersede(proposalId);
      return { status: 409, body: { code: "paper-version-proposal-stale" } };
    }
    const replay = this.database.prepare(`SELECT j.id,j.import_request_id,j.state,j.input_json FROM job_runs j
      WHERE j.idempotency_key=?`).get(idempotencyKey) as { id: string; import_request_id: string; state: string } | undefined;
    if (replay) {
      const replayInput = JSON.parse((replay as typeof replay & { input_json: string }).input_json) as { proposalId?: string };
      if (replayInput.proposalId !== proposalId) return { status: 409, body: { code: "idempotency-key-conflict" } };
      return { status: 200, body: { preparation: { status: replay.state },
        importRequest: { id: replay.import_request_id }, job: { id: replay.id, state: replay.state } } };
    }
    const active = this.database.prepare(`SELECT j.id FROM job_runs j WHERE j.paper_id=? AND j.job_type='paper-import'
      AND j.state IN ('queued','running') AND json_extract(j.input_json,'$.versionUpdate')=1 LIMIT 1`).get(proposal.paper_id);
    if (active) return { status: 409, body: { code: "paper-version-update-in-progress" } };
    const timestamp = this.now().toISOString();
    const importRequestId = `import:${randomUUID()}`;
    const jobId = `job:${randomUUID()}`;
    const frozen = { versionId: payload.candidateVersionId, arxivId: payload.arxivId, version: payload.candidateVersion,
      sourceUrl: payload.sourceUrl, proposalId, versionUpdate: true };
    this.database.transaction(() => {
      this.database.prepare(`INSERT INTO import_requests
        (id,original_input,normalized_input,submitted_at,resolution_status,resolved_paper_id,completed_at,reference_kind,frozen_input_json)
        VALUES (?,?,?,?, 'resolved',?,?,'arxiv',?)`).run(importRequestId, payload.sourceUrl, payload.arxivId,
          timestamp, proposal.paper_id, timestamp, JSON.stringify(frozen));
      this.database.prepare(`INSERT INTO job_runs
        (id,job_type,import_request_id,paper_id,state,progress,idempotency_key,input_json,output_json,queued_at,started_at,heartbeat_at)
        VALUES (?,'paper-import',?,?,'running',0.1,?,?,'{}',?,?,?)`).run(jobId, importRequestId, proposal.paper_id,
          idempotencyKey, JSON.stringify(frozen), timestamp, timestamp, timestamp);
      this.database.prepare(`UPDATE paper_version_candidates SET preparation_status='processing',updated_at=? WHERE proposal_id=?`)
        .run(timestamp, proposalId);
      this.database.prepare("UPDATE paper_versions SET processing_status='processing',updated_at=? WHERE id=?")
        .run(timestamp, payload.candidateVersionId);
    })();
    return { status: 202, body: { preparation: { status: "processing" }, importRequest: { id: importRequestId },
      job: { id: jobId, state: "running" } }, execution: { paperId: proposal.paper_id, arxivId: payload.arxivId,
      version: payload.candidateVersion, versionId: payload.candidateVersionId, sourceUrl: payload.sourceUrl,
      title: payload.metadata.title, authors: payload.metadata.authors, year: payload.metadata.year, importRequestId, jobId } };
  }

  supersede(proposalId: string): void {
    const timestamp = this.now().toISOString();
    this.database.transaction(() => {
      this.database.prepare(`UPDATE proposals SET review_status='superseded',decided_at=?
        WHERE id=? AND review_status='pending'`).run(timestamp, proposalId);
      this.database.prepare(`UPDATE paper_version_candidates SET preparation_status='superseded',updated_at=?
        WHERE proposal_id=? AND preparation_status NOT IN ('accepted','rejected','superseded')`).run(timestamp, proposalId);
    })();
  }

  #supersedeStale(paperId: string, currentVersionId: string, currentVersion: number): void {
    const rows = this.database.prepare(`SELECT id,payload_json FROM proposals
      WHERE paper_id=? AND proposal_type='paper-version-update' AND review_status='pending'`).all(paperId) as
      Array<{ id: string; payload_json: string }>;
    for (const row of rows) {
      const payload = JSON.parse(row.payload_json) as { sourceType?: string; currentVersionId?: string;
        candidateVersion?: number; latestVersion?: number };
      if (payload.sourceType === "direct-pdf") continue;
      const candidateVersion = payload.candidateVersion ?? payload.latestVersion;
      if (payload.currentVersionId !== currentVersionId || typeof candidateVersion !== "number" ||
          candidateVersion <= currentVersion) this.supersede(row.id);
    }
  }
}
