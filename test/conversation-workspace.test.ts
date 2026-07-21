import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PDFDocument, StandardFonts } from "pdf-lib";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";

import { createApp, type CreateAppOptions } from "../src/app.js";
import { initializeDataRoot } from "../src/storage/layout.js";

async function fixturePdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage().drawText("ScholarLoom durable discussion fixture", { x: 40, y: 700, font });
  return pdf.save();
}

async function waitForImport(app: FastifyInstance, id: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await app.inject({ method: "GET", url: `/api/imports/${encodeURIComponent(id)}` });
    if (response.json().jobs.at(-1)?.state === "succeeded") return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("fixture import did not finish");
}

type ConversationBody = { messages: Array<{ id: string; role: string; content: string;
  attempts: Array<{ state: string; attemptNo: number }> }> } & Record<string, unknown>;

async function waitForAssistant(app: FastifyInstance, conversationId: string): Promise<ConversationBody> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await app.inject({ method: "GET", url: `/api/conversations/${conversationId}` });
    if (response.json().messages.some((message: { role: string }) => message.role === "assistant")) return response.json() as ConversationBody;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("assistant message did not finish");
}

async function waitForAttemptState(app: FastifyInstance, conversationId: string, state: string): Promise<ConversationBody> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await app.inject({ method: "GET", url: `/api/conversations/${conversationId}` });
    if (response.json().messages.some((message: { attempts?: Array<{ state: string }> }) =>
      message.attempts?.some((run) => run.state === state))) return response.json() as ConversationBody;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`attempt did not reach ${state}`);
}

function options(storageLayout: ReturnType<typeof initializeDataRoot>): CreateAppOptions {
  return {
    storageLayout,
    paperSource: {
      async resolve() {
        return { arxivId: "2401.54321", latestVersion: 1, title: "Discussion Fixture", authors: ["Ada Fixture"], year: 2024 };
      },
      async fetchPdf() { return fixturePdf(); },
    },
    codexRunner: {
      async runSummary() {
        return {
          sections: [{ key: "overview", title: "概述", body: "持久化讨论测试。" }],
          claims: [{ voice: "paper-evidence", claim: "Durable discussion fixture.", sourceHandle: "pdf-page:1" }],
          readStatus: "read",
        };
      },
    },
  };
}

