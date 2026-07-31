import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";

import type Database from "better-sqlite3";
import { parseDocument } from "yaml";

import {
  normalizePaperLookup,
  validatePaperOrganization,
  type PaperAlias,
  type PaperDirectionInput,
  type PaperOrganizationInput,
} from "../domain/paper-organization.js";
import type { StorageLayout } from "./layout.js";

type BasePaper = {
  id: string;
  title: string;
  authors: string[];
  year: number;
  arxivId?: string;
  pendingReviewCount?: number;
  [key: string]: unknown;
};

export type CatalogDirection = {
  topicId: string;
  title: string;
  role: "primary" | "secondary";
};

export type CatalogPaper<T extends BasePaper = BasePaper> = T & {
  aliases: PaperAlias[];
  preferredAlias: string | null;
  directions: CatalogDirection[];
  pendingOrganizationCount: number;
  matchedBy?: { kind: "preferred-alias" | "alias" | "canonical-title" | "catalog"; value: string; exact: boolean };
};

type WritePayload = {
  kind: "paper-organization" | "direction-taxonomy";
  paperId?: string;
  topicId?: string;
  targetPath: string;
  expectedHash: string | null;
  proposalIds: string[];
  idempotencyKey: string;
  response: unknown;
};

export class PaperOrganizationStoreError extends Error {
  constructor(readonly code: string, readonly status: 400 | 404 | 409 = 400) {
    super(code);
  }
}

export class PaperOrganizationStore {
  constructor(
    private readonly database: Database.Database,
    private readonly layout: StorageLayout,
    private readonly now: () => Date,
  ) {
    this.recover();
    this.rebuildCatalog();
  }

  listDirections(): Array<{
    id: string;
    title: string;
    aliases: string[];
    scope: string;
    usageLevel: "classification" | "knowledge-ready";
    primaryCount: number;
    secondaryCount: number;
  }> {
    return (this.database.prepare(`SELECT n.id,r.title,r.usage_level,r.structured_json,
      (SELECT count(*) FROM paper_direction_assignments a WHERE a.topic_id=n.id AND a.assignment_role='primary') primary_count,
      (SELECT count(*) FROM paper_direction_assignments a WHERE a.topic_id=n.id AND a.assignment_role='secondary') secondary_count
      FROM knowledge_nodes n JOIN knowledge_revisions r ON r.id=n.active_revision_id
      WHERE n.node_type='topic' AND n.lifecycle_status='active' AND r.review_status='confirmed'
      ORDER BY r.title COLLATE NOCASE,n.id`).all() as Array<{
        id: string;
        title: string;
        usage_level: "classification" | "knowledge-ready";
        structured_json: string;
        primary_count: number;
        secondary_count: number;
      }>).map((row) => {
        const structured = JSON.parse(row.structured_json) as { aliases: string[]; scope: string };
        return {
          id: row.id,
          title: row.title,
          aliases: structured.aliases,
          scope: structured.scope,
          usageLevel: row.usage_level,
          primaryCount: row.primary_count,
          secondaryCount: row.secondary_count,
        };
      });
  }

