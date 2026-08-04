import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PDFDocument, StandardFonts } from "pdf-lib";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { PaperSourceError } from "../src/adapters/safe-pdf-downloader.js";
import { DirectPdfPreparationError } from "../src/adapters/direct-pdf.js";
import { initializeDataRoot } from "../src/storage/layout.js";

async function directPdf(text = "Locate Anything reports grounded localization."): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage().drawText(text, { x: 40, y: 700, font });
  return pdf.save();
}

describe("direct PDF import", () => {
  it("redownloads on retry when acquisition failed before any PDF was frozen", async () => {
    const bytes = await directPdf();
    const contentHash = createHash("sha256").update(bytes).digest("hex");
    let attempts = 0;
    const source = "https://papers.example.test/download-retry.pdf";
    const app = await createApp({
      storageLayout: initializeDataRoot(join(await mkdtemp(join(tmpdir(), "scholarloom-direct-download-retry-")), "data")),
      paperSource: { async resolve(arxivId) { return { arxivId, latestVersion: 1, title: "unused", authors: ["unused"], year: 2025 }; } },
      directPdfSource: { async prepare(reference) { attempts += 1; if (attempts === 1) throw new PaperSourceError("paper-source-dns-failed"); return {
        reference, sourceIdentity: source, sourceType: "direct-pdf" as const, sourceVersion: `sha256:${contentHash}`,
        canonicalUrl: source, bytes, contentHash, byteSize: bytes.byteLength, mediaType: "application/pdf",
        metadata: { title: "Download Retry", authors: ["Ada Researcher"], year: 2025 },
      }; } },
    });
    const failed = await app.inject({ method: "POST", url: "/api/imports", payload: { reference: source } });
    const status = (await app.inject({ method: "GET", url: `/api/imports/${failed.json().importRequest.id}` })).json();
    const retried = await app.inject({ method: "POST", url: `/api/jobs/${status.jobs[0].id}/retry`,
      headers: { "idempotency-key": "retry-download" } });
    expect(retried.statusCode, retried.body).toBe(202);
    expect(retried.json().job.attempt).toBe(2);
    expect(attempts).toBe(2);
    expect((await app.inject({ method: "GET", url: "/api/papers" })).json().papers).toHaveLength(1);
    await app.close();
  });

  it("keeps the arXiv retry availability check when no PDF fetch adapter exists", async () => {
    const layout = initializeDataRoot(join(await mkdtemp(join(tmpdir(), "scholarloom-arxiv-retry-compat-")), "data"));
    const bytes = await directPdf();
    const first = await createApp({
      storageLayout: layout,
      paperSource: {
        async resolve(arxivId) { return { arxivId, latestVersion: 1, title: "arXiv Retry", authors: ["Ada Researcher"], year: 2025 }; },
        async fetchPdf() { return bytes; },
      },
      codexRunner: { async runSummary() { throw new Error("summary failed"); } },
    });
    const imported = await first.inject({ method: "POST", url: "/api/imports", payload: { reference: "https://arxiv.org/abs/2501.00001" } });
    let failedJob = "";
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const status = (await first.inject({ method: "GET", url: `/api/imports/${imported.json().importRequest.id}` })).json();
      if (status.jobs.at(-1)?.state === "failed") { failedJob = status.jobs.at(-1).id; break; }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await first.close();

    const resumed = await createApp({
      storageLayout: layout,
      paperSource: { async resolve(arxivId) { return { arxivId, latestVersion: 1, title: "arXiv Retry", authors: ["Ada Researcher"], year: 2025 }; } },
      codexRunner: { async runSummary() { return { sections: [], claims: [], readStatus: "read" }; } },
    });
    const retry = await resumed.inject({ method: "POST", url: `/api/jobs/${failedJob}/retry`, headers: { "idempotency-key": "arxiv-retry-no-fetch" } });
    expect(retry.statusCode).toBe(503);
    expect(retry.json()).toEqual({ code: "import-runner-unavailable" });
    await resumed.close();
  });

  it("creates a non-arXiv Paper and completes the existing ingestion lifecycle", async () => {
    const bytes = await directPdf();
    const hash = createHash("sha256").update(bytes).digest("hex");
    const source = "https://research.nvidia.com/labs/lpr/locate-anything/LocateAnything.pdf";
    const app = await createApp({
      storageLayout: initializeDataRoot(join(await mkdtemp(join(tmpdir(), "scholarloom-direct-")), "data")),
      paperSource: { async resolve(arxivId) { return { arxivId, latestVersion: 1, title: "unused", authors: ["unused"], year: 2025 }; } },
      directPdfSource: { async prepare(reference) { return { reference, sourceIdentity: source, sourceType: "direct-pdf" as const,
        sourceVersion: `sha256:${hash}`, canonicalUrl: source, bytes, contentHash: hash, byteSize: bytes.byteLength,
        mediaType: "application/pdf", metadata: { title: "Locate Anything", authors: ["Junyan Zhu"], year: 2025 } }; } },
      codexRunner: { async runSummary() { return { sections: [{ key: "overview", title: "概述", body: "grounded localization" }],
        claims: [{ voice: "paper-evidence", claim: "Locate Anything reports grounded localization.", sourceHandle: "pdf-page:1" }], readStatus: "read" }; } },
    });

    const imported = await app.inject({ method: "POST", url: "/api/imports", payload: { reference: source } });
    expect(imported.statusCode, imported.body).toBe(202);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const status = await app.inject({ method: "GET", url: `/api/imports/${imported.json().importRequest.id}` });
      if (status.json().jobs.at(-1)?.state === "succeeded") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const workspace = await app.inject({ method: "GET", url: `/api/papers/${encodeURIComponent(imported.json().paper.id)}` });
    expect(workspace.json()).toMatchObject({ paper: { sourceType: "direct-pdf", sourceUrl: source }, pdf: { pageCount: 1 },
      summary: { status: "active" } });
    expect(JSON.stringify(workspace.json())).not.toContain("arxivId");
    await app.close();
  });

  it("deduplicates by content hash and proposes changed bytes for the same URL", async () => {
    const firstBytes = new TextEncoder().encode("%PDF-first");
    const secondBytes = new TextEncoder().encode("%PDF-second");
    let selected = firstBytes;
    const layout = initializeDataRoot(join(await mkdtemp(join(tmpdir(), "scholarloom-direct-dedup-")), "data"));
    const app = await createApp({
      storageLayout: layout,
      paperSource: { async resolve(arxivId) { return { arxivId, latestVersion: 1, title: "unused", authors: ["unused"], year: 2025 }; } },
      directPdfSource: { async prepare(reference) { const hash = createHash("sha256").update(selected).digest("hex"); return {
        reference, sourceIdentity: reference.normalizedUrl, sourceType: "direct-pdf" as const, sourceVersion: `sha256:${hash}`,
        canonicalUrl: reference.normalizedUrl, bytes: selected, contentHash: hash, byteSize: selected.byteLength,
        mediaType: "application/pdf", metadata: { title: "One Paper", authors: ["Ada Researcher"], year: 2025 },
      }; } },
    });
    const firstUrl = "https://papers.example.test/paper.pdf";
    const mirrorUrl = "https://mirror.example.test/paper.pdf";
    const first = await app.inject({ method: "POST", url: "/api/imports", payload: { reference: firstUrl } });
    const mirror = await app.inject({ method: "POST", url: "/api/imports", payload: { reference: mirrorUrl } });
    expect(mirror.json().paper.id).toBe(first.json().paper.id);
    expect((await app.inject({ method: "GET", url: "/api/papers" })).json().papers).toHaveLength(1);
    selected = secondBytes;
    const changed = await app.inject({ method: "POST", url: "/api/imports", payload: { reference: firstUrl } });
    expect(changed.json()).toMatchObject({ paper: { id: first.json().paper.id }, versionProposal: true });
    const proposals = (await app.inject({ method: "GET", url: "/api/proposals" })).json().proposals;
    expect(proposals).toEqual(expect.arrayContaining([expect.objectContaining({ proposalType: "paper-version-update", reviewStatus: "pending",
      payload: expect.objectContaining({ sourceType: "direct-pdf", candidateVersionId: expect.any(String) }) })]));
    const proposal = proposals.find((item: { proposalType: string }) => item.proposalType === "paper-version-update");
    const opened = await app.inject({ method: "POST", url: `/api/proposals/${encodeURIComponent(proposal.id)}/open-source` });
    expect(opened.statusCode).toBe(201);
    expect(opened.json().pdfUrl).toMatch(/^\/api\/artifacts\/[0-9a-f]{64}\/pdf#page=1$/);
    const database = new Database(layout.databasePath);
    expect((database.prepare("SELECT count(*) count FROM source_open_events WHERE proposal_id=?")
      .get(proposal.id) as { count: number }).count).toBe(1);
    expect((database.prepare("SELECT count(*) count FROM source_open_tokens WHERE proposal_id=?")
      .get(proposal.id) as { count: number }).count).toBe(0);
    database.close();
    const reopened = await app.inject({ method: "POST", url: `/api/proposals/${encodeURIComponent(proposal.id)}/open-source` });
    expect(reopened.json().pdfUrl).toBe(opened.json().pdfUrl);
    const reopenedDatabase = new Database(layout.databasePath);
    expect((reopenedDatabase.prepare("SELECT count(*) count FROM source_open_events WHERE proposal_id=?")
      .get(proposal.id) as { count: number }).count).toBe(2);
    reopenedDatabase.close();
    const candidatePdf = await app.inject({ method: "GET", url: opened.json().pdfUrl });
    expect(candidatePdf.statusCode).toBe(200);
    expect(candidatePdf.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");
    await app.close();
  });

  it("keeps content deduplication stable after reopening the data root", async () => {
    const layout = initializeDataRoot(join(await mkdtemp(join(tmpdir(), "scholarloom-direct-restart-dedup-")), "data"));
    const bytes = await directPdf();
    const contentHash = createHash("sha256").update(bytes).digest("hex");
    const source = "https://papers.example.test/restart.pdf";
    const directPdfSource = { async prepare(reference: import("../src/domain/paper-import-reference.js").DirectPdfReference) { return {
      reference, sourceIdentity: source, sourceType: "direct-pdf" as const, sourceVersion: `sha256:${contentHash}`,
      canonicalUrl: source, bytes, contentHash, byteSize: bytes.byteLength, mediaType: "application/pdf",
      metadata: { title: "Restart PDF", authors: ["Ada Researcher"], year: 2025 },
    }; } };
    const paperSource = { async resolve(arxivId: string) { return { arxivId, latestVersion: 1, title: "unused", authors: ["unused"], year: 2025 }; } };
    const firstApp = await createApp({ storageLayout: layout, paperSource, directPdfSource });
    const first = await firstApp.inject({ method: "POST", url: "/api/imports", payload: { reference: source } });
    await firstApp.close();
    const reopened = await createApp({ storageLayout: layout, paperSource, directPdfSource });
    const again = await reopened.inject({ method: "POST", url: "/api/imports", payload: { reference: source } });
    expect(again.json().paper.id).toBe(first.json().paper.id);
    expect((await reopened.inject({ method: "GET", url: "/api/papers" })).json().papers).toHaveLength(1);
    await reopened.close();
  });

  it("keeps a changed URL candidate on its original Paper when those bytes already belong to another Paper", async () => {
    const firstBytes = new TextEncoder().encode("%PDF-original-paper");
    const sharedBytes = new TextEncoder().encode("%PDF-other-paper");
    let selected = firstBytes;
    const app = await createApp({
      storageLayout: initializeDataRoot(join(await mkdtemp(join(tmpdir(), "scholarloom-direct-cross-paper-")), "data")),
      paperSource: { async resolve(arxivId) { return { arxivId, latestVersion: 1, title: "unused", authors: ["unused"], year: 2025 }; } },
      directPdfSource: { async prepare(reference) { const hash = createHash("sha256").update(selected).digest("hex"); return {
        reference, sourceIdentity: reference.normalizedUrl, sourceType: "direct-pdf" as const, sourceVersion: `sha256:${hash}`,
        canonicalUrl: reference.normalizedUrl, bytes: selected, contentHash: hash, byteSize: selected.byteLength,
        mediaType: "application/pdf", metadata: { title: "Paper", authors: ["Ada Researcher"], year: 2025 },
      }; } },
    });
    const originalUrl = "https://papers.example.test/original.pdf";
    const original = await app.inject({ method: "POST", url: "/api/imports", payload: { reference: originalUrl } });
    selected = sharedBytes;
    const other = await app.inject({ method: "POST", url: "/api/imports", payload: { reference: "https://papers.example.test/other.pdf" } });
    expect(other.json().paper.id).not.toBe(original.json().paper.id);

    const changed = await app.inject({ method: "POST", url: "/api/imports", payload: { reference: originalUrl } });
    expect(changed.json()).toMatchObject({ paper: { id: original.json().paper.id }, versionProposal: true });
    await app.close();
  });

  it("opens and accepts a changed direct PDF version before ingesting it", async () => {
    let evidence = "Version one evidence.";
    let selected = await directPdf(evidence);
    const source = "https://papers.example.test/versioned.pdf";
    const app = await createApp({
      storageLayout: initializeDataRoot(join(await mkdtemp(join(tmpdir(), "scholarloom-direct-accept-version-")), "data")),
      paperSource: { async resolve(arxivId) { return { arxivId, latestVersion: 1, title: "unused", authors: ["unused"], year: 2025 }; } },
      directPdfSource: { async prepare(reference) { const contentHash = createHash("sha256").update(selected).digest("hex"); return {
        reference, sourceIdentity: source, sourceType: "direct-pdf" as const, sourceVersion: `sha256:${contentHash}`,
        canonicalUrl: source, bytes: selected, contentHash, byteSize: selected.byteLength, mediaType: "application/pdf",
        metadata: { title: "Versioned PDF", authors: ["Ada Researcher"], year: 2025 },
      }; } },
      codexRunner: { async runSummary() { return { sections: [{ key: "overview", title: "概述", body: evidence }],
        claims: [{ voice: "paper-evidence" as const, claim: evidence, sourceHandle: "pdf-page:1" }], readStatus: "read" as const }; } },
    });
    const first = await app.inject({ method: "POST", url: "/api/imports", payload: { reference: source } });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const status = (await app.inject({ method: "GET", url: `/api/imports/${first.json().importRequest.id}` })).json();
      if (status.jobs.at(-1)?.state === "succeeded") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    evidence = "Version two evidence.";
    selected = await directPdf(evidence);
    const changed = await app.inject({ method: "POST", url: "/api/imports", payload: { reference: source } });
    const proposal = (await app.inject({ method: "GET", url: "/api/proposals" })).json().proposals
      .find((item: { proposalType: string }) => item.proposalType === "paper-version-update");
    const opened = await app.inject({ method: "POST", url: `/api/proposals/${encodeURIComponent(proposal.id)}/open-source` });
    await app.inject({ method: "GET", url: opened.json().pdfUrl });
    const accepted = await app.inject({ method: "POST", url: `/api/proposals/${encodeURIComponent(proposal.id)}/decisions`,
      headers: { "idempotency-key": "accept-direct-version" }, payload: { action: "accept" } });
    expect(accepted.statusCode, accepted.body).toBe(202);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const status = (await app.inject({ method: "GET", url: `/api/imports/${changed.json().importRequest.id}` })).json();
      if (status.jobs.at(-1)?.state === "succeeded") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const workspace = (await app.inject({ method: "GET", url: `/api/papers/${encodeURIComponent(first.json().paper.id)}` })).json();
    expect(workspace.paper.versionId).toBe(proposal.payload.candidateVersionId);
    expect(JSON.stringify(workspace.summary)).toContain("Version two evidence.");
    await app.close();
  });

  it("persists metadata-incomplete without creating a fabricated Paper", async () => {
    const layout = initializeDataRoot(join(await mkdtemp(join(tmpdir(), "scholarloom-direct-metadata-")), "data"));
    const bytes = await directPdf();
    const contentHash = createHash("sha256").update(bytes).digest("hex");
    let downloads = 0;
    let frozenReuses = 0;
    const app = await createApp({
      storageLayout: layout,
      paperSource: { async resolve(arxivId) { return { arxivId, latestVersion: 1, title: "unused", authors: ["unused"], year: 2025 }; } },
      directPdfSource: { async prepare(reference) { downloads += 1; throw new DirectPdfPreparationError(
        new PaperSourceError("paper-metadata-incomplete", "缺少 metadata 字段：authors, year"),
        { bytes, contentHash, byteSize: bytes.byteLength, canonicalUrl: reference.normalizedUrl, mediaType: "application/pdf" }, reference);
      }, async prepareDownloaded(reference, downloaded) { frozenReuses += 1; return { ...downloaded, reference,
        sourceIdentity: reference.normalizedUrl, sourceType: "direct-pdf" as const, sourceVersion: `sha256:${downloaded.contentHash}`,
        metadata: { title: "Recovered Metadata", authors: ["Ada Researcher"], year: 2025 } };
      } },
    });
    const failed = await app.inject({ method: "POST", url: "/api/imports", payload: { reference: "https://papers.example.test/incomplete.pdf" } });
    expect(failed.statusCode).toBe(422);
    expect(failed.json()).toMatchObject({ code: "paper-metadata-incomplete", detail: expect.stringContaining("authors, year"),
      importRequest: { status: "failed" } });
    const status = await app.inject({ method: "GET", url: `/api/imports/${failed.json().importRequest.id}` });
    expect(status.json()).toMatchObject({ importRequest: { resolutionStatus: "failed",
      error: { code: "paper-metadata-incomplete", detail: expect.stringContaining("authors, year") } },
      jobs: [expect.objectContaining({ state: "failed", error: expect.objectContaining({ code: "paper-metadata-incomplete", retryable: true }) })] });
    expect((await app.inject({ method: "GET", url: "/api/papers" })).json()).toEqual({ papers: [] });
    expect(existsSync(join(layout.originalsRoot, "papers", contentHash.slice(0, 2), `${contentHash}.pdf`))).toBe(true);
    const retry = await app.inject({ method: "POST", url: `/api/jobs/${status.json().jobs[0].id}/retry`,
      headers: { "idempotency-key": "retry-frozen-metadata" } });
    expect(retry.statusCode, retry.body).toBe(202);
    expect(downloads).toBe(1);
    expect(frozenReuses).toBe(1);
    expect((await app.inject({ method: "GET", url: "/api/papers" })).json().papers).toHaveLength(1);
    await app.close();
  });

  it("reuses the frozen PDF artifact when retrying Summary", async () => {
    const bytes = await directPdf();
    const hash = createHash("sha256").update(bytes).digest("hex");
    let preparations = 0;
    let summaries = 0;
    const source = "https://papers.example.test/retry.pdf";
    const app = await createApp({
      storageLayout: initializeDataRoot(join(await mkdtemp(join(tmpdir(), "scholarloom-direct-retry-")), "data")),
      paperSource: { async resolve(arxivId) { return { arxivId, latestVersion: 1, title: "unused", authors: ["unused"], year: 2025 }; } },
      directPdfSource: { async prepare(reference) { preparations += 1; return { reference, sourceIdentity: source, sourceType: "direct-pdf" as const,
        sourceVersion: `sha256:${hash}`, canonicalUrl: source, bytes, contentHash: hash, byteSize: bytes.byteLength,
        mediaType: "application/pdf", metadata: { title: "Retry PDF", authors: ["Ada Researcher"], year: 2025 } }; } },
      codexRunner: { async runSummary() { summaries += 1; if (summaries === 1) throw new Error("summary failed"); return {
        sections: [{ key: "overview", title: "概述", body: "retry" }], claims: [{ voice: "paper-evidence", claim: "Locate Anything reports grounded localization.", sourceHandle: "pdf-page:1" }], readStatus: "read" }; } },
    });
    const imported = await app.inject({ method: "POST", url: "/api/imports", payload: { reference: source } });
    let failedJob = "";
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const status = (await app.inject({ method: "GET", url: `/api/imports/${imported.json().importRequest.id}` })).json();
      if (status.jobs.at(-1)?.state === "failed") { failedJob = status.jobs.at(-1).id; break; }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const retried = await app.inject({ method: "POST", url: `/api/jobs/${failedJob}/retry`, headers: { "idempotency-key": "direct-retry" } });
    expect(retried.statusCode, retried.body).toBe(202);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const status = (await app.inject({ method: "GET", url: `/api/imports/${imported.json().importRequest.id}` })).json();
      if (status.jobs.at(-1)?.state === "succeeded") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(preparations).toBe(1);
    expect(summaries).toBe(2);
    expect((await app.inject({ method: "GET", url: "/api/papers" })).json().papers).toHaveLength(1);
    await app.close();
  });
});
