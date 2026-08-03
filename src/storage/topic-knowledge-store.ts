import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import type Database from "better-sqlite3";

import {
  TOPIC_KNOWLEDGE_HEADINGS,
  knowledgeReadyContentErrors,
  parseTopicKnowledgeMarkdown,
  setTopicSection,
  type TopicKnowledgeHeading,
  type TopicProvenance,
} from "../domain/topic-knowledge.js";
import { normalizePaperLookup } from "../domain/paper-organization.js";
import type { StorageLayout } from "./layout.js";
import { PaperOrganizationStoreError } from "./paper-organization-store.js";

type TopicKnowledgeInput = {
  title: string;
  aliases: string[];
  scope: string;
  usageLevel: "classification" | "knowledge-ready";
  sections: Partial<Record<TopicKnowledgeHeading, string>>;
  provenance: TopicProvenance[];
  ownerAttested: boolean;
  expectedRevisionId: string;
  expectedMarkdownHash: string;
};

type TopicKnowledgePayload = {
  topicId: string;
  title: string;
  aliases: string[];
  scope: string;
  parentDomainId: string | null;
  parentTargetRevisionId: string | null;
  parentTargetMarkdownHash: string | null;
  revisionId: string;
  revisionNumber: number;
  parentRevisionId: string;
  targetPath: string;
  historyPath: string;
  historyStagedPath: string;
  historyHash: string;
  knowledgeBody: string;
  knowledgeBodyHash: string;
  usageLevel: "classification" | "knowledge-ready";
  provenance: TopicProvenance[];
  paperScope: Array<{ paperId: string; sourceCount: number }>;
  ownerAttested: boolean;
  proposalId: string;
  decisionId: string;
  idempotencyKey: string;
  response: unknown;
  now: string;
};

export class TopicKnowledgeStore {
  constructor(
    private readonly database: Database.Database,
    private readonly layout: StorageLayout,
    private readonly now: () => Date,
    private readonly rebuildPaperCatalog: (trusted?: { targetPath: string; resultHash: string }) => unknown,
  ) {}

  recover(): void {
    const ids = this.database.prepare(`SELECT id FROM knowledge_write_requests
      WHERE request_type='topic-knowledge-revision'
        AND phase NOT IN ('complete','failed','conflicted') ORDER BY created_at,id`)
      .pluck().all() as string[];
    ids.forEach((id) => this.advance(id));
    this.syncObservedDirections();
  }

  syncObservedDirections(): void {
    const rows = this.database.prepare(`SELECT topic_id,revision_id,revision_number,review_status,
      markdown_path,markdown_hash,created_at,updated_at FROM direction_catalog ORDER BY topic_id`).all() as Array<{
        topic_id: string; revision_id: string; revision_number: number; review_status: string;
        markdown_path: string; markdown_hash: string; created_at: string; updated_at: string;
      }>;
    const insert = this.database.prepare(`INSERT OR IGNORE INTO topic_knowledge_revisions(
      id,topic_id,revision_number,usage_level,review_status,epistemic_status,markdown_path,
      markdown_hash,history_path,knowledge_body_hash,provenance_json,owner_attested,
      eligibility_status,active,confirmed_at,created_at
    ) VALUES (?, ?, ?, 'classification', ?, 'evidence-backed', ?, ?, NULL, '', '[]', 0,
      'classification',1,?,?)`);
    this.database.transaction(() => {
      for (const row of rows) {
        const existing = this.database.prepare("SELECT markdown_hash FROM topic_knowledge_revisions WHERE id=?")
          .get(row.revision_id) as { markdown_hash: string } | undefined;
        if (existing && existing.markdown_hash !== row.markdown_hash) {
          this.flagReconciliation(row.topic_id, row.markdown_path, existing.markdown_hash, row.markdown_hash,
            "topic-knowledge-external-drift");
          this.database.prepare(`UPDATE topic_knowledge_revisions SET eligibility_status='external-drift'
            WHERE id=?`).run(row.revision_id);
          this.removeCurated(row.topic_id, row.revision_id);
          continue;
        }
        if (!existing) {
          this.database.prepare("UPDATE topic_knowledge_revisions SET active=0 WHERE topic_id=?")
            .run(row.topic_id);
          insert.run(row.revision_id, row.topic_id, row.revision_number, row.review_status,
            row.markdown_path, row.markdown_hash,
            row.review_status === "confirmed" ? row.updated_at : null, row.created_at);
          this.database.prepare(`DELETE FROM curated_search_documents
            WHERE source_type='topic-knowledge' AND source_id=?`).run(row.topic_id);
        }
      }
    })();
  }