  createDirection(input: unknown, idempotencyKey: string): unknown {
    const replay = this.replay(idempotencyKey);
    if (replay) return replay;
    if (!input || typeof input !== "object") throw new PaperOrganizationStoreError("direction-invalid");
    const value = input as { id?: unknown; title?: unknown; aliases?: unknown; scope?: unknown };
    const id = typeof value.id === "string" ? value.id.trim() : "";
    const title = typeof value.title === "string" ? value.title.trim() : "";
    const scope = typeof value.scope === "string" ? value.scope.trim() : "";
    const aliases = value.aliases === undefined ? [] : value.aliases;
    if (!/^topic:[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || !title || !scope ||
        !Array.isArray(aliases) || aliases.some((alias) => typeof alias !== "string" || !alias.trim())) {
      throw new PaperOrganizationStoreError("direction-invalid");
    }
    if (this.database.prepare("SELECT 1 FROM knowledge_nodes WHERE id=?").get(id)) {
      throw new PaperOrganizationStoreError("direction-already-exists", 409);
    }
    const uniqueAliases = [...new Map((aliases as string[]).map((alias) => [normalizePaperLookup(alias), alias.trim()])).values()];
    const now = this.now().toISOString();
    const relativePath = join("knowledge", "topics", `${id.slice("topic:".length)}.md`);
    if (existsSync(join(this.layout.vaultRoot, relativePath))) {
      throw new PaperOrganizationStoreError("direction-path-conflict", 409);
    }
    const revisionId = `${id}:r1`;
    const markdown = renderTopic({
      id,
      revisionId,
      title,
      aliases: uniqueAliases,
      scope,
      now,
    });
    const response = {
      direction: {
        id,
        title,
        aliases: uniqueAliases,
        scope,
        usageLevel: "classification",
        primaryCount: 0,
        secondaryCount: 0,
      },
    };
    const proposalId = `proposal:direction-taxonomy:${hashKey(idempotencyKey)}`;
    this.database.prepare(`INSERT INTO proposals
      (id,proposal_type,paper_id,payload_json,review_status,one_click_eligible,created_at)
      VALUES (?,'direction-taxonomy',NULL,?,'pending',1,?)`)
      .run(proposalId, JSON.stringify({
        operation: "create",
        topicId: id,
        title,
        aliases: uniqueAliases,
        scope,
        usageLevel: "classification",
        rationale: "用户直接创建 Research Direction。",
      }), now);
    this.commitMarkdown({
      requestType: "direction-taxonomy",
      targetPath: relativePath,
      markdown,
      payload: {
        kind: "direction-taxonomy",
        topicId: id,
        targetPath: relativePath,
        expectedHash: null,
        proposalIds: [proposalId],
        idempotencyKey,
        response,
      },
    });
    return response;
  }

  savePaperOrganization(paperId: string, input: unknown, idempotencyKey: string): unknown {
    const replay = this.replay(idempotencyKey);
    if (replay) return replay;
    const organization = validatePaperOrganization(input);
    const manifest = this.database.prepare("SELECT markdown_path,markdown_hash FROM paper_manifests WHERE paper_id=?")
      .get(paperId) as { markdown_path: string; markdown_hash: string } | undefined;
    if (!manifest) throw new PaperOrganizationStoreError("paper-not-found", 404);
    const target = join(this.layout.vaultRoot, manifest.markdown_path);
    if (!existsSync(target)) throw new PaperOrganizationStoreError("paper-manifest-missing", 409);
    const currentMarkdown = readFileSync(target, "utf8");
    const currentHash = sha256(currentMarkdown);
    if (currentHash !== manifest.markdown_hash) {
      throw new PaperOrganizationStoreError("paper-organization-conflicted", 409);
    }
    const parsed = parseFrontmatter(currentMarkdown);
    const canonicalTitle = String(parsed.data.title ?? "");
    if (organization.aliases.some((alias) =>
      normalizePaperLookup(alias.name) === normalizePaperLookup(canonicalTitle))) {
      throw new PaperOrganizationStoreError("paper-alias-matches-canonical-title");
    }
    for (const direction of organization.directions) this.requireDirection(direction.topicId);
    const before = organizationFromData(parsed.data);
    if (JSON.stringify(before) === JSON.stringify(organization)) {
      return { organization: this.organizationResponse(paperId, organization) };
    }

    parsed.document.set("aliases", organization.aliases.map((alias) => ({
      name: alias.name,
      kind: alias.kind,
      preferred: alias.preferred,
    })));
    parsed.document.set("directions", organization.directions.map((direction) => ({
      topic_id: direction.topicId,
      role: direction.role,
    })));
    parsed.document.set("updated", this.now().toISOString().slice(0, 10));
    const markdown = `---\n${parsed.document.toString().trimEnd()}\n---\n${parsed.body}`;
    const now = this.now().toISOString();
    const proposalKinds = [
      {
        kind: "alias",
        before: before.aliases,
        after: organization.aliases,
        changed: JSON.stringify(before.aliases) !== JSON.stringify(organization.aliases),
        rationale: undefined,
      },
      {
        kind: "primary-direction",
        before: before.directions.find((direction) => direction.role === "primary") ?? null,
        after: organization.directions.find((direction) => direction.role === "primary") ?? null,
        changed: JSON.stringify(before.directions.find((direction) => direction.role === "primary") ?? null) !==
          JSON.stringify(organization.directions.find((direction) => direction.role === "primary") ?? null),
        rationale: "用户直接确认 Paper 的核心研究问题或贡献所属方向。",
      },
      {
        kind: "secondary-direction",
        before: before.directions.filter((direction) => direction.role === "secondary"),
        after: organization.directions.filter((direction) => direction.role === "secondary"),
        changed: JSON.stringify(before.directions.filter((direction) => direction.role === "secondary")) !==
          JSON.stringify(organization.directions.filter((direction) => direction.role === "secondary")),
        rationale: "用户直接确认这些方向会因该 Paper 的实质贡献而更新认知。",
      },
    ].filter((change) => change.changed);
    const proposalIds = proposalKinds.map((change) => {
      const proposalId = `proposal:paper-organization:${hashKey(`${idempotencyKey}:${change.kind}`)}`;
      this.database.prepare(`INSERT INTO proposals
        (id,proposal_type,paper_id,payload_json,review_status,one_click_eligible,created_at)
        VALUES (?,'paper-organization',?,?,'pending',1,?)`)
        .run(proposalId, paperId, JSON.stringify({
          changeKind: change.kind,
          operation: "replace",
          before: change.before,
          after: change.after,
          ...(change.rationale ? { rationale: change.rationale } : {}),
        }), now);
      return proposalId;
    });
    const response = { organization: this.organizationResponse(paperId, organization) };
    this.commitMarkdown({
      requestType: "paper-organization",
      targetPath: manifest.markdown_path,
      markdown,
      payload: {
        kind: "paper-organization",
        paperId,
        targetPath: manifest.markdown_path,
        expectedHash: currentHash,
        proposalIds,
        idempotencyKey,
        response,
      },
    });
    return response;
  }

  decoratePapers<T extends BasePaper>(papers: T[], filters: {
    q?: string;
    view?: "all" | "unclassified";
    direction?: string;
    relation?: "all" | "primary";
    pending?: boolean;
  } = {}): CatalogPaper<T>[] {
    const decorated = papers.map((paper) => {
      const aliases = (this.database.prepare(`SELECT name,alias_kind,preferred FROM paper_aliases
        WHERE paper_id=? ORDER BY preferred DESC,ordinal`).all(paper.id) as Array<{
          name: string;
          alias_kind: PaperAlias["kind"];
          preferred: number;
        }>).map((alias) => ({ name: alias.name, kind: alias.alias_kind, preferred: Boolean(alias.preferred) }));
      const directions = (this.database.prepare(`SELECT a.topic_id,r.title,a.assignment_role FROM paper_direction_assignments a
        JOIN knowledge_nodes n ON n.id=a.topic_id JOIN knowledge_revisions r ON r.id=n.active_revision_id
        WHERE a.paper_id=? ORDER BY CASE a.assignment_role WHEN 'primary' THEN 0 ELSE 1 END,a.ordinal`)
        .all(paper.id) as Array<{ topic_id: string; title: string; assignment_role: "primary" | "secondary" }>)
        .map((direction) => ({
          topicId: direction.topic_id,
          title: direction.title,
          role: direction.assignment_role,
        }));
      const pendingOrganizationCount = (this.database.prepare(`SELECT count(*) count FROM proposals
        WHERE paper_id=? AND proposal_type='paper-organization' AND review_status='pending'`)
        .get(paper.id) as { count: number }).count;
      return {
        ...paper,
        aliases,
        preferredAlias: aliases.find((alias) => alias.preferred)?.name ?? null,
        directions,
        pendingOrganizationCount,
      } satisfies CatalogPaper<T>;
    });

    let result = decorated;
    if (filters.view === "unclassified") {
      result = result.filter((paper) => !paper.directions.some((direction) => direction.role === "primary"));
    }
    if (filters.pending) result = result.filter((paper) => paper.pendingOrganizationCount > 0);
    if (filters.direction) {
      this.requireDirection(filters.direction);
      result = result.filter((paper) => paper.directions.some((direction) =>
        direction.topicId === filters.direction && (filters.relation !== "primary" || direction.role === "primary")));
    }
    const query = filters.q?.trim();
    if (!query) return result;
    const normalized = normalizePaperLookup(query);
    const ftsIds = this.ftsPaperIds(query);
    const matched: CatalogPaper<T>[] = [];
    for (const paper of result) {
      const preferred = paper.aliases.find((alias) => alias.preferred &&
        normalizePaperLookup(alias.name) === normalized);
      if (preferred) {
        matched.push({ ...paper, matchedBy: {
        kind: "preferred-alias" as const,
        value: preferred.name,
        exact: true,
        } });
        continue;
      }
      const alias = paper.aliases.find((candidate) => normalizePaperLookup(candidate.name) === normalized);
      if (alias) {
        matched.push({ ...paper, matchedBy: { kind: "alias", value: alias.name, exact: true } });
        continue;
      }
      if (normalizePaperLookup(paper.title) === normalized) {
        matched.push({ ...paper, matchedBy: { kind: "canonical-title", value: paper.title, exact: true } });
        continue;
      }
      const searchable = normalizePaperLookup([
        paper.title,
        ...paper.aliases.map((candidate) => candidate.name),
        ...paper.authors,
        ...paper.directions.map((direction) => direction.title),
      ].join(" "));
      if (searchable.startsWith(normalized) || searchable.includes(normalized) || ftsIds.has(paper.id)) {
        matched.push({ ...paper, matchedBy: { kind: "catalog", value: query, exact: false } });
      }
    }
    return matched.sort((left, right) => matchRank(left) - matchRank(right) ||
      String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")) ||
      left.id.localeCompare(right.id));
  }

  rebuildCatalog(): { count: number; rebuiltAt: string } {
    const rebuiltAt = this.now().toISOString();
    const topics = this.readMarkdownFiles(join(this.layout.vaultRoot, "knowledge", "topics"))
      .map((path) => this.readTopic(path));
    const papers = this.readMarkdownFiles(join(this.layout.vaultRoot, "library", "papers"))
      .filter((path) => path.endsWith(`${join("", "paper.md")}`))
      .map((path) => this.readPaper(path));
    const topicIds = new Set(topics.map((topic) => topic.id));
    for (const paper of papers) {
      for (const direction of paper.organization.directions) {
        if (!topicIds.has(direction.topicId)) throw new PaperOrganizationStoreError("paper-direction-not-usable", 409);
      }
    }
    this.database.transaction(() => {
      this.database.exec(`DELETE FROM paper_catalog_fts;
        DELETE FROM paper_aliases;
        DELETE FROM paper_direction_assignments;
        DELETE FROM paper_catalog_documents;
        DELETE FROM paper_manifests;
        DELETE FROM knowledge_revisions;
        DELETE FROM knowledge_nodes;`);
      for (const topic of topics) {
        this.database.prepare(`INSERT INTO knowledge_nodes
          (id,node_type,active_revision_id,lifecycle_status,created_at,updated_at)
          VALUES (?,'topic',?,'active',?,?)`).run(topic.id, topic.revisionId, topic.createdAt, topic.updatedAt);
        this.database.prepare(`INSERT INTO knowledge_revisions
          (id,knowledge_node_id,revision_number,title,review_status,usage_level,markdown_path,markdown_hash,
           structured_json,confirmed_at,created_at)
          VALUES (?,?,1,?,'confirmed',?,?,?,?,?,?)`).run(topic.revisionId, topic.id, topic.title,
            topic.usageLevel, topic.relativePath, topic.hash,
            JSON.stringify({ aliases: topic.aliases, scope: topic.scope }), topic.updatedAt, topic.createdAt);
      }
      const topicTitle = new Map(topics.map((topic) => [topic.id, topic.title]));
      for (const paper of papers) {
        this.database.prepare(`INSERT INTO paper_manifests(paper_id,markdown_path,markdown_hash,updated_at)
          VALUES (?,?,?,?)`).run(paper.id, paper.relativePath, paper.hash, paper.updatedAt);
        paper.organization.aliases.forEach((alias, ordinal) => this.database.prepare(`INSERT INTO paper_aliases
          (paper_id,name,normalized_name,alias_kind,preferred,ordinal) VALUES (?,?,?,?,?,?)`)
          .run(paper.id, alias.name, normalizePaperLookup(alias.name), alias.kind, Number(alias.preferred), ordinal));
        paper.organization.directions.forEach((direction, ordinal) => this.database.prepare(`INSERT INTO paper_direction_assignments
          (paper_id,topic_id,assignment_role,ordinal) VALUES (?,?,?,?)`)
          .run(paper.id, direction.topicId, direction.role, ordinal));
        const directionNames = paper.organization.directions.map((direction) => topicTitle.get(direction.topicId)!);
        const searchText = [paper.title, ...paper.organization.aliases.map((alias) => alias.name),
          ...paper.authors, ...directionNames].join("\n");
        this.database.prepare(`INSERT INTO paper_catalog_documents
          (paper_id,canonical_title,preferred_alias,authors_json,publication_year,search_text,updated_at)
          VALUES (?,?,?,?,?,?,?)`).run(paper.id, paper.title,
            paper.organization.aliases.find((alias) => alias.preferred)?.name ?? null,
            JSON.stringify(paper.authors), paper.year, searchText, paper.updatedAt);
        this.database.prepare("INSERT INTO paper_catalog_fts(paper_id,search_text) VALUES (?,?)")
          .run(paper.id, searchText);
      }
      this.database.prepare(`UPDATE projection_state SET last_successful_at=?,rebuilt_at=?,updated_at=?
        WHERE projection='paper-catalog'`).run(rebuiltAt, rebuiltAt, rebuiltAt);
    })();
    return { count: papers.length, rebuiltAt };
  }

  private commitMarkdown(input: {
    requestType: "paper-organization" | "direction-taxonomy";
    targetPath: string;
    markdown: string;
    payload: WritePayload;
  }): void {
    const hash = sha256(input.markdown);
    const writeId = `knowledge-write:${input.requestType}:${hashKey(input.payload.idempotencyKey)}`;
    const stagedPath = `${input.targetPath}.${hash.slice(0, 12)}.staged`;
    const now = this.now().toISOString();
    const active = this.database.prepare(`SELECT id FROM knowledge_write_requests
      WHERE target_path=? AND phase NOT IN ('complete','failed','conflicted')`).get(input.targetPath) as { id: string } | undefined;
    if (active && active.id !== writeId) throw new PaperOrganizationStoreError("organization-write-in-progress", 409);
    this.database.prepare(`INSERT INTO knowledge_write_requests
      (id,request_type,target_path,staged_path,result_hash,phase,created_at,updated_at,payload_json)
      VALUES (?,?,?,?,?,'reserved',?,?,?) ON CONFLICT(id) DO NOTHING`)
      .run(writeId, input.requestType, input.targetPath, stagedPath, hash, now, now, JSON.stringify(input.payload));
    const staged = join(this.layout.vaultRoot, stagedPath);
    mkdirSync(dirname(staged), { recursive: true });
    writeFileSync(staged, input.markdown, "utf8");
    this.database.prepare("UPDATE knowledge_write_requests SET phase='staged',updated_at=? WHERE id=? AND phase='reserved'")
      .run(now, writeId);
    this.advance(writeId);
    const phase = (this.database.prepare("SELECT phase FROM knowledge_write_requests WHERE id=?").get(writeId) as
      { phase: string }).phase;
    if (phase === "conflicted") throw new PaperOrganizationStoreError("paper-organization-conflicted", 409);
    if (phase !== "complete") throw new PaperOrganizationStoreError("paper-organization-write-failed", 409);
  }

  private recover(): void {
    const writes = this.database.prepare(`SELECT id FROM knowledge_write_requests
      WHERE request_type IN ('paper-organization','direction-taxonomy')
        AND phase NOT IN ('complete','failed','conflicted') ORDER BY created_at,id`).all() as Array<{ id: string }>;
    for (const write of writes) this.advance(write.id);
  }

  private advance(writeId: string): void {
    const row = this.database.prepare(`SELECT target_path,staged_path,result_hash,phase,payload_json
      FROM knowledge_write_requests WHERE id=?`).get(writeId) as {
        target_path: string;
        staged_path: string;
        result_hash: string;
        phase: string;
        payload_json: string;
      };
    const payload = JSON.parse(row.payload_json) as WritePayload;
    const target = join(this.layout.vaultRoot, row.target_path);
    const staged = join(this.layout.vaultRoot, row.staged_path);
    let phase = row.phase;
    if (phase === "reserved" || phase === "staged") {
      if (!existsSync(staged)) {
        if (existsSync(target) && sha256(readFileSync(target, "utf8")) === row.result_hash) phase = "renamed";
        else {
          this.failWrite(writeId, "staged-file-missing");
          return;
        }
      } else if (sha256(readFileSync(staged, "utf8")) !== row.result_hash) {
        this.failWrite(writeId, "staged-hash-mismatch");
        return;
      } else {
        const actualHash = existsSync(target) ? sha256(readFileSync(target, "utf8")) : null;
        if (actualHash !== payload.expectedHash && actualHash !== row.result_hash) {
          this.conflictWrite(writeId, payload, actualHash);
          return;
        }
        mkdirSync(dirname(target), { recursive: true });
        renameSync(staged, target);
        phase = "renamed";
      }
      this.database.prepare("UPDATE knowledge_write_requests SET phase='renamed',updated_at=? WHERE id=?")
        .run(this.now().toISOString(), writeId);
    }
    if (phase === "renamed") {
      if (!existsSync(target) || sha256(readFileSync(target, "utf8")) !== row.result_hash) {
        this.conflictWrite(writeId, payload, existsSync(target) ? sha256(readFileSync(target, "utf8")) : null);
        return;
      }
      const now = this.now().toISOString();
      this.database.transaction(() => {
        payload.proposalIds.forEach((proposalId, ordinal) => {
          const decisionId = `review-decision:${hashKey(`${payload.idempotencyKey}:${ordinal}`)}`;
          this.database.prepare(`UPDATE proposals SET review_status='accepted',decided_at=?
            WHERE id=? AND review_status='pending'`).run(now, proposalId);
          this.database.prepare(`INSERT OR IGNORE INTO review_decisions
            (id,proposal_id,action,idempotency_key,result_json,created_at) VALUES (?,?,'accept',?,?,?)`)
            .run(decisionId, proposalId, `${payload.idempotencyKey}:${ordinal}`, JSON.stringify(payload.response), now);
        });
        this.database.prepare(`INSERT INTO index_outbox(projection,source_id,operation,state,created_at)
          VALUES ('paper-catalog',?,'upsert','pending',?)`)
          .run(payload.paperId ?? payload.topicId, now);
        this.database.prepare(`UPDATE knowledge_write_requests SET phase='metadata-committed',updated_at=?
          WHERE id=?`).run(now, writeId);
      })();
      phase = "metadata-committed";
    }
    if (phase === "metadata-committed" || phase === "indexed") {
      this.rebuildCatalog();
      const now = this.now().toISOString();
      this.database.transaction(() => {
        this.database.prepare(`UPDATE index_outbox SET state='complete',completed_at=?
          WHERE projection='paper-catalog' AND source_id=? AND state='pending'`)
          .run(now, payload.paperId ?? payload.topicId);
        this.database.prepare(`UPDATE knowledge_write_requests SET phase='complete',updated_at=?,error_code=NULL
          WHERE id=?`).run(now, writeId);
      })();
    }
  }

  private failWrite(writeId: string, code: string): void {
    this.database.prepare(`UPDATE knowledge_write_requests SET phase='failed',error_code=?,updated_at=? WHERE id=?`)
      .run(code, this.now().toISOString(), writeId);
  }

  private conflictWrite(writeId: string, payload: WritePayload, actualHash: string | null): void {
    const now = this.now().toISOString();
    this.database.transaction(() => {
      this.database.prepare(`UPDATE knowledge_write_requests
        SET phase='conflicted',error_code='external-edit',updated_at=? WHERE id=?`).run(now, writeId);
      if (payload.paperId) this.database.prepare(`INSERT OR IGNORE INTO proposals
        (id,proposal_type,paper_id,payload_json,review_status,one_click_eligible,created_at)
        VALUES (?,'reconciliation',?,?,'pending',0,?)`)
        .run(`proposal:reconciliation:${writeId}`, payload.paperId,
          JSON.stringify({ writeId, targetPath: payload.targetPath, expectedHash: payload.expectedHash, actualHash }), now);
    })();
  }

  private replay(idempotencyKey: string): unknown | null {
    const row = this.database.prepare("SELECT result_json FROM review_decisions WHERE idempotency_key=? OR idempotency_key LIKE ? LIMIT 1")
      .get(idempotencyKey, `${idempotencyKey}:%`) as { result_json: string } | undefined;
    return row ? JSON.parse(row.result_json) as unknown : null;
  }

  private organizationResponse(paperId: string, organization: PaperOrganizationInput): {
    paperId: string;
    aliases: PaperAlias[];
    preferredAlias: string | null;
    directions: CatalogDirection[];
  } {
    const titles = new Map(this.listDirections().map((direction) => [direction.id, direction.title]));
    return {
      paperId,
      aliases: organization.aliases,
      preferredAlias: organization.aliases.find((alias) => alias.preferred)?.name ?? null,
      directions: organization.directions.map((direction) => ({
        topicId: direction.topicId,
        title: titles.get(direction.topicId) ?? direction.topicId,
        role: direction.role,
      })),
    };
  }

  private requireDirection(topicId: string): void {
    const usable = this.database.prepare(`SELECT 1 FROM knowledge_nodes n JOIN knowledge_revisions r
      ON r.id=n.active_revision_id WHERE n.id=? AND n.node_type='topic' AND n.lifecycle_status='active'
      AND r.review_status='confirmed'`).get(topicId);
    if (!usable) throw new PaperOrganizationStoreError("paper-direction-not-usable", 409);
  }

  private ftsPaperIds(query: string): Set<string> {
    if (normalizePaperLookup(query).length < 3) return new Set();
    try {
      return new Set((this.database.prepare(`SELECT paper_id FROM paper_catalog_fts
        WHERE paper_catalog_fts MATCH ? ORDER BY rank LIMIT 100`).all(`"${query.replaceAll("\"", "\"\"")}"`) as
        Array<{ paper_id: string }>).map((row) => row.paper_id));
    } catch {
      return new Set();
    }
  }

  private readMarkdownFiles(root: string): string[] {
    if (!existsSync(root)) return [];
    const files: string[] = [];
    const visit = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) visit(path);
        else if (entry.isFile() && entry.name.endsWith(".md") && !entry.name.endsWith(".staged")) files.push(path);
      }
    };
    visit(root);
    return files.sort();
  }

  private readTopic(path: string): {
    id: string;
    revisionId: string;
    title: string;
    aliases: string[];
    scope: string;
    usageLevel: "classification" | "knowledge-ready";
    relativePath: string;
    hash: string;
    createdAt: string;
    updatedAt: string;
  } {
    const markdown = readFileSync(path, "utf8");
    const parsed = parseFrontmatter(markdown);
    const data = parsed.data;
    const id = String(data.id ?? "");
    const title = String(data.title ?? "").trim();
    const aliases = Array.isArray(data.aliases) ? data.aliases.filter((alias): alias is string => typeof alias === "string") : [];
    const usageLevel = data.usage_level === "knowledge-ready" ? "knowledge-ready" : "classification";
    const scope = markdownSection(parsed.body, "Scope");
    if (!id.startsWith("topic:") || !title || !scope || data.review_status !== "confirmed") {
      throw new PaperOrganizationStoreError("direction-markdown-invalid", 409);
    }
    return {
      id,
      revisionId: typeof data.revision_id === "string" && data.revision_id ? data.revision_id : `${id}:r1`,
      title,
      aliases,
      scope,
      usageLevel,
      relativePath: relative(this.layout.vaultRoot, path),
      hash: sha256(markdown),
      createdAt: String(data.created ?? this.now().toISOString()),
      updatedAt: String(data.updated ?? this.now().toISOString()),
    };
  }

  private readPaper(path: string): {
    id: string;
    title: string;
    authors: string[];
    year: number;
    organization: PaperOrganizationInput;
    relativePath: string;
    hash: string;
    updatedAt: string;
  } {
    const markdown = readFileSync(path, "utf8");
    const parsed = parseFrontmatter(markdown);
    const data = parsed.data;
    const organization = organizationFromData(data);
    return {
      id: String(data.id),
      title: String(data.title),
      authors: Array.isArray(data.authors) ? data.authors.filter((author): author is string => typeof author === "string") : [],
      year: Number(data.year),
      organization: validatePaperOrganization(organization),
      relativePath: relative(this.layout.vaultRoot, path),
      hash: sha256(markdown),
      updatedAt: String(data.updated ?? this.now().toISOString()),
    };
  }
}