describe("recoverable paper conversation workspace", () => {
  it("lists multiple paper-scoped conversations in stable order after restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "scholarloom-conversations-"));
    const storageLayout = initializeDataRoot(join(root, "data"));
    let app = await createApp(options(storageLayout));
    const imported = await app.inject({ method: "POST", url: "/api/imports", payload: { arxivUrl: "https://arxiv.org/abs/2401.54321v1" } });
    await waitForImport(app, imported.json().importRequest.id);
    const paperId = imported.json().paper.id as string;

    const first = await app.inject({ method: "POST", url: `/api/papers/${paperId}/conversations` });
    const second = await app.inject({ method: "POST", url: `/api/papers/${paperId}/conversations` });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(first.json().contextSnapshot).toMatchObject({ pageCount: 1 });

    const beforeRestart = await app.inject({ method: "GET", url: `/api/papers/${paperId}/conversations` });
    expect(beforeRestart.statusCode).toBe(200);
    expect(beforeRestart.json().conversations.map((conversation: { id: string }) => conversation.id)).toEqual([
      second.json().conversation.id,
      first.json().conversation.id,
    ]);

    const invariantDatabase = new Database(storageLayout.databasePath);
    expect(() => invariantDatabase.prepare("UPDATE conversations SET active_context_snapshot_id=NULL WHERE id=?")
      .run(first.json().conversation.id)).toThrow(/conversation-context-snapshot-immutable/);
    expect(() => invariantDatabase.prepare(`INSERT INTO context_snapshots
      (id,conversation_id,paper_version_id,summary_revision_id,extraction_run_id,repositories_json,created_at)
      SELECT 'context-snapshot:duplicate',conversation_id,paper_version_id,summary_revision_id,extraction_run_id,repositories_json,created_at
      FROM context_snapshots WHERE id=?`).run(first.json().contextSnapshot.id)).toThrow(/conversation-context-snapshot-immutable/);
    expect(() => invariantDatabase.prepare("UPDATE context_snapshots SET repositories_json='[]' WHERE id=?")
      .run(first.json().contextSnapshot.id)).toThrow(/conversation-context-snapshot-immutable/);
    expect(() => invariantDatabase.prepare("DELETE FROM context_snapshots WHERE id=?")
      .run(first.json().contextSnapshot.id)).toThrow(/conversation-context-snapshot-immutable/);
    invariantDatabase.close();

    await app.close();
    app = await createApp(options(storageLayout));
    const afterRestart = await app.inject({ method: "GET", url: `/api/papers/${paperId}/conversations` });
    expect(afterRestart.json()).toEqual(beforeRestart.json());
    await app.close();
  });

  it("persists the user message and running attempt before Codex returns", async () => {
    const root = await mkdtemp(join(tmpdir(), "scholarloom-message-tx1-"));
    const storageLayout = initializeDataRoot(join(root, "data"));
    let releaseChat!: () => void;
    let chatStarted!: () => void;
    const started = new Promise<void>((resolve) => { chatStarted = resolve; });
    const blocked = new Promise<void>((resolve) => { releaseChat = resolve; });
    const appOptions = options(storageLayout);
    appOptions.codexRunner!.runChat = async () => {
      chatStarted();
      await blocked;
      return { answer: "完成", citations: [], proposedTakeaways: [] };
    };
    const app = await createApp(appOptions);
    const imported = await app.inject({ method: "POST", url: "/api/imports", payload: { arxivUrl: "https://arxiv.org/abs/2401.54321v1" } });
    await waitForImport(app, imported.json().importRequest.id);
    const conversation = await app.inject({ method: "POST", url: `/api/papers/${imported.json().paper.id}/conversations` });

    const pendingResponse = app.inject({
      method: "POST",
      url: `/api/conversations/${conversation.json().conversation.id}/messages`,
      payload: { content: "Codex 返回前应先持久化", idempotencyKey: "send-before-codex" },
    });
    await started;
    const overlapping = await app.inject({ method: "POST", url: `/api/conversations/${conversation.json().conversation.id}/messages`,
      payload: { content: "不能排队的第二条", idempotencyKey: "overlapping-send" } });
    expect(overlapping.statusCode).toBe(409);
    expect(overlapping.json()).toEqual({ code: "conversation-turn-active" });

    const database = new Database(storageLayout.databasePath, { readonly: true });
    const userMessages = database.prepare("SELECT id,context_snapshot_id FROM messages WHERE conversation_id=? AND role='user'")
      .all(conversation.json().conversation.id) as Array<{ id: string; context_snapshot_id: string }>;
    const attempts = database.prepare(`SELECT j.state,a.user_message_id,a.conversation_id
      FROM conversation_turn_attempts a JOIN job_runs j ON j.id=a.job_run_id WHERE a.conversation_id=?`)
      .all(conversation.json().conversation.id) as Array<{ state: string; user_message_id: string; conversation_id: string }>;
    database.close();
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]!.context_snapshot_id).toBe(conversation.json().contextSnapshot.id);
    expect(attempts).toEqual([expect.objectContaining({ state: "running", user_message_id: userMessages[0]!.id })]);

    releaseChat();
    expect((await pendingResponse).statusCode).toBe(202);
    const restored = await waitForAssistant(app, conversation.json().conversation.id);
    expect(restored).toMatchObject({
      conversation: { id: conversation.json().conversation.id, snapshotIntegrity: "frozen" },
      messages: [
        { id: userMessages[0]!.id, role: "user", content: "Codex 返回前应先持久化", attempts: [{ state: "succeeded", attemptNo: 1 }] },
        { role: "assistant", content: "完成", inReplyToMessageId: userMessages[0]!.id },
      ],
    });
    await app.close();
  });

  it("retries a failed turn without duplicating the user or assistant message", async () => {
    const root = await mkdtemp(join(tmpdir(), "scholarloom-message-retry-"));
    const storageLayout = initializeDataRoot(join(root, "data"));
    const appOptions = options(storageLayout);
    let calls = 0;
    appOptions.codexRunner!.runChat = async () => {
      calls += 1;
      if (calls === 1) throw new Error("fixture-codex-failure");
      return { answer: "retry succeeded", citations: [], proposedTakeaways: [] };
    };
    const app = await createApp(appOptions);
    const imported = await app.inject({ method: "POST", url: "/api/imports", payload: { arxivUrl: "https://arxiv.org/abs/2401.54321v1" } });
    await waitForImport(app, imported.json().importRequest.id);
    const conversation = await app.inject({ method: "POST", url: `/api/papers/${imported.json().paper.id}/conversations` });
    const conversationId = conversation.json().conversation.id as string;
    await app.inject({ method: "POST", url: `/api/conversations/${conversationId}/messages`,
      payload: { content: "请重试这一条", idempotencyKey: "failed-send" } });
    const failed = await waitForAttemptState(app, conversationId, "failed");
    const userMessage = failed.messages.find((message: { role: string }) => message.role === "user")!;

    const retry = await app.inject({ method: "POST", url: `/api/messages/${userMessage.id}/retry`,
      headers: { "idempotency-key": "retry-send" } });
    expect(retry.statusCode).toBe(202);
    const restored = await waitForAssistant(app, conversationId);
    expect(restored.messages.filter((message: { role: string }) => message.role === "user")).toHaveLength(1);
    expect(restored.messages.filter((message: { role: string }) => message.role === "assistant")).toHaveLength(1);
    expect(restored.messages[0]!.attempts).toMatchObject([
      { attemptNo: 1, state: "failed" },
      { attemptNo: 2, state: "succeeded" },
    ]);
    const invalidRetry = await app.inject({ method: "POST", url: `/api/messages/${userMessage.id}/retry`,
      headers: { "idempotency-key": "retry-after-success" } });
    expect(invalidRetry.statusCode).toBe(409);
    expect(invalidRetry.json()).toEqual({ code: "message-not-retryable" });
    await app.close();
  });

  it("fails an invented Proposal handle atomically without an assistant Message", async () => {
    const root = await mkdtemp(join(tmpdir(), "scholarloom-invalid-handle-"));
    const storageLayout = initializeDataRoot(join(root, "data"));
    const appOptions = options(storageLayout);
    appOptions.codexRunner!.runChat = async () => ({ answer: "must not persist", citations: [],
      proposedTakeaways: [{ claim: "invented", sourceHandles: ["agent-invented-handle"], quote: null }] });
    const app = await createApp(appOptions);
    const imported = await app.inject({ method: "POST", url: "/api/imports", payload: { arxivUrl: "https://arxiv.org/abs/2401.54321v1" } });
    await waitForImport(app, imported.json().importRequest.id);
    const created = await app.inject({ method: "POST", url: `/api/papers/${imported.json().paper.id}/conversations` });
    const conversationId = created.json().conversation.id as string;
    await app.inject({ method: "POST", url: `/api/conversations/${conversationId}/messages`,
      payload: { content: "不要接受发明的 handle", idempotencyKey: "invalid-handle" } });
    const failed = await waitForAttemptState(app, conversationId, "failed");
    expect(failed.messages).toHaveLength(1);
    expect(failed.messages[0]).toMatchObject({ role: "user", attempts: [{ state: "failed", error: { code: "codex-output-invalid" } }] });
    const database = new Database(storageLayout.databasePath, { readonly: true });
    expect((database.prepare("SELECT count(*) count FROM proposals WHERE paper_id=?").get(imported.json().paper.id) as { count: number }).count).toBe(0);
    database.close();
    await app.close();
  });

  it("marks an in-flight turn interrupted on restart and preserves its reliable user message", async () => {
    const root = await mkdtemp(join(tmpdir(), "scholarloom-message-interrupted-"));
    const storageLayout = initializeDataRoot(join(root, "data"));
    let app = await createApp(options(storageLayout));
    const imported = await app.inject({ method: "POST", url: "/api/imports",
      payload: { arxivUrl: "https://arxiv.org/abs/2401.54321v1" } });
    await waitForImport(app, imported.json().importRequest.id);
    const created = await app.inject({ method: "POST", url: `/api/papers/${imported.json().paper.id}/conversations` });
    const conversationId = created.json().conversation.id as string;
    const snapshotId = created.json().contextSnapshot.id as string;
    await app.close();

    const database = new Database(storageLayout.databasePath);
    database.transaction(() => {
      database.prepare(`INSERT INTO messages
        (id,conversation_id,context_snapshot_id,role,content,citations_json,created_at,ordinal)
        VALUES ('message:interrupted',?,?, 'user','进程退出前已经可靠保存','[]',?,1)`)
        .run(conversationId, snapshotId, "2026-07-21T08:00:00.000Z");
      database.prepare(`INSERT INTO job_runs
        (id,job_type,paper_id,state,progress,attempt,idempotency_key,input_json,queued_at,started_at,heartbeat_at)
        VALUES ('job:interrupted','paper-chat',?,'running',0.5,1,'interrupted-fixture','{}',?,?,?)`)
        .run(imported.json().paper.id, "2026-07-21T08:00:00.000Z", "2026-07-21T08:00:00.000Z", "2026-07-21T08:00:00.000Z");
      database.prepare(`INSERT INTO conversation_turn_attempts
        (job_run_id,conversation_id,user_message_id,attempt_no,created_at)
        VALUES ('job:interrupted',?,'message:interrupted',1,?)`)
        .run(conversationId, "2026-07-21T08:00:00.000Z");
    })();
    database.close();

    app = await createApp(options(storageLayout));
    const restored = await app.inject({ method: "GET", url: `/api/conversations/${conversationId}` });
    expect(restored.json().messages).toEqual([
      expect.objectContaining({ id: "message:interrupted", role: "user", content: "进程退出前已经可靠保存",
        attempts: [expect.objectContaining({ state: "interrupted", error: { code: "process-interrupted" } })] }),
    ]);
    const recoveredDatabase = new Database(storageLayout.databasePath, { readonly: true });
    expect(recoveredDatabase.prepare(`SELECT count(*) count FROM durable_events
      WHERE scope=? AND event_type='message-interrupted'`).get(conversationId)).toEqual({ count: 1 });
    recoveredDatabase.close();
    await app.close();
  });
});
