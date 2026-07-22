import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import Database from "better-sqlite3";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";

import { PdfPageRenderer } from "../src/storage/pdf-page-renderer.js";
import { VisualEvidenceStore } from "../src/storage/visual-evidence-store.js";
import { initializeDataRoot } from "../src/storage/layout.js";
import { migrate } from "../src/storage/migrations.js";

describe("VisualEvidenceStore", () => {
  it("reuses the same content-addressed artifact for the same frozen page", async () => {
    const fixture = await visualFixture();
    const store = new VisualEvidenceStore(fixture.layout, fixture.database, new PdfPageRenderer());

    const first = await store.renderPage(fixture.source, 1);
    const second = await store.renderPage(fixture.source, 1);

    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.artifactId).toBe(first.artifactId);
    expect(second.imageHash).toBe(first.imageHash);
    expect(second.storageRef).toBe(first.storageRef);
    expect(fixture.database.prepare("SELECT count(*) FROM visual_render_artifacts").pluck().get()).toBe(1);
    fixture.database.close();
  });

  it("garbage-collects unreferenced render artifacts", async () => {
    const fixture = await visualFixture();
    const store = new VisualEvidenceStore(fixture.layout, fixture.database, new PdfPageRenderer());
    const rendered = await store.renderPage(fixture.source, 1);

    const result = store.collectGarbage({ retainUnreferenced: 0 });

    expect(result.removedArtifactIds).toEqual([rendered.artifactId]);
    await expect(access(join(fixture.layout.root, rendered.storageRef))).rejects.toThrow();
    expect(fixture.database.prepare("SELECT count(*) FROM visual_render_artifacts").pluck().get()).toBe(0);
    fixture.database.close();
  });

  it("deterministically rebuilds a missing cached image", async () => {
    const fixture = await visualFixture();
    const store = new VisualEvidenceStore(fixture.layout, fixture.database, new PdfPageRenderer());
    const first = await store.renderPage(fixture.source, 1);
    await rm(dirname(join(fixture.layout.root, first.storageRef)), { recursive: true, force: true });

    const rebuilt = await store.renderPage(fixture.source, 1);

    expect(rebuilt.reused).toBe(false);
    expect(rebuilt.imageHash).toBe(first.imageHash);
    await expect(access(join(fixture.layout.root, rebuilt.storageRef))).resolves.toBeUndefined();
    fixture.database.close();
  });

  it("replaces a partially missing cache directory atomically", async () => {
    const fixture = await visualFixture();
    const store = new VisualEvidenceStore(fixture.layout, fixture.database, new PdfPageRenderer());
    const first = await store.renderPage(fixture.source, 1);
    await unlink(join(fixture.layout.root, first.storageRef));

    const rebuilt = await store.renderPage(fixture.source, 1);

    expect(rebuilt.imageHash).toBe(first.imageHash);
    await expect(access(join(fixture.layout.root, rebuilt.storageRef))).resolves.toBeUndefined();
    fixture.database.close();
  });

  it("rejects a symlinked visual-cache ancestor", async () => {
    const fixture = await visualFixture();
    const store = new VisualEvidenceStore(fixture.layout, fixture.database, new PdfPageRenderer());
    const first = await store.renderPage(fixture.source, 1);
    const shard = dirname(dirname(join(fixture.layout.root, first.storageRef)));
    const outside = `${shard}-outside`;
    await rename(shard, outside);
    await symlink(outside, shard, "dir");

    await expect(store.renderPage(fixture.source, 1)).rejects.toThrow("visual-render-path-unsafe");

    await unlink(shard);
    await rename(outside, shard);
    fixture.database.close();
  });

  it("records render-drift instead of accepting a mismatched rebuild", async () => {
    const fixture = await visualFixture();
    const renderer = new PdfPageRenderer();
    const store = new VisualEvidenceStore(fixture.layout, fixture.database, renderer);
    const first = await store.renderPage(fixture.source, 1);
    await rm(dirname(join(fixture.layout.root, first.storageRef)), { recursive: true, force: true });
    const driftingRenderer = { async render(source: typeof fixture.source, page: number) {
      const rendered = await renderer.render(source, page);
      const imageBytes = Buffer.concat([rendered.imageBytes, Buffer.from("drift")]);
      return { ...rendered, imageBytes, imageHash: createHash("sha256").update(imageBytes).digest("hex") };
    } };

    await expect(new VisualEvidenceStore(fixture.layout, fixture.database, driftingRenderer)
      .renderPage(fixture.source, 1)).rejects.toThrow("visual-render-drift");

    expect(fixture.database.prepare("SELECT cache_state FROM visual_render_artifacts WHERE id=?")
      .pluck().get(first.artifactId)).toBe("render-drift");
    expect(fixture.database.prepare("SELECT count(*) FROM durable_events WHERE event_type='visual-render-drift'")
      .pluck().get()).toBe(1);
    fixture.database.close();
  });
});

async function visualFixture() {
  const root = await mkdtemp(join(tmpdir(), "scholarloom-visual-store-"));
  const layout = initializeDataRoot(join(root, "data"));
  const database = new Database(layout.databasePath);
  database.pragma("foreign_keys = ON");
  migrate(database);
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage([240, 180]).drawText("visual fixture", { x: 20, y: 120, font });
  const bytes = Buffer.from(await pdf.save({ useObjectStreams: false }));
  const contentHash = createHash("sha256").update(bytes).digest("hex");
  const storageRef = join("originals", "papers", contentHash.slice(0, 2), `${contentHash}.pdf`);
  await mkdir(dirname(join(layout.root, storageRef)), { recursive: true });
  await writeFile(join(layout.root, storageRef), bytes);
  const artifactId = `artifact:pdf:${contentHash}`;
  database.prepare(`INSERT INTO artifacts
    (id,artifact_type,content_hash,storage_ref,media_type,byte_size,created_by_kind,retention_class,created_at)
    VALUES (?,'paper-pdf',?,?, 'application/pdf',?,'external-source','irreplaceable',?)`)
    .run(artifactId, contentHash, storageRef, bytes.length, new Date().toISOString());
  return { layout, database, source: { artifactId, contentHash, bytes } };
}
