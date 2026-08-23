import { createHash, randomUUID } from "node:crypto";

import Database from "better-sqlite3";

import {
  knowledgeAnswerSchema,
  validateKnowledgeAnswer,
  type KnowledgeAnswer,
  type KnowledgeAnswerRunner,
} from "../agent/knowledge-answer.js";
import type { AgentExecutionMetadataProvider } from "../agent/agent-configuration.js";
import type { StorageLayout } from "./layout.js";
import { migrate } from "./migrations.js";
import { SqliteCuratedKnowledgeReader, type CuratedSourceType } from "./curated-knowledge-reader.js";

const MAXIMUM_AUTOMATIC_RETRIES = 3;
const RETRY_DELAYS_MS = [1_000, 3_000, 10_000] as const;
const VALIDATED_KNOWLEDGE_FAILURES = new Set([
  "knowledge-answer-basis-invalid",
  "knowledge-answer-boundary-invalid",
  "knowledge-answer-budget-coverage-invalid",
  "knowledge-answer-citation-canonical-mismatch",
  "knowledge-answer-citation-invalid",
  "knowledge-answer-citation-not-verified",
  "knowledge-answer-citation-unused",
  "knowledge-answer-claim-invalid",
  "knowledge-answer-conflict-invalid",
  "knowledge-answer-consensus-invalid",
  "knowledge-answer-content-invalid",
  "knowledge-answer-context-missing",
  "knowledge-answer-coverage-invalid",
  "knowledge-answer-markdown-unsafe",
  "knowledge-answer-retrieval-invalid",
]);

export type KnowledgeEvidenceReceiptView = {
  id: string;
  ordinal: number;
  sourceType: CuratedSourceType;
  sourceId: string;
  revisionId: string;
  contentHash: string;
  title: string;
  trustLabel: "generated-from-primary-source" | "user-confirmed";
  locator: { lineStart: number; lineEnd: number };
  quote: string;
  whySelected: string;
  available: boolean;
  unavailableReason: "missing" | "ineligible" | "integrity-withheld" | null;
  href: string | null;
};

export type KnowledgeAttemptState = "running" | "succeeded" | "failed" | "canceled" | "interrupted";
export type KnowledgeAttemptView = {
  id: string;
  state: KnowledgeAttemptState;
  conversationId: string | null;
  error: { code: string; detail: string | null } | null;
  createdAt: string;
  completedAt: string | null;
};

export type KnowledgeMessageView = {
  id: string;
  role: "user" | "assistant";
  ordinal: number;
  replyToMessageId: string | null;
  content: string;
  answerBasis: KnowledgeAnswer["answerBasis"] | null;
  coverage: KnowledgeAnswer["coverage"] | null;
  answer: KnowledgeAnswer | null;
  evidenceReceipts: KnowledgeEvidenceReceiptView[];
  createdAt: string;
};

export type KnowledgeConversationView = {
  id: string;
  title: string;
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
  messages: KnowledgeMessageView[];
};

type CoordinatorOptions = {
  now?: () => Date;
  agentExecutionMetadata?: AgentExecutionMetadataProvider;
  recentMessageLimit?: number;
  hardTimeoutMs?: number;
  maximumConcurrency?: number;
  waitBeforeRetry?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
};

export class KnowledgeConversationCoordinator {
  readonly #database: Database.Database;
  readonly #runner: KnowledgeAnswerRunner;
  readonly #curatedReader: SqliteCuratedKnowledgeReader;
  readonly #now: () => Date;
  readonly #metadata: AgentExecutionMetadataProvider | undefined;
  readonly #recentMessageLimit: number;
  readonly #hardTimeoutMs: number;
  readonly #maximumConcurrency: number;
  readonly #waitBeforeRetry: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly #controllers = new Map<string, AbortController>();
  readonly #tasks = new Set<Promise<void>>();
  readonly #permitWaiters: Array<() => void> = [];
  #activeExecutions = 0;
  #closed = false;