function parseFrontmatter(markdown: string): {
  document: ReturnType<typeof parseDocument>;
  data: Record<string, unknown>;
  body: string;
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(markdown);
  if (!match) throw new PaperOrganizationStoreError("markdown-frontmatter-invalid", 409);
  const document = parseDocument(match[1]!);
  if (document.errors.length) throw new PaperOrganizationStoreError("markdown-frontmatter-invalid", 409);
  const data = document.toJS() as Record<string, unknown>;
  return { document, data, body: match[2]! };
}

function organizationFromData(data: Record<string, unknown>): PaperOrganizationInput {
  const aliases = Array.isArray(data.aliases) ? data.aliases.map((value) => {
    const alias = value as { name?: unknown; kind?: unknown; preferred?: unknown };
    return { name: alias.name, kind: alias.kind, preferred: alias.preferred };
  }) : [];
  const directions = Array.isArray(data.directions) ? data.directions.map((value) => {
    const direction = value as { topic_id?: unknown; role?: unknown };
    return { topicId: direction.topic_id, role: direction.role };
  }) : [];
  return validatePaperOrganization({ aliases, directions });
}

function renderTopic(input: {
  id: string;
  revisionId: string;
  title: string;
  aliases: string[];
  scope: string;
  now: string;
}): string {
  const date = input.now.slice(0, 10);
  return `---
id: ${JSON.stringify(input.id)}
type: topic
title: ${JSON.stringify(input.title)}
aliases: ${JSON.stringify(input.aliases)}
revision_id: ${JSON.stringify(input.revisionId)}
revision: 1
review_status: confirmed
usage_level: classification
epistemic_status: evidence-backed
superseded_by: null
provenance: []
semantic_relations: []
tags: []
created: ${date}
updated: ${date}
---

# ${input.title}

## Scope

${input.scope}

## Map of concepts

## Representative papers

## Schools of thought and disagreements

## Open questions

## Syntheses

## Suggested reading path

## Revision note

由用户创建为仅用于分类的 Research Direction。
`;
}

function markdownSection(body: string, heading: string): string {
  const match = new RegExp(`(?:^|\\n)## ${escapeRegex(heading)}\\r?\\n\\r?\\n([\\s\\S]*?)(?=\\r?\\n## |$)`).exec(body);
  return match?.[1]?.trim() ?? "";
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashKey(value: string): string {
  return sha256(value).slice(0, 24);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchRank(paper: CatalogPaper): number {
  switch (paper.matchedBy?.kind) {
    case "preferred-alias": return 2;
    case "alias": return 3;
    case "canonical-title": return 4;
    default: return 6;
  }
}
