import { createHash } from "node:crypto";
import { isAbsolute, join, relative } from "node:path";

import type Database from "better-sqlite3";

import {
  AnswerGroundingGate,
  type ProposedCitation,
  type TextProposedCitation,
} from "./answer-grounding-gate.js";
import type { StorageLayout } from "./layout.js";

type AttemptAuthority = {
  context_snapshot_id: string;
  root_ref: string;
};

export class TextCitationPreflight {
  constructor(private readonly input: {
    attemptId: string;
    runEpoch: number;
    layout: StorageLayout;
    database: Database.Database;
  }) {}

  verify(request: Omit<TextProposedCitation, "kind">): TextProposedCitation {
    try {
      const authority = this.#authority();
      const workspaceRoot = this.#workspaceRoot(authority.root_ref);
      const gate = AnswerGroundingGate.open(workspaceRoot, this.input.database, authority.context_snapshot_id);
      const proposed: TextProposedCitation = { kind: "text", ...request };
      let receipts: ReturnType<AnswerGroundingGate["verify"]>;
      try { receipts = gate.verify([proposed]); }
      catch { receipts = gate.repair([proposed]); }
      const receipt = receipts[0];
      if (!receipt || receipt.evidenceKind === "visual") throw new Error("text-citation-preflight-invalid");
      const citation: TextProposedCitation = {
        kind: "text",
        path: receipt.workspacePath,
        lineStart: receipt.locator.lineStart,
        lineEnd: receipt.locator.lineEnd,
        quote: receipt.quote,
      };
      this.#recordSuccess(citation);
      return citation;
    } catch (error) {
      this.#recordFailure(error);
      throw error;
    }
  }

  #recordSuccess(citation: TextProposedCitation): void {
    const metadata = JSON.stringify({ citationHash: textCitationPreflightHash(citation) });
    this.input.database.prepare(`INSERT INTO agent_run_activities
      (job_run_id,run_epoch,event_type,display_text,metadata_json,created_at)
      SELECT ?,?,'text-citation-preflight','已预检文本引用',?,?
      WHERE EXISTS (SELECT 1 FROM job_runs WHERE id=? AND state='running' AND run_epoch=?)
        AND NOT EXISTS (SELECT 1 FROM agent_run_activities
          WHERE job_run_id=? AND run_epoch=? AND event_type='text-citation-preflight' AND metadata_json=?)`)
      .run(this.input.attemptId, this.input.runEpoch, metadata, new Date().toISOString(),
        this.input.attemptId, this.input.runEpoch, this.input.attemptId, this.input.runEpoch, metadata);
  }

  #recordFailure(error: unknown): void {
    const code = (error instanceof Error ? error.message : "text-citation-preflight-failed").split(":", 1)[0]!.slice(0, 120);
    this.input.database.prepare(`INSERT INTO agent_run_activities
      (job_run_id,run_epoch,event_type,display_text,metadata_json,created_at)
      SELECT ?,?,'text-citation-preflight-failed','文本引用预检失败',?,?
      WHERE EXISTS (SELECT 1 FROM job_runs WHERE id=? AND state='running' AND run_epoch=?)`)
      .run(this.input.attemptId, this.input.runEpoch, JSON.stringify({ code }), new Date().toISOString(),
        this.input.attemptId, this.input.runEpoch);
  }

  #authority(): AttemptAuthority {
    const row = this.input.database.prepare(`SELECT message.context_snapshot_id,workspace.root_ref
      FROM job_runs job
      JOIN conversation_turn_attempts attempt ON attempt.job_run_id=job.id
      JOIN messages message ON message.id=attempt.user_message_id
      JOIN evidence_workspaces workspace ON workspace.id=job.evidence_workspace_id
      WHERE job.id=? AND job.state='running' AND job.run_epoch=? AND job.runner_kind='agentic_evidence'
        AND workspace.status='built'`).get(this.input.attemptId, this.input.runEpoch) as AttemptAuthority | undefined;
    if (!row) throw new Error("text-citation-attempt-inactive-or-stale");
    return row;
  }

  #workspaceRoot(rootRef: string): string {
    const root = join(this.input.layout.root, rootRef);
    const fromWorkspaceParent = relative(join(this.input.layout.derivedRoot, "evidence-workspaces"), root);
    if (!fromWorkspaceParent || fromWorkspaceParent.startsWith("..") || isAbsolute(fromWorkspaceParent)) {
      throw new Error("text-citation-workspace-path-unsafe");
    }
    return root;
  }
}

export function preflightTextCitations(input: {
  attemptId: string;
  runEpoch: number;
  layout: StorageLayout;
  database: Database.Database;
  citations: ProposedCitation[];
}): ProposedCitation[] {
  const preflight = new TextCitationPreflight(input);
  return input.citations.map((citation) => citation.kind === "text"
    ? preflight.verify({ path: citation.path, lineStart: citation.lineStart,
      lineEnd: citation.lineEnd, quote: citation.quote })
    : citation);
}

export function textCitationPreflightHash(citation: TextProposedCitation): string {
  return createHash("sha256").update(JSON.stringify([
    citation.path,
    citation.lineStart,
    citation.lineEnd,
    citation.quote,
  ])).digest("hex");
}