  get(topicId: string) {
    this.syncObservedDirections();
    const row = this.directionRow(topicId);
    const markdown = this.readCurrent(row.markdown_path);
    const parsed = parseTopicKnowledgeMarkdown(markdown);
    const revision = this.database.prepare(`SELECT usage_level,eligibility_status,owner_attested,
      provenance_json,knowledge_body_hash FROM topic_knowledge_revisions WHERE id=?`).get(row.revision_id) as {
        usage_level: "classification" | "knowledge-ready"; eligibility_status: string;
        owner_attested: number; provenance_json: string; knowledge_body_hash: string;
      } | undefined;
    const currentProvenance = revision ? JSON.parse(revision.provenance_json) as TopicProvenance[] : [];
    const valid = this.resolveProvenance(currentProvenance);
    return {
      topicId,
      title: row.title,
      aliases: JSON.parse(row.aliases_json) as string[],
      scope: row.scope,
      parentDomainId: row.parent_domain_id,
      revisionId: row.revision_id,
      markdownHash: row.markdown_hash,
      usageLevel: revision?.usage_level ?? "classification",
      eligibilityStatus: revision?.eligibility_status ?? "classification",
      indexed: Boolean(this.database.prepare(`SELECT 1 FROM curated_search_documents
        WHERE source_type='topic-knowledge' AND source_id=?`).get(topicId)),
      sections: Object.fromEntries(TOPIC_KNOWLEDGE_HEADINGS.map((heading) => [heading, parsed.sections[heading]])),
      provenance: currentProvenance,
      provenanceValid: currentProvenance.length > 0 && valid.invalid.length === 0,
      ownerAttested: revision?.owner_attested === 1,
      drifted: sha256(markdown) !== row.markdown_hash || revision?.eligibility_status === "external-drift",
      substantiveSections: parsed.substantiveSections,
    };
  }

  provenanceOptions(topicId: string) {
    this.directionRow(topicId);
    const summaries = this.database.prepare(`SELECT s.id source_id,'summary' source_type,p.id paper_id,p.title
      FROM paper_direction_assignments a JOIN papers p ON p.id=a.paper_id
      JOIN summary_revisions s ON s.paper_id=p.id AND s.status='active'
      WHERE a.topic_id=? ORDER BY p.title,p.id,s.revision DESC,s.id`).all(topicId) as Array<{
        source_id: string; source_type: "summary"; paper_id: string; title: string;
      }>;
    const takeaways = this.database.prepare(`SELECT tr.id source_id,'takeaway' source_type,p.id paper_id,
      COALESCE(tr.title,p.title) title FROM paper_direction_assignments a JOIN papers p ON p.id=a.paper_id
      JOIN takeaways t ON t.paper_id=p.id JOIN takeaway_revisions tr ON tr.id=t.active_revision_id
      WHERE a.topic_id=? AND tr.review_status='confirmed' ORDER BY p.title,p.id,tr.id`).all(topicId) as Array<{
        source_id: string; source_type: "takeaway"; paper_id: string; title: string;
      }>;
    return [...summaries, ...takeaways].map((source) => ({
      sourceType: source.source_type, sourceId: source.source_id, paperId: source.paper_id, title: source.title,
    }));
  }

  preview(topicId: string, input: unknown) {
    const prepared = this.prepare(topicId, input);
    return {
      topicId,
      nextRevisionId: prepared.revisionId,
      usageLevel: prepared.usageLevel,
      eligible: prepared.errors.length === 0,
      errors: prepared.errors,
      indexedSections: prepared.parsed.substantiveSections,
      provenance: prepared.provenance,
      projectionOperation: prepared.usageLevel === "knowledge-ready" ? "upsert" : "delete",
    };
  }

