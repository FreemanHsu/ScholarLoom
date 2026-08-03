import { createHash } from "node:crypto";

import { parseDocument } from "yaml";

export const TOPIC_SECTION_HEADINGS = [
  "Scope",
  "Map of concepts",
  "Representative papers",
  "Schools of thought and disagreements",
  "Open questions",
  "Syntheses",
  "Suggested reading path",
  "Revision note",
] as const;

export const TOPIC_KNOWLEDGE_HEADINGS = [
  "Map of concepts",
  "Schools of thought and disagreements",
  "Open questions",
  "Syntheses",
  "Suggested reading path",
] as const;

export type TopicSectionHeading = typeof TOPIC_SECTION_HEADINGS[number];
export type TopicKnowledgeHeading = typeof TOPIC_KNOWLEDGE_HEADINGS[number];
export type TopicProvenance = { sourceType: "summary" | "takeaway"; sourceId: string };

export type ParsedTopicKnowledge = {
  data: Record<string, unknown>;
  frontmatter: ReturnType<typeof parseDocument>;
  body: string;
  sections: Record<TopicSectionHeading, string>;
  unknownSections: string[];
  knowledgeBody: string;
  knowledgeBodyHash: string;
  substantiveSections: TopicKnowledgeHeading[];
  provenance: TopicProvenance[];
  ownerAttested: boolean;
  schemaErrors: string[];
};

export function parseTopicKnowledgeMarkdown(markdown: string): ParsedTopicKnowledge {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(markdown);
  if (!match) throw new Error("topic-frontmatter-invalid");
  const frontmatter = parseDocument(match[1]!);
  if (frontmatter.errors.length) throw new Error("topic-frontmatter-invalid");
  const data = frontmatter.toJS() as Record<string, unknown>;
  const body = match[2]!;
  const headings = [...body.matchAll(/^## ([^\r\n]+)\r?$/gm)].map((item) => ({
    title: item[1]!.trim(),
    start: item.index!,
    contentStart: item.index! + item[0].length,
  }));
  const canonical = new Set<string>(TOPIC_SECTION_HEADINGS);
  const schemaErrors: string[] = [];
  const counts = new Map<string, number>();
  headings.forEach((heading) => counts.set(heading.title, (counts.get(heading.title) ?? 0) + 1));
  for (const heading of TOPIC_SECTION_HEADINGS) {
    if (!counts.has(heading)) schemaErrors.push(`missing:${heading}`);
    if ((counts.get(heading) ?? 0) > 1) schemaErrors.push(`duplicate:${heading}`);
  }
  const observedCanonical = headings.filter((heading) => canonical.has(heading.title)).map((heading) => heading.title);
  if (observedCanonical.length === TOPIC_SECTION_HEADINGS.length &&
      observedCanonical.some((heading, index) => heading !== TOPIC_SECTION_HEADINGS[index])) {
    schemaErrors.push("canonical-order-invalid");
  }
  const byHeading = new Map<string, string>();
  headings.forEach((heading, index) => {
    const end = headings[index + 1]?.start ?? body.length;
    if (!byHeading.has(heading.title)) byHeading.set(heading.title, body.slice(heading.contentStart, end).trim());
  });
  const sections = Object.fromEntries(TOPIC_SECTION_HEADINGS.map((heading) =>
    [heading, byHeading.get(heading) ?? ""])) as Record<TopicSectionHeading, string>;
  const substantiveSections = TOPIC_KNOWLEDGE_HEADINGS.filter((heading) => isSubstantive(sections[heading]));
  const knowledgeBody = TOPIC_KNOWLEDGE_HEADINGS.filter((heading) => isSubstantive(sections[heading]))
    .map((heading) => `## ${heading}\n\n${sections[heading]}`).join("\n\n");
  const provenance = parseProvenance(data.provenance);
  return {
    data,
    frontmatter,
    body,
    sections,
    unknownSections: headings.map((heading) => heading.title).filter((heading) => !canonical.has(heading)),
    knowledgeBody,
    knowledgeBodyHash: sha256(knowledgeBody),
    substantiveSections,
    provenance,
    ownerAttested: data.knowledge_attested === true,
    schemaErrors,
  };
}

export function knowledgeReadyContentErrors(parsed: ParsedTopicKnowledge): string[] {
  return [
    ...parsed.schemaErrors,
    ...(!isSubstantive(parsed.sections.Scope) ? ["scope-empty"] : []),
    ...(parsed.substantiveSections.length === 0 ? ["substantive-content-empty"] : []),
    ...(parsed.provenance.length === 0 ? ["provenance-empty"] : []),
    ...(!parsed.ownerAttested ? ["owner-attestation-required"] : []),
  ];
}

export function setTopicSection(body: string, heading: TopicSectionHeading, content: string): string {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`((?:^|\\n)## ${escaped}\\r?\\n)[\\s\\S]*?(?=\\r?\\n## |$)`);
  if (!pattern.test(body)) throw new Error("topic-section-schema-invalid");
  return body.replace(pattern, `$1\n${content.trim()}\n`);
}

export function parseProvenance(value: unknown): TopicProvenance[] {
  if (!Array.isArray(value)) return [];
  const result: TopicProvenance[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const sourceType = (item as { source_type?: unknown }).source_type;
    const sourceId = (item as { source_id?: unknown }).source_id;
    if ((sourceType !== "summary" && sourceType !== "takeaway") || typeof sourceId !== "string" || !sourceId) continue;
    const key = `${sourceType}:${sourceId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ sourceType, sourceId });
  }
  return result;
}

function isSubstantive(value: string): boolean {
  const normalized = value.replace(/<!--[\s\S]*?-->/g, "").trim();
  return Boolean(normalized) && !["TODO", "TBD", "待补充"].includes(normalized);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
