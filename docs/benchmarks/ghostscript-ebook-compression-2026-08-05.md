# Ghostscript `/ebook` PDF Compression Benchmark - 2026-08-05

## Decision

Do **not** integrate Ghostscript `-dPDFSETTINGS=/ebook` into the derived PDF
delivery pipeline. The six-Paper corpus reduced total bytes by 81.52%, but zero
candidates passed the quality gates. Several outputs omitted complete scholarly
figures while retaining their captions, one contained a bad indirect reference,
four changed extracted text, and two changed page geometry.

The benchmark runner remains available for evaluating a future strategy with
explicit image-only controls. Originals remain immutable and no Ghostscript output
is selected or recorded in SQLite.

## Method

The corpus pins six public arXiv Paper Versions by URL and SHA-256. Ghostscript
10.07.1 runs `pdfwrite` with PDF 1.5 compatibility, `/ebook`, annotation and marked
content preservation, and omitted volatile Info dates/trailer IDs. Stable
`DocumentUUID` and `InstanceUUID` values are derived from the source SHA-256 because
Ghostscript's generated XMP UUID otherwise changes between identical runs.

Each source is compressed twice. A candidate must satisfy all of these gates:

- identical hashes across both runs;
- qpdf 12.3.2 structural validation without warnings;
- at least 30% byte reduction;
- identical page count, page geometry, normalized extracted text, outline targets,
  Link/Widget annotation semantics, and structured-content signals;
- RGB block SSIM of at least 0.99 for first, middle, last, image-heavy, and every
  text/annotation-mismatch page;
- manual inspection of rendered equations, charts, small text, colors, and page
  boundaries.

[Ghostscript's pdfwrite documentation](https://ghostscript.readthedocs.io/en/latest/VectorDevices.html)
warns that `PDFSETTINGS` presets alter the input in multiple ways and that pdfwrite
creates a new PDF from marking operations rather than modifying the source in place.

## Corpus results

| Paper Version | Original | `/ebook` | Reduction | First run | Structural | Text | Geometry | Decision |
|---|---:|---:|---:|---:|---|---|---|---|
| Attention v7 | 2,215,244 B | 215,117 B | 90.29% | 330 ms | pass | fail | pass | no-go |
| BERT v2 | 775,166 B | 152,180 B | 80.37% | 203 ms | pass | fail | fail | no-go |
| GPT-3 v4 | 6,768,044 B | 2,022,625 B | 70.12% | 2,822 ms | pass | pass | pass | no-go |
| LLaMA v1 | 726,566 B | 195,628 B | 73.07% | 240 ms | pass | fail | fail | no-go |
| ViT v2 | 3,743,814 B | 537,107 B | 85.65% | 776 ms | **fail** | n/a | n/a | no-go |
| Hunyuan3D v5 | 6,512,838 B | 709,958 B | 89.10% | 8,298 ms | pass | fail | pass | no-go |
| **Total** | **20,741,672 B** | **3,832,615 B** | **81.52%** | **12,670 ms** | 5/6 | 2/6 | 4/6 | **0/6 go** |

All six repeated outputs were byte-for-byte deterministic after source-derived XMP
UUIDs were added. All page counts, outline destinations, annotation semantics, and
structured-content signals matched for the five structurally valid candidates.
The destination comparison resolves named and explicit destinations to page/coordinate
semantics, so Ghostscript object-number rewrites do not create false failures.

## Rendering findings

The automatic renderer and manual checks found material content loss, not merely
acceptable 150 dpi softening:

- Attention page 15: both attention-head diagrams disappeared; SSIM 0.867008.
- BERT page 15: the complete fine-tuning task illustration disappeared; SSIM 0.894367.
- LLaMA page 8: the six-panel training-performance chart disappeared; SSIM 0.878386.
- Hunyuan3D page 3: the complete pipeline overview disappeared while its caption
  remained; SSIM 0.914286.
- GPT-3 page 67 retained all plots but visibly softened axes, legends, and small
  labels; SSIM 0.899793.
- ViT produced qpdf's `bad indirect reference (-1 0 R)` warning and was rejected
  before semantic/render inspection.

Ghostscript 10.07.1 was also used to render its own generated PDFs. It reproduced
the missing figures, confirming that these were absent from the candidate files and
not a PDF.js-only rendering incompatibility. Adding `-dWantsOptionalContent=true`
did not restore Hunyuan3D's missing overview.

## Consequences

- Keep native Chromium PDF viewing and immutable HTTP caching as the default path.
- Keep `lossless-linearization` opt-in; this benchmark does not change ADR 0014's
  accepted production strategy.
- Do not add `ebook-compression` to migrations, SQLite strategy checks, startup
  backfill, imports, or delivery selection.
- A future Ghostscript experiment must avoid `PDFSETTINGS` presets and start from
  explicit image downsampling/compression controls, with identical fail-closed gates.
- Never claim that `/ebook` affects only embedded raster images; this corpus shows
  changes to vector figures, text extraction, page geometry, and PDF structure.

## Reproduction

```bash
npm run benchmark:pdf-compression
```

An optional local corpus directory is checked before network download, and an exact
comma-separated Paper Version filter can limit a run:

```bash
SCHOLARLOOM_PDF_CORPUS_DIR=/path/to/pinned-pdfs \
SCHOLARLOOM_PDF_CORPUS_FILTER=2411.02293v5 \
npm run benchmark:pdf-compression
```

Local files are named `<arxiv-id>v<version>.pdf`; their bytes still must match the
pinned manifest hash. Reports, candidates, and PNG comparisons are written under
`output/pdf/ghostscript-ebook/`, which is ignored and rebuildable.
