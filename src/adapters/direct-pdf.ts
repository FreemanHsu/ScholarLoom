import type { DirectPdfReference } from "../domain/paper-import-reference.js";
import { PdfMetadataExtractor, type PaperMetadata } from "./pdf-metadata.js";
import { SafePdfDownloader, type DownloadedPdf } from "./safe-pdf-downloader.js";
import { PaperSourceError } from "./safe-pdf-downloader.js";

export type PreparedDirectPdfImport = DownloadedPdf & {
  reference: DirectPdfReference;
  sourceIdentity: string;
  sourceType: "direct-pdf";
  sourceVersion: string;
  metadata: PaperMetadata;
};

export interface PaperSourceAdapter<TReference, TPrepared> {
  prepare(reference: TReference): Promise<TPrepared>;
}

export class DirectPdfPreparationError extends PaperSourceError {
  constructor(error: PaperSourceError, readonly downloaded: DownloadedPdf, readonly reference: DirectPdfReference) {
    super(error.code, error.message);
  }
}

export class DirectPdfSource implements PaperSourceAdapter<DirectPdfReference, PreparedDirectPdfImport> {
  constructor(readonly downloader = new SafePdfDownloader(), readonly metadata = new PdfMetadataExtractor()) {}

  async prepare(reference: DirectPdfReference): Promise<PreparedDirectPdfImport> {
    const downloaded = await this.downloader.download(reference.normalizedUrl);
    return this.prepareDownloaded(reference, downloaded);
  }

  async prepareDownloaded(reference: DirectPdfReference, downloaded: DownloadedPdf): Promise<PreparedDirectPdfImport> {
    let metadata: PaperMetadata;
    try { metadata = await this.metadata.extract(downloaded.bytes); }
    catch (error) {
      if (error instanceof PaperSourceError) throw new DirectPdfPreparationError(error, downloaded, reference);
      throw error;
    }
    return { ...downloaded, reference, metadata, sourceIdentity: reference.normalizedUrl,
      sourceType: "direct-pdf", sourceVersion: `sha256:${downloaded.contentHash}` };
  }
}
