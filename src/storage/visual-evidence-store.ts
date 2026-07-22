import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync,
  rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import type Database from "better-sqlite3";

import type { StorageLayout } from "./layout.js";
import { PDF_RENDERER_FINGERPRINT, PDF_RENDER_SETTINGS, type FrozenPdfSource, type PdfPageRenderer } from "./pdf-page-renderer.js";
import { assertNoSymlinkPath, ensureNoSymlinkDirectory, readRegularFileNoFollow } from "./safe-local-path.js";

export type StoredVisualRender = {
  artifactId: string;
  imageHash: string;
  storageRef: string;
  imageBytes: Buffer;
  reused: boolean;
  page: number;
  pageCount: number;
  pixelWidth: number;
  pixelHeight: number;
  rendererName: string;
  rendererVersion: string;
  rendererFingerprint: string;
  renderSettings: typeof PDF_RENDER_SETTINGS;
};

type ArtifactRow = {
  id: string;
  image_content_hash: string;
  storage_ref: string;
  byte_size: number;
  pixel_width: number;
  pixel_height: number;
  page_count: number;
  renderer_name: string;
  renderer_version: string;
  renderer_fingerprint: string;
  render_settings_json: string;
  cache_state: string;
};

export class VisualEvidenceStore {
  constructor(private readonly layout: StorageLayout, private readonly database: Database.Database,
    private readonly renderer: PdfPageRenderer) {}

