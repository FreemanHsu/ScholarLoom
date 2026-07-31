import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join, relative } from "node:path";

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
import type { KnowledgeWriter } from "./knowledge-writer.js";

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
  aliasCollision: boolean;
  matchedBy?: {
    kind: "external-identity" | "preferred-alias" | "alias" | "canonical-title" | "prefix" | "catalog";
    value: string;
    exact: boolean;
  };
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
    private readonly knowledgeWriter: KnowledgeWriter,
  ) {
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
    return (this.database.prepare(`SELECT d.topic_id,d.title,d.usage_level,d.aliases_json,d.scope,
      (SELECT count(*) FROM paper_direction_assignments a WHERE a.topic_id=d.topic_id AND a.assignment_role='primary') primary_count,
      (SELECT count(*) FROM paper_direction_assignments a WHERE a.topic_id=d.topic_id AND a.assignment_role='secondary') secondary_count
      FROM direction_catalog d
      WHERE d.lifecycle_status='active' AND d.review_status='confirmed'
      ORDER BY d.title COLLATE NOCASE,d.topic_id`).all() as Array<{
        topic_id: string;
        title: string;
        usage_level: "classification" | "knowledge-ready";
        aliases_json: string;
        scope: string;
        primary_count: number;
        secondary_count: number;
      }>).map((row) => {
        return {
          id: row.topic_id,
          title: row.title,
          aliases: JSON.parse(row.aliases_json) as string[],
          scope: row.scope,
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
    if (this.database.prepare("SELECT 1 FROM direction_catalog WHERE topic_id=?").get(id)) {
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
    this.commitOrganization({
      requestType: "direction-taxonomy",
      targetPath: relativePath,
      markdown,
      topicId: id,
      expectedHash: null,
      proposalIds: [proposalId],
      idempotencyKey,
      response,
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
    this.commitOrganization({
      requestType: "paper-organization",
      targetPath: manifest.markdown_path,
      markdown,
      paperId,
      expectedHash: manifest.markdown_hash,
      proposalIds,
      idempotencyKey,
      response,
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
      const directions = (this.database.prepare(`SELECT a.topic_id,d.title,a.assignment_role FROM paper_direction_assignments a
        JOIN direction_catalog d ON d.topic_id=a.topic_id
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
      const aliasCollision = aliases.some((alias) => (this.database.prepare(`SELECT count(DISTINCT paper_id) count
        FROM paper_aliases WHERE normalized_name=?`).get(normalizePaperLookup(alias.name)) as { count: number }).count > 1);
      return {
        ...paper,
        aliases,
        preferredAlias: aliases.find((alias) => alias.preferred)?.name ?? null,
        directions,
        pendingOrganizationCount,
        aliasCollision,
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
      const externalIdentities = [
        paper.arxivId,
        typeof paper.sourceUrl === "string" ? paper.sourceUrl : undefined,
      ].filter((value): value is string => Boolean(value));
      const external = externalIdentities.find((identity) => normalizePaperLookup(identity) === normalized);
      if (external) {
        matched.push({ ...paper, matchedBy: { kind: "external-identity", value: external, exact: true } });
        continue;
      }
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
      const prefix = [paper.title, ...paper.aliases.map((candidate) => candidate.name)]
        .some((value) => normalizePaperLookup(value).startsWith(normalized));
      if (prefix) {
        matched.push({ ...paper, matchedBy: { kind: "prefix", value: query, exact: false } });
      } else if (searchable.includes(normalized) || ftsIds.has(paper.id)) {
        matched.push({ ...paper, matchedBy: { kind: "catalog", value: query, exact: false } });
      }
    }
    return matched.sort((left, right) => matchRank(left) - matchRank(right) ||
      String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")) ||
      left.id.localeCompare(right.id));
  }

  rebuildCatalog(trustedWrite?: { targetPath: string; resultHash: string }): { count: number; rebuiltAt: string } {
    const rebuiltAt = this.now().toISOString();
    const topics = this.readMarkdownFiles(join(this.layout.vaultRoot, "knowledge", "topics"))
      .map((path) => this.readTopic(path));
    const papers = this.readMarkdownFiles(join(this.layout.vaultRoot, "library", "papers"))
      .filter((path) => path.endsWith(`${join("", "paper.md")}`))
      .map((path) => this.readPaper(path));
    const knownHashes = new Map<string, { hash: string; targetId: string; targetKind: "paper" | "topic" }>([
      ...(this.database.prepare("SELECT markdown_path,markdown_hash,paper_id FROM paper_manifests").all() as
        Array<{ markdown_path: string; markdown_hash: string; paper_id: string }>).map((row) =>
        [row.markdown_path, { hash: row.markdown_hash, targetId: row.paper_id, targetKind: "paper" as const }] as const),
      ...(this.database.prepare("SELECT markdown_path,markdown_hash,topic_id FROM direction_catalog").all() as
        Array<{ markdown_path: string; markdown_hash: string; topic_id: string }>).map((row) =>
        [row.markdown_path, { hash: row.markdown_hash, targetId: row.topic_id, targetKind: "topic" as const }] as const),
    ]);
    const conflicts = [
      ...topics.map((topic) => ({ ...topic, targetId: topic.id, targetKind: "topic" as const })),
      ...papers.map((paper) => ({ ...paper, targetId: paper.id, targetKind: "paper" as const })),
    ].filter((item) => {
      const known = knownHashes.get(item.relativePath);
      if (!known || known.hash === item.hash) return false;
      return trustedWrite?.targetPath !== item.relativePath || trustedWrite.resultHash !== item.hash;
    });
    if (conflicts.length > 0) {
      this.database.transaction(() => {
        for (const conflict of conflicts) {
          const known = knownHashes.get(conflict.relativePath)!;
          const proposalId = `proposal:reconciliation:catalog:${hashKey(`${conflict.relativePath}:${conflict.hash}`)}`;
          this.database.prepare(`INSERT OR IGNORE INTO proposals
            (id,proposal_type,paper_id,payload_json,review_status,one_click_eligible,created_at)
            VALUES (?,'reconciliation',?,?,'pending',0,?)`).run(proposalId,
              conflict.targetKind === "paper" ? conflict.targetId : null,
              JSON.stringify({
                targetKind: conflict.targetKind,
                targetId: conflict.targetId,
                targetPath: conflict.relativePath,
                expectedHash: known.hash,
                actualHash: conflict.hash,
                source: "external-markdown-rebuild",
              }), rebuiltAt);
        }
      })();
      const count = (this.database.prepare("SELECT count(*) count FROM paper_catalog_documents").get() as
        { count: number }).count;
      return { count, rebuiltAt };
    }
    const topicIds = new Set(topics.map((topic) => topic.id));
    const topicsById = new Map(topics.map((topic) => [topic.id, topic]));
    const resolveTopic = (topicId: string): string => {
      const visited = new Set<string>();
      let current = topicId;
      while (true) {
        if (visited.has(current)) throw new PaperOrganizationStoreError("direction-redirect-loop", 409);
        visited.add(current);
        const topic = topicsById.get(current);
        if (!topic) throw new PaperOrganizationStoreError("paper-direction-not-usable", 409);
        if (!topic.supersededBy) return current;
        current = topic.supersededBy;
      }
    };
    const projectedPapers = papers.map((paper) => {
      const assignments = new Map<string, PaperDirectionInput>();
      for (const assignment of paper.organization.directions) {
        const topicId = resolveTopic(assignment.topicId);
        const existing = assignments.get(topicId);
        if (!existing || assignment.role === "primary") assignments.set(topicId, { topicId, role: assignment.role });
      }
      return { ...paper, organization: validatePaperOrganization({
        aliases: paper.organization.aliases,
        directions: [...assignments.values()],
      }) };
    });
    for (const paper of projectedPapers) {
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
        DELETE FROM direction_catalog;`);
      for (const topic of topics) {
        this.database.prepare(`INSERT INTO direction_catalog
          (topic_id,title,aliases_json,scope,usage_level,lifecycle_status,superseded_by,revision_id,
           revision_number,review_status,markdown_path,markdown_hash,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(topic.id, topic.title, JSON.stringify(topic.aliases),
            topic.scope, topic.usageLevel, topic.lifecycleStatus, topic.supersededBy, topic.revisionId,
            topic.revisionNumber, topic.reviewStatus, topic.relativePath, topic.hash, topic.createdAt, topic.updatedAt);
      }
      for (const paper of projectedPapers) {
        this.database.prepare(`INSERT INTO paper_manifests(paper_id,markdown_path,markdown_hash,updated_at)
          VALUES (?,?,?,?)`).run(paper.id, paper.relativePath, paper.hash, paper.updatedAt);
        paper.organization.aliases.forEach((alias, ordinal) => this.database.prepare(`INSERT INTO paper_aliases
          (paper_id,name,normalized_name,alias_kind,preferred,ordinal) VALUES (?,?,?,?,?,?)`)
          .run(paper.id, alias.name, normalizePaperLookup(alias.name), alias.kind, Number(alias.preferred), ordinal));
        paper.organization.directions.forEach((direction, ordinal) => this.database.prepare(`INSERT INTO paper_direction_assignments
          (paper_id,topic_id,assignment_role,ordinal) VALUES (?,?,?,?)`)
          .run(paper.id, direction.topicId, direction.role, ordinal));
        const assignedTopics = paper.organization.directions.map((direction) => topicsById.get(direction.topicId)!);
        const searchText = [paper.title, ...paper.organization.aliases.map((alias) => alias.name),
          ...paper.authors, ...paper.externalIdentities, ...assignedTopics.flatMap((topic) =>
            [topic.title, ...topic.aliases, topic.scope])].join("\n");
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
    return { count: projectedPapers.length, rebuiltAt };
  }

  private commitOrganization(command: Parameters<KnowledgeWriter["commitOrganization"]>[0]): void {
    try {
      this.knowledgeWriter.commitOrganization(command);
    } catch (error) {
      const code = error instanceof Error ? error.message : "paper-organization-write-failed";
      if (code === "paper-organization-conflicted" || code === "organization-write-in-progress" ||
          code === "paper-organization-write-failed") {
        throw new PaperOrganizationStoreError(code, 409);
      }
      throw error;
    }
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
    const usable = this.database.prepare(`SELECT 1 FROM direction_catalog
      WHERE topic_id=? AND lifecycle_status='active' AND review_status='confirmed'`).get(topicId);
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
    lifecycleStatus: "active" | "superseded" | "deleted";
    supersededBy: string | null;
    reviewStatus: "confirmed" | "needs-review" | "superseded" | "provenance-missing";
    revisionNumber: number;
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
    const reviewStatus = ["confirmed", "needs-review", "superseded", "provenance-missing"].includes(String(data.review_status))
      ? data.review_status as "confirmed" | "needs-review" | "superseded" | "provenance-missing"
      : "needs-review";
    const supersededBy = typeof data.superseded_by === "string" && data.superseded_by.startsWith("topic:")
      ? data.superseded_by : null;
    const lifecycleStatus = data.lifecycle_status === "deleted" ? "deleted"
      : reviewStatus === "superseded" || supersededBy ? "superseded" : "active";
    const revisionNumber = Number.isInteger(data.revision) && Number(data.revision) > 0 ? Number(data.revision) : 1;
    const scope = markdownSection(parsed.body, "Scope");
    if (!id.startsWith("topic:") || !title || !scope) {
      throw new PaperOrganizationStoreError("direction-markdown-invalid", 409);
    }
    return {
      id,
      revisionId: typeof data.revision_id === "string" && data.revision_id ? data.revision_id : `${id}:r1`,
      title,
      aliases,
      scope,
      usageLevel,
      lifecycleStatus,
      supersededBy,
      reviewStatus,
      revisionNumber,
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
    externalIdentities: string[];
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
      externalIdentities: data.external_identities && typeof data.external_identities === "object"
        ? Object.values(data.external_identities as Record<string, unknown>)
          .filter((identity): identity is string => typeof identity === "string")
        : [],
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
    case "external-identity": return 1;
    case "preferred-alias": return 2;
    case "alias": return 3;
    case "canonical-title": return 4;
    case "prefix": return 5;
    default: return 6;
  }
}
