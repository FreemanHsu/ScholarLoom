import type { PaperSource, ResolvedPaper } from "../app.js";

export class ArxivPaperSource implements PaperSource {
  async resolve(arxivId: string): Promise<ResolvedPaper> {
    const response = await fetch(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(arxivId)}`, {
      headers: { "user-agent": "ScholarLoom/0.1 (personal research ingestion)" },
    });
    if (!response.ok) throw new Error(`paper-source-unavailable:${response.status}`);
    const xml = await response.text();
    const entry = xml.match(/<entry>([\s\S]*?)<\/entry>/)?.[1];
    const title = entry?.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.replace(/\s+/g, " ").trim();
    const resolvedId = entry?.match(/<id>[^<]*\/abs\/([^<]+)<\/id>/)?.[1];
    const authors = [...(entry?.matchAll(/<author>\s*<name>([^<]+)<\/name>\s*<\/author>/g) ?? [])].map((match) => match[1]!.trim());
    const year = Number.parseInt(entry?.match(/<published>(\d{4})-/)?.[1] ?? "", 10);
    if (!entry || !title || !resolvedId || !authors.length || !Number.isInteger(year)) throw new Error("paper-source-unavailable:not-found");
    const versionMatch = resolvedId.match(/v(\d+)$/);
    return { arxivId, latestVersion: versionMatch ? Number.parseInt(versionMatch[1]!, 10) : 1, title, authors, year };
  }

  async fetchPdf(arxivId: string, version: number): Promise<Uint8Array> {
    const response = await fetch(`https://arxiv.org/pdf/${encodeURIComponent(arxivId)}v${version}`, {
      headers: { "user-agent": "ScholarLoom/0.1 (personal research ingestion)" },
    });
    if (!response.ok) throw new Error(`paper-source-unavailable:${response.status}`);
    const type = response.headers.get("content-type") ?? "";
    if (!type.includes("pdf")) throw new Error("paper-source-invalid-pdf");
    return new Uint8Array(await response.arrayBuffer());
  }
}
