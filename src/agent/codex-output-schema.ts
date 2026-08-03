export function codexOutputSchema<T>(schema: T): T {
  if (Array.isArray(schema)) return schema.map(codexOutputSchema) as T;
  if (!schema || typeof schema !== "object") return schema;
  return Object.fromEntries(Object.entries(schema as Record<string, unknown>)
    // Codex structured outputs reject uniqueItems and empty enums. Keep the
    // application contract intact; AJV and domain validators run on the original.
    .filter(([key, value]) => key !== "uniqueItems" &&
      !(key === "enum" && Array.isArray(value) && value.length === 0))
    .map(([key, value]) => [key, codexOutputSchema(value)])) as T;
}
