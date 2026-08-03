import { createHash } from "node:crypto";

import type Database from "better-sqlite3";

import {
  normalizePaperLookup,
  PAPER_LOOKUP_NORMALIZATION_VERSION,
} from "../domain/paper-organization.js";

export const PAPER_RESOLVER_VERSION = "paper-resolver.v1";
export type PaperResolverMode = "off" | "shadow" | "enabled";

export class PaperResolverError extends Error {
  constructor(readonly code: "entry-paper-resolution-invalid" | "entry-paper-resolution-stale") {
    super(code);
  }
}

export type PaperResolutionCandidate = {
  paperId: string;
  canonicalTitle: string;
  matchedText: string;
  matchKind: "preferred-alias" | "alias" | "canonical-title";
  authors: string[];
  year: number;
  primaryDirection: { topicId: string; title: string } | null;
};

export type PaperResolutionGroup = {
  id: string;
  normalizedText: string;
  matchedText: string;
  start: number;
  end: number;
  candidates: PaperResolutionCandidate[];
};

export type PaperResolution = {
  state: "none" | "resolved" | "ambiguous" | "too-many" | "normalization-mismatch";
  snapshotHash: string;
  groups: PaperResolutionGroup[];
  paperIds: string[];
};

type Identity = {
  normalizedText: string;
  matchedText: string;
  candidate: PaperResolutionCandidate;
  rank: number;
};

const COMMON_TERMS = new Set([
  "attention", "transformer", "diffusion", "generation", "reasoning", "alignment",
  "video generation", "representation learning", "machine learning", "deep learning",
  "注意力", "扩散", "推理", "对齐", "视频生成", "表示学习", "机器学习", "深度学习",
  "生成模型", "大语言模型",
]);
const QUOTES: Array<[string, string]> = [
  ['"', '"'], ["'", "'"], ["“", "”"], ["‘", "’"], ["「", "」"], ["『", "』"], ["《", "》"],
];
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const stableJson = (value: unknown) => JSON.stringify(value, (_key, item) => {
  if (!item || typeof item !== "object" || Array.isArray(item)) return item;
  return Object.fromEntries(Object.entries(item as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right)));
});
const asciiAlphanumeric = /[a-z0-9]/i;
const containsCjk = (value: string) => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(value);

export class PaperResolver {
  constructor(private readonly database: Database.Database) {}

  normalizationMatches(): boolean {
    const version = this.database.prepare(`SELECT metadata_value FROM paper_catalog_metadata
      WHERE metadata_key='normalization-version'`).pluck().get() as string | undefined;
    return version === PAPER_LOOKUP_NORMALIZATION_VERSION;
  }

  resolve(question: string): PaperResolution {
    if (!this.normalizationMatches()) {
      return this.#result("normalization-mismatch", [], []);
    }
    const normalizedQuestion = normalizePaperLookup(question);
    const occurrences = this.#identities().flatMap((identity) =>
      this.#occurrences(normalizedQuestion, identity).map(({ start, end }) => ({ identity, start, end })));
    const spanGroups = new Map<string, { start: number; end: number; identities: Identity[] }>();
    for (const occurrence of occurrences) {
      const key = `${occurrence.start}:${occurrence.end}:${occurrence.identity.normalizedText}`;
      const group = spanGroups.get(key) ?? { start: occurrence.start, end: occurrence.end, identities: [] };
      group.identities.push(occurrence.identity);
      spanGroups.set(key, group);
    }
    const ordered = [...spanGroups.values()].sort((left, right) =>
      left.start - right.start || (right.end - right.start) - (left.end - left.start) ||
      Math.min(...left.identities.map((item) => item.rank)) - Math.min(...right.identities.map((item) => item.rank)));
    const selected: typeof ordered = [];
    for (const group of ordered) {
      if (selected.some((prior) => group.start < prior.end && group.end > prior.start)) continue;
      selected.push(group);
    }
    const byMention = new Map<string, PaperResolutionGroup>();
    for (const group of selected) {
      const normalizedText = group.identities[0]!.normalizedText;
      if (byMention.has(normalizedText)) continue;
      const perPaper = new Map<string, Identity>();
      for (const identity of group.identities.sort((left, right) => left.rank - right.rank ||
        left.candidate.paperId.localeCompare(right.candidate.paperId))) {
        if (!perPaper.has(identity.candidate.paperId)) perPaper.set(identity.candidate.paperId, identity);
      }
      const candidates = [...perPaper.values()].map((identity) => identity.candidate);
      const id = `resolution-group:${hash(stableJson({ normalizedText,
        paperIds: candidates.map((candidate) => candidate.paperId) })).slice(0, 20)}`;
      byMention.set(normalizedText, { id, normalizedText,
        matchedText: group.identities[0]!.matchedText, start: group.start, end: group.end, candidates });
    }
    const groups = [...byMention.values()].sort((left, right) => left.start - right.start || left.id.localeCompare(right.id));
    if (!groups.length) return this.#result("none", [], []);
    const ambiguous = groups.some((group) => group.candidates.length > 1);
    const paperIds = [...new Set(groups.flatMap((group) => group.candidates.length === 1
      ? [group.candidates[0]!.paperId] : []))].sort();
    if (ambiguous) return this.#result("ambiguous", groups, paperIds);
    if (paperIds.length > 5) return this.#result("too-many", groups, paperIds);
    return this.#result("resolved", groups, paperIds);
  }