  commit(topicId: string, input: unknown, idempotencyKey: string) {
    const replay = this.database.prepare(`SELECT result_json FROM review_decisions WHERE idempotency_key=?`)
      .pluck().get(idempotencyKey) as string | undefined;
    if (replay) return JSON.parse(replay) as unknown;
    const prepared = this.prepare(topicId, input);
    if (prepared.errors.length) throw new PaperOrganizationStoreError(prepared.errors[0]!, 409);
    const now = this.now().toISOString();
    const writeId = `knowledge-write:topic:${shortHash(idempotencyKey)}`;
    const existing = this.database.prepare("SELECT payload_json,phase FROM knowledge_write_requests WHERE id=?")
      .get(writeId) as { payload_json: string; phase: string } | undefined;
    if (existing) {
      const prior = JSON.parse(existing.payload_json) as TopicKnowledgePayload;
      if (prior.topicId !== topicId || prior.parentRevisionId !== prepared.row.revision_id) {
        throw new PaperOrganizationStoreError("idempotency-key-conflict", 409);
      }
      this.advance(writeId);
      const decision = this.database.prepare("SELECT result_json FROM review_decisions WHERE idempotency_key=?")
        .pluck().get(idempotencyKey) as string | undefined;
      if (decision) return JSON.parse(decision) as unknown;
      throw new PaperOrganizationStoreError("topic-knowledge-write-incomplete", 409);
    }
    const proposalId = `proposal:topic-knowledge:${shortHash(idempotencyKey)}`;
    const decisionId = `review-decision:topic-knowledge:${shortHash(idempotencyKey)}`;
    const historyPath = join("knowledge", "topics", ".revisions", encodeURIComponent(topicId),
      `${prepared.row.revision_id.replaceAll(":", "_")}.md`);
    const targetPath = prepared.row.markdown_path;
    const resultHash = sha256(prepared.markdown);
    const stagedPath = `${targetPath}.${resultHash.slice(0, 12)}.staged`;
    const historyStagedPath = `${historyPath}.${prepared.row.markdown_hash.slice(0, 12)}.staged`;
    const response = { topicKnowledge: {
      topicId, revisionId: prepared.revisionId, revisionNumber: prepared.revisionNumber,
      usageLevel: prepared.usageLevel, indexed: prepared.usageLevel === "knowledge-ready",
    } };
    const payload: TopicKnowledgePayload = {
      topicId, title: prepared.title, aliases: prepared.aliases, scope: prepared.scope,
      parentDomainId: prepared.parentDomainId,
      parentTargetRevisionId: prepared.parentTargetRevisionId,
      parentTargetMarkdownHash: prepared.parentTargetMarkdownHash,
      revisionId: prepared.revisionId,
      revisionNumber: prepared.revisionNumber, parentRevisionId: prepared.row.revision_id,
      targetPath, historyPath, historyStagedPath, historyHash: prepared.row.markdown_hash,
      knowledgeBody: prepared.parsed.knowledgeBody,
      knowledgeBodyHash: prepared.parsed.knowledgeBodyHash,
      usageLevel: prepared.usageLevel, provenance: prepared.provenance,
      paperScope: prepared.paperScope, ownerAttested: prepared.ownerAttested,
      proposalId, decisionId, idempotencyKey, response, now,
    };
    this.database.transaction(() => {
      this.database.prepare(`INSERT INTO proposals(id,proposal_type,paper_id,payload_json,
        review_status,one_click_eligible,created_at) VALUES (?,'topic-knowledge-revision',NULL,?,'pending',0,?)`)
        .run(proposalId, JSON.stringify({ topicId, parentRevisionId: prepared.row.revision_id,
          revisionId: prepared.revisionId, title: prepared.title, aliases: prepared.aliases,
          scope: prepared.scope, parentDomainId: prepared.parentDomainId,
          operationReason: prepared.parentChanged ? "navigation-parent-change" : "topic-knowledge-edit",
          usageLevel: prepared.usageLevel,
          substantiveSections: prepared.parsed.substantiveSections,
          provenance: prepared.provenance }), now);
      this.database.prepare(`INSERT INTO knowledge_write_requests(id,request_type,target_path,staged_path,
        result_hash,phase,created_at,updated_at,payload_json) VALUES
        (?, 'topic-knowledge-revision', ?, ?, ?, 'reserved', ?, ?, ?)`)
        .run(writeId, targetPath, stagedPath, resultHash, now, now, JSON.stringify(payload));
    })();
    durableWrite(this.path(stagedPath), prepared.markdown);
    durableWrite(this.path(historyStagedPath), prepared.currentMarkdown);
    this.advance(writeId);
    const result = this.database.prepare("SELECT result_json FROM review_decisions WHERE idempotency_key=?")
      .pluck().get(idempotencyKey) as string | undefined;
    if (!result) throw new PaperOrganizationStoreError("topic-knowledge-write-incomplete", 409);
    return JSON.parse(result) as unknown;
  }

  refreshEligibility(): void {
    const revisions = this.database.prepare(`SELECT id,topic_id,provenance_json FROM topic_knowledge_revisions
      WHERE active=1 AND usage_level='knowledge-ready' AND eligibility_status='eligible'
      ORDER BY topic_id`).all() as Array<{ id: string; topic_id: string; provenance_json: string }>;
    for (const revision of revisions) {
      const provenance = JSON.parse(revision.provenance_json) as TopicProvenance[];
      const resolved = this.resolveProvenance(provenance);
      if (resolved.invalid.length > 0 || provenance.length === 0) {
        this.database.prepare(`UPDATE topic_knowledge_revisions SET eligibility_status='invalid-provenance'
          WHERE id=?`).run(revision.id);
        this.removeCurated(revision.topic_id, revision.id);
        this.flagReconciliation(revision.topic_id, "", revision.id, "invalid-provenance",
          "topic-knowledge-invalid-provenance");
      } else {
        this.database.prepare(`UPDATE topic_knowledge_revisions SET eligibility_status='eligible' WHERE id=?`)
          .run(revision.id);
        this.replacePaperScope(revision.id, resolved.paperScope);
      }
    }
  }

