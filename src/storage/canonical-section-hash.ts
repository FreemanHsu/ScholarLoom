import { createHash } from "node:crypto";

export function canonicalSectionHash(structuredJson: string | object): string {
  const parsed = typeof structuredJson === "string" ? JSON.parse(structuredJson) as { sections?: unknown } : structuredJson as { sections?: unknown };
  const canonical = canonicalize(parsed.sections ?? []);
  return createHash("sha256").update(Buffer.from(JSON.stringify(canonical), "utf8")).digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (typeof value === "string") return value.normalize("NFC");
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonicalize(item)]));
  return value;
}