  static open(layout: StorageLayout, runner: KnowledgeAnswerRunner, options: CoordinatorOptions = {}) {
    const database = new Database(layout.databasePath);
    database.pragma("foreign_keys = ON");
    database.pragma("busy_timeout = 5000");
    migrate(database);
    return new KnowledgeConversationCoordinator(layout, database, runner, options);
  }

  private constructor(layout: StorageLayout, database: Database.Database, runner: KnowledgeAnswerRunner,
    options: CoordinatorOptions) {
    this.#database = database;
    this.#runner = runner;
    this.#curatedReader = SqliteCuratedKnowledgeReader.open(layout);
    this.#now = options.now ?? (() => new Date());
    this.#metadata = options.agentExecutionMetadata;
    this.#recentMessageLimit = options.recentMessageLimit ?? 12;
    this.#hardTimeoutMs = options.hardTimeoutMs ?? 180_000;
    this.#maximumConcurrency = options.maximumConcurrency ?? 2;
    this.#waitBeforeRetry = options.waitBeforeRetry ?? abortableDelay;
    if (!Number.isFinite(this.#hardTimeoutMs) || this.#hardTimeoutMs <= 0 ||
        !Number.isInteger(this.#maximumConcurrency) || this.#maximumConcurrency <= 0) {
      throw new Error("knowledge-answer-runtime-invalid");
    }
    const interruptedAt = this.#now().toISOString();
    this.#database.transaction(() => {
      this.#database.prepare(`UPDATE job_runs SET state='interrupted',completed_at=?,error_json=?
        WHERE job_type='knowledge-answer' AND state IN ('queued','running','canceling')`)
        .run(interruptedAt, JSON.stringify({ code: "application-restarted" }));
      this.#database.prepare(`UPDATE knowledge_turn_attempts SET state='interrupted',completed_at=?,
        error_code='application-restarted',error_detail=NULL WHERE state='running'`).run(interruptedAt);
    })();
  }

  submit(input: { conversationId?: string; question: string; idempotencyKey: string }): KnowledgeAttemptView {
    if (this.#closed) throw new Error("knowledge-conversation-closed");
    const question = input.question.trim();
    if (!question || question.length > 20_000) throw new Error("knowledge-question-invalid");
    if (!input.idempotencyKey.trim() || input.idempotencyKey.length > 200) throw new Error("idempotency-key-invalid");
    const questionHash = sha256(question);
    const replay = this.#attemptBySubmission(input.idempotencyKey, questionHash, input.conversationId ?? null);
    if (replay) return replay;
    if (input.conversationId) {
      const conversation = this.#database.prepare("SELECT status FROM knowledge_conversations WHERE id=?")
        .get(input.conversationId) as { status: string } | undefined;
      if (!conversation) throw new Error("knowledge-conversation-not-found");
      if (conversation.status !== "active") throw new Error("knowledge-conversation-archived");
    }

    const attemptId = randomUUID();
    const jobRunId = randomUUID();
    const createdAt = this.#now().toISOString();
    this.#database.transaction(() => {
      this.#database.prepare(`INSERT INTO job_runs
        (id,job_type,state,progress,attempt,idempotency_key,input_json,queued_at,started_at,heartbeat_at,run_epoch)
        VALUES (?,'knowledge-answer','queued',0,1,?,?,?,NULL,NULL,0)`)
        .run(jobRunId, `knowledge-answer:${input.idempotencyKey}`, JSON.stringify({
          questionHash,
          conversationId: input.conversationId ?? null,
        }), createdAt);
      this.#database.prepare(`INSERT INTO knowledge_turn_attempts
        (id,job_run_id,knowledge_conversation_id,submission_id,question_hash,run_epoch,state,created_at)
        VALUES (?,?,?,?,?,0,'running',?)`)
        .run(attemptId, jobRunId, input.conversationId ?? null, input.idempotencyKey, questionHash, createdAt);
    })();

    const controller = new AbortController();
    this.#controllers.set(attemptId, controller);
    const task = Promise.resolve().then(() => this.#execute({
      attemptId,
      jobRunId,
      conversationId: input.conversationId ?? null,
      question,
      signal: controller.signal,
    })).finally(() => {
      this.#controllers.delete(attemptId);
      this.#tasks.delete(task);
    });
    this.#tasks.add(task);
    return this.readAttempt(attemptId);
  }

  cancel(attemptId: string, idempotencyKey: string): boolean {
    if (!idempotencyKey.trim() || idempotencyKey.length > 200) throw new Error("idempotency-key-invalid");
    const completedAt = this.#now().toISOString();
    const result = this.#database.transaction(() => {
      const attempt = this.#database.prepare(`SELECT job_run_id,state,cancel_idempotency_key
        FROM knowledge_turn_attempts WHERE id=?`).get(attemptId) as {
          job_run_id: string; state: KnowledgeAttemptState; cancel_idempotency_key: string | null;
        } | undefined;
      if (!attempt) throw new Error("knowledge-attempt-not-found");
      const keyOwner = this.#database.prepare(`SELECT id FROM knowledge_turn_attempts
        WHERE cancel_idempotency_key=?`).pluck().get(idempotencyKey) as string | undefined;
      if (keyOwner && keyOwner !== attemptId) throw new Error("idempotency-key-conflict");
      if (attempt.cancel_idempotency_key) {
        if (attempt.cancel_idempotency_key !== idempotencyKey) throw new Error("idempotency-key-conflict");
        return { accepted: true, changed: false };
      }
      if (attempt.state !== "running") return { accepted: false, changed: false };
      this.#database.prepare(`UPDATE knowledge_turn_attempts SET state='canceled',completed_at=?,
        error_code='user-canceled',error_detail=NULL,cancel_idempotency_key=? WHERE id=?`)
        .run(completedAt, idempotencyKey, attemptId);
      this.#database.prepare(`UPDATE job_runs SET state='canceled',progress=1,completed_at=?,error_json=? WHERE id=?`)
        .run(completedAt, JSON.stringify({ code: "user-canceled" }), attempt.job_run_id);
      return { accepted: true, changed: true };
    })();
    if (result.changed) this.#controllers.get(attemptId)?.abort(new Error("user-canceled"));
    return result.accepted;
  }

  readAttempt(attemptId: string): KnowledgeAttemptView {
    const row = this.#database.prepare(`SELECT id,state,knowledge_conversation_id,error_code,error_detail,created_at,completed_at
      FROM knowledge_turn_attempts WHERE id=?`).get(attemptId) as {
        id: string; state: KnowledgeAttemptState; knowledge_conversation_id: string | null;
        error_code: string | null; error_detail: string | null; created_at: string; completed_at: string | null;
      } | undefined;
    if (!row) throw new Error("knowledge-attempt-not-found");
    return {
      id: row.id,
      state: row.state,
      conversationId: row.knowledge_conversation_id,
      error: row.error_code ? { code: row.error_code, detail: row.error_detail } : null,
      createdAt: row.created_at,
      completedAt: row.completed_at,
    };
  }

  list(view: "active" | "archived") {
    return (this.#database.prepare(`SELECT c.id,c.title,c.status,c.created_at,c.updated_at,COUNT(m.id) message_count
      FROM knowledge_conversations c LEFT JOIN knowledge_messages m ON m.knowledge_conversation_id=c.id
      WHERE c.status=? GROUP BY c.id ORDER BY c.updated_at DESC,c.id`).all(view) as Array<{
        id: string; title: string; status: "active" | "archived"; created_at: string; updated_at: string; message_count: number;
      }>).map((row) => ({ id: row.id, title: row.title, status: row.status,
        createdAt: row.created_at, updatedAt: row.updated_at, messageCount: row.message_count }));
  }

  read(conversationId: string): KnowledgeConversationView {
    const conversation = this.#database.prepare(`SELECT id,title,status,created_at,updated_at
      FROM knowledge_conversations WHERE id=?`).get(conversationId) as {
        id: string; title: string; status: "active" | "archived"; created_at: string; updated_at: string;
      } | undefined;
    if (!conversation) throw new Error("knowledge-conversation-not-found");
    const messages = (this.#database.prepare(`SELECT id,role,ordinal,reply_to_message_id,content,answer_basis,coverage,
      structured_answer_json,created_at FROM knowledge_messages WHERE knowledge_conversation_id=? ORDER BY ordinal`)
      .all(conversationId) as Array<{
        id: string; role: "user" | "assistant"; ordinal: number; reply_to_message_id: string | null;
        content: string; answer_basis: KnowledgeAnswer["answerBasis"] | null; coverage: KnowledgeAnswer["coverage"] | null;
        structured_answer_json: string | null; created_at: string;
      }>).map((row): KnowledgeMessageView => ({
        id: row.id,
        role: row.role,
        ordinal: row.ordinal,
        replyToMessageId: row.reply_to_message_id,
        content: row.content,
        answerBasis: row.answer_basis,
        coverage: row.coverage,
        answer: row.structured_answer_json ? JSON.parse(row.structured_answer_json) as KnowledgeAnswer : null,
        evidenceReceipts: this.#readEvidenceReceipts(row.id),
        createdAt: row.created_at,
      }));
    return { id: conversation.id, title: conversation.title, status: conversation.status,
      createdAt: conversation.created_at, updatedAt: conversation.updated_at, messages };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const completedAt = this.#now().toISOString();
    this.#database.transaction(() => {
      this.#database.prepare(`UPDATE job_runs SET state='interrupted',progress=1,completed_at=?,error_json=?
        WHERE job_type='knowledge-answer' AND state IN ('queued','running')`)
        .run(completedAt, JSON.stringify({ code: "application-closing" }));
      this.#database.prepare(`UPDATE knowledge_turn_attempts SET state='interrupted',completed_at=?,
        error_code='application-closing',error_detail=NULL WHERE state='running'`).run(completedAt);
    })();
    for (const controller of this.#controllers.values()) controller.abort(new Error("application-closing"));
    await Promise.allSettled(this.#tasks);
    this.#curatedReader.close();
    this.#database.close();
  }

  #attemptBySubmission(submissionId: string, questionHash: string,
    conversationId: string | null): KnowledgeAttemptView | null {
    const row = this.#database.prepare(`SELECT id,question_hash,knowledge_conversation_id
      FROM knowledge_turn_attempts WHERE submission_id=?`).get(submissionId) as {
        id: string; question_hash: string; knowledge_conversation_id: string | null;
      } | undefined;
    if (row && (row.question_hash !== questionHash || row.knowledge_conversation_id !== conversationId)) {
      throw new Error("idempotency-key-conflict");
    }
    return row ? this.readAttempt(row.id) : null;
  }

  #recentConversation(conversationId: string | null) {
    if (!conversationId) return [];
    return (this.#database.prepare(`SELECT role,content FROM knowledge_messages WHERE knowledge_conversation_id=?
      ORDER BY ordinal DESC LIMIT ?`).all(conversationId, this.#recentMessageLimit) as Array<{
        role: "user" | "assistant"; content: string;
      }>).reverse();
  }

  async #execute(input: { attemptId: string; jobRunId: string; conversationId: string | null;
    question: string; signal: AbortSignal }): Promise<void> {
    let permit = false;
    try {
      if (input.signal.aborted) return;
      permit = await this.#acquirePermit(input.signal);
      if (!permit || input.signal.aborted) return;
      const conversation = this.#recentConversation(input.conversationId);
      const { answer, runEpoch } = await this.#answerWithRetries(input, conversation);
      const completedAt = this.#now().toISOString();
      this.#database.transaction(() => {
        const attempt = this.#database.prepare("SELECT state FROM knowledge_turn_attempts WHERE id=?")
          .get(input.attemptId) as { state: KnowledgeAttemptState } | undefined;
        if (attempt?.state !== "running") return;
        const conversationId = input.conversationId ?? randomUUID();
        if (!input.conversationId) {
          this.#database.prepare(`INSERT INTO knowledge_conversations(id,title,status,created_at,updated_at)
            VALUES (?,?,'active',?,?)`).run(conversationId, titleFromQuestion(input.question), completedAt, completedAt);
        }
        const nextOrdinal = (this.#database.prepare(`SELECT COALESCE(MAX(ordinal),-1)+1 value FROM knowledge_messages
          WHERE knowledge_conversation_id=?`).pluck().get(conversationId) as number);
        const userMessageId = randomUUID();
        const assistantMessageId = randomUUID();
        this.#database.prepare(`INSERT INTO knowledge_messages
          (id,knowledge_conversation_id,role,ordinal,content,created_at) VALUES (?,?,'user',?,?,?)`)
          .run(userMessageId, conversationId, nextOrdinal, input.question, completedAt);
        this.#database.prepare(`INSERT INTO knowledge_messages
          (id,knowledge_conversation_id,role,ordinal,reply_to_message_id,content,answer_basis,coverage,structured_answer_json,created_at)
          VALUES (?,?,'assistant',?,?,?,?,?,?,?)`)
          .run(assistantMessageId, conversationId, nextOrdinal + 1, userMessageId, answer.directAnswer,
            answer.answerBasis, answer.coverage, JSON.stringify(answer), completedAt);
        this.#database.prepare(`UPDATE knowledge_turn_attempts SET state='succeeded',knowledge_conversation_id=?,
          user_message_id=?,assistant_message_id=?,completed_at=? WHERE id=?`)
          .run(conversationId, userMessageId, assistantMessageId, completedAt, input.attemptId);
        const insertReceipt = this.#database.prepare(`INSERT INTO knowledge_evidence_receipts
          (id,assistant_message_id,job_run_id,run_epoch,ordinal,source_type,source_id,source_revision_id,
           content_hash,source_title,trust_label,locator_json,quote_text,why_selected,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
        answer.citations.forEach((citation, index) => insertReceipt.run(randomUUID(), assistantMessageId,
          input.jobRunId, runEpoch, index + 1, citation.sourceType, citation.sourceId, citation.revisionId,
          citation.contentHash, citation.title, citation.trustLabel, JSON.stringify(citation.locator),
          citation.quote, citation.whySelected, completedAt));
        this.#database.prepare("UPDATE knowledge_conversations SET updated_at=? WHERE id=?")
          .run(completedAt, conversationId);
        const metadata = this.#metadata?.("knowledge-answer");
        this.#database.prepare(`INSERT INTO agent_runs
          (job_run_id,task_kind,model,reasoning_effort,codex_version,configuration_version,
           output_schema_hash,prompt_hash,output_json) VALUES (?,?,?,?,?,?,?,?,?)`)
          .run(input.jobRunId, "knowledge-answer", metadata?.model ?? null, metadata?.reasoningEffort ?? null,
            metadata?.codexVersion ?? "unknown", metadata?.configurationVersion ?? null,
            sha256(JSON.stringify(knowledgeAnswerSchema)), sha256("knowledge-answer.v1"), JSON.stringify(answer));
        this.#database.prepare(`UPDATE job_runs SET state='succeeded',progress=1,output_json=?,completed_at=?,heartbeat_at=? WHERE id=?`)
          .run(JSON.stringify({ conversationId, userMessageId, assistantMessageId }), completedAt, completedAt, input.jobRunId);
      })();
    } catch (error) {
      const completedAt = this.#now().toISOString();
      const code = knowledgeFailureCode(error);
      this.#database.transaction(() => {
        const attempt = this.#database.prepare("SELECT state FROM knowledge_turn_attempts WHERE id=?")
          .get(input.attemptId) as { state: KnowledgeAttemptState } | undefined;
        if (attempt?.state !== "running") return;
        this.#database.prepare(`UPDATE knowledge_turn_attempts SET state='failed',completed_at=?,
          error_code=?,error_detail=NULL WHERE id=?`).run(completedAt, code, input.attemptId);
        this.#database.prepare(`UPDATE job_runs SET state='failed',progress=1,completed_at=?,error_json=? WHERE id=?`)
          .run(completedAt, JSON.stringify({ code }), input.jobRunId);
      })();
    } finally {
      if (permit) this.#releasePermit();
    }
  }

  async #answerWithRetries(input: { attemptId: string; jobRunId: string; question: string; signal: AbortSignal },
    conversation: Array<{ role: "user" | "assistant"; content: string }>): Promise<{ answer: KnowledgeAnswer; runEpoch: number }> {
    for (let retry = 0; retry <= MAXIMUM_AUTOMATIC_RETRIES; retry += 1) {
      const runEpoch = this.#markRunning(input.attemptId, input.jobRunId);
      if (runEpoch === null) throw input.signal.reason ?? new Error("knowledge-answer-aborted");
      const epochController = new AbortController();
      const abortEpoch = () => epochController.abort(input.signal.reason ?? new Error("knowledge-answer-aborted"));
      input.signal.addEventListener("abort", abortEpoch, { once: true });
      const timeout = setTimeout(() => epochController.abort(new Error("knowledge-answer-timeout")), this.#hardTimeoutMs);
      try {
        const answer = await settleOnAbort(Promise.resolve().then(() => this.#runner.answer({
          question: input.question,
          conversation,
          attemptId: input.attemptId,
          jobRunId: input.jobRunId,
          runEpoch,
          signal: epochController.signal,
        })), epochController.signal);
        validateKnowledgeAnswer(answer);
        if (answer.answerBasis === "conversation-context" && conversation.length === 0) {
          throw new Error("knowledge-answer-context-missing");
        }
        return { answer, runEpoch };
      } catch (error) {
        if (input.signal.aborted || retry === MAXIMUM_AUTOMATIC_RETRIES || !retryableKnowledgeFailure(error)) throw error;
      } finally {
        clearTimeout(timeout);
        input.signal.removeEventListener("abort", abortEpoch);
      }
      await this.#waitBeforeRetry(RETRY_DELAYS_MS[retry]!, input.signal);
    }
    throw new Error("knowledge-answer-failed");
  }

  #markRunning(attemptId: string, jobRunId: string): number | null {
    const startedAt = this.#now().toISOString();
    return this.#database.transaction(() => {
      const state = this.#database.prepare("SELECT state FROM knowledge_turn_attempts WHERE id=?")
        .pluck().get(attemptId) as KnowledgeAttemptState | undefined;
      if (state !== "running") return null;
      const currentEpoch = Number(this.#database.prepare("SELECT run_epoch FROM job_runs WHERE id=?").pluck().get(jobRunId));
      const runEpoch = currentEpoch + 1;
      this.#database.prepare(`UPDATE job_runs SET state='running',progress=.05,attempt=?,started_at=?,heartbeat_at=?,run_epoch=? WHERE id=?`)
        .run(runEpoch, startedAt, startedAt, runEpoch, jobRunId);
      this.#database.prepare("UPDATE knowledge_turn_attempts SET run_epoch=? WHERE id=?").run(runEpoch, attemptId);
      return runEpoch;
    })();
  }

  #readEvidenceReceipts(messageId: string): KnowledgeEvidenceReceiptView[] {
    return (this.#database.prepare(`SELECT id,ordinal,source_type,source_id,source_revision_id,content_hash,
      source_title,trust_label,locator_json,quote_text,why_selected
      FROM knowledge_evidence_receipts WHERE assistant_message_id=? ORDER BY ordinal`).all(messageId) as Array<{
        id: string; ordinal: number; source_type: CuratedSourceType; source_id: string; source_revision_id: string;
        content_hash: string; source_title: string; trust_label: "generated-from-primary-source" | "user-confirmed";
        locator_json: string; quote_text: string; why_selected: string;
      }>).map((row) => {
        const availability = this.#curatedReader.availability({ sourceType: row.source_type, sourceId: row.source_id,
          revisionId: row.source_revision_id, contentHash: row.content_hash });
        return { id: row.id, ordinal: row.ordinal, sourceType: row.source_type, sourceId: row.source_id,
          revisionId: row.source_revision_id, contentHash: row.content_hash, title: row.source_title,
          trustLabel: row.trust_label, locator: JSON.parse(row.locator_json) as { lineStart: number; lineEnd: number },
          quote: row.quote_text, whySelected: row.why_selected, available: availability.available,
          unavailableReason: availability.available ? null : availability.reason,
          href: availability.available ? this.#sourceHref(row.source_type, row.source_id) : null };
      });
  }

  #sourceHref(sourceType: CuratedSourceType, sourceId: string): string | null {
    if (sourceType === "topic-knowledge") {
      const topicExists = this.#database.prepare(`SELECT 1 FROM direction_catalog
        WHERE topic_id=? AND lifecycle_status='active'`).pluck().get(sourceId);
      return topicExists
        ? `/papers/organize?view=all&direction=${encodeURIComponent(sourceId)}#topic-knowledge`
        : null;
    }
    let paperId: string | undefined;
    if (sourceType === "summary") {
      paperId = this.#database.prepare("SELECT paper_id FROM summary_revisions WHERE id=?").pluck().get(sourceId) as string | undefined;
    } else if (sourceType === "takeaway") {
      paperId = this.#database.prepare(`SELECT t.paper_id FROM takeaway_revisions r
        JOIN takeaways t ON t.id=r.takeaway_id WHERE r.id=?`).pluck().get(sourceId) as string | undefined;
    }
    return paperId ? `/papers/${encodeURIComponent(paperId)}#${sourceType}=${encodeURIComponent(sourceId)}` : null;
  }

  #acquirePermit(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    if (this.#activeExecutions < this.#maximumConcurrency) {
      this.#activeExecutions += 1;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const grant = () => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted) { resolve(false); return; }
        this.#activeExecutions += 1;
        resolve(true);
      };
      const abort = () => {
        const index = this.#permitWaiters.indexOf(grant);
        if (index >= 0) this.#permitWaiters.splice(index, 1);
        resolve(false);
      };
      this.#permitWaiters.push(grant);
      signal.addEventListener("abort", abort, { once: true });
    });
  }

  #releasePermit(): void {
    this.#activeExecutions -= 1;
    this.#permitWaiters.shift()?.();
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function titleFromQuestion(question: string): string {
  const characters = [...question.trim().replace(/\s+/gu, " ")];
  return characters.length <= 48 ? characters.join("") : `${characters.slice(0, 47).join("")}…`;
}

function settleOnAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(signal.reason ?? new Error("knowledge-answer-aborted")));
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
    operation.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason ?? new Error("knowledge-answer-aborted"));
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

function knowledgeFailureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message === "knowledge-answer-timeout") return message;
  if (message === "curated-mcp-capability-unavailable") return "knowledge-answer-capability-unavailable";
  if (message === "knowledge-answer-context-missing") return message;
  if (message.startsWith("knowledge-answer-") || message.startsWith("codex-output-invalid:")) {
    return "knowledge-answer-invalid-output";
  }
  return "knowledge-answer-failed";
}

function retryableKnowledgeFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message === "knowledge-answer-timeout" || message === "curated-mcp-capability-unavailable" ||
    message === "curated-reader-failed" || message.startsWith("knowledge-answer Codex failed") ||
    message.startsWith("codex-output-invalid:") || VALIDATED_KNOWLEDGE_FAILURES.has(message);
}