  validateForCurated(row: { topicId: string; revisionId: string; markdownPath: string; markdownHash: string }) {
    const revision = this.database.prepare(`SELECT * FROM topic_knowledge_revisions
      WHERE id=? AND topic_id=? AND active=1`).get(row.revisionId, row.topicId) as Record<string, unknown> | undefined;
    if (!revision || revision.usage_level !== "knowledge-ready" || revision.eligibility_status !== "eligible") return null;
    const path = this.path(row.markdownPath);
    if (!existsSync(path)) return null;
    const markdown = readFileSync(path, "utf8");
    if (sha256(markdown) !== row.markdownHash || revision.markdown_hash !== row.markdownHash) return null;
    const parsed = parseTopicKnowledgeMarkdown(markdown);
    if (knowledgeReadyContentErrors(parsed).length) return null;
    const resolved = this.resolveProvenance(parsed.provenance);
    if (resolved.invalid.length || parsed.provenance.length === 0) return null;
    return { title: String(parsed.data.title ?? row.topicId), body: parsed.knowledgeBody, paperScope: resolved.paperScope };
  }

  auditHistory(): { checked: number; findings: number } {
    const rows = this.database.prepare(`SELECT topic_id,id,history_path,markdown_hash
      FROM topic_knowledge_revisions WHERE history_path IS NOT NULL ORDER BY topic_id,revision_number`).all() as Array<{
        topic_id: string; id: string; history_path: string; markdown_hash: string;
      }>;
    let findings = 0;
    for (const row of rows) {
      const path = this.path(row.history_path);
      const actual = existsSync(path) ? sha256(readFileSync(path)) : null;
      if (actual !== row.markdown_hash) {
        findings += 1;
        const kind = actual === null ? "missing" : "hash-mismatch";
        const id = `topic-history-finding:${shortHash(`${row.id}:${kind}:${actual ?? "missing"}`)}`;
        this.database.prepare(`INSERT OR IGNORE INTO topic_knowledge_history_findings
          (id,topic_id,revision_id,history_path,expected_hash,actual_hash,finding_kind,detected_at)
          VALUES (?,?,?,?,?,?,?,?)`).run(id, row.topic_id, row.id, row.history_path,
            row.markdown_hash, actual, kind, this.now().toISOString());
      }
    }
    return { checked: rows.length, findings };
  }

