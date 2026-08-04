# ADR 0014: Rebuildable Lossless PDF Delivery

- Status: Accepted
- Date: 2026-08-04

## Context

Immutable source PDFs are the evidence authority, but a non-linearized file may require
most or all bytes before its first page can render. HTTP streaming and Range support do
not change the source layout, and PDF.js does not compress or linearize the document.
Delivery optimization must therefore improve transport without replacing source identity,
changing evidence extraction, or making a derived file authoritative.

## Decision

Lossless linearization is an opt-in delivery strategy enabled with
`SCHOLARLOOM_PDF_OPTIMIZATION=lossless-linearization`. The `PdfDeliveryOptimizer` module
owns tool invocation, validation, content-addressed publication, selection, metrics,
lineage, fallback, reuse, and startup rebuilding behind one `prepare` interface.

The production adapter invokes qpdf without a shell. PDFs smaller than 1 MiB and sources
already reported linearized are skipped. A candidate is selected only when qpdf validates
both PDF structure and linearization, PDF.js reports the same page count as the original,
and output size is no more than 102% of the source size. qpdf is lossless; a real renderer
regression additionally requires identical page-image hashes before the adapter is accepted.
qpdf runs with `--deterministic-id`, and this choice is part of the canonical generation
parameters so rebuilding the same source does not create a new delivery identity.

Original PDFs remain read-only under `originals/papers` and continue to drive extraction,
Evidence Anchors, and source identity. Selected outputs are content-addressed
`paper-pdf-delivery` Artifacts under `derived/pdf-delivery`, linked to the original with
`delivery-derived-from`. SQLite stores only hashes, relative paths, tool/version,
parameters, status, reason, byte counts, page counts, and timings; it stores no PDF blob.

Tool absence, small input, already-linearized input, excessive size inflation, tool error,
structural failure, or page-count mismatch records a bounded decision and serves the
original. Optimizer failure never fails Paper import. A healthy selected output is reused
without rerunning qpdf. Startup backfill rebuilds missing selected output after a default
snapshot restore and opportunistically evaluates existing Paper PDFs; the original remains
readable while rebuilding.

Selection is gated by the same runtime flag as generation. When the flag is off, Paper
Workspace and version redirects serve the original even if a selected derived Artifact is
already present. Direct content-hash access remains valid for immutable URLs, but does not
change the runtime selection policy. Candidate selection uses the normal PDF integrity path,
so a missing or same-size-corrupt derived file falls through to the verified original.

## Consequences

- Artifact URLs and ETags identify the bytes actually delivered.
- Default snapshots remain small and authoritative; derived delivery files are optional.
- Enabling the strategy adds bounded import CPU/I/O and requires qpdf for optimization,
  while missing qpdf degrades safely to the original.
- A five-Paper real corpus preserved all nine sampled page renders and reduced eligible
  output size by 0.60%-3.08%, but browser A/B samples showed no meaningful first-page
  latency improvement. The strategy therefore remains opt-in.
- Image downsampling and lossy compression are separate future strategies with independent
  quality review; they are not implied by this ADR.