  record(question: string, mode: PaperResolverMode, resolution: PaperResolution,
    outcome: string = resolution.state): void {
    const safeOutcome = ["none", "resolved", "ambiguous", "too-many", "bypassed", "normalization-mismatch"]
      .includes(outcome) ? outcome : "none";
    const matches = resolution.groups.map((group) => ({ groupId: group.id,
      kinds: [...new Set(group.candidates.map((candidate) => candidate.matchKind))],
      paperIds: group.candidates.map((candidate) => candidate.paperId) }));
    this.database.prepare(`INSERT INTO entry_paper_resolution_events
      (question_hash,resolver_version,normalization_version,mode,outcome,matches_json,created_at)
      VALUES (?,?,?,?,?,?,?)`).run(hash(question), PAPER_RESOLVER_VERSION,
        PAPER_LOOKUP_NORMALIZATION_VERSION, mode, safeOutcome, stableJson(matches), new Date().toISOString());
    this.database.prepare(`DELETE FROM entry_paper_resolution_events WHERE id IN (
      SELECT id FROM entry_paper_resolution_events ORDER BY id DESC LIMIT -1 OFFSET 1000
    )`).run();
  }

  #result(state: PaperResolution["state"], groups: PaperResolutionGroup[], paperIds: string[]): PaperResolution {
    const snapshotHash = hash(stableJson({ version: PAPER_RESOLVER_VERSION, state,
      groups: groups.map((group) => ({ id: group.id, normalizedText: group.normalizedText,
        candidates: group.candidates.map((candidate) => ({ paperId: candidate.paperId,
          kind: candidate.matchKind })) })) }));
    return { state, snapshotHash, groups, paperIds };
  }

  #identities(): Identity[] {
    const papers = this.database.prepare(`SELECT d.paper_id,d.canonical_title,d.authors_json,d.publication_year,
      p.updated_at,a.topic_id,c.title direction_title
      FROM paper_catalog_documents d JOIN papers p ON p.id=d.paper_id
      LEFT JOIN paper_direction_assignments a ON a.paper_id=d.paper_id AND a.assignment_role='primary'
      LEFT JOIN direction_catalog c ON c.topic_id=a.topic_id`).all() as Array<{
        paper_id: string; canonical_title: string; authors_json: string; publication_year: number;
        updated_at: string; topic_id: string | null; direction_title: string | null;
      }>;
    const metadata = new Map(papers.map((paper) => [paper.paper_id, paper]));
    const aliases = this.database.prepare(`SELECT paper_id,name,normalized_name,preferred
      FROM paper_aliases ORDER BY preferred DESC,ordinal,paper_id`).all() as Array<{
        paper_id: string; name: string; normalized_name: string; preferred: number;
      }>;
    const identities: Identity[] = [];
    const candidate = (paper: typeof papers[number], matchedText: string,
      matchKind: PaperResolutionCandidate["matchKind"]): PaperResolutionCandidate => ({
      paperId: paper.paper_id, canonicalTitle: paper.canonical_title, matchedText, matchKind,
      authors: JSON.parse(paper.authors_json) as string[], year: paper.publication_year,
      primaryDirection: paper.topic_id && paper.direction_title
        ? { topicId: paper.topic_id, title: paper.direction_title } : null,
    });
    for (const alias of aliases) {
      const paper = metadata.get(alias.paper_id);
      if (!paper) continue;
      identities.push({ normalizedText: alias.normalized_name, matchedText: alias.name,
        candidate: candidate(paper, alias.name, alias.preferred ? "preferred-alias" : "alias"),
        rank: alias.preferred ? 0 : 1 });
    }
    for (const paper of papers) {
      identities.push({ normalizedText: normalizePaperLookup(paper.canonical_title),
        matchedText: paper.canonical_title, candidate: candidate(paper, paper.canonical_title, "canonical-title"),
        rank: 2 });
    }
    return identities.sort((left, right) => right.normalizedText.length - left.normalizedText.length ||
      left.rank - right.rank || left.candidate.paperId.localeCompare(right.candidate.paperId));
  }

  #occurrences(question: string, identity: Identity): Array<{ start: number; end: number }> {
    const value = identity.normalizedText;
    if (!value) return [];
    const quotedOnly = identity.candidate.matchKind !== "canonical-title" && this.#requiresQuoting(value);
    const result: Array<{ start: number; end: number }> = [];
    let offset = 0;
    while (offset <= question.length - value.length) {
      const start = question.indexOf(value, offset);
      if (start < 0) break;
      const end = start + value.length;
      const quoted = this.#quoted(question, start, end);
      const latinBoundary = !containsCjk(value) &&
        (start === 0 || !asciiAlphanumeric.test(question[start - 1]!)) &&
        (end === question.length || !asciiAlphanumeric.test(question[end]!));
      const eligible = quoted || (!quotedOnly && (containsCjk(value) || latinBoundary));
      if (eligible) result.push({ start, end });
      offset = start + Math.max(1, value.length);
    }
    return result;
  }

  #requiresQuoting(value: string): boolean {
    const compact = value.replace(/[^a-z0-9]/gi, "");
    const cjkLength = [...value].filter((character) => containsCjk(character)).length;
    return COMMON_TERMS.has(value) || (cjkLength > 0 ? cjkLength <= 2 : compact.length <= 3);
  }

  #quoted(question: string, start: number, end: number): boolean {
    let left = start - 1;
    let right = end;
    while (left >= 0 && /\s/u.test(question[left]!)) left -= 1;
    while (right < question.length && /\s/u.test(question[right]!)) right += 1;
    return QUOTES.some(([open, close]) => question[left] === open && question[right] === close);
  }
}