  private prepare(topicId: string, input: unknown) {
    if (!input || typeof input !== "object") throw new PaperOrganizationStoreError("topic-knowledge-invalid");
    const value = input as Record<string, unknown>;
    const row = this.directionRow(topicId);
    if (value.expectedRevisionId !== row.revision_id || value.expectedMarkdownHash !== row.markdown_hash) {
      throw new PaperOrganizationStoreError("topic-knowledge-stale", 409);
    }
    const currentMarkdown = this.readCurrent(row.markdown_path);
    if (sha256(currentMarkdown) !== row.markdown_hash) throw new PaperOrganizationStoreError("topic-knowledge-stale", 409);
    const current = parseTopicKnowledgeMarkdown(currentMarkdown);
    const title = typeof value.title === "string" ? value.title.trim() : row.title;
    const aliases = Array.isArray(value.aliases)
      ? value.aliases.map((alias) => String(alias).trim()).filter(Boolean)
      : JSON.parse(row.aliases_json) as string[];
    const scope = typeof value.scope === "string" ? value.scope.trim() : row.scope;
    const identityKeys = [title, ...aliases].map(normalizePaperLookup);
    if (!title || !scope || identityKeys.some((key) => !key) || new Set(identityKeys).size !== identityKeys.length) {
      throw new PaperOrganizationStoreError("topic-knowledge-identity-invalid");
    }
    const occupied = this.database.prepare(`SELECT topic_id,title,aliases_json FROM direction_catalog
      WHERE topic_id<>? AND lifecycle_status='active' AND review_status='confirmed' ORDER BY topic_id`).all(topicId) as
      Array<{ topic_id: string; title: string; aliases_json: string }>;
    const candidateKeys = new Set(identityKeys);
    if (occupied.some((item) => [item.title, ...(JSON.parse(item.aliases_json) as string[])]
      .some((candidate) => candidateKeys.has(normalizePaperLookup(candidate))))) {
      throw new PaperOrganizationStoreError("topic-knowledge-identity-collision", 409);
    }
    const hasParentInput = Object.prototype.hasOwnProperty.call(value, "parentDomainId");
    const requestedParent = value.parentDomainId === null ? null
      : typeof value.parentDomainId === "string" ? value.parentDomainId : undefined;
    if (hasParentInput && requestedParent === undefined) {
      throw new PaperOrganizationStoreError("direction-domain-invalid");
    }
    const parentDomainId = hasParentInput ? requestedParent! : row.parent_domain_id;
    if (parentDomainId === topicId) throw new PaperOrganizationStoreError("direction-domain-invalid");
    let parentTargetRevisionId: string | null = null;
    let parentTargetMarkdownHash: string | null = null;
    if (parentDomainId) {
      const parent = this.database.prepare(`SELECT d.revision_id,d.markdown_hash,d.lifecycle_status,d.review_status,
        n.navigation_role FROM direction_catalog d JOIN topic_navigation n ON n.topic_id=d.topic_id WHERE d.topic_id=?`)
        .get(parentDomainId) as Record<string, unknown> | undefined;
      if (!parent || parent.navigation_role !== "domain" || parent.lifecycle_status !== "active" ||
          parent.review_status !== "confirmed") throw new PaperOrganizationStoreError("direction-domain-target-invalid", 409);
      parentTargetRevisionId = String(parent.revision_id);
      parentTargetMarkdownHash = String(parent.markdown_hash);
      if (hasParentInput && (value.expectedParentRevisionId !== parentTargetRevisionId ||
          value.expectedParentMarkdownHash !== parentTargetMarkdownHash)) {
        throw new PaperOrganizationStoreError("direction-domain-target-stale", 409);
      }
    }
    const usageLevel: "classification" | "knowledge-ready" | null = value.usageLevel === "knowledge-ready" ? "knowledge-ready"
      : value.usageLevel === "classification" ? "classification" : null;
    if (!usageLevel) throw new PaperOrganizationStoreError("topic-knowledge-invalid");
    const sectionsValue = value.sections && typeof value.sections === "object"
      ? value.sections as Record<string, unknown> : {};
    const sections = Object.fromEntries(TOPIC_KNOWLEDGE_HEADINGS.map((heading) => [heading,
      typeof sectionsValue[heading] === "string" ? String(sectionsValue[heading]) : current.sections[heading]])) as
      Record<TopicKnowledgeHeading, string>;
    const provenance = Array.isArray(value.provenance) ? value.provenance.map((item) => ({
      sourceType: (item as { sourceType?: unknown }).sourceType,
      sourceId: (item as { sourceId?: unknown }).sourceId,
    })).filter((item): item is TopicProvenance =>
      (item.sourceType === "summary" || item.sourceType === "takeaway") &&
      typeof item.sourceId === "string" && Boolean(item.sourceId)) : [];
    const unique = new Map(provenance.map((item) => [`${item.sourceType}:${item.sourceId}`, item]));
    const canonicalProvenance = [...unique.values()].sort((a, b) =>
      a.sourceType.localeCompare(b.sourceType) || a.sourceId.localeCompare(b.sourceId));
    const ownerAttested = value.ownerAttested === true && usageLevel === "knowledge-ready";
    let body = current.body;
    body = body.replace(/^# .+$/m, () => `# ${title}`);
    body = setTopicSection(body, "Scope", scope);
    for (const heading of TOPIC_KNOWLEDGE_HEADINGS) body = setTopicSection(body, heading, sections[heading]);
    const parentChanged = parentDomainId !== row.parent_domain_id;
    body = setTopicSection(body, "Revision note", parentChanged
      ? "用户确认 navigation parent 变更；Topic 知识正文与 provenance 仍需按本 revision 校验。"
      : usageLevel === "knowledge-ready" ? "用户确认该 revision 包含可复用的 Topic 知识。"
        : "用户确认该 revision 仅用于分类。");
    const revisionNumber = row.revision_number + 1;
    const revisionId = `${topicId}:r${revisionNumber}`;
    current.frontmatter.set("revision", revisionNumber);
    current.frontmatter.set("revision_id", revisionId);
    current.frontmatter.set("title", title);
    current.frontmatter.set("aliases", aliases);
    current.frontmatter.set("navigation_role", "direction");
    current.frontmatter.set("parent_domain_id", parentDomainId);
    current.frontmatter.set("usage_level", usageLevel);
    current.frontmatter.set("knowledge_attested", ownerAttested);
    current.frontmatter.set("provenance", canonicalProvenance.map((item) => ({
      source_type: item.sourceType, source_id: item.sourceId,
    })));
    current.frontmatter.set("updated", this.now().toISOString().slice(0, 10));
    current.frontmatter.set("confirmed_at", this.now().toISOString());
    const markdown = `---\n${current.frontmatter.toString().trimEnd()}\n---\n${body}`;
    const parsed = parseTopicKnowledgeMarkdown(markdown);
    const resolved = this.resolveProvenance(canonicalProvenance);
    const errors = usageLevel === "knowledge-ready"
      ? [...knowledgeReadyContentErrors(parsed), ...resolved.invalid.map((item) => `provenance-invalid:${item.sourceType}:${item.sourceId}`)]
      : [];
    return { row, currentMarkdown, markdown, parsed, title, aliases, scope, parentDomainId,
      parentTargetRevisionId, parentTargetMarkdownHash, parentChanged,
      usageLevel, provenance: canonicalProvenance,
      ownerAttested, revisionNumber, revisionId, paperScope: resolved.paperScope, errors };
  }

  private advance(writeId: string): void {
    const row = this.database.prepare(`SELECT target_path,staged_path,result_hash,phase,payload_json
      FROM knowledge_write_requests WHERE id=?`).get(writeId) as {
        target_path: string; staged_path: string; result_hash: string; phase: string; payload_json: string;
      } | undefined;
    if (!row) return;
    const payload = JSON.parse(row.payload_json) as TopicKnowledgePayload;
    const target = this.path(row.target_path);
    const staged = this.path(row.staged_path);
    const history = this.path(payload.historyPath);
    const historyStaged = this.path(payload.historyStagedPath);
    let phase = row.phase;
    if (phase === "reserved") {
      if (!matches(staged, row.result_hash) || (!matches(historyStaged, payload.historyHash) &&
          !matches(history, payload.historyHash))) return this.fail(writeId, "topic-knowledge-staged-missing");
      this.setPhase(writeId, "staged"); phase = "staged";
    }
    if (phase === "staged") {
      if (!matches(history, payload.historyHash)) {
        if (!matches(historyStaged, payload.historyHash)) return this.fail(writeId, "topic-history-staged-invalid");
        mkdirSync(dirname(history), { recursive: true });
        renameSync(historyStaged, history);
      } else if (existsSync(historyStaged)) unlinkSync(historyStaged);
      this.setPhase(writeId, "history-retained"); phase = "history-retained";
    }
    if (phase === "history-retained") {
      if (payload.parentDomainId) {
        const parent = this.database.prepare(`SELECT d.revision_id,d.markdown_hash,d.lifecycle_status,d.review_status,
          n.navigation_role FROM direction_catalog d JOIN topic_navigation n ON n.topic_id=d.topic_id WHERE d.topic_id=?`)
          .get(payload.parentDomainId) as Record<string, unknown> | undefined;
        if (!parent || parent.navigation_role !== "domain" || parent.lifecycle_status !== "active" ||
            parent.review_status !== "confirmed" || parent.revision_id !== payload.parentTargetRevisionId ||
            parent.markdown_hash !== payload.parentTargetMarkdownHash) {
          return this.conflict(writeId, payload, String(parent?.markdown_hash ?? "missing-parent"));
        }
      }
      const actual = existsSync(target) ? sha256(readFileSync(target)) : "";
      if (actual === payload.historyHash) {
        if (!matches(staged, row.result_hash)) return this.fail(writeId, "topic-knowledge-staged-invalid");
        renameSync(staged, target);
      } else if (actual === row.result_hash) {
        if (existsSync(staged)) unlinkSync(staged);
      } else {
        return this.conflict(writeId, payload, actual);
      }
      this.setPhase(writeId, "renamed"); phase = "renamed";
    }
    if (phase === "renamed") {
      if (!matches(target, row.result_hash)) return this.conflict(writeId, payload,
        existsSync(target) ? sha256(readFileSync(target)) : "");
      this.database.transaction(() => {
        this.database.prepare(`UPDATE topic_knowledge_revisions SET active=0,history_path=?,
          eligibility_status=CASE WHEN eligibility_status='eligible' THEN 'superseded' ELSE eligibility_status END
          WHERE topic_id=? AND active=1`).run(payload.historyPath, payload.topicId);
        this.database.prepare(`INSERT OR IGNORE INTO topic_knowledge_revisions(
          id,topic_id,revision_number,usage_level,review_status,epistemic_status,markdown_path,
          markdown_hash,history_path,knowledge_body_hash,provenance_json,owner_attested,
          eligibility_status,active,confirmed_at,created_at
        ) VALUES (?,?,?,?,'confirmed','evidence-backed',?,?,NULL,?,?,?,?,1,?,?)`)
          .run(payload.revisionId, payload.topicId, payload.revisionNumber, payload.usageLevel,
            payload.targetPath, row.result_hash, payload.knowledgeBodyHash, JSON.stringify(payload.provenance),
            Number(payload.ownerAttested), payload.usageLevel === "knowledge-ready" ? "eligible" : "classification",
            payload.now, payload.now);
        payload.provenance.forEach((source, ordinal) => this.database.prepare(`INSERT OR IGNORE INTO topic_knowledge_provenance
          (topic_revision_id,ordinal,source_type,source_id) VALUES (?,?,?,?)`)
          .run(payload.revisionId, ordinal, source.sourceType, source.sourceId));
        this.replacePaperScope(payload.revisionId, payload.paperScope);
        this.database.prepare("UPDATE proposals SET review_status='accepted',decided_at=? WHERE id=?")
          .run(payload.now, payload.proposalId);
        this.database.prepare(`INSERT OR IGNORE INTO review_decisions
          (id,proposal_id,action,idempotency_key,result_json,created_at) VALUES (?,?,'accept',?,?,?)`)
          .run(payload.decisionId, payload.proposalId, payload.idempotencyKey,
            JSON.stringify(payload.response), payload.now);
        this.enqueue("paper-catalog", payload.topicId, "upsert", payload.now);
        this.enqueue("global-curated", payload.topicId,
          payload.usageLevel === "knowledge-ready" ? "upsert" : "delete", payload.now);
        this.setPhase(writeId, "metadata-committed");
      })();
      phase = "metadata-committed";
    }
    if (phase === "metadata-committed") {
      this.rebuildPaperCatalog({ targetPath: row.target_path, resultHash: row.result_hash });
      this.completeOutbox("paper-catalog", payload.topicId);
      this.setPhase(writeId, "catalog-indexed"); phase = "catalog-indexed";
    }
    if (phase === "catalog-indexed") {
      const resolved = this.resolveProvenance(payload.provenance);
      if (payload.usageLevel === "knowledge-ready" && resolved.invalid.length === 0 && payload.provenance.length > 0) {
        this.database.prepare(`INSERT INTO curated_search_documents(id,source_type,source_id,title,body,updated_at)
          VALUES (?,'topic-knowledge',?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET
          id=excluded.id,source_type=excluded.source_type,title=excluded.title,body=excluded.body,updated_at=excluded.updated_at`)
          .run(`curated-topic:${payload.topicId}`, payload.topicId, payload.title,
            payload.knowledgeBody, this.now().toISOString());
      } else {
        this.database.prepare(`DELETE FROM curated_search_documents WHERE source_type='topic-knowledge' AND source_id=?`)
          .run(payload.topicId);
        if (payload.usageLevel === "knowledge-ready") this.database.prepare(`UPDATE topic_knowledge_revisions
          SET eligibility_status='invalid-provenance' WHERE id=?`).run(payload.revisionId);
      }
      this.completeOutbox("global-curated", payload.topicId);
      const now = this.now().toISOString();
      this.database.prepare(`UPDATE projection_state SET last_successful_at=?,updated_at=?
        WHERE projection='global-curated'`).run(now, now);
      this.setPhase(writeId, "curated-indexed"); phase = "curated-indexed";
    }
    if (phase === "curated-indexed") this.setPhase(writeId, "complete");
  }

  private resolveProvenance(provenance: TopicProvenance[]) {
    const invalid: TopicProvenance[] = [];
    const counts = new Map<string, number>();
    for (const source of provenance) {
      let paperId: string | undefined;
      if (source.sourceType === "summary") paperId = (this.database.prepare(`SELECT paper_id FROM summary_revisions
        WHERE id=? AND status='active'`).pluck().get(source.sourceId) as string | undefined);
      else paperId = (this.database.prepare(`SELECT t.paper_id FROM takeaway_revisions tr JOIN takeaways t
        ON t.active_revision_id=tr.id WHERE tr.id=? AND tr.review_status='confirmed'`).pluck().get(source.sourceId) as string | undefined);
      if (!paperId) invalid.push(source);
      else counts.set(paperId, (counts.get(paperId) ?? 0) + 1);
    }
    return { invalid, paperScope: [...counts].sort(([a], [b]) => a.localeCompare(b))
      .map(([paperId, sourceCount]) => ({ paperId, sourceCount })) };
  }

  private replacePaperScope(revisionId: string, rows: Array<{ paperId: string; sourceCount: number }>): void {
    this.database.prepare("DELETE FROM topic_knowledge_paper_scope WHERE topic_revision_id=?").run(revisionId);
    const now = this.now().toISOString();
    rows.forEach((row) => this.database.prepare(`INSERT INTO topic_knowledge_paper_scope
      (topic_revision_id,paper_id,source_count,rebuilt_at) VALUES (?,?,?,?)`)
      .run(revisionId, row.paperId, row.sourceCount, now));
  }

  private directionRow(topicId: string) {
    const row = this.database.prepare(`SELECT d.topic_id,d.title,d.revision_id,d.revision_number,d.markdown_path,d.markdown_hash,
      d.lifecycle_status,d.review_status,d.aliases_json,d.scope,n.navigation_role,n.parent_domain_id
      FROM direction_catalog d JOIN topic_navigation n ON n.topic_id=d.topic_id WHERE d.topic_id=?`).get(topicId) as {
        topic_id: string; title: string; revision_id: string; revision_number: number;
        markdown_path: string; markdown_hash: string; lifecycle_status: string; review_status: string;
        aliases_json: string; scope: string; navigation_role: "domain" | "direction"; parent_domain_id: string | null;
      } | undefined;
    if (!row) throw new PaperOrganizationStoreError("direction-not-found", 404);
    if (row.lifecycle_status !== "active" || row.review_status !== "confirmed") {
      throw new PaperOrganizationStoreError("paper-direction-not-usable", 409);
    }
    if (row.navigation_role !== "direction") throw new PaperOrganizationStoreError("domain-knowledge-invalid", 409);
    return row;
  }

  private readCurrent(relativePath: string): string {
    const path = this.path(relativePath);
    if (!existsSync(path)) throw new PaperOrganizationStoreError("direction-markdown-invalid", 409);
    return readFileSync(path, "utf8");
  }

  private path(relativePath: string): string { return join(this.layout.vaultRoot, relativePath); }
  private setPhase(id: string, phase: string): void {
    this.database.prepare("UPDATE knowledge_write_requests SET phase=?,updated_at=?,error_code=NULL WHERE id=?")
      .run(phase, this.now().toISOString(), id);
  }
  private fail(id: string, code: string): void {
    this.database.prepare("UPDATE knowledge_write_requests SET phase='failed',error_code=?,updated_at=? WHERE id=?")
      .run(code, this.now().toISOString(), id);
  }
  private conflict(id: string, payload: TopicKnowledgePayload, actualHash: string): void {
    this.database.transaction(() => {
      this.database.prepare(`UPDATE knowledge_write_requests SET phase='conflicted',error_code='external-edit',updated_at=?
        WHERE id=?`).run(this.now().toISOString(), id);
      this.flagReconciliation(payload.topicId, payload.targetPath, payload.historyHash, actualHash,
        "topic-knowledge-external-drift", id);
    })();
  }
  private flagReconciliation(topicId: string, targetPath: string, expectedHash: string, actualHash: string,
    reason: string, writeId = `external:${topicId}`): void {
    const now = this.now().toISOString();
    this.database.prepare(`INSERT OR IGNORE INTO proposals(id,proposal_type,paper_id,payload_json,
      review_status,one_click_eligible,created_at) VALUES (?,'reconciliation',NULL,?,'pending',0,?)`)
      .run(`proposal:reconciliation:${shortHash(`${writeId}:${reason}`)}`, JSON.stringify({
        writeId, targetKind: "topic", targetId: topicId, targetPath, expectedHash, actualHash, reason,
      }), now);
  }
  private enqueue(projection: string, sourceId: string, operation: string, now: string): void {
    this.database.prepare(`INSERT INTO index_outbox(projection,source_id,operation,state,created_at)
      VALUES (?,?,?,'pending',?) ON CONFLICT(projection,source_id,operation) DO UPDATE SET
      state='pending',created_at=excluded.created_at,completed_at=NULL`).run(projection, sourceId, operation, now);
  }
  private completeOutbox(projection: string, sourceId: string): void {
    this.database.prepare(`UPDATE index_outbox SET state='complete',completed_at=? WHERE projection=? AND source_id=?
      AND state='pending'`).run(this.now().toISOString(), projection, sourceId);
  }
  private removeCurated(topicId: string, revisionId: string): void {
    const now = this.now().toISOString();
    this.database.prepare(`DELETE FROM curated_search_documents WHERE source_type='topic-knowledge' AND source_id=?`)
      .run(topicId);
    this.enqueue("global-curated", topicId, "delete", now);
    this.completeOutbox("global-curated", topicId);
    this.database.prepare(`UPDATE topic_knowledge_revisions SET eligibility_status=CASE
      WHEN eligibility_status='external-drift' THEN eligibility_status ELSE 'invalid-provenance' END WHERE id=?`)
      .run(revisionId);
  }
}

function durableWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
  const descriptor = openSync(path, "r");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function matches(path: string, expectedHash: string): boolean {
  return existsSync(path) && sha256(readFileSync(path)) === expectedHash;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function shortHash(value: string): string { return sha256(value).slice(0, 24); }
