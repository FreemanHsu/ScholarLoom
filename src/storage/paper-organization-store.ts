import { createHash, randomUUID } from "node:crypto";
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
import { knowledgeReadyContentErrors, parseTopicKnowledgeMarkdown } from "../domain/topic-knowledge.js";
import type {
  OrganizationDirectionSnapshot,
  OrganizationRequestedSection,
  OrganizationSectionKind,
  PaperOrganizationDecisionV1,
  PaperOrganizationScope,
} from "../agent/paper-organization.js";
import {
  PAPER_ORGANIZATION_DECISION_VERSION,
  validatePaperOrganizationDecision,
} from "../agent/paper-organization.js";
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
  externalIdentities: string[];
  pendingOrganizationCount: number;
  aliasCollision: boolean;
  matchedBy?: {
    kind: "external-identity" | "preferred-alias" | "alias" | "canonical-title" | "prefix" | "catalog";
    value: string;
    exact: boolean;
  };
};

export type OrganizationQueueQuery = {
  view: "pending" | "attention" | "all";
  section?: "alias" | "primary" | "secondary";
  direction?: string;
  unclassified?: boolean;
  q?: string;
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
  ) {}

  listDirections(): Array<{
    id: string;
    title: string;
    aliases: string[];
    scope: string;
    usageLevel: "classification" | "knowledge-ready";
    parentDomainId: string | null;
    revisionId: string;
    markdownHash: string;
    semanticHash: string;
    primaryCount: number;
    secondaryCount: number;
  }> {
    return (this.database.prepare(`SELECT d.topic_id,d.title,d.usage_level,d.aliases_json,d.scope,n.parent_domain_id,
      d.revision_id,d.markdown_hash,d.lifecycle_status,d.superseded_by,d.review_status,
      (SELECT count(*) FROM paper_direction_assignments a WHERE a.topic_id=d.topic_id AND a.assignment_role='primary') primary_count,
      (SELECT count(*) FROM paper_direction_assignments a WHERE a.topic_id=d.topic_id AND a.assignment_role='secondary') secondary_count
      FROM direction_catalog d JOIN topic_navigation n ON n.topic_id=d.topic_id
      WHERE d.lifecycle_status='active' AND d.review_status='confirmed' AND n.navigation_role='direction'
      ORDER BY d.title COLLATE NOCASE,d.topic_id`).all() as Array<{
        topic_id: string;
        title: string;
        usage_level: "classification" | "knowledge-ready";
        parent_domain_id: string | null;
        aliases_json: string;
        scope: string;
        revision_id: string;
        markdown_hash: string;
        lifecycle_status: string;
        superseded_by: string | null;
        review_status: string;
        primary_count: number;
        secondary_count: number;
      }>).map((row) => {
        return {
          id: row.topic_id,
          title: row.title,
          aliases: JSON.parse(row.aliases_json) as string[],
          scope: row.scope,
          usageLevel: row.usage_level,
          parentDomainId: row.parent_domain_id,
          revisionId: row.revision_id,
          markdownHash: row.markdown_hash,
          semanticHash: sha256(JSON.stringify({
            scope: row.scope,
            usageLevel: row.usage_level,
            lifecycleStatus: row.lifecycle_status,
            supersededBy: row.superseded_by,
            reviewStatus: row.review_status,
          })),
          primaryCount: row.primary_count,
          secondaryCount: row.secondary_count,
        };
      });
  }

  hierarchy() {
    const enabled = this.metadataFlag("hierarchy-enabled");
    const everEnabled = this.metadataFlag("hierarchy-ever-enabled");
    const directionCount = Number(this.database.prepare(`SELECT count(*) FROM direction_catalog d
      JOIN topic_navigation n ON n.topic_id=d.topic_id WHERE d.lifecycle_status='active'
        AND d.review_status='confirmed' AND n.navigation_role='direction'`).pluck().get() ?? 0);
    const domains = (this.database.prepare(`SELECT d.topic_id,d.title,d.aliases_json,d.scope,d.revision_id,
      d.markdown_hash,count(DISTINCT CASE WHEN a.assignment_role='primary' THEN a.paper_id END) primary_count,
      count(DISTINCT c.topic_id) child_count
      FROM direction_catalog d JOIN topic_navigation n ON n.topic_id=d.topic_id
      LEFT JOIN topic_navigation c ON c.parent_domain_id=d.topic_id AND c.navigation_role='direction'
      LEFT JOIN paper_direction_assignments a ON a.topic_id=c.topic_id
      WHERE d.lifecycle_status='active' AND d.review_status='confirmed' AND n.navigation_role='domain'
      GROUP BY d.topic_id ORDER BY d.title COLLATE NOCASE,d.topic_id`).all() as Array<{
        topic_id: string; title: string; aliases_json: string; scope: string; revision_id: string;
        markdown_hash: string; primary_count: number; child_count: number;
      }>).map((row) => ({ id: row.topic_id, title: row.title,
        aliases: JSON.parse(row.aliases_json) as string[], scope: row.scope,
        revisionId: row.revision_id, markdownHash: row.markdown_hash,
        primaryCount: row.primary_count, childCount: row.child_count }));
    const ungroupedPrimaryCount = Number(this.database.prepare(`SELECT count(DISTINCT a.paper_id)
      FROM paper_direction_assignments a JOIN topic_navigation n ON n.topic_id=a.topic_id
      WHERE a.assignment_role='primary' AND n.navigation_role='direction' AND n.parent_domain_id IS NULL`)
      .pluck().get() ?? 0);
    return { enabled, everEnabled, threshold: 15, directionCount,
      canEnable: everEnabled || directionCount >= 15, ungroupedPrimaryCount, domains };
  }

  resolveDirection(topicId: string): { requestedId: string; canonicalId: string; lineage: string[] } {
    const active = this.database.prepare(`SELECT 1 FROM direction_catalog d JOIN topic_navigation n ON n.topic_id=d.topic_id
      WHERE d.topic_id=? AND d.lifecycle_status='active' AND d.review_status='confirmed'
        AND n.navigation_role='direction'`).get(topicId);
    if (active) return { requestedId: topicId, canonicalId: topicId, lineage: [topicId] };
    const redirect = this.database.prepare(`SELECT canonical_target_topic_id,lineage_json
      FROM topic_redirects WHERE source_topic_id=?`).get(topicId) as
      { canonical_target_topic_id: string; lineage_json: string } | undefined;
    if (!redirect) throw new PaperOrganizationStoreError("topic-redirect-unavailable", 409);
    const targetActive = this.database.prepare(`SELECT 1 FROM direction_catalog d JOIN topic_navigation n ON n.topic_id=d.topic_id
      WHERE d.topic_id=? AND d.lifecycle_status='active' AND d.review_status='confirmed'
        AND n.navigation_role='direction'`)
      .get(redirect.canonical_target_topic_id);
    if (!targetActive) throw new PaperOrganizationStoreError("topic-redirect-unavailable", 409);
    return {
      requestedId: topicId,
      canonicalId: redirect.canonical_target_topic_id,
      lineage: JSON.parse(redirect.lineage_json) as string[],
    };
  }

  snapshotForOrganizationAgent(
    paperId: string,
    summaryRevisionId: string,
    scope: PaperOrganizationScope = "all",
  ): {
    paper: { id: string; versionId: string; title: string; authors: string[]; externalIdentities: string[] };
    summary: { revisionId: string; markdownHash: string;
      sections: Array<{ key: string; title: string; body: string }> };
    organization: PaperOrganizationInput;
    paperManifest: { path: string; hash: string };
    directions: OrganizationDirectionSnapshot[];
    requestedSections: OrganizationRequestedSection[];
    lockedPrimaryTopicId: string | null;
  } {
    const paper = this.database.prepare(`SELECT p.id,p.current_version_id,p.title,
      s.id summary_id,s.markdown_hash,s.structured_json
      FROM papers p JOIN summary_revisions s ON s.paper_id=p.id
      WHERE p.id=? AND s.id=? AND s.status='active'`).get(paperId, summaryRevisionId) as {
        id: string;
        current_version_id: string | null;
        title: string;
        summary_id: string;
        markdown_hash: string;
        structured_json: string;
      } | undefined;
    if (!paper?.current_version_id) throw new PaperOrganizationStoreError("paper-organization-source-unavailable", 409);
    const summaryVersion = this.database.prepare("SELECT paper_version_id FROM summary_revisions WHERE id=?")
      .pluck().get(summaryRevisionId) as string | undefined;
    if (summaryVersion !== paper.current_version_id) {
      throw new PaperOrganizationStoreError("paper-organization-summary-not-current", 409);
    }
    const manifest = this.database.prepare("SELECT markdown_path,markdown_hash FROM paper_manifests WHERE paper_id=?")
      .get(paperId) as { markdown_path: string; markdown_hash: string } | undefined;
    if (!manifest) throw new PaperOrganizationStoreError("paper-organization-source-busy", 409);
    const activeWrite = this.database.prepare(`SELECT 1 FROM knowledge_write_requests
      WHERE target_path=? AND request_type IN ('paper-manifest','paper-organization')
        AND phase NOT IN ('complete','failed','conflicted') LIMIT 1`).get(manifest.markdown_path);
    if (activeWrite) throw new PaperOrganizationStoreError("paper-organization-source-busy", 409);
    const path = join(this.layout.vaultRoot, manifest.markdown_path);
    if (!existsSync(path) || hashFile(path) !== manifest.markdown_hash) {
      throw new PaperOrganizationStoreError("paper-organization-source-drift", 409);
    }
    const markdownPaper = this.readPaper(path);
    if (markdownPaper.id !== paperId) throw new PaperOrganizationStoreError("paper-organization-source-drift", 409);
    const summary = JSON.parse(paper.structured_json) as {
      sections?: Array<{ key?: unknown; title?: unknown; body?: unknown }>;
    };
    const sections = (summary.sections ?? []).map((section) => ({
      key: String(section.key ?? ""),
      title: String(section.title ?? ""),
      body: String(section.body ?? ""),
    })).filter((section) => section.key && section.title && section.body);
    if (sections.length === 0) throw new PaperOrganizationStoreError("paper-organization-summary-invalid", 409);
    const identityRows = this.database.prepare(`SELECT identity_type,normalized_value,metadata_json
      FROM paper_external_identities WHERE paper_id=? ORDER BY identity_type,normalized_value`).all(paperId) as
      Array<{ identity_type: string; normalized_value: string; metadata_json: string }>;
    const metadata = identityRows.length > 0
      ? JSON.parse(identityRows[0]!.metadata_json) as { authors?: string[] } : {};
    const directions = (this.database.prepare(`SELECT d.topic_id,d.title,d.aliases_json,d.scope,d.revision_id,
      d.markdown_hash,d.usage_level,d.lifecycle_status,d.superseded_by,d.review_status
      FROM direction_catalog d JOIN topic_navigation n ON n.topic_id=d.topic_id
      WHERE d.lifecycle_status='active' AND d.review_status='confirmed' AND n.navigation_role='direction'
      ORDER BY d.title COLLATE NOCASE,d.topic_id`).all() as Array<{
        topic_id: string;
        title: string;
        aliases_json: string;
        scope: string;
        revision_id: string;
        markdown_hash: string;
        usage_level: string;
        lifecycle_status: string;
        superseded_by: string | null;
        review_status: string;
      }>).map((direction) => ({
        topicId: direction.topic_id,
        title: direction.title,
        aliases: JSON.parse(direction.aliases_json) as string[],
        scope: direction.scope,
        revisionId: direction.revision_id,
        markdownHash: direction.markdown_hash,
        semanticHash: sha256(JSON.stringify({
          scope: direction.scope,
          usageLevel: direction.usage_level,
          lifecycleStatus: direction.lifecycle_status,
          supersededBy: direction.superseded_by,
          reviewStatus: direction.review_status,
        })),
      }));
    const primary = markdownPaper.organization.directions.find((direction) => direction.role === "primary")?.topicId ?? null;
    const requestedSections: OrganizationRequestedSection[] = scope === "all"
      ? ["alias", ...(primary ? [] : ["primary" as const]), "secondary"]
      : [scope];
    return {
      paper: {
        id: paperId,
        versionId: paper.current_version_id,
        title: markdownPaper.title || paper.title,
        authors: metadata.authors ?? markdownPaper.authors,
        externalIdentities: identityRows.map((identity) => `${identity.identity_type}:${identity.normalized_value}`),
      },
      summary: { revisionId: paper.summary_id, markdownHash: paper.markdown_hash, sections },
      organization: markdownPaper.organization,
      paperManifest: { path: manifest.markdown_path, hash: manifest.markdown_hash },
      directions,
      requestedSections,
      lockedPrimaryTopicId: scope === "primary" ? null : primary,
    };
  }

  createDirection(input: unknown, idempotencyKey: string,
    navigationRole: "direction" | "domain" = "direction"): unknown {
    const replay = this.replay(idempotencyKey);
    if (replay) return replay;
    const retrying = this.hasRetryableWrite(idempotencyKey);
    const continuing = this.hasUnfinishedWrite(idempotencyKey);
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
    if (this.database.prepare("SELECT 1 FROM direction_catalog WHERE topic_id=?").get(id) && !retrying && !continuing) {
      throw new PaperOrganizationStoreError("direction-already-exists", 409);
    }
    const uniqueAliases = [...new Map((aliases as string[]).map((alias) => [normalizePaperLookup(alias), alias.trim()])).values()];
    const candidateKeys = new Set([title, ...uniqueAliases].map(normalizePaperLookup));
    const occupied = this.database.prepare("SELECT title,aliases_json FROM direction_catalog WHERE topic_id<>?")
      .all(id) as Array<{ title: string; aliases_json: string }>;
    if (occupied.some((row) => [row.title, ...(JSON.parse(row.aliases_json) as string[])]
      .some((name) => candidateKeys.has(normalizePaperLookup(name))))) {
      throw new PaperOrganizationStoreError("direction-name-collision", 409);
    }
    if (retrying || continuing) {
      const prior = this.writePayload(idempotencyKey)?.response as {
        direction?: { id?: string; title?: string; aliases?: string[]; scope?: string };
      } | undefined;
      if (!prior?.direction || JSON.stringify({
        id: prior.direction.id,
        title: prior.direction.title,
        aliases: prior.direction.aliases ?? [],
        scope: prior.direction.scope,
      }) !== JSON.stringify({ id, title, aliases: uniqueAliases, scope })) {
        throw new PaperOrganizationStoreError("idempotency-key-conflict", 409);
      }
    }
    const now = this.now().toISOString();
    const relativePath = join("knowledge", "topics", `${id.slice("topic:".length)}.md`);
    const target = join(this.layout.vaultRoot, relativePath);
    if (retrying && existsSync(target)) {
      const priorHash = this.database.prepare(`SELECT result_hash FROM knowledge_write_requests
        WHERE request_type='direction-taxonomy' AND json_extract(payload_json,'$.idempotencyKey')=?`)
        .pluck().get(idempotencyKey) as string | undefined;
      if (!priorHash || hashFile(target) !== priorHash) {
        throw new PaperOrganizationStoreError("direction-retry-review-required", 409);
      }
    }
    if (existsSync(target) && !retrying && !continuing) {
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
      navigationRole,
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
        navigationRole,
      },
    };
    const proposalId = `proposal:direction-taxonomy:${hashKey(idempotencyKey)}`;
    this.database.prepare(`INSERT OR IGNORE INTO proposals
      (id,proposal_type,paper_id,payload_json,review_status,one_click_eligible,created_at)
      VALUES (?,'direction-taxonomy',NULL,?,'pending',1,?)`)
      .run(proposalId, JSON.stringify({
        operation: navigationRole === "domain" ? "create-domain" : "create",
        topicId: id,
        title,
        aliases: uniqueAliases,
        scope,
        usageLevel: "classification", navigationRole,
        rationale: "用户直接创建 Research Direction。",
      }), now);
    this.commitOrganization({
      requestType: "direction-taxonomy",
      targetPath: relativePath,
      markdown,
      topicId: id,
      expectedHash: retrying && existsSync(target) ? hashFile(target) : null,
      proposalIds: [proposalId],
      idempotencyKey,
      response,
    });
    return response;
  }

  createDomain(input: unknown, idempotencyKey: string): unknown {
    return this.createDirection(input, idempotencyKey, "domain");
  }

  renameDirection(topicId: string, input: unknown, idempotencyKey: string,
    expectedRole: "direction" | "domain" = "direction"): unknown {
    const replay = this.replay(idempotencyKey);
    if (replay) return replay;
    if (!input || typeof input !== "object") throw new PaperOrganizationStoreError("direction-rename-invalid");
    const value = input as {
      title?: unknown; aliases?: unknown; scope?: unknown; scopeMeaningUnchanged?: unknown;
      expectedRevisionId?: unknown; expectedMarkdownHash?: unknown;
    };
    const row = this.database.prepare(`SELECT * FROM direction_catalog WHERE topic_id=?`)
      .get(topicId) as Record<string, unknown> | undefined;
    if (!row) throw new PaperOrganizationStoreError("direction-not-found", 404);
    const role = this.database.prepare("SELECT navigation_role FROM topic_navigation WHERE topic_id=?")
      .pluck().get(topicId) as string | undefined;
    if (role !== expectedRole) throw new PaperOrganizationStoreError("taxonomy-role-invalid", 409);
    if (row.lifecycle_status !== "active" || row.review_status !== "confirmed") {
      throw new PaperOrganizationStoreError("paper-direction-not-usable", 409);
    }
    if (expectedRole === "domain" && row.usage_level !== "classification") {
      throw new PaperOrganizationStoreError("domain-knowledge-invalid", 409);
    }
    if (row.usage_level === "knowledge-ready") {
      throw new PaperOrganizationStoreError("topic-knowledge-rename-required", 409);
    }
    if (value.expectedRevisionId !== row.revision_id || value.expectedMarkdownHash !== row.markdown_hash) {
      throw new PaperOrganizationStoreError("direction-rename-stale", 409);
    }
    const title = typeof value.title === "string" ? value.title.trim() : "";
    const scope = typeof value.scope === "string" ? value.scope.trim() : "";
    const aliases = Array.isArray(value.aliases)
      ? value.aliases.map((alias) => String(alias).trim()).filter(Boolean) : [];
    if (!title || !scope || new Set(aliases.map(normalizePaperLookup)).size !== aliases.length) {
      throw new PaperOrganizationStoreError("direction-rename-invalid");
    }
    const sameMeaning = scope === row.scope;
    if (sameMeaning && value.scopeMeaningUnchanged !== true) {
      throw new PaperOrganizationStoreError("direction-rename-attestation-required");
    }
    const candidateKeys = new Set([title, ...aliases].map(normalizePaperLookup));
    const occupiedNames = this.database.prepare("SELECT topic_id,title,aliases_json FROM direction_catalog WHERE topic_id<>?")
      .all(topicId) as Array<{ topic_id: string; title: string; aliases_json: string }>;
    if (occupiedNames.some((direction) =>
      [direction.title, ...(JSON.parse(direction.aliases_json) as string[])].some((candidate) =>
        candidateKeys.has(normalizePaperLookup(candidate))))) {
      throw new PaperOrganizationStoreError("direction-rename-collision", 409);
    }
    const relativePath = String(row.markdown_path);
    const path = join(this.layout.vaultRoot, relativePath);
    if (!existsSync(path) || hashFile(path) !== row.markdown_hash) {
      throw new PaperOrganizationStoreError("direction-rename-stale", 409);
    }
    const parsed = parseFrontmatter(readFileSync(path, "utf8"));
    const revision = Number(row.revision_number) + 1;
    const now = this.now().toISOString();
    parsed.document.set("title", title);
    parsed.document.set("aliases", aliases);
    parsed.document.set("revision", revision);
    parsed.document.set("revision_id", `${topicId}:r${revision}`);
    parsed.document.set("updated", now.slice(0, 10));
    let body = parsed.body.replace(/^# .+$/m, `# ${title}`);
    body = replaceMarkdownSection(body, "Scope", scope);
    body = setMarkdownSection(body, "Revision note", sameMeaning
      ? "用户确认仅调整显示名称，Scope 含义不变。" : "用户编辑了 Research Direction 的 Scope。");
    const markdown = `---\n${parsed.document.toString().trimEnd()}\n---\n${body}`;
    const response = {
      direction: {
        id: topicId, title, aliases, scope,
        revisionId: `${topicId}:r${revision}`,
        usageLevel: row.usage_level,
      },
      scopeMeaningUnchanged: sameMeaning,
      actor: "local-owner",
    };
    const proposalId = `proposal:direction-taxonomy:${hashKey(idempotencyKey)}`;
    this.database.prepare(`INSERT OR IGNORE INTO proposals
      (id,proposal_type,paper_id,payload_json,review_status,one_click_eligible,created_at)
      VALUES (?,'direction-taxonomy',NULL,?,'pending',0,?)`).run(proposalId, JSON.stringify({
        operation: expectedRole === "domain" ? "rename-domain" : sameMeaning ? "rename" : "scope-edit",
        actor: "local-owner",
        topicId,
        frozen: {
          revisionId: row.revision_id,
          markdownHash: row.markdown_hash,
          semanticHash: this.directionSemanticHash(topicId),
          scope: row.scope,
        },
        accepted: { title, aliases, scope, scopeMeaningUnchanged: sameMeaning },
      }), now);
    this.commitOrganization({
      requestType: "direction-taxonomy",
      targetPath: relativePath,
      markdown,
      topicId,
      expectedHash: String(row.markdown_hash),
      proposalIds: [proposalId],
      idempotencyKey,
      response,
    });
    return response;
  }

  renameDomain(topicId: string, input: unknown, idempotencyKey: string): unknown {
    return this.renameDirection(topicId, input, idempotencyKey, "domain");
  }

  setDirectionDomain(topicId: string, input: unknown, idempotencyKey: string): unknown {
    const replay = this.replay(idempotencyKey);
    if (replay) return replay;
    if (!input || typeof input !== "object") throw new PaperOrganizationStoreError("direction-domain-invalid");
    const value = input as Record<string, unknown>;
    const child = this.database.prepare(`SELECT d.*,n.navigation_role,n.parent_domain_id FROM direction_catalog d
      JOIN topic_navigation n ON n.topic_id=d.topic_id WHERE d.topic_id=?`).get(topicId) as Record<string, unknown> | undefined;
    if (!child || child.navigation_role !== "direction" || child.lifecycle_status !== "active" ||
        child.review_status !== "confirmed") throw new PaperOrganizationStoreError("paper-direction-not-usable", 409);
    if (child.usage_level === "knowledge-ready") {
      throw new PaperOrganizationStoreError("topic-knowledge-parent-required", 409);
    }
    if (value.expectedRevisionId !== child.revision_id || value.expectedMarkdownHash !== child.markdown_hash) {
      throw new PaperOrganizationStoreError("direction-domain-stale", 409);
    }
    const parentDomainId = value.parentDomainId === null ? null
      : typeof value.parentDomainId === "string" ? value.parentDomainId : undefined;
    if (parentDomainId === undefined || parentDomainId === topicId) {
      throw new PaperOrganizationStoreError("direction-domain-invalid");
    }
    if (parentDomainId && !this.metadataFlag("hierarchy-enabled")) {
      throw new PaperOrganizationStoreError("taxonomy-hierarchy-disabled", 409);
    }
    if (parentDomainId) {
      const parent = this.database.prepare(`SELECT d.revision_id,d.markdown_hash,d.lifecycle_status,d.review_status,
        n.navigation_role FROM direction_catalog d JOIN topic_navigation n ON n.topic_id=d.topic_id
        WHERE d.topic_id=?`).get(parentDomainId) as Record<string, unknown> | undefined;
      if (!parent || parent.navigation_role !== "domain" || parent.lifecycle_status !== "active" ||
          parent.review_status !== "confirmed") throw new PaperOrganizationStoreError("direction-domain-target-invalid", 409);
      if (value.expectedParentRevisionId !== parent.revision_id || value.expectedParentMarkdownHash !== parent.markdown_hash) {
        throw new PaperOrganizationStoreError("direction-domain-target-stale", 409);
      }
    }
    const targetPath = String(child.markdown_path);
    const fullPath = join(this.layout.vaultRoot, targetPath);
    if (!existsSync(fullPath) || hashFile(fullPath) !== child.markdown_hash) {
      throw new PaperOrganizationStoreError("direction-domain-stale", 409);
    }
    const parsed = parseFrontmatter(readFileSync(fullPath, "utf8"));
    const revisionNumber = Number(child.revision_number) + 1;
    const revisionId = `${topicId}:r${revisionNumber}`;
    const now = this.now().toISOString();
    parsed.document.set("parent_domain_id", parentDomainId);
    parsed.document.set("revision", revisionNumber);
    parsed.document.set("revision_id", revisionId);
    parsed.document.set("updated", now.slice(0, 10));
    const body = setMarkdownSection(parsed.body, "Revision note", parentDomainId
      ? `用户将该 Research Direction 归入 ${parentDomainId}。` : "用户将该 Research Direction 设为 Ungrouped。");
    const markdown = `---\n${parsed.document.toString().trimEnd()}\n---\n${body}`;
    const response = { hierarchyAssignment: { topicId, parentDomainId, revisionId } };
    const proposalId = `proposal:direction-taxonomy:${hashKey(idempotencyKey)}`;
    this.database.prepare(`INSERT OR IGNORE INTO proposals
      (id,proposal_type,paper_id,payload_json,review_status,one_click_eligible,created_at)
      VALUES (?,'direction-taxonomy',NULL,?,'pending',0,?)`).run(proposalId, JSON.stringify({
        operation: parentDomainId ? "assign-domain" : "remove-domain", topicId, parentDomainId,
        frozen: { childRevisionId: child.revision_id, childMarkdownHash: child.markdown_hash,
          parentRevisionId: value.expectedParentRevisionId ?? null,
          parentMarkdownHash: value.expectedParentMarkdownHash ?? null },
      }), now);
    this.commitOrganization({ requestType: "direction-taxonomy", targetPath, markdown, topicId,
      expectedHash: String(child.markdown_hash), proposalIds: [proposalId], idempotencyKey, response });
    return response;
  }

  setHierarchyEnabled(enabled: boolean, idempotencyKey: string): unknown {
    const prior = this.database.prepare("SELECT result_json FROM review_decisions WHERE idempotency_key=?")
      .pluck().get(idempotencyKey) as string | undefined;
    if (prior) return JSON.parse(prior) as unknown;
    const state = this.hierarchy();
    if (enabled && !state.canEnable) throw new PaperOrganizationStoreError("taxonomy-hierarchy-threshold", 409);
    const now = this.now().toISOString();
    const proposalId = `proposal:direction-taxonomy:${hashKey(idempotencyKey)}`;
    const decisionId = `review-decision:direction-taxonomy:${hashKey(idempotencyKey)}`;
    const response = { hierarchy: { enabled, everEnabled: enabled || state.everEnabled,
      threshold: state.threshold, directionCount: state.directionCount } };
    this.database.transaction(() => {
      this.database.prepare(`INSERT INTO proposals(id,proposal_type,paper_id,payload_json,
        review_status,one_click_eligible,created_at,decided_at) VALUES
        (?,'direction-taxonomy',NULL,?,'accepted',0,?,?)`).run(proposalId,
          JSON.stringify({ operation: "set-hierarchy-enabled", enabled }), now, now);
      this.database.prepare(`INSERT INTO review_decisions(id,proposal_id,action,idempotency_key,result_json,created_at)
        VALUES (?,?,'accept',?,?,?)`).run(decisionId, proposalId, idempotencyKey, JSON.stringify(response), now);
      this.database.prepare(`INSERT INTO paper_catalog_metadata(metadata_key,metadata_value) VALUES
        ('hierarchy-enabled',?) ON CONFLICT(metadata_key) DO UPDATE SET metadata_value=excluded.metadata_value`)
        .run(String(enabled));
      if (enabled) this.database.prepare(`INSERT INTO paper_catalog_metadata(metadata_key,metadata_value) VALUES
        ('hierarchy-ever-enabled','true') ON CONFLICT(metadata_key) DO UPDATE SET metadata_value='true'`).run();
      this.database.prepare(`INSERT INTO index_outbox(projection,source_id,operation,state,created_at)
        VALUES ('paper-catalog','taxonomy-hierarchy','rebuild','pending',?)
        ON CONFLICT(projection,source_id,operation) DO UPDATE SET state='pending',created_at=excluded.created_at,completed_at=NULL`)
        .run(now);
    })();
    const rebuilt = this.rebuildCatalog();
    if (!rebuilt.blocked) this.database.prepare(`UPDATE index_outbox SET state='complete',completed_at=?
      WHERE projection='paper-catalog' AND source_id='taxonomy-hierarchy' AND operation='rebuild'`).run(this.now().toISOString());
    return response;
  }

  mergeDirectionPreview(sourceTopicId: string, targetTopicId: string) {
    if (sourceTopicId === targetTopicId) throw new PaperOrganizationStoreError("direction-merge-invalid");
    if (this.navigationRole(sourceTopicId) !== "direction" || this.navigationRole(targetTopicId) !== "direction") {
      throw new PaperOrganizationStoreError("direction-merge-role-invalid", 409);
    }
    const source = this.directionLifecycleRow(sourceTopicId);
    const target = this.directionLifecycleRow(targetTopicId);
    const redirectTarget = this.database.prepare("SELECT canonical_target_topic_id FROM topic_redirects WHERE source_topic_id=?")
      .pluck().get(targetTopicId);
    if (source.lifecycle_status !== "active" || source.review_status !== "confirmed" ||
        target.lifecycle_status !== "active" || target.review_status !== "confirmed" || redirectTarget) {
      throw new PaperOrganizationStoreError("direction-merge-target-not-usable", 409);
    }
    const paperRows = this.database.prepare(`SELECT a.paper_id,m.markdown_hash
      FROM paper_direction_assignments a JOIN paper_manifests m ON m.paper_id=a.paper_id
      WHERE a.topic_id=? ORDER BY a.paper_id`).all(sourceTopicId) as
      Array<{ paper_id: string; markdown_hash: string }>;
    const members = paperRows.map((paper) => {
      const organization = this.projectedOrganization(paper.paper_id);
      return {
        paperId: paper.paper_id,
        expectedManifestHash: paper.markdown_hash,
        organization: mergeOrganization(organization, sourceTopicId, targetTopicId),
      };
    });
    return {
      source: {
        id: sourceTopicId,
        title: source.title,
        semanticHash: this.directionMergeSemanticHash(sourceTopicId)!,
        markdownHash: source.markdown_hash,
      },
      target: {
        id: targetTopicId,
        title: target.title,
        semanticHash: this.directionMergeSemanticHash(targetTopicId)!,
        markdownHash: target.markdown_hash,
      },
      affectedPaperCount: members.length,
      hierarchy: {
        sourceParentDomainId: this.parentDomainId(sourceTopicId),
        targetParentDomainId: this.parentDomainId(targetTopicId),
        discardedSourceParent: this.parentDomainId(sourceTopicId) !== this.parentDomainId(targetTopicId),
      },
      samples: members.slice(0, 5).map((member) => ({ paperId: member.paperId })),
      members,
    };
  }

  reserveDirectionMerge(sourceTopicId: string, targetTopicId: string, idempotencyKey: string) {
    const replay = this.database.prepare("SELECT id FROM direction_merge_commands WHERE idempotency_key=?")
      .pluck().get(idempotencyKey) as string | undefined;
    if (replay) return { mergeId: replay, replayed: true };
    const preview = this.mergeDirectionPreview(sourceTopicId, targetTopicId);
    const activeBatchReferences = (this.database.prepare(`SELECT p.payload_json
      FROM paper_organization_batch_members m
      JOIN paper_organization_batches b ON b.id=m.batch_id
      JOIN proposals p ON p.id=m.proposal_id
      WHERE b.state IN ('reserved','applying')`).all() as Array<{ payload_json: string }>)
      .some((row) => row.payload_json.includes(sourceTopicId) || row.payload_json.includes(targetTopicId));
    if (activeBatchReferences) throw new PaperOrganizationStoreError("direction-merge-batch-active", 409);
    const mergeId = `direction-merge:${randomUUID()}`;
    const proposalId = `proposal:direction-taxonomy:${hashKey(idempotencyKey)}`;
    const now = this.now().toISOString();
    try {
      this.database.transaction(() => {
        this.database.prepare(`INSERT INTO proposals
          (id,proposal_type,paper_id,payload_json,review_status,one_click_eligible,created_at)
          VALUES (?,'direction-taxonomy',NULL,?,'pending',0,?)`).run(proposalId, JSON.stringify({
            operation: "merge",
            actor: "local-owner",
            mergeId,
            sourceTopicId,
            targetTopicId,
            sourceSemanticHash: preview.source.semanticHash,
            targetSemanticHash: preview.target.semanticHash,
            hierarchy: preview.hierarchy,
            affectedPaperIds: preview.members.map((member) => member.paperId),
          }), now);
        this.database.prepare(`INSERT INTO direction_merge_commands
          (id,idempotency_key,source_topic_id,target_topic_id,source_semantic_hash,
           target_semantic_hash,source_markdown_hash,state,proposal_id,preview_json,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,'reserved',?,?,?,?)`).run(mergeId, idempotencyKey,
            sourceTopicId, targetTopicId, preview.source.semanticHash, preview.target.semanticHash,
            preview.source.markdownHash, proposalId, JSON.stringify({
              affectedPaperCount: preview.affectedPaperCount,
              samples: preview.samples,
            }), now, now);
        preview.members.forEach((member, ordinal) => this.database.prepare(`INSERT INTO direction_merge_members
          (merge_id,ordinal,paper_id,expected_manifest_hash,organization_json,member_state,created_at,updated_at)
          VALUES (?,?,?,?,?,'pending',?,?)`).run(mergeId, ordinal, member.paperId,
            member.expectedManifestHash, JSON.stringify(member.organization), now, now));
      })();
    } catch (error) {
      if (String(error).includes("one_active_direction_merge")) {
        throw new PaperOrganizationStoreError("direction-merge-active", 409);
      }
      throw error;
    }
    return { mergeId, replayed: false };
  }

  commitDirectionMergeSource(mergeId: string): void {
    const command = this.database.prepare("SELECT * FROM direction_merge_commands WHERE id=?")
      .get(mergeId) as Record<string, unknown> | undefined;
    if (!command) throw new PaperOrganizationStoreError("direction-merge-not-found", 404);
    const redirect = this.database.prepare("SELECT canonical_target_topic_id FROM topic_redirects WHERE source_topic_id=?")
      .pluck().get(command.source_topic_id) as string | undefined;
    if (redirect === command.target_topic_id || command.state === "migrating") {
      this.database.prepare("UPDATE direction_merge_commands SET state='migrating',updated_at=? WHERE id=?")
        .run(this.now().toISOString(), mergeId);
      return;
    }
    if (command.state !== "reserved" && command.state !== "superseding") {
      throw new PaperOrganizationStoreError("direction-merge-not-applicable", 409);
    }
    if (this.directionMergeSemanticHash(String(command.source_topic_id)) !== command.source_semantic_hash ||
        this.directionMergeSemanticHash(String(command.target_topic_id)) !== command.target_semantic_hash) {
      throw new PaperOrganizationStoreError("direction-merge-stale", 409);
    }
    const source = this.directionLifecycleRow(String(command.source_topic_id));
    const path = join(this.layout.vaultRoot, String(source.markdown_path));
    if (!existsSync(path) || hashFile(path) !== command.source_markdown_hash) {
      throw new PaperOrganizationStoreError("direction-merge-stale", 409);
    }
    const parsed = parseFrontmatter(readFileSync(path, "utf8"));
    const revision = Number(source.revision_number) + 1;
    const now = this.now().toISOString();
    parsed.document.set("superseded_by", command.target_topic_id);
    parsed.document.set("review_status", "superseded");
    parsed.document.set("revision", revision);
    parsed.document.set("revision_id", `${command.source_topic_id}:r${revision}`);
    parsed.document.set("updated", now.slice(0, 10));
    const body = setMarkdownSection(
      parsed.body,
      "Revision note",
      `Merged into ${command.target_topic_id}.`,
    );
    const markdown = `---\n${parsed.document.toString().trimEnd()}\n---\n${body}`;
    this.database.prepare(`UPDATE direction_merge_commands SET state='superseding',updated_at=?
      WHERE id=?`).run(now, mergeId);
    this.commitOrganization({
      requestType: "direction-taxonomy",
      targetPath: String(source.markdown_path),
      markdown,
      topicId: String(command.source_topic_id),
      expectedHash: String(command.source_markdown_hash),
      proposalIds: [String(command.proposal_id)],
      idempotencyKey: String(command.idempotency_key),
      response: {
        mergeId,
        sourceTopicId: command.source_topic_id,
        targetTopicId: command.target_topic_id,
        actor: "local-owner",
      },
    });
    const verified = this.database.prepare(`SELECT canonical_target_topic_id FROM topic_redirects
      WHERE source_topic_id=?`).pluck().get(command.source_topic_id);
    if (verified !== command.target_topic_id) {
      throw new PaperOrganizationStoreError("topic-redirect-unavailable", 409);
    }
    this.database.prepare(`UPDATE direction_merge_commands SET state='migrating',updated_at=?
      WHERE id=?`).run(this.now().toISOString(), mergeId);
  }

  applyDirectionMergeMember(mergeId: string, ordinal: number): unknown {
    const row = this.database.prepare(`SELECT m.paper_id,m.organization_json,c.idempotency_key
      FROM direction_merge_members m JOIN direction_merge_commands c ON c.id=m.merge_id
      WHERE m.merge_id=? AND m.ordinal=?`).get(mergeId, ordinal) as
      { paper_id: string; organization_json: string; idempotency_key: string } | undefined;
    if (!row) throw new PaperOrganizationStoreError("direction-merge-member-not-found", 404);
    return this.savePaperOrganization(row.paper_id, JSON.parse(row.organization_json),
      `merge-member:${row.idempotency_key}:${ordinal}`);
  }

  private directionLifecycleRow(topicId: string): Record<string, string | number> {
    const row = this.database.prepare("SELECT * FROM direction_catalog WHERE topic_id=?")
      .get(topicId) as Record<string, string | number> | undefined;
    if (!row) throw new PaperOrganizationStoreError("direction-not-found", 404);
    return row;
  }

  savePaperOrganization(paperId: string, input: unknown, idempotencyKey: string): unknown {
    const replay = this.replay(idempotencyKey);
    if (replay) return replay;
    const retrying = this.hasRetryableWrite(idempotencyKey);
    const continuing = this.hasUnfinishedWrite(idempotencyKey);
    const organization = validatePaperOrganization(input);
    if (retrying || continuing) {
      const prior = this.writePayload(idempotencyKey)?.response as {
        organization?: {
          aliases?: PaperAlias[];
          directions?: Array<{ topicId: string; role: "primary" | "secondary" }>;
        };
      } | undefined;
      if (!prior?.organization || JSON.stringify({
        aliases: prior.organization.aliases ?? [],
        directions: (prior.organization.directions ?? []).map((direction) => ({
          topicId: direction.topicId,
          role: direction.role,
        })),
      }) !== JSON.stringify(organization)) {
        throw new PaperOrganizationStoreError("idempotency-key-conflict", 409);
      }
    }
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
    if (retrying && JSON.stringify(before) !== JSON.stringify(this.projectedOrganization(paperId))) {
      throw new PaperOrganizationStoreError("paper-organization-retry-review-required", 409);
    }
    if (JSON.stringify(before) === JSON.stringify(organization)) {
      const response = { organization: this.organizationResponse(paperId, organization) };
      if (this.hasUnfinishedWrite(idempotencyKey)) {
        this.commitOrganization({
          requestType: "paper-organization",
          targetPath: manifest.markdown_path,
          markdown: currentMarkdown,
          paperId,
          expectedHash: hashFile(target),
          proposalIds: [],
          idempotencyKey,
          response,
        });
      }
      return response;
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
      this.database.prepare(`INSERT OR IGNORE INTO proposals
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
    const supersedeProposalIds = proposalKinds.flatMap((change) =>
      (this.database.prepare(`SELECT id FROM proposals
        WHERE paper_id=? AND proposal_type='paper-organization' AND review_status='pending'
          AND json_extract(payload_json,'$.sourceKind')='agent'
          AND json_extract(payload_json,'$.changeKind')=? ORDER BY created_at,id`)
        .all(paperId, change.kind) as Array<{ id: string }>).map((row) => row.id));
    const response = { organization: this.organizationResponse(paperId, organization) };
    this.commitOrganization({
      requestType: "paper-organization",
      targetPath: manifest.markdown_path,
      markdown,
      paperId,
      expectedHash: retrying ? hashFile(target) : manifest.markdown_hash,
      proposalIds,
      supersedeProposalIds,
      idempotencyKey,
      response,
    });
    return response;
  }

  decideAgentProposal(
    proposalId: string,
    input: { action?: unknown; value?: unknown; automation?: unknown },
    idempotencyKey: string,
  ): PaperOrganizationDecisionV1 {
    const replay = this.database.prepare(`SELECT result_json FROM review_decisions
      WHERE idempotency_key=? OR idempotency_key LIKE ? ORDER BY created_at LIMIT 1`)
      .get(idempotencyKey, `${idempotencyKey}:%`) as { result_json: string } | undefined;
    if (replay) return JSON.parse(replay.result_json) as PaperOrganizationDecisionV1;
    const row = this.database.prepare(`SELECT paper_id,payload_json,review_status FROM proposals
      WHERE id=? AND proposal_type='paper-organization'
        AND json_extract(payload_json,'$.sourceKind')='agent'`).get(proposalId) as {
        paper_id: string;
        payload_json: string;
        review_status: string;
      } | undefined;
    if (!row) throw new PaperOrganizationStoreError("paper-organization-proposal-not-found", 404);
    const action = input.action;
    if (!["accept", "accept-with-edit", "reject"].includes(String(action))) {
      throw new PaperOrganizationStoreError("paper-organization-decision-invalid");
    }
    if (row.review_status !== "pending") {
      const prior = this.database.prepare(`SELECT action,result_json FROM review_decisions
        WHERE proposal_id=? ORDER BY created_at DESC LIMIT 1`).get(proposalId) as
        { action: string; result_json: string } | undefined;
      const expected = action === "reject" ? "reject" : "accept";
      if (prior?.action === expected) return JSON.parse(prior.result_json) as PaperOrganizationDecisionV1;
      throw new PaperOrganizationStoreError("paper-organization-proposal-decided", 409);
    }
    const payload = JSON.parse(row.payload_json) as {
      changeKind: OrganizationSectionKind;
      before: unknown;
      after: unknown;
      summaryRevisionId: string;
      targetSemanticHashes?: Record<string, string>;
      conditionedOnPrimaryTopicId?: string;
    };
    if (!["alias", "primary-direction", "secondary-direction"].includes(payload.changeKind)) {
      throw new PaperOrganizationStoreError("paper-organization-proposal-invalid", 409);
    }
    if (action === "reject") {
      const decision: PaperOrganizationDecisionV1 = {
        schemaVersion: PAPER_ORGANIZATION_DECISION_VERSION,
        sectionKind: payload.changeKind,
        action: "reject",
        agentProposed: payload.after,
        userAccepted: null,
        edited: false,
        editedFields: [],
        resultingOrganization: null,
      };
      validatePaperOrganizationDecision(decision);
      const now = this.now().toISOString();
      this.database.transaction(() => {
        const changed = this.database.prepare(`UPDATE proposals SET review_status='rejected',decided_at=?
          WHERE id=? AND review_status='pending'`).run(now, proposalId).changes;
        if (!changed) throw new PaperOrganizationStoreError("paper-organization-proposal-decided", 409);
        this.database.prepare(`INSERT INTO review_decisions
          (id,proposal_id,action,idempotency_key,result_json,created_at)
          VALUES (?,?,?,?,?,?)`).run(`review-decision:${hashKey(idempotencyKey)}`, proposalId, "reject",
            idempotencyKey, JSON.stringify(decision), now);
      })();
      return decision;
    }

    const manifest = this.database.prepare("SELECT markdown_path,markdown_hash FROM paper_manifests WHERE paper_id=?")
      .get(row.paper_id) as { markdown_path: string; markdown_hash: string } | undefined;
    if (!manifest) throw new PaperOrganizationStoreError("paper-not-found", 404);
    const path = join(this.layout.vaultRoot, manifest.markdown_path);
    if (!existsSync(path) || hashFile(path) !== manifest.markdown_hash) {
      throw new PaperOrganizationStoreError("paper-organization-proposal-stale", 409);
    }
    const markdown = readFileSync(path, "utf8");
    const parsed = parseFrontmatter(markdown);
    if (String(parsed.data.current_summary_revision_id ?? "") !== payload.summaryRevisionId) {
      throw new PaperOrganizationStoreError("paper-organization-proposal-stale", 409);
    }
    const before = organizationFromData(parsed.data);
    const currentSection = payload.changeKind === "alias"
      ? before.aliases
      : payload.changeKind === "primary-direction"
        ? before.directions.find((direction) => direction.role === "primary") ?? null
        : before.directions.filter((direction) => direction.role === "secondary");
    if (JSON.stringify(currentSection) !== JSON.stringify(payload.before)) {
      throw new PaperOrganizationStoreError("paper-organization-proposal-stale", 409);
    }
    for (const [topicId, expectedHash] of Object.entries(payload.targetSemanticHashes ?? {})) {
      if (this.directionSemanticHash(topicId) !== expectedHash) {
        throw new PaperOrganizationStoreError("paper-organization-proposal-stale", 409);
      }
    }
    if (payload.changeKind === "secondary-direction") {
      const primary = before.directions.find((direction) => direction.role === "primary")?.topicId ?? null;
      if (!primary) throw new PaperOrganizationStoreError("paper-organization-proposal-blocked", 409);
      if (primary !== payload.conditionedOnPrimaryTopicId) {
        throw new PaperOrganizationStoreError("paper-organization-proposal-stale", 409);
      }
    }

    const chosen = input.value === undefined ? payload.after : input.value;
    let organization: PaperOrganizationInput;
    if (payload.changeKind === "alias") {
      const aliases = validatePaperOrganization({ aliases: chosen, directions: before.directions }).aliases;
      if (aliases.some((alias) => [...alias.name].length > 120 ||
          /[\u0000-\u001f\u007f-\u009f]/u.test(alias.name) ||
          normalizePaperLookup(alias.name) === normalizePaperLookup(String(parsed.data.title ?? "")))) {
        throw new PaperOrganizationStoreError("paper-alias-invalid");
      }
      organization = { aliases, directions: before.directions };
    } else if (payload.changeKind === "primary-direction") {
      const primaryValue = typeof chosen === "string"
        ? { topicId: chosen, role: "primary" as const }
        : chosen as { topicId?: unknown; role?: unknown } | null;
      if (!primaryValue || typeof primaryValue.topicId !== "string") {
        throw new PaperOrganizationStoreError("paper-direction-invalid");
      }
      this.requireDirection(primaryValue.topicId);
      organization = validatePaperOrganization({
        aliases: before.aliases,
        directions: [
          { topicId: primaryValue.topicId, role: "primary" },
          ...before.directions.filter((direction) =>
            direction.role === "secondary" && direction.topicId !== primaryValue.topicId),
        ],
      });
    } else {
      if (!Array.isArray(chosen)) throw new PaperOrganizationStoreError("paper-direction-invalid");
      const secondary = chosen.map((value) => typeof value === "string"
        ? { topicId: value, role: "secondary" as const }
        : value as PaperDirectionInput);
      secondary.forEach((direction) => this.requireDirection(direction.topicId));
      organization = validatePaperOrganization({
        aliases: before.aliases,
        directions: [
          ...before.directions.filter((direction) => direction.role === "primary"),
          ...secondary.map((direction) => ({ topicId: direction.topicId, role: "secondary" })),
        ],
      });
    }
    for (const direction of organization.directions) this.requireDirection(direction.topicId);
    const edited = JSON.stringify(chosen) !== JSON.stringify(payload.after);
    const decision: PaperOrganizationDecisionV1 = {
      schemaVersion: PAPER_ORGANIZATION_DECISION_VERSION,
      sectionKind: payload.changeKind,
      action: edited ? "accept-with-edit" : "accept",
      agentProposed: payload.after,
      userAccepted: chosen,
      edited,
      editedFields: edited ? [payload.changeKind] : [],
      resultingOrganization: organization,
      ...(input.automation && typeof input.automation === "object"
        ? { automation: input.automation as NonNullable<PaperOrganizationDecisionV1["automation"]> }
        : {}),
    };
    validatePaperOrganizationDecision(decision);
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
    const nextMarkdown = `---\n${parsed.document.toString().trimEnd()}\n---\n${parsed.body}`;
    this.commitOrganization({
      requestType: "paper-organization",
      targetPath: manifest.markdown_path,
      markdown: nextMarkdown,
      paperId: row.paper_id,
      expectedHash: manifest.markdown_hash,
      proposalIds: [proposalId],
      idempotencyKey,
      response: decision,
    });
    return decision;
  }

  organizationProposalState(proposalId: string): {
    applicability: "ready" | "blocked" | "stale";
    materialization: "not-started" | "applying" | "succeeded" | "failed" | "conflicted";
  } {
    const proposal = this.database.prepare(`SELECT paper_id,payload_json,review_status FROM proposals WHERE id=?`)
      .get(proposalId) as { paper_id: string; payload_json: string; review_status: string } | undefined;
    if (!proposal) throw new PaperOrganizationStoreError("paper-organization-proposal-not-found", 404);
    const payload = JSON.parse(proposal.payload_json) as {
      changeKind: OrganizationSectionKind;
      before: unknown;
      summaryRevisionId: string;
      conditionedOnPrimaryTopicId?: string;
      targetSemanticHashes?: Record<string, string>;
    };
    let applicability: "ready" | "blocked" | "stale" = "ready";
    const manifest = this.database.prepare("SELECT markdown_path,markdown_hash FROM paper_manifests WHERE paper_id=?")
      .get(proposal.paper_id) as { markdown_path: string; markdown_hash: string } | undefined;
    const path = manifest ? join(this.layout.vaultRoot, manifest.markdown_path) : "";
    if (!manifest || !existsSync(path) || hashFile(path) !== manifest.markdown_hash) applicability = "stale";
    else {
      try {
        const parsed = parseFrontmatter(readFileSync(path, "utf8"));
        const organization = organizationFromData(parsed.data);
        const current = payload.changeKind === "alias" ? organization.aliases
          : payload.changeKind === "primary-direction"
            ? organization.directions.find((direction) => direction.role === "primary") ?? null
            : organization.directions.filter((direction) => direction.role === "secondary");
        if (String(parsed.data.current_summary_revision_id ?? "") !== payload.summaryRevisionId ||
            JSON.stringify(current) !== JSON.stringify(payload.before) ||
            Object.entries(payload.targetSemanticHashes ?? {}).some(([topicId, hash]) =>
              this.directionSemanticHash(topicId) !== hash)) applicability = "stale";
        else if (payload.changeKind === "secondary-direction") {
          const primary = organization.directions.find((direction) => direction.role === "primary")?.topicId ?? null;
          applicability = !primary ? "blocked"
            : primary === payload.conditionedOnPrimaryTopicId ? "ready" : "stale";
        }
      } catch {
        applicability = "stale";
      }
    }
    const write = this.database.prepare(`SELECT phase FROM knowledge_write_requests w
      WHERE EXISTS (SELECT 1 FROM json_each(w.payload_json,'$.proposalIds') ids WHERE ids.value=?)
      ORDER BY w.created_at DESC LIMIT 1`).get(proposalId) as { phase: string } | undefined;
    const materialization = !write ? "not-started"
      : write.phase === "complete" ? "succeeded"
        : write.phase === "failed" ? "failed"
          : write.phase === "conflicted" ? "conflicted" : "applying";
    return { applicability, materialization };
  }

  organizationProposalLightState(proposalId: string): {
    applicability: "ready" | "blocked" | "stale";
    materialization: "not-started" | "applying" | "succeeded" | "failed" | "conflicted";
  } {
    const proposal = this.database.prepare("SELECT paper_id,payload_json FROM proposals WHERE id=?")
      .get(proposalId) as { paper_id: string; payload_json: string } | undefined;
    if (!proposal) throw new PaperOrganizationStoreError("paper-organization-proposal-not-found", 404);
    const payload = JSON.parse(proposal.payload_json) as {
      changeKind: OrganizationSectionKind;
      before: unknown;
      summaryRevisionId: string;
      conditionedOnPrimaryTopicId?: string;
      targetSemanticHashes?: Record<string, string>;
    };
    const organization = this.projectedOrganization(proposal.paper_id);
    const current = payload.changeKind === "alias" ? organization.aliases
      : payload.changeKind === "primary-direction"
        ? organization.directions.find((direction) => direction.role === "primary") ?? null
        : organization.directions.filter((direction) => direction.role === "secondary");
    const activeSummary = this.database.prepare(`SELECT s.id FROM summary_revisions s JOIN papers p
      ON p.current_version_id=s.paper_version_id WHERE p.id=? AND s.paper_id=p.id AND s.status='active'
      ORDER BY s.created_at DESC,s.id DESC LIMIT 1`).pluck().get(proposal.paper_id) as string | undefined;
    let applicability: "ready" | "blocked" | "stale" =
      activeSummary !== payload.summaryRevisionId ||
      JSON.stringify(current) !== JSON.stringify(payload.before) ||
      Object.entries(payload.targetSemanticHashes ?? {}).some(([topicId, hash]) =>
        this.directionSemanticHash(topicId) !== hash) ? "stale" : "ready";
    if (applicability === "ready" && payload.changeKind === "secondary-direction") {
      const primary = organization.directions.find((direction) => direction.role === "primary")?.topicId ?? null;
      applicability = !primary ? "blocked"
        : primary === payload.conditionedOnPrimaryTopicId ? "ready" : "stale";
    }
    const write = this.database.prepare(`SELECT phase FROM knowledge_write_requests w
      WHERE EXISTS (SELECT 1 FROM json_each(w.payload_json,'$.proposalIds') ids WHERE ids.value=?)
      ORDER BY w.created_at DESC LIMIT 1`).get(proposalId) as { phase: string } | undefined;
    const materialization = !write ? "not-started"
      : write.phase === "complete" ? "succeeded"
        : write.phase === "failed" ? "failed"
          : write.phase === "conflicted" ? "conflicted" : "applying";
    return { applicability, materialization };
  }

  readOrganizationForPaper(paperId: string, verifyLive = true): {
    runs: unknown[];
    suggestions: unknown[];
  } {
    const runs = (this.database.prepare(`SELECT j.id,j.state,j.error_json,j.started_at,j.completed_at,
      r.sequence,r.scope,r.proposal_group_id,r.outcome_json
      FROM paper_organization_runs r JOIN job_runs j ON j.id=r.job_run_id
      WHERE r.paper_id=? ORDER BY r.sequence DESC`).all(paperId) as Array<{
        id: string;
        state: string;
        error_json: string | null;
        started_at: string | null;
        completed_at: string | null;
        sequence: number;
        scope: string;
        proposal_group_id: string | null;
        outcome_json: string | null;
      }>).map((run) => ({
        id: run.id,
        state: run.state,
        sequence: run.sequence,
        scope: run.scope,
        groupId: run.proposal_group_id,
        outcomes: run.outcome_json ? JSON.parse(run.outcome_json) as unknown : null,
        error: run.error_json ? JSON.parse(run.error_json) as unknown : null,
        startedAt: run.started_at,
        completedAt: run.completed_at,
      }));
    const suggestions = (this.database.prepare(`SELECT p.id,p.payload_json,p.review_status,p.created_at,p.decided_at,
      r.sequence FROM proposals p LEFT JOIN paper_organization_runs r
        ON r.job_run_id=json_extract(p.payload_json,'$.jobRunId')
      WHERE p.paper_id=? AND p.proposal_type='paper-organization'
        AND json_extract(p.payload_json,'$.sourceKind')='agent'
      ORDER BY COALESCE(r.sequence,0) DESC,p.created_at DESC,p.id`).all(paperId) as Array<{
        id: string;
        payload_json: string;
        review_status: string;
        created_at: string;
        decided_at: string | null;
        sequence: number | null;
      }>).map((proposal) => ({
        id: proposal.id,
        ...JSON.parse(proposal.payload_json) as Record<string, unknown>,
        reviewStatus: proposal.review_status,
        ...(verifyLive ? this.organizationProposalState(proposal.id)
          : this.organizationProposalLightState(proposal.id)),
        sequence: proposal.sequence,
        createdAt: proposal.created_at,
        decidedAt: proposal.decided_at,
      }));
    return { runs, suggestions };
  }

  organizationQueue(query: OrganizationQueueQuery): {
    items: unknown[];
    truncated: boolean;
    counts: { pendingPapers: number; attentionPapers: number; unclassifiedPapers: number };
  } {
    if (!["pending", "attention", "all"].includes(query.view) ||
        (query.section && !["alias", "primary", "secondary"].includes(query.section))) {
      throw new PaperOrganizationStoreError("paper-organization-queue-query-invalid");
    }
    if (query.direction) this.requireDirection(query.direction);
    const lifecycleRows = this.database.prepare(`SELECT r.paper_id,max(r.sequence) latest_sequence
      FROM paper_organization_runs r GROUP BY r.paper_id ORDER BY latest_sequence DESC,r.paper_id`).all() as
      Array<{ paper_id: string; latest_sequence: number }>;
    const basePapers = (this.database.prepare(`SELECT d.paper_id id,d.canonical_title title,d.authors_json,
      d.publication_year year,p.updated_at FROM paper_catalog_documents d JOIN papers p ON p.id=d.paper_id
      WHERE p.lifecycle_status='active'`).all() as Array<{
        id: string;
        title: string;
        authors_json: string;
        year: number;
        updated_at: string;
      }>).map((paper) => ({
        id: paper.id,
        title: paper.title,
        authors: JSON.parse(paper.authors_json) as string[],
        year: paper.year,
        updatedAt: paper.updated_at,
      }));
    const allCatalogPapers = new Map(this.decoratePapers(basePapers).map((paper) => [paper.id, paper]));
    const catalogMatches = new Map(this.decoratePapers(basePapers, {
      ...(query.q ? { q: query.q } : {}),
    }).map((paper) => [paper.id, paper]));
    const rows = lifecycleRows.flatMap((lifecycle) => {
      const paper = catalogMatches.get(lifecycle.paper_id);
      if (!paper) return [];
      const readModel = this.readOrganizationForPaper(lifecycle.paper_id, false) as {
        runs: Array<{ id: string; state: string; sequence: number; scope: string;
          outcomes: Record<string, unknown> | null; error: { code?: string } | null }>;
        suggestions: Array<{
          id: string;
          changeKind: OrganizationSectionKind;
          reviewStatus: string;
          applicability: "ready" | "blocked" | "stale";
          materialization: "not-started" | "applying" | "succeeded" | "failed" | "conflicted";
          sequence: number | null;
          after?: unknown;
          alternatives?: Array<{ topicId: string }>;
        }>;
      };
      const latestBySection = new Map<OrganizationSectionKind, typeof readModel.suggestions[number]>();
      for (const suggestion of readModel.suggestions) {
        if (!latestBySection.has(suggestion.changeKind)) latestBySection.set(suggestion.changeKind, suggestion);
      }
      const pending = readModel.suggestions.filter((suggestion) => suggestion.reviewStatus === "pending");
      const latestRun = readModel.runs[0] ?? null;
      const attention = Boolean(latestRun && ["failed", "timed_out", "interrupted"].includes(latestRun.state)) ||
        pending.some((suggestion) => suggestion.applicability !== "ready" ||
          ["failed", "conflicted"].includes(suggestion.materialization));
      const unclassified = !paper.directions.some((direction) => direction.role === "primary");
      const sectionKind = query.section === "alias" ? "alias"
        : query.section === "primary" ? "primary-direction"
          : query.section === "secondary" ? "secondary-direction" : null;
      if (sectionKind && !pending.some((suggestion) => suggestion.changeKind === sectionKind)) return [];
      if (query.unclassified && !unclassified) return [];
      if (query.direction) {
        const matchesConfirmed = paper.directions.some((direction) => direction.topicId === query.direction);
        const matchesProposal = readModel.suggestions.some((suggestion) => {
          const after = suggestion.after;
          const afterIds = Array.isArray(after)
            ? after.map((value) => (value as { topicId?: string }).topicId)
            : [(after as { topicId?: string } | null)?.topicId];
          return afterIds.includes(query.direction) ||
            suggestion.alternatives?.some((alternative) => alternative.topicId === query.direction);
        });
        if (!matchesConfirmed && !matchesProposal) return [];
      }
      return [{
        paper,
        latestRun,
        sections: {
          alias: latestBySection.get("alias") ?? null,
          primary: latestBySection.get("primary-direction") ?? null,
          secondary: latestBySection.get("secondary-direction") ?? null,
        },
        pendingSectionCount: pending.length,
        attention,
        unclassified,
        latestSequence: lifecycle.latest_sequence,
      }];
    });
    const allRows = lifecycleRows.map((lifecycle) => {
      const paper = allCatalogPapers.get(lifecycle.paper_id);
      if (!paper) return null;
      const readModel = this.readOrganizationForPaper(lifecycle.paper_id, false) as {
        runs: Array<{ state: string }>;
        suggestions: Array<{ reviewStatus: string; applicability: string; materialization: string }>;
      };
      const pending = readModel.suggestions.filter((suggestion) => suggestion.reviewStatus === "pending");
      return {
        pending: pending.length > 0,
        attention: ["failed", "timed_out", "interrupted"].includes(readModel.runs[0]?.state ?? "") ||
          pending.some((suggestion) => suggestion.applicability !== "ready" ||
            ["failed", "conflicted"].includes(suggestion.materialization)),
        unclassified: !paper.directions.some((direction) => direction.role === "primary"),
      };
    }).filter((row): row is NonNullable<typeof row> => Boolean(row));
    const filtered = rows.filter((row) => query.view === "all" ||
      (query.view === "pending" ? row.pendingSectionCount > 0 : row.attention));
    filtered.sort((left, right) => Number(right.attention) - Number(left.attention) ||
      right.latestSequence - left.latestSequence || left.paper.id.localeCompare(right.paper.id));
    return {
      items: filtered.slice(0, 500),
      truncated: filtered.length > 500,
      counts: {
        pendingPapers: allRows.filter((row) => row.pending).length,
        attentionPapers: allRows.filter((row) => row.attention).length,
        unclassifiedPapers: allRows.filter((row) => row.unclassified).length,
      },
    };
  }

  organizationStatuses(input: { jobRunIds: string[]; proposalIds: string[] }): {
    jobs: Array<{ id: string; state: string }>;
    proposals: Array<{ id: string; reviewStatus: string; materialization: string }>;
  } {
    if (input.jobRunIds.length > 50 || input.proposalIds.length > 50 ||
        [...input.jobRunIds, ...input.proposalIds].some((id) => typeof id !== "string" || !id)) {
      throw new PaperOrganizationStoreError("paper-organization-status-query-invalid");
    }
    const jobs = input.jobRunIds.flatMap((id) => {
      const row = this.database.prepare(`SELECT id,state FROM job_runs
        WHERE id=? AND job_type='paper-organization'`).get(id) as { id: string; state: string } | undefined;
      return row ? [row] : [];
    });
    const proposals = input.proposalIds.flatMap((id) => {
      const row = this.database.prepare(`SELECT id,review_status FROM proposals
        WHERE id=? AND proposal_type='paper-organization'`).get(id) as {
          id: string;
          review_status: string;
        } | undefined;
      if (!row) return [];
      return [{
        id: row.id,
        reviewStatus: row.review_status,
        materialization: this.organizationProposalLightState(row.id).materialization,
      }];
    });
    return { jobs, proposals };
  }

  decoratePapers<T extends BasePaper>(papers: T[], filters: {
    q?: string;
    view?: "all" | "unclassified";
    direction?: string;
    domain?: string;
    relation?: "all" | "primary";
    pending?: boolean;
  } = {}): CatalogPaper<T>[] {
    const canonicalTitles = this.database.prepare(`SELECT paper_id,canonical_title FROM paper_catalog_documents`)
      .all() as Array<{ paper_id: string; canonical_title: string }>;
    const decorated = papers.map((paper) => {
      const catalogDocument = this.database.prepare(`SELECT external_identities_json FROM paper_catalog_documents
        WHERE paper_id=?`).get(paper.id) as { external_identities_json: string } | undefined;
      const externalIdentities = catalogDocument
        ? JSON.parse(catalogDocument.external_identities_json) as string[]
        : [];
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
      const aliasCollision = aliases.some((alias) => {
        const normalized = normalizePaperLookup(alias.name);
        const aliasMatches = (this.database.prepare(`SELECT count(DISTINCT paper_id) count
          FROM paper_aliases WHERE normalized_name=?`).get(normalized) as { count: number }).count > 1;
        return aliasMatches || canonicalTitles.some((candidate) =>
          candidate.paper_id !== paper.id && normalizePaperLookup(candidate.canonical_title) === normalized);
      }) || (this.database.prepare(`SELECT count(DISTINCT paper_id) count FROM paper_aliases
        WHERE normalized_name=? AND paper_id<>?`).get(normalizePaperLookup(paper.title), paper.id) as { count: number }).count > 0;
      return {
        ...paper,
        aliases,
        preferredAlias: aliases.find((alias) => alias.preferred)?.name ?? null,
        directions,
        externalIdentities,
        pendingOrganizationCount,
        aliasCollision,
      } satisfies CatalogPaper<T>;
    });

    let result = decorated;
    if (filters.view === "unclassified") {
      result = result.filter((paper) => !paper.directions.some((direction) => direction.role === "primary"));
    }
    if (filters.pending) result = result.filter((paper) => paper.pendingOrganizationCount > 0);
    if (filters.domain && filters.direction) throw new PaperOrganizationStoreError("paper-domain-filter-invalid", 409);
    if (filters.domain) {
      if (!this.metadataFlag("hierarchy-enabled")) {
        throw new PaperOrganizationStoreError("paper-domain-filter-invalid", 409);
      }
      let childIds: Set<string>;
      if (filters.domain === "ungrouped") {
        childIds = new Set(this.database.prepare(`SELECT topic_id FROM topic_navigation
          WHERE navigation_role='direction' AND parent_domain_id IS NULL ORDER BY topic_id`).pluck().all() as string[]);
      } else {
        const valid = this.database.prepare(`SELECT 1 FROM direction_catalog d JOIN topic_navigation n ON n.topic_id=d.topic_id
          WHERE d.topic_id=? AND d.lifecycle_status='active' AND d.review_status='confirmed' AND n.navigation_role='domain'`)
          .get(filters.domain);
        if (!valid) throw new PaperOrganizationStoreError("paper-domain-filter-invalid", 409);
        childIds = new Set(this.database.prepare(`SELECT topic_id FROM topic_navigation
          WHERE navigation_role='direction' AND parent_domain_id=? ORDER BY topic_id`).pluck().all(filters.domain) as string[]);
      }
      result = result.filter((paper) => paper.directions.some((direction) => childIds.has(direction.topicId) &&
        (filters.relation !== "primary" || direction.role === "primary")));
    }
    if (filters.direction) {
      const resolvedDirection = this.resolveDirection(filters.direction).canonicalId;
      result = result.filter((paper) => paper.directions.some((direction) =>
        direction.topicId === resolvedDirection && (filters.relation !== "primary" || direction.role === "primary")));
    }
    const query = filters.q?.trim();
    if (!query) return result;
    const normalized = normalizePaperLookup(query);
    const ftsIds = this.ftsPaperIds(query);
    const matched: CatalogPaper<T>[] = [];
    for (const paper of result) {
      const external = paper.externalIdentities.find((identity) => normalizePaperLookup(identity) === normalized);
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

  rebuildCatalog(trustedWrite?: { targetPath: string; resultHash: string }): {
    count: number;
    rebuiltAt: string;
    blocked?: boolean;
  } {
    const rebuiltAt = this.now().toISOString();
    const allTopicPaths = this.readMarkdownFiles(join(this.layout.vaultRoot, "knowledge", "topics"));
    const topicsReadmePath = join(this.layout.vaultRoot, "knowledge", "topics", "README.md");
    const ignoredTopicPaths = allTopicPaths.filter((path) => path === topicsReadmePath);
    const topicPaths = allTopicPaths.filter((path) => path !== topicsReadmePath);
    if (ignoredTopicPaths.length > 0) {
      const supersede = this.database.prepare(`UPDATE proposals
        SET review_status='superseded',decided_at=?
        WHERE proposal_type='reconciliation' AND review_status IN ('pending','archived')
          AND json_extract(payload_json,'$.targetPath')=?`);
      this.database.transaction(() => {
        for (const path of ignoredTopicPaths) {
          supersede.run(rebuiltAt, relative(this.layout.vaultRoot, path));
        }
      })();
    }
    const paperPaths = this.readMarkdownFiles(join(this.layout.vaultRoot, "library", "papers"))
      .filter((path) => path.endsWith(`${join("", "paper.md")}`));
    const knownHashes = new Map<string, { hash: string; targetId: string; targetKind: "paper" | "topic" }>([
      ...(this.database.prepare("SELECT markdown_path,markdown_hash,paper_id FROM paper_manifests").all() as
        Array<{ markdown_path: string; markdown_hash: string; paper_id: string }>).map((row) =>
        [row.markdown_path, { hash: row.markdown_hash, targetId: row.paper_id, targetKind: "paper" as const }] as const),
      ...(this.database.prepare("SELECT markdown_path,markdown_hash,topic_id FROM direction_catalog").all() as
        Array<{ markdown_path: string; markdown_hash: string; topic_id: string }>).map((row) =>
        [row.markdown_path, { hash: row.markdown_hash, targetId: row.topic_id, targetKind: "topic" as const }] as const),
    ]);
    const scanned = [
      ...topicPaths.map((path) => ({
        relativePath: relative(this.layout.vaultRoot, path),
        hash: hashFile(path),
        targetKind: "topic" as const,
      })),
      ...paperPaths.map((path) => ({
        relativePath: relative(this.layout.vaultRoot, path),
        hash: hashFile(path),
        targetKind: "paper" as const,
      })),
    ];
    const acceptedReconciliations = new Set((this.database.prepare(`SELECT payload_json FROM proposals
      WHERE proposal_type='reconciliation' AND review_status='accepted'`).all() as
      Array<{ payload_json: string }>).map((row) => {
        const payload = JSON.parse(row.payload_json) as { targetPath?: string; actualHash?: string | null };
        return payload.targetPath ? reconciliationKey(payload.targetPath, payload.actualHash ?? null) : "";
      }).filter(Boolean));
    const initialized = Boolean((this.database.prepare(`SELECT last_successful_at FROM projection_state
      WHERE projection='paper-catalog'`).pluck().get() as string | null | undefined));
    const scannedPaths = new Set(scanned.map((item) => item.relativePath));
    const conflicts: Array<{
      targetId: string | null;
      targetKind: "paper" | "topic";
      relativePath: string;
      expectedHash: string | null;
      actualHash: string | null;
    }> = scanned.flatMap((item) => {
      const known = knownHashes.get(item.relativePath);
      const trusted = trustedWrite?.targetPath === item.relativePath && trustedWrite.resultHash === item.hash;
      const accepted = acceptedReconciliations.has(reconciliationKey(item.relativePath, item.hash));
      if (trusted || accepted || known?.hash === item.hash || (!known && !initialized)) return [];
      return [{
        targetId: known?.targetId ?? null,
        targetKind: item.targetKind,
        relativePath: item.relativePath,
        expectedHash: known?.hash ?? null,
        actualHash: item.hash,
      }];
    });
    if (initialized) {
      for (const [relativePath, known] of knownHashes) {
        if (!scannedPaths.has(relativePath) &&
            !acceptedReconciliations.has(reconciliationKey(relativePath, null))) {
          conflicts.push({
            targetId: known.targetId,
            targetKind: known.targetKind,
            relativePath,
            expectedHash: known.hash,
            actualHash: null,
          });
        }
      }
    }
    if (conflicts.length > 0) {
      this.database.transaction(() => {
        for (const conflict of conflicts) {
          const proposalId = `proposal:reconciliation:catalog:${hashKey(
            `${conflict.relativePath}:${conflict.actualHash ?? "deleted"}`,
          )}`;
          this.database.prepare(`INSERT OR IGNORE INTO proposals
            (id,proposal_type,paper_id,payload_json,review_status,one_click_eligible,created_at)
            VALUES (?,'reconciliation',?,?,'pending',0,?)`).run(proposalId,
              conflict.targetKind === "paper" ? conflict.targetId : null,
              JSON.stringify({
                targetKind: conflict.targetKind,
                targetId: conflict.targetId,
                targetPath: conflict.relativePath,
                expectedHash: conflict.expectedHash,
                actualHash: conflict.actualHash,
                source: "external-markdown-rebuild",
              }), rebuiltAt);
        }
      })();
      const blocking = conflicts.some((conflict) => conflict.targetKind === "paper" ||
        conflict.actualHash === null || conflict.expectedHash === null);
      if (blocking) {
        const count = (this.database.prepare("SELECT count(*) count FROM paper_catalog_documents").get() as
          { count: number }).count;
        return { count, rebuiltAt, blocked: true };
      }
    }
    let invalid: {
      targetId: string | null;
      targetKind: "paper" | "topic";
      relativePath: string;
      actualHash: string;
      errorCode: string;
    } | null = null;
    const topics = topicPaths.flatMap((path) => {
      try { return [this.readTopic(path)]; }
      catch (error) {
        const relativePath = relative(this.layout.vaultRoot, path);
        invalid = {
          targetId: knownHashes.get(relativePath)?.targetId ?? null,
          targetKind: "topic",
          relativePath,
          actualHash: hashFile(path),
          errorCode: error instanceof Error ? error.message : "direction-markdown-invalid",
        };
        return [];
      }
    });
    const papers = invalid ? [] : paperPaths.flatMap((path) => {
      try { return [this.readPaper(path)]; }
      catch (error) {
        const relativePath = relative(this.layout.vaultRoot, path);
        invalid = {
          targetId: knownHashes.get(relativePath)?.targetId ?? null,
          targetKind: "paper",
          relativePath,
          actualHash: hashFile(path),
          errorCode: error instanceof Error ? error.message : "paper-markdown-invalid",
        };
        return [];
      }
    });
    if (invalid) {
      const detail = invalid as {
        targetId: string | null;
        targetKind: "paper" | "topic";
        relativePath: string;
        actualHash: string;
        errorCode: string;
      };
      const proposalId = `proposal:reconciliation:invalid:${hashKey(`${detail.relativePath}:${detail.actualHash}`)}`;
      this.database.prepare(`INSERT OR IGNORE INTO proposals
        (id,proposal_type,paper_id,payload_json,review_status,one_click_eligible,created_at)
        VALUES (?,'reconciliation',?,?,'pending',0,?)`).run(proposalId,
          detail.targetKind === "paper" ? detail.targetId : null,
          JSON.stringify({
            targetKind: detail.targetKind,
            targetId: detail.targetId,
            targetPath: detail.relativePath,
            expectedHash: knownHashes.get(detail.relativePath)?.hash ?? null,
            actualHash: detail.actualHash,
            source: "invalid-markdown-rebuild",
            validationError: detail.errorCode,
          }), rebuiltAt);
      const count = (this.database.prepare("SELECT count(*) count FROM paper_catalog_documents").get() as
        { count: number }).count;
      return { count, rebuiltAt, blocked: true };
    }
    const topicIds = new Set(topics.map((topic) => topic.id));
    const topicsById = new Map(topics.map((topic) => [topic.id, topic]));
    for (const topic of topics) {
      if (topic.navigationRole === "domain" && topic.parentDomainId !== null) {
        return this.blockCatalogRebuild({ targetKind: "topic", targetId: topic.id,
          relativePath: topic.relativePath, actualHash: topic.hash,
          expectedHash: knownHashes.get(topic.relativePath)?.hash ?? null,
          errorCode: "topic-navigation-parent-invalid", rebuiltAt });
      }
      if (topic.navigationRole === "direction" && topic.lifecycleStatus === "active" &&
          topic.reviewStatus === "confirmed" && topic.parentDomainId) {
        const parent = topicsById.get(topic.parentDomainId);
        if (!parent || parent.navigationRole !== "domain" || parent.lifecycleStatus !== "active" ||
            parent.reviewStatus !== "confirmed" || parent.id === topic.id) {
          return this.blockCatalogRebuild({ targetKind: "topic", targetId: topic.id,
            relativePath: topic.relativePath, actualHash: topic.hash,
            expectedHash: knownHashes.get(topic.relativePath)?.hash ?? null,
            errorCode: "topic-navigation-parent-invalid", rebuiltAt });
        }
      }
    }
    for (const paper of papers) {
      const domainAssignment = paper.organization.directions.find((assignment) =>
        topicsById.get(assignment.topicId)?.navigationRole === "domain");
      if (domainAssignment) return this.blockCatalogRebuild({ targetKind: "paper", targetId: paper.id,
        relativePath: paper.relativePath, actualHash: paper.hash,
        expectedHash: knownHashes.get(paper.relativePath)?.hash ?? null,
        errorCode: "paper-direction-role-invalid", rebuiltAt });
    }
    const redirects = new Map<string, {
      source: string; directTarget: string; canonicalTarget: string; lineage: string[]; sourceHash: string;
    }>();
    const resolveTopic = (topicId: string): string => {
      const visited = new Set<string>();
      const lineage: string[] = [];
      let current = topicId;
      while (true) {
        if (visited.size >= 32) throw new PaperOrganizationStoreError("direction-redirect-depth-exceeded", 409);
        if (visited.has(current)) throw new PaperOrganizationStoreError("direction-redirect-loop", 409);
        visited.add(current);
        lineage.push(current);
        const topic = topicsById.get(current);
        if (!topic) throw new PaperOrganizationStoreError("paper-direction-not-usable", 409);
        if (!topic.supersededBy) {
          if (topic.lifecycleStatus !== "active" || topic.reviewStatus !== "confirmed") {
            throw new PaperOrganizationStoreError("paper-direction-not-usable", 409);
          }
          if (lineage.length > 1) {
            const source = topicsById.get(topicId)!;
            redirects.set(topicId, {
              source: topicId,
              directTarget: source.supersededBy!,
              canonicalTarget: current,
              lineage,
              sourceHash: source.hash,
            });
          }
          if (topic.navigationRole !== "direction") {
            throw new PaperOrganizationStoreError("paper-direction-role-invalid", 409);
          }
          return current;
        }
        current = topic.supersededBy;
      }
    };
    for (const topic of topics.filter((candidate) => candidate.supersededBy)) resolveTopic(topic.id);
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
        DELETE FROM topic_navigation;
        DELETE FROM direction_catalog;
        DELETE FROM topic_redirects;`);
      for (const topic of topics) {
        this.database.prepare(`INSERT INTO direction_catalog
          (topic_id,title,aliases_json,scope,usage_level,lifecycle_status,superseded_by,revision_id,
           revision_number,review_status,markdown_path,markdown_hash,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(topic.id, topic.title, JSON.stringify(topic.aliases),
            topic.scope, topic.usageLevel, topic.lifecycleStatus, topic.supersededBy, topic.revisionId,
            topic.revisionNumber, topic.reviewStatus, topic.relativePath, topic.hash, topic.createdAt, topic.updatedAt);
      }
      for (const topic of topics) {
        this.database.prepare(`INSERT INTO topic_navigation(topic_id,navigation_role,parent_domain_id,projected_at)
          VALUES (?,?,?,?)`).run(topic.id, topic.navigationRole, topic.parentDomainId, rebuiltAt);
      }
      for (const redirect of redirects.values()) {
        this.database.prepare(`INSERT INTO topic_redirects
          (source_topic_id,direct_target_topic_id,canonical_target_topic_id,depth,lineage_json,
           source_markdown_hash,rebuilt_at) VALUES (?,?,?,?,?,?,?)`)
          .run(redirect.source, redirect.directTarget, redirect.canonicalTarget,
            redirect.lineage.length - 1, JSON.stringify(redirect.lineage), redirect.sourceHash, rebuiltAt);
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
        const hierarchyEnabled = this.metadataFlag("hierarchy-enabled");
        const parentDomains = hierarchyEnabled ? [...new Map(assignedTopics.flatMap((topic) => {
          const parent = topic.parentDomainId ? topicsById.get(topic.parentDomainId) : null;
          return parent ? [[parent.id, parent] as const] : [];
        })).values()] : [];
        const searchText = [paper.title, ...paper.organization.aliases.map((alias) => alias.name),
          ...paper.authors, ...paper.externalIdentities, ...assignedTopics.flatMap((topic) =>
            [topic.title, ...topic.aliases, topic.scope]),
          ...parentDomains.flatMap((domain) => [domain.title, ...domain.aliases])].join("\n");
        this.database.prepare(`INSERT INTO paper_catalog_documents
          (paper_id,canonical_title,preferred_alias,authors_json,external_identities_json,publication_year,search_text,updated_at)
          VALUES (?,?,?,?,?,?,?,?)`).run(paper.id, paper.title,
            paper.organization.aliases.find((alias) => alias.preferred)?.name ?? null,
            JSON.stringify(paper.authors), JSON.stringify(paper.externalIdentities), paper.year, searchText, paper.updatedAt);
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
    const row = this.database.prepare(`SELECT d.result_json FROM review_decisions d
      WHERE (d.idempotency_key=? OR d.idempotency_key LIKE ?)
        AND EXISTS (
          SELECT 1 FROM knowledge_write_requests w
          WHERE json_extract(w.payload_json,'$.idempotencyKey')=? AND w.phase='complete'
        )
      LIMIT 1`).get(idempotencyKey, `${idempotencyKey}:%`, idempotencyKey) as
      { result_json: string } | undefined;
    return row ? JSON.parse(row.result_json) as unknown : null;
  }

  private hasRetryableWrite(idempotencyKey: string): boolean {
    return Boolean(this.database.prepare(`SELECT 1 FROM knowledge_write_requests
      WHERE request_type IN ('paper-organization','direction-taxonomy')
        AND phase IN ('failed','conflicted')
        AND json_extract(payload_json,'$.idempotencyKey')=?
      LIMIT 1`).get(idempotencyKey));
  }

  private hasUnfinishedWrite(idempotencyKey: string): boolean {
    return Boolean(this.database.prepare(`SELECT 1 FROM knowledge_write_requests
      WHERE request_type IN ('paper-organization','direction-taxonomy')
        AND phase NOT IN ('complete','failed','conflicted')
        AND json_extract(payload_json,'$.idempotencyKey')=?
      LIMIT 1`).get(idempotencyKey));
  }

  private writePayload(idempotencyKey: string): { response?: unknown } | null {
    const row = this.database.prepare(`SELECT payload_json FROM knowledge_write_requests
      WHERE request_type IN ('paper-organization','direction-taxonomy')
        AND json_extract(payload_json,'$.idempotencyKey')=?
      LIMIT 1`).get(idempotencyKey) as { payload_json: string } | undefined;
    return row ? JSON.parse(row.payload_json) as { response?: unknown } : null;
  }

  validateReconciliationTarget(input: {
    targetKind: "paper" | "topic";
    targetPath: string;
    actualHash: string | null;
  }): void {
    const candidates = input.targetKind === "topic"
      ? this.readMarkdownFiles(join(this.layout.vaultRoot, "knowledge", "topics"))
      : this.readMarkdownFiles(join(this.layout.vaultRoot, "library", "papers"))
        .filter((path) => path.endsWith(`${join("", "paper.md")}`));
    const path = candidates.find((candidate) => relative(this.layout.vaultRoot, candidate) === input.targetPath);
    if (input.actualHash === null) {
      if (path) throw new PaperOrganizationStoreError("reconciliation-target-changed", 409);
      return;
    }
    if (!path || hashFile(path) !== input.actualHash) {
      throw new PaperOrganizationStoreError("reconciliation-target-changed", 409);
    }
    if (input.targetKind === "topic") this.readTopic(path);
    else {
      const paper = this.readPaper(path);
      if (!this.database.prepare("SELECT 1 FROM papers WHERE id=?").get(paper.id)) {
        throw new PaperOrganizationStoreError("reconciliation-paper-identity-missing", 409);
      }
    }
  }

  private projectedOrganization(paperId: string): PaperOrganizationInput {
    const aliases = (this.database.prepare(`SELECT name,alias_kind,preferred FROM paper_aliases
      WHERE paper_id=? ORDER BY ordinal`).all(paperId) as Array<{
        name: string;
        alias_kind: PaperAlias["kind"];
        preferred: number;
      }>).map((alias) => ({ name: alias.name, kind: alias.alias_kind, preferred: alias.preferred === 1 }));
    const directions = (this.database.prepare(`SELECT topic_id,assignment_role FROM paper_direction_assignments
      WHERE paper_id=? ORDER BY ordinal`).all(paperId) as Array<{
        topic_id: string;
        assignment_role: "primary" | "secondary";
      }>).map((direction) => ({ topicId: direction.topic_id, role: direction.assignment_role }));
    return { aliases, directions };
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
    const usable = this.database.prepare(`SELECT 1 FROM direction_catalog d JOIN topic_navigation n ON n.topic_id=d.topic_id
      WHERE d.topic_id=? AND d.lifecycle_status='active' AND d.review_status='confirmed'
        AND n.navigation_role='direction'`).get(topicId);
    if (!usable) throw new PaperOrganizationStoreError("paper-direction-not-usable", 409);
  }

  private directionSemanticHash(topicId: string): string | null {
    const direction = this.database.prepare(`SELECT scope,usage_level,lifecycle_status,superseded_by,review_status
      FROM direction_catalog WHERE topic_id=?`).get(topicId) as {
        scope: string;
        usage_level: string;
        lifecycle_status: string;
        superseded_by: string | null;
        review_status: string;
      } | undefined;
    if (!direction) return null;
    return sha256(JSON.stringify({
      scope: direction.scope,
      usageLevel: direction.usage_level,
      lifecycleStatus: direction.lifecycle_status,
      supersededBy: direction.superseded_by,
      reviewStatus: direction.review_status,
    }));
  }

  private directionMergeSemanticHash(topicId: string): string | null {
    const semanticHash = this.directionSemanticHash(topicId);
    if (!semanticHash) return null;
    return sha256(JSON.stringify({
      semanticHash,
      navigationRole: this.navigationRole(topicId),
      parentDomainId: this.parentDomainId(topicId),
    }));
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

  private blockCatalogRebuild(input: { targetKind: "paper" | "topic"; targetId: string;
    relativePath: string; expectedHash: string | null; actualHash: string; errorCode: string; rebuiltAt: string }) {
    const proposalId = `proposal:reconciliation:hierarchy:${hashKey(
      `${input.relativePath}:${input.actualHash}:${input.errorCode}`)}`;
    this.database.prepare(`INSERT OR IGNORE INTO proposals
      (id,proposal_type,paper_id,payload_json,review_status,one_click_eligible,created_at)
      VALUES (?,'reconciliation',?,?,'pending',0,?)`).run(proposalId,
        input.targetKind === "paper" ? input.targetId : null,
        JSON.stringify({ targetKind: input.targetKind, targetId: input.targetId,
          targetPath: input.relativePath, expectedHash: input.expectedHash,
          actualHash: input.actualHash, source: "hierarchy-validation",
          validationError: input.errorCode }), input.rebuiltAt);
    const count = Number(this.database.prepare("SELECT count(*) FROM paper_catalog_documents").pluck().get() ?? 0);
    return { count, rebuiltAt: input.rebuiltAt, blocked: true as const };
  }

  private metadataFlag(key: string): boolean {
    return this.database.prepare("SELECT metadata_value FROM paper_catalog_metadata WHERE metadata_key=?")
      .pluck().get(key) === "true";
  }

  private navigationRole(topicId: string): "domain" | "direction" | null {
    const role = this.database.prepare("SELECT navigation_role FROM topic_navigation WHERE topic_id=?")
      .pluck().get(topicId);
    return role === "domain" || role === "direction" ? role : null;
  }

  private parentDomainId(topicId: string): string | null {
    return (this.database.prepare("SELECT parent_domain_id FROM topic_navigation WHERE topic_id=?")
      .pluck().get(topicId) as string | null | undefined) ?? null;
  }

  private readMarkdownFiles(root: string): string[] {
    if (!existsSync(root)) return [];
    const files: string[] = [];
    const visit = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name === ".revisions") continue;
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
    navigationRole: "domain" | "direction";
    parentDomainId: string | null;
  } {
    const markdown = readFileSync(path, "utf8");
    const parsed = parseFrontmatter(markdown);
    const data = parsed.data;
    const id = String(data.id ?? "");
    const title = String(data.title ?? "").trim();
    const aliases = Array.isArray(data.aliases) ? data.aliases.filter((alias): alias is string => typeof alias === "string") : [];
    const topicKnowledge = parseTopicKnowledgeMarkdown(markdown);
    const navigationRole = data.navigation_role === undefined || data.navigation_role === "direction"
      ? "direction" : data.navigation_role === "domain" ? "domain" : null;
    if (!navigationRole) throw new PaperOrganizationStoreError("topic-navigation-role-invalid", 409);
    const parentDomainId = data.parent_domain_id === undefined || data.parent_domain_id === null
      ? null : typeof data.parent_domain_id === "string" && data.parent_domain_id.startsWith("topic:")
        ? data.parent_domain_id : undefined;
    if (parentDomainId === undefined || (navigationRole === "domain" && parentDomainId !== null)) {
      throw new PaperOrganizationStoreError("topic-navigation-parent-invalid", 409);
    }
    if (navigationRole === "domain" &&
        (data.usage_level === "knowledge-ready" || data.knowledge_attested === true)) {
      throw new PaperOrganizationStoreError("domain-knowledge-invalid", 409);
    }
    const usageLevel = data.usage_level === "knowledge-ready" && knowledgeReadyContentErrors(topicKnowledge).length === 0
      ? "knowledge-ready" : "classification";
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
      navigationRole,
      parentDomainId,
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
  navigationRole?: "direction" | "domain";
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
knowledge_attested: false
navigation_role: ${input.navigationRole ?? "direction"}
parent_domain_id: null
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

function replaceMarkdownSection(body: string, heading: string, content: string): string {
  const pattern = new RegExp(
    `((?:^|\\n)## ${escapeRegex(heading)}\\r?\\n\\r?\\n)[\\s\\S]*?(?=\\r?\\n## |$)`,
  );
  if (!pattern.test(body)) throw new PaperOrganizationStoreError("direction-markdown-invalid", 409);
  return body.replace(pattern, `$1${content.trim()}\n`);
}

function setMarkdownSection(body: string, heading: string, content: string): string {
  return new RegExp(`(?:^|\\n)## ${escapeRegex(heading)}\\r?\\n`).test(body)
    ? replaceMarkdownSection(body, heading, content)
    : `${body.trimEnd()}\n\n## ${heading}\n\n${content.trim()}\n`;
}

function mergeOrganization(
  organization: PaperOrganizationInput,
  sourceTopicId: string,
  targetTopicId: string,
): PaperOrganizationInput {
  const source = organization.directions.find((direction) => direction.topicId === sourceTopicId);
  if (!source) return organization;
  const target = organization.directions.find((direction) => direction.topicId === targetTopicId);
  const result = organization.directions.filter((direction) =>
    direction.topicId !== sourceTopicId && direction.topicId !== targetTopicId);
  const role = source.role === "primary" || target?.role === "primary" ? "primary" : "secondary";
  const insertAt = Math.min(
    organization.directions.findIndex((direction) => direction.topicId === sourceTopicId),
    target ? organization.directions.findIndex((direction) => direction.topicId === targetTopicId)
      : organization.directions.length,
  );
  result.splice(Math.max(0, insertAt), 0, { topicId: targetTopicId, role });
  return validatePaperOrganization({
    aliases: organization.aliases,
    directions: [
      ...result.filter((direction) => direction.role === "primary"),
      ...result.filter((direction) => direction.role === "secondary"),
    ],
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashFile(path: string): string {
  return sha256(readFileSync(path, "utf8"));
}

function hashKey(value: string): string {
  return sha256(value).slice(0, 24);
}

function reconciliationKey(targetPath: string, actualHash: string | null): string {
  return `${targetPath}\u0000${actualHash ?? "<deleted>"}`;
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
