import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { PDFDocument, StandardFonts } from "pdf-lib";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";

import { createApp, type CreateAppOptions } from "../src/app.js";
import { initializeDataRoot } from "../src/storage/layout.js";

const exec = promisify(execFile);

async function repositoryCheckout(root: string, relativePath: string, content: string): Promise<string> {
  const directory = join(root, relativePath);
  await mkdir(directory, { recursive: true });
  await exec("git", ["init", directory]);
  await exec("git", ["-C", directory, "config", "user.email", "fixture@example.test"]);
  await exec("git", ["-C", directory, "config", "user.name", "Fixture"]);
  await writeFile(join(directory, "README.md"), content, "utf8");
  await exec("git", ["-C", directory, "add", "."]);
  await exec("git", ["-C", directory, "commit", "-m", "fixture snapshot"]);
  const { stdout } = await exec("git", ["-C", directory, "rev-parse", "HEAD"]);
  return stdout.trim();
}

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
      async resolve(arxivId) {
        return { arxivId, latestVersion: 1, title: `Discussion Fixture ${arxivId}`, authors: ["Ada Fixture"], year: 2024 };
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
  it("rejects a linked successor when the frozen material has not changed without writing rows", async () => {
    const root = await mkdtemp(join(tmpdir(), "scholarloom-successor-unchanged-"));
    const storageLayout = initializeDataRoot(join(root, "data"));
    const app = await createApp(options(storageLayout));
    const imported = await app.inject({ method: "POST", url: "/api/imports",
      payload: { arxivUrl: "https://arxiv.org/abs/2401.54321v1" } });
    await waitForImport(app, imported.json().importRequest.id);
    const paperId = imported.json().paper.id as string;
    const parent = await app.inject({ method: "POST", url: `/api/papers/${paperId}/conversations` });
    const database = new Database(storageLayout.databasePath, { readonly: true });
    const before = {
      conversations: (database.prepare("SELECT count(*) count FROM conversations").get() as { count: number }).count,
      snapshots: (database.prepare("SELECT count(*) count FROM context_snapshots").get() as { count: number }).count,
      manifests: (database.prepare("SELECT count(*) count FROM knowledge_corpus_manifests").get() as { count: number }).count,
    };

    const successor = await app.inject({ method: "POST", url: `/api/papers/${paperId}/conversations`,
      payload: { continuedFromConversationId: parent.json().conversation.id } });

    expect(successor.statusCode).toBe(409);
    expect(successor.json()).toEqual({ code: "conversation-context-unchanged", parentStatus: "active" });
    expect({
      conversations: (database.prepare("SELECT count(*) count FROM conversations").get() as { count: number }).count,
      snapshots: (database.prepare("SELECT count(*) count FROM context_snapshots").get() as { count: number }).count,
      manifests: (database.prepare("SELECT count(*) count FROM knowledge_corpus_manifests").get() as { count: number }).count,
    }).toEqual(before);
    database.close();
    await app.close();
  });

  it("previews an unchanged continuation without persisting a Knowledge Corpus Manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "scholarloom-continuation-preview-"));
    const storageLayout = initializeDataRoot(join(root, "data"));
    const app = await createApp(options(storageLayout));
    const imported = await app.inject({ method: "POST", url: "/api/imports",
      payload: { arxivUrl: "https://arxiv.org/abs/2401.54321v1" } });
    await waitForImport(app, imported.json().importRequest.id);
    const parent = await app.inject({ method: "POST",
      url: `/api/papers/${imported.json().paper.id}/conversations` });
    const database = new Database(storageLayout.databasePath, { readonly: true });
    const manifestsBefore = (database.prepare("SELECT count(*) count FROM knowledge_corpus_manifests").get() as { count: number }).count;

    const preview = await app.inject({ method: "GET",
      url: `/api/conversations/${parent.json().conversation.id}/continuation-preview` });

    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({
      status: "no-change",
      parentStatus: "active",
      comparison: {
        status: "available",
        identical: true,
        diff: {
          paperVersion: { status: "unchanged" },
          summaryRevision: { status: "unchanged" },
          extractionRun: { status: "unchanged" },
          repositories: { status: "available", added: [], removed: [], changed: [] },
          knowledgeCorpus: { status: "unchanged" },
        },
      },
    });
    expect((database.prepare("SELECT count(*) count FROM knowledge_corpus_manifests").get() as { count: number }).count)
      .toBe(manifestsBefore);
    database.close();
    await app.close();
  });

  it("rejects an equivalent second successor and identifies the existing child", async () => {
    const root = await mkdtemp(join(tmpdir(), "scholarloom-successor-duplicate-"));
    const storageLayout = initializeDataRoot(join(root, "data"));
    const app = await createApp(options(storageLayout));
    const imported = await app.inject({ method: "POST", url: "/api/imports",
      payload: { arxivUrl: "https://arxiv.org/abs/2401.54321v1" } });
    await waitForImport(app, imported.json().importRequest.id);
    const paperId = imported.json().paper.id as string;
    const parent = await app.inject({ method: "POST", url: `/api/papers/${paperId}/conversations` });
    const corpusChange = await app.inject({ method: "POST", url: "/api/imports",
      payload: { arxivUrl: "https://arxiv.org/abs/2401.54322v1" } });
    await waitForImport(app, corpusChange.json().importRequest.id);
    const firstChild = await app.inject({ method: "POST", url: `/api/papers/${paperId}/conversations`,
      payload: { continuedFromConversationId: parent.json().conversation.id } });

    const duplicate = await app.inject({ method: "POST", url: `/api/papers/${paperId}/conversations`,
      payload: { continuedFromConversationId: parent.json().conversation.id } });

    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toEqual({
      code: "conversation-successor-already-exists",
      existingConversationId: firstChild.json().conversation.id,
      existingConversationStatus: "active",
    });
    const conversations = await app.inject({ method: "GET", url: `/api/papers/${paperId}/conversations` });
    expect(conversations.json().conversations).toHaveLength(2);
    await app.close();
  });

  it("reads an independent Conversation as lineage without a parent or successors", async () => {
    const root = await mkdtemp(join(tmpdir(), "scholarloom-independent-lineage-"));
    const storageLayout = initializeDataRoot(join(root, "data"));
    const app = await createApp(options(storageLayout));
    const imported = await app.inject({ method: "POST", url: "/api/imports",
      payload: { arxivUrl: "https://arxiv.org/abs/2401.54321v1" } });
    await waitForImport(app, imported.json().importRequest.id);
    const created = await app.inject({ method: "POST",
      url: `/api/papers/${imported.json().paper.id}/conversations` });

    const lineage = await app.inject({ method: "GET",
      url: `/api/conversations/${created.json().conversation.id}/lineage` });

    expect(lineage.statusCode).toBe(200);
    expect(lineage.json()).toEqual({
      conversation: expect.objectContaining({ id: created.json().conversation.id, status: "active" }),
      parent: null,
      ancestors: [],
      successors: [],
      contextComparison: { status: "independent" },
    });
    await app.close();
  });

  it("reads a linked successor from both its parent and child", async () => {
    const root = await mkdtemp(join(tmpdir(), "scholarloom-parent-child-lineage-"));
    const storageLayout = initializeDataRoot(join(root, "data"));
    const app = await createApp(options(storageLayout));
    const imported = await app.inject({ method: "POST", url: "/api/imports",
      payload: { arxivUrl: "https://arxiv.org/abs/2401.54321v1" } });
    await waitForImport(app, imported.json().importRequest.id);
    const paperId = imported.json().paper.id as string;
    const parent = await app.inject({ method: "POST", url: `/api/papers/${paperId}/conversations` });
    const corpusChange = await app.inject({ method: "POST", url: "/api/imports",
      payload: { arxivUrl: "https://arxiv.org/abs/2401.54322v1" } });
    await waitForImport(app, corpusChange.json().importRequest.id);
    const successor = await app.inject({ method: "POST", url: `/api/papers/${paperId}/conversations`,
      payload: { continuedFromConversationId: parent.json().conversation.id } });

    const parentLineage = await app.inject({ method: "GET",
      url: `/api/conversations/${parent.json().conversation.id}/lineage` });
    const childLineage = await app.inject({ method: "GET",
      url: `/api/conversations/${successor.json().conversation.id}/lineage` });

    expect(parentLineage.json().successors).toEqual([
      expect.objectContaining({ id: successor.json().conversation.id, status: "active" }),
    ]);
    expect(childLineage.json()).toMatchObject({
      parent: { id: parent.json().conversation.id, status: "active" },
      ancestors: [{ id: parent.json().conversation.id }],
      successors: [],
      contextComparison: {
        status: "available",
        identical: false,
        diff: {
          paperVersion: { status: "unchanged" },
          summaryRevision: { status: "unchanged" },
          extractionRun: { status: "unchanged" },
          repositories: { status: "available", added: [], removed: [], changed: [] },
          knowledgeCorpus: {
            status: "changed",
            summaries: { added: [expect.objectContaining({ paperId: corpusChange.json().paper.id })], removed: [], changed: [] },
            knowledge: { added: [], removed: [] },
          },
        },
      },
    });
    await app.close();
  });

  it("keeps a multi-generation ancestor breadcrumb ordered from root to parent after restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "scholarloom-ancestor-order-"));
    const storageLayout = initializeDataRoot(join(root, "data"));
    let app = await createApp(options(storageLayout));
    const imported = await app.inject({ method: "POST", url: "/api/imports",
      payload: { arxivUrl: "https://arxiv.org/abs/2401.54321v1" } });
    await waitForImport(app, imported.json().importRequest.id);
    const paperId = imported.json().paper.id as string;
    const first = await app.inject({ method: "POST", url: `/api/papers/${paperId}/conversations` });
    const corpusChangeOne = await app.inject({ method: "POST", url: "/api/imports",
      payload: { arxivUrl: "https://arxiv.org/abs/2401.54322v1" } });
    await waitForImport(app, corpusChangeOne.json().importRequest.id);
    const second = await app.inject({ method: "POST", url: `/api/papers/${paperId}/conversations`,
      payload: { continuedFromConversationId: first.json().conversation.id } });
    const corpusChangeTwo = await app.inject({ method: "POST", url: "/api/imports",
      payload: { arxivUrl: "https://arxiv.org/abs/2401.54323v1" } });
    await waitForImport(app, corpusChangeTwo.json().importRequest.id);
    const third = await app.inject({ method: "POST", url: `/api/papers/${paperId}/conversations`,
      payload: { continuedFromConversationId: second.json().conversation.id } });
    await app.close();

    app = await createApp(options(storageLayout));
    const lineage = await app.inject({ method: "GET",
      url: `/api/conversations/${third.json().conversation.id}/lineage` });

    expect(lineage.json().ancestors.map((ancestor: { id: string }) => ancestor.id)).toEqual([
      first.json().conversation.id,
      second.json().conversation.id,
    ]);
    await app.close();
  });

  it("keeps archived lineage readable while the active child remains in the default lifecycle list", async () => {
    const root = await mkdtemp(join(tmpdir(), "scholarloom-archived-lineage-"));
    const storageLayout = initializeDataRoot(join(root, "data"));
    const app = await createApp(options(storageLayout));
    const imported = await app.inject({ method: "POST", url: "/api/imports",
      payload: { arxivUrl: "https://arxiv.org/abs/2401.54321v1" } });
    await waitForImport(app, imported.json().importRequest.id);
    const paperId = imported.json().paper.id as string;
    const parent = await app.inject({ method: "POST", url: `/api/papers/${paperId}/conversations` });
    const corpusChange = await app.inject({ method: "POST", url: "/api/imports",
      payload: { arxivUrl: "https://arxiv.org/abs/2401.54322v1" } });
    await waitForImport(app, corpusChange.json().importRequest.id);
    const child = await app.inject({ method: "POST", url: `/api/papers/${paperId}/conversations`,
      payload: { continuedFromConversationId: parent.json().conversation.id } });
    await app.inject({ method: "POST", url: `/api/conversations/${parent.json().conversation.id}/archive` });

    const parentLineage = await app.inject({ method: "GET",
      url: `/api/conversations/${parent.json().conversation.id}/lineage` });
    const childLineage = await app.inject({ method: "GET",
      url: `/api/conversations/${child.json().conversation.id}/lineage` });
    const list = await app.inject({ method: "GET", url: `/api/papers/${paperId}/conversations` });

    expect(parentLineage.json()).toMatchObject({
      conversation: { status: "archived" },
      successors: [{ id: child.json().conversation.id, status: "active" }],
    });
    expect(childLineage.json().parent).toMatchObject({ id: parent.json().conversation.id, status: "archived" });
    expect(list.json().conversations.find((item: { id: string }) => item.id === child.json().conversation.id))
      .toMatchObject({ status: "active", continuedFromConversationId: parent.json().conversation.id });
    await app.inject({ method: "POST", url: `/api/conversations/${child.json().conversation.id}/archive` });
    const unchangedFromArchived = await app.inject({ method: "POST",
      url: `/api/papers/${paperId}/conversations`,
      payload: { continuedFromConversationId: child.json().conversation.id } });
    expect(unchangedFromArchived.statusCode).toBe(409);
    expect(unchangedFromArchived.json()).toEqual({
      code: "conversation-context-unchanged",
      parentStatus: "archived",
    });
    await app.close();
  });

  it("allows a legacy Conversation to continue while failing its Context Diff safely", async () => {
    const root = await mkdtemp(join(tmpdir(), "scholarloom-legacy-lineage-"));
    const storageLayout = initializeDataRoot(join(root, "data"));
    const app = await createApp(options(storageLayout));
    const imported = await app.inject({ method: "POST", url: "/api/imports",
      payload: { arxivUrl: "https://arxiv.org/abs/2401.54321v1" } });
    await waitForImport(app, imported.json().importRequest.id);
    const paperId = imported.json().paper.id as string;
    const parent = await app.inject({ method: "POST", url: `/api/papers/${paperId}/conversations` });
    const database = new Database(storageLayout.databasePath);
    database.prepare("UPDATE conversations SET snapshot_integrity='legacy' WHERE id=?")
      .run(parent.json().conversation.id);
    database.close();
    const corpusChange = await app.inject({ method: "POST", url: "/api/imports",
      payload: { arxivUrl: "https://arxiv.org/abs/2401.54322v1" } });
    await waitForImport(app, corpusChange.json().importRequest.id);

    const child = await app.inject({ method: "POST", url: `/api/papers/${paperId}/conversations`,
      payload: { continuedFromConversationId: parent.json().conversation.id } });
    const lineage = await app.inject({ method: "GET",
      url: `/api/conversations/${child.json().conversation.id}/lineage` });
    const duplicate = await app.inject({ method: "POST", url: `/api/papers/${paperId}/conversations`,
      payload: { continuedFromConversationId: parent.json().conversation.id } });

    expect(child.statusCode).toBe(201);
    expect(lineage.json().contextComparison).toEqual({
      status: "unavailable",
      reason: "conversation-context-legacy",
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({
      code: "conversation-successor-already-exists",
      existingConversationId: child.json().conversation.id,
    });
    await app.close();
  });

  it("classifies multiple repositories by repository identity and commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "scholarloom-repository-diff-"));
    const storageLayout = initializeDataRoot(join(root, "data"));
    const app = await createApp(options(storageLayout));
    const imported = await app.inject({ method: "POST", url: "/api/imports",
      payload: { arxivUrl: "https://arxiv.org/abs/2401.54321v1" } });
    await waitForImport(app, imported.json().importRequest.id);
    const paperId = imported.json().paper.id as string;
    const database = new Database(storageLayout.databasePath);
    const timestamp = "2026-07-23T00:00:00.000Z";
    const insertRepository = database.prepare(`INSERT INTO code_repositories
      (id,canonical_url,host,owner_name,repository_name,availability_status,created_at,updated_at)
      VALUES (?,?, 'fixture.local','fixture',?,'available',?,?)`);
    const insertSnapshot = database.prepare(`INSERT INTO repository_snapshots
      (id,code_repository_id,commit_sha,local_path,created_at) VALUES (?,?,?,?,?)`);
    const insertLink = database.prepare(`INSERT INTO paper_code_links
      (id,paper_id,code_repository_id,link_type,origin,status,repository_snapshot_id,created_at)
      VALUES (?,?,?,'official','fixture','confirmed',?,?)`);
    for (const repository of ["a", "b", "c", "d"]) {
      insertRepository.run(`repo:${repository}`, `https://fixture.local/${repository}`, repository, timestamp, timestamp);
    }
    const commits = {
      aOld: await repositoryCheckout(storageLayout.repositoryRoot, "synthetic/a-old", "a old\n"),
      aNew: await repositoryCheckout(storageLayout.repositoryRoot, "synthetic/a-new", "a new\n"),
      b: await repositoryCheckout(storageLayout.repositoryRoot, "synthetic/b", "b\n"),
      c: await repositoryCheckout(storageLayout.repositoryRoot, "synthetic/c", "c\n"),
      d: await repositoryCheckout(storageLayout.repositoryRoot, "synthetic/d", "d\n"),
    };
    insertSnapshot.run("snapshot:a-old", "repo:a", commits.aOld, "synthetic/a-old", timestamp);
    insertSnapshot.run("snapshot:a-new", "repo:a", commits.aNew, "synthetic/a-new", timestamp);
    insertSnapshot.run("snapshot:b", "repo:b", commits.b, "synthetic/b", timestamp);
    insertSnapshot.run("snapshot:c", "repo:c", commits.c, "synthetic/c", timestamp);
    insertSnapshot.run("snapshot:d", "repo:d", commits.d, "synthetic/d", timestamp);
    insertLink.run("link:a", paperId, "repo:a", "snapshot:a-old", timestamp);
    insertLink.run("link:b", paperId, "repo:b", "snapshot:b", timestamp);
    insertLink.run("link:d", paperId, "repo:d", "snapshot:d", timestamp);
    database.close();
    const parent = await app.inject({ method: "POST", url: `/api/papers/${paperId}/conversations` });
    const changedDatabase = new Database(storageLayout.databasePath);
    changedDatabase.prepare("UPDATE paper_code_links SET repository_snapshot_id='snapshot:a-new' WHERE id='link:a'").run();
    changedDatabase.prepare("UPDATE paper_code_links SET status='rejected' WHERE id='link:b'").run();
    changedDatabase.prepare(`INSERT INTO paper_code_links
      (id,paper_id,code_repository_id,link_type,origin,status,repository_snapshot_id,created_at)
      VALUES ('link:c',?, 'repo:c','official','fixture','confirmed','snapshot:c',?)`).run(paperId, timestamp);
    changedDatabase.close();

    const child = await app.inject({ method: "POST", url: `/api/papers/${paperId}/conversations`,
      payload: { continuedFromConversationId: parent.json().conversation.id } });
    const lineage = await app.inject({ method: "GET",
      url: `/api/conversations/${child.json().conversation.id}/lineage` });
    const repositories = lineage.json().contextComparison.diff.repositories;

    expect(repositories.added.map((item: { repositoryId: string }) => item.repositoryId)).toEqual(["repo:c"]);
    expect(repositories.removed.map((item: { repositoryId: string }) => item.repositoryId)).toEqual(["repo:b"]);
    expect(repositories.changed).toEqual([
      expect.objectContaining({ repositoryId: "repo:a",
        before: expect.objectContaining({ commitSha: commits.aOld }),
        after: expect.objectContaining({ commitSha: commits.aNew }) }),
    ]);
    expect(repositories.unchanged.map((item: { repositoryId: string }) => item.repositoryId)).toEqual(["repo:d"]);
    await app.close();
  });

  it("localizes a malformed Knowledge Corpus Manifest to an unavailable diff section", async () => {
    const root = await mkdtemp(join(tmpdir(), "scholarloom-malformed-manifest-"));
    const storageLayout = initializeDataRoot(join(root, "data"));
    const app = await createApp(options(storageLayout));
    const imported = await app.inject({ method: "POST", url: "/api/imports",
      payload: { arxivUrl: "https://arxiv.org/abs/2401.54321v1" } });
    await waitForImport(app, imported.json().importRequest.id);
    const paperId = imported.json().paper.id as string;
    const parent = await app.inject({ method: "POST", url: `/api/papers/${paperId}/conversations` });
    const corpusChange = await app.inject({ method: "POST", url: "/api/imports",
      payload: { arxivUrl: "https://arxiv.org/abs/2401.54322v1" } });
    await waitForImport(app, corpusChange.json().importRequest.id);
    const child = await app.inject({ method: "POST", url: `/api/papers/${paperId}/conversations`,
      payload: { continuedFromConversationId: parent.json().conversation.id } });
    const database = new Database(storageLayout.databasePath);
    database.prepare("DROP TRIGGER knowledge_corpus_manifests_no_update").run();
    database.prepare(`UPDATE knowledge_corpus_manifests SET manifest_json='{"summaries":[null],"knowledge":[]}'
      WHERE id=?`).run(child.json().contextSnapshot.knowledgeCorpusManifestId);
    database.close();

    const lineage = await app.inject({ method: "GET",
      url: `/api/conversations/${child.json().conversation.id}/lineage` });

    expect(lineage.statusCode).toBe(200);
    expect(lineage.json().contextComparison).toMatchObject({
      status: "available",
      identical: false,
      diff: {
        paperVersion: { status: "unchanged" },
        summaryRevision: { status: "unchanged" },
        repositories: { status: "available" },
        knowledgeCorpus: { status: "unavailable", reason: "conversation-knowledge-manifest-invalid" },
      },
    });
    await app.close();
  });

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
