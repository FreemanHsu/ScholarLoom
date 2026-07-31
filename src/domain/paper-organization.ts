export const PAPER_ALIAS_KINDS = [
  "model-name",
  "method-name",
  "acronym",
  "project-name",
  "user-defined",
] as const;

export type PaperAliasKind = typeof PAPER_ALIAS_KINDS[number];
export type PaperAlias = { name: string; kind: PaperAliasKind; preferred: boolean };
export type DirectionRole = "primary" | "secondary";
export type PaperDirectionInput = { topicId: string; role: DirectionRole };
export type PaperOrganizationInput = { aliases: PaperAlias[]; directions: PaperDirectionInput[] };

export class PaperOrganizationValidationError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export function normalizePaperLookup(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("und")
    .replaceAll("ß", "ss")
    .replaceAll("\u03c2", "\u03c3");
}

export function validatePaperOrganization(input: unknown): PaperOrganizationInput {
  if (!input || typeof input !== "object") throw new PaperOrganizationValidationError("paper-organization-invalid");
  const candidate = input as { aliases?: unknown; directions?: unknown };
  if (!Array.isArray(candidate.aliases) || !Array.isArray(candidate.directions)) {
    throw new PaperOrganizationValidationError("paper-organization-invalid");
  }
  const aliases = candidate.aliases.map((value) => {
    if (!value || typeof value !== "object") throw new PaperOrganizationValidationError("paper-alias-invalid");
    const alias = value as { name?: unknown; kind?: unknown; preferred?: unknown };
    const name = typeof alias.name === "string" ? alias.name.trim() : "";
    if (!name || !PAPER_ALIAS_KINDS.includes(alias.kind as PaperAliasKind) || typeof alias.preferred !== "boolean") {
      throw new PaperOrganizationValidationError("paper-alias-invalid");
    }
    return { name, kind: alias.kind as PaperAliasKind, preferred: alias.preferred };
  });
  const normalizedAliases = aliases.map((alias) => normalizePaperLookup(alias.name));
  if (new Set(normalizedAliases).size !== aliases.length) {
    throw new PaperOrganizationValidationError("paper-alias-duplicate");
  }
  if (aliases.filter((alias) => alias.preferred).length > 1) {
    throw new PaperOrganizationValidationError("paper-preferred-alias-limit");
  }

  const directions = candidate.directions.map((value) => {
    if (!value || typeof value !== "object") throw new PaperOrganizationValidationError("paper-direction-invalid");
    const direction = value as { topicId?: unknown; role?: unknown };
    if (typeof direction.topicId !== "string" || !direction.topicId.startsWith("topic:") ||
        !["primary", "secondary"].includes(String(direction.role))) {
      throw new PaperOrganizationValidationError("paper-direction-invalid");
    }
    return { topicId: direction.topicId, role: direction.role as DirectionRole };
  });
  if (new Set(directions.map((direction) => direction.topicId)).size !== directions.length) {
    throw new PaperOrganizationValidationError("paper-direction-duplicate");
  }
  if (directions.filter((direction) => direction.role === "primary").length > 1) {
    throw new PaperOrganizationValidationError("paper-primary-direction-limit");
  }
  if (directions.filter((direction) => direction.role === "secondary").length > 3) {
    throw new PaperOrganizationValidationError("paper-secondary-direction-limit");
  }
  if (directions.some((direction) => direction.role === "secondary") &&
      !directions.some((direction) => direction.role === "primary")) {
    throw new PaperOrganizationValidationError("paper-secondary-requires-primary");
  }
  return { aliases, directions };
}