  async renderPage(source: FrozenPdfSource, page: number): Promise<StoredVisualRender> {
    const settingsJson = JSON.stringify(PDF_RENDER_SETTINGS);
    const cacheKey = createHash("sha256").update(JSON.stringify({ sourceHash: source.contentHash, page,
      rendererFingerprint: PDF_RENDERER_FINGERPRINT, settings: PDF_RENDER_SETTINGS })).digest("hex");
    const artifactId = `visual-render:${cacheKey}`;
    const existing = this.#artifact(artifactId);
    if (existing?.cache_state === "render-drift") throw new Error("visual-render-drift");
    if (existing && existing.cache_state === "complete") {
      const bytes = this.#readVerified(existing);
      if (bytes) {
        this.database.prepare("UPDATE visual_render_artifacts SET last_accessed_at=? WHERE id=?")
          .run(new Date().toISOString(), artifactId);
        return this.#stored(existing, bytes, page, true);
      }
    }

    const rendered = await this.renderer.render(source, page);
    if (existing && rendered.imageHash !== existing.image_content_hash) {
      this.#recordDrift(existing, rendered.imageHash);
      throw new Error("visual-render-drift");
    }
    const storageRef = join("derived", "visual-evidence", cacheKey.slice(0, 2), cacheKey, "page.png");
    this.#writeCompletedArtifact(storageRef, rendered.imageBytes, {
      cacheKey, sourceContentHash: source.contentHash, page, imageContentHash: rendered.imageHash,
      rendererFingerprint: rendered.descriptor.rendererFingerprint, settings: rendered.descriptor.settings,
    }, Boolean(existing));
    const now = new Date().toISOString();
    this.database.prepare(`INSERT INTO visual_render_artifacts
      (id,source_artifact_id,source_content_hash,page_number,renderer_name,renderer_version,renderer_fingerprint,
       render_settings_json,image_content_hash,storage_ref,media_type,byte_size,pixel_width,pixel_height,page_count,cache_state,created_at,last_accessed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,'image/png',?,?,?,?,'complete',?,?)
      ON CONFLICT(id) DO UPDATE SET storage_ref=excluded.storage_ref,cache_state='complete',last_accessed_at=excluded.last_accessed_at`)
      .run(artifactId, source.artifactId, source.contentHash, page, rendered.descriptor.rendererName,
        rendered.descriptor.rendererVersion, rendered.descriptor.rendererFingerprint, settingsJson, rendered.imageHash,
        storageRef, rendered.imageBytes.length, rendered.descriptor.pixelWidth, rendered.descriptor.pixelHeight,
        rendered.descriptor.pageCount, now, now);
    return { artifactId, imageHash: rendered.imageHash, storageRef, imageBytes: rendered.imageBytes, reused: false,
      page, pageCount: rendered.descriptor.pageCount, pixelWidth: rendered.descriptor.pixelWidth,
      pixelHeight: rendered.descriptor.pixelHeight, rendererName: rendered.descriptor.rendererName,
      rendererVersion: rendered.descriptor.rendererVersion, rendererFingerprint: rendered.descriptor.rendererFingerprint,
      renderSettings: rendered.descriptor.settings };
  }

  collectGarbage(input: { retainUnreferenced: number }): { removedArtifactIds: string[] } {
    if (!Number.isInteger(input.retainUnreferenced) || input.retainUnreferenced < 0) {
      throw new Error("visual-gc-retention-invalid");
    }
    const rows = this.database.prepare(`SELECT artifact.id,artifact.storage_ref
      FROM visual_render_artifacts artifact
      WHERE NOT EXISTS (SELECT 1 FROM visual_evidence_receipts receipt WHERE receipt.render_artifact_id=artifact.id)
      ORDER BY artifact.last_accessed_at DESC,artifact.id DESC`).all() as Array<{ id: string; storage_ref: string }>;
    const removable = rows.slice(input.retainUnreferenced);
    for (const row of removable) {
      const artifactPath = join(this.layout.root, row.storage_ref);
      if (!this.#isInsideDerived(artifactPath)) throw new Error("visual-render-path-unsafe");
      assertNoSymlinkPath(this.layout.derivedRoot, dirname(artifactPath), "visual-render-path-unsafe");
      rmSync(dirname(artifactPath), { recursive: true, force: true });
      this.database.prepare("DELETE FROM visual_render_artifacts WHERE id=?").run(row.id);
    }
    return { removedArtifactIds: removable.map((row) => row.id) };
  }

  async recoverReceiptImage(input: { source: FrozenPdfSource; page: number; renderArtifactId: string;
    rendererFingerprint: string; renderSettings: Record<string, unknown>; imageHash: string }): Promise<
      { status: "verified"; imageBytes: Buffer } | { status: "renderer-unavailable" | "render-drift" }> {
    if (input.rendererFingerprint !== PDF_RENDERER_FINGERPRINT ||
        JSON.stringify(input.renderSettings) !== JSON.stringify(PDF_RENDER_SETTINGS)) {
      return { status: "renderer-unavailable" };
    }
    const row = this.#artifact(input.renderArtifactId);
    if (!row || row.image_content_hash !== input.imageHash) return { status: "render-drift" };
    if (row.cache_state === "render-drift") return { status: "render-drift" };
    const cached = this.#readVerified(row);
    if (cached) return { status: "verified", imageBytes: cached };
    try {
      const rebuilt = await this.renderPage(input.source, input.page);
      return rebuilt.artifactId === input.renderArtifactId && rebuilt.imageHash === input.imageHash
        ? { status: "verified", imageBytes: rebuilt.imageBytes }
        : { status: "render-drift" };
    } catch (error) {
      if (error instanceof Error && error.message === "visual-render-drift") return { status: "render-drift" };
      throw error;
    }
  }

  #artifact(id: string): ArtifactRow | undefined {
    return this.database.prepare(`SELECT id,image_content_hash,storage_ref,byte_size,pixel_width,pixel_height,
      renderer_name,renderer_version,renderer_fingerprint,render_settings_json,cache_state,page_count
      FROM visual_render_artifacts WHERE id=?`).get(id) as ArtifactRow | undefined;
  }

  #readVerified(row: ArtifactRow): Buffer | null {
    const absolute = join(this.layout.root, row.storage_ref);
    if (!this.#isInsideDerived(absolute) || !existsSync(absolute)) return null;
    let opened: { bytes: Buffer; size: number };
    try { opened = readRegularFileNoFollow(this.layout.derivedRoot, absolute, "visual-render-path-unsafe"); }
    catch (error) {
      if (error instanceof Error && error.message === "visual-render-path-unsafe") throw error;
      return null;
    }
    if (opened.size !== row.byte_size) return null;
    const bytes = opened.bytes;
    return createHash("sha256").update(bytes).digest("hex") === row.image_content_hash ? bytes : null;
  }

  #stored(row: ArtifactRow, imageBytes: Buffer, page: number, reused: boolean): StoredVisualRender {
    return { artifactId: row.id, imageHash: row.image_content_hash, storageRef: row.storage_ref, imageBytes, reused, page,
      pageCount: row.page_count, pixelWidth: row.pixel_width, pixelHeight: row.pixel_height, rendererName: row.renderer_name,
      rendererVersion: row.renderer_version, rendererFingerprint: row.renderer_fingerprint,
      renderSettings: JSON.parse(row.render_settings_json) as typeof PDF_RENDER_SETTINGS };
  }

  #writeCompletedArtifact(storageRef: string, bytes: Buffer, descriptor: object, replaceInvalid: boolean): void {
    const target = join(this.layout.root, storageRef);
    if (!this.#isInsideDerived(target)) throw new Error("visual-render-path-unsafe");
    const targetDirectory = dirname(target);
    const parent = dirname(targetDirectory);
    ensureNoSymlinkDirectory(this.layout.derivedRoot, parent, "visual-render-path-unsafe");
    const building = `${targetDirectory}.building-${randomUUID()}`;
    mkdirSync(building, { mode: 0o700 });
    try {
      const imagePath = join(building, "page.png");
      const completePath = join(building, "COMPLETE.json");
      writeFileSync(imagePath, bytes, { mode: 0o600 });
      writeFileSync(completePath, `${JSON.stringify(descriptor)}\n`, { encoding: "utf8", mode: 0o600 });
      for (const path of [imagePath, completePath]) {
        const fd = openSync(path, "r");
        try { fsyncSync(fd); } finally { closeSync(fd); }
        chmodSync(path, 0o400);
      }
      const directoryFd = openSync(building, "r");
      try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
      if (existsSync(targetDirectory)) {
        if (this.#publishedMatches(target, bytes)) return;
        if (!replaceInvalid) throw new Error("visual-render-publish-conflict");
        assertNoSymlinkPath(this.layout.derivedRoot, targetDirectory, "visual-render-path-unsafe");
        const invalid = `${targetDirectory}.invalid-${randomUUID()}`;
        renameSync(targetDirectory, invalid);
        try { renameSync(building, targetDirectory); }
        catch (error) {
          if (!existsSync(targetDirectory)) renameSync(invalid, targetDirectory);
          throw error;
        }
        rmSync(invalid, { recursive: true, force: true });
        const parentFd = openSync(parent, "r");
        try { fsyncSync(parentFd); } finally { closeSync(parentFd); }
        return;
      }
      try { renameSync(building, targetDirectory); }
      catch (error) {
        if (!existsSync(targetDirectory) || !this.#publishedMatches(target, bytes)) throw error;
      }
      const parentFd = openSync(parent, "r");
      try { fsyncSync(parentFd); } finally { closeSync(parentFd); }
    } finally { if (existsSync(building)) rmSync(building, { recursive: true, force: true }); }
  }

  #publishedMatches(target: string, expected: Buffer): boolean {
    if (!existsSync(target)) return false;
    const opened = readRegularFileNoFollow(this.layout.derivedRoot, target, "visual-render-path-unsafe");
    if (opened.size !== expected.length) return false;
    return createHash("sha256").update(opened.bytes).digest("hex") ===
      createHash("sha256").update(expected).digest("hex");
  }

  #recordDrift(row: ArtifactRow, actualHash: string): void {
    const now = new Date().toISOString();
    this.database.transaction(() => {
      this.database.prepare("UPDATE visual_render_artifacts SET cache_state='render-drift',last_accessed_at=? WHERE id=?")
        .run(now, row.id);
      this.database.prepare("INSERT INTO durable_events(scope,event_type,data_json,created_at) VALUES (?,'visual-render-drift',?,?)")
        .run(row.id, JSON.stringify({ expectedHash: row.image_content_hash, actualHash,
          rendererFingerprint: row.renderer_fingerprint }), now);
    })();
  }

  #isInsideDerived(path: string): boolean {
    const fromRoot = relative(this.layout.derivedRoot, path);
    return fromRoot !== "" && !fromRoot.startsWith("..") && !fromRoot.startsWith("/");
  }
}
