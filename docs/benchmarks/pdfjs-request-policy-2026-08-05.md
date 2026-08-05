# PDF.js Request Policy Benchmark - 2026-08-05

## Final decision

This is a historical experiment record. The embedded PDF.js reader and `range-first`
runtime flags were removed after a real Hunyuan3D v5 reading journey showed that the
canvas-only implementation exposed only one current page and delivered a worse overall
experience than Chromium native viewer. The earlier ViT transport improvement did not
justify retaining an incomplete reader.

`range-first` maps to PDF.js `disableStream: true` and `disableAutoFetch: true`.
The installed PDF.js 6.1.200 contract states that streaming must also be disabled
for disabling pre-fetch to work correctly. Missing or unknown values preserve the
PDF.js default request policy.

## Method

The comparison used two pinned original arXiv Paper Versions from the existing PDF
delivery corpus. Each mode ran in a fresh headed Chrome session against a new
temporary ScholarLoom data root. Chrome was throttled to 2 MiB/s throughput and
40 ms latency. The journey measured first-page render, then clicked the Summary
Evidence claim and waited for page 2 to render in the same PDF.js document.

TaskDuration and JS heap are Chrome page-target metrics. They exclude the PDF.js
worker process and are lower bounds. Results are single-run diagnostics, not p95s.

## Results

| Paper Version | Policy | First page | Evidence p.2 | Completed response bodies at first page | Full PDF complete? | TaskDuration to first page |
|---|---|---:|---:|---:|---|---:|
| GPT-3 v4 | default | 1.904 s | 73 ms | 411,052 B | no | 177 ms |
| GPT-3 v4 | range-first | 1.914 s | 66 ms | 411,052 B | no | 174 ms |
| ViT v2 | default | 3.408 s | 53 ms | 3,817,612 B | yes | 418 ms |
| ViT v2 | range-first | 1.906 s | 79 ms | 467,014 B | no | 166 ms |

For GPT-3, both policies requested the same leading and tail ranges. Range-first
cancelled the initial full `200` response at zero decoded bytes, but default also
rendered before that response completed, so latency and completed bytes were neutral.

For ViT, default completed the full 3,743,814-byte PDF plus overlapping ranges before
page 1 rendered. Range-first cancelled the full response, completed only bounded
ranges, reduced completed response-body traffic by 87.8%, and reduced first-render
time by 44.1%. The page-2 Evidence transition became 26 ms slower but remained below
the existing 250 ms promotion threshold.

## Consequences

- Chromium native viewer is the sole browser reader.
- The removed environment variables and dedicated benchmark/browser commands are no
  longer accepted operational interfaces.
- `pdfjs-dist` remains a server-side dependency for extraction, PDF validation, and
  deterministic page rendering; this retirement concerns only the embedded browser reader.
- Lossless qpdf delivery remains an independent opt-in pipeline and continues to fall
  back to immutable original bytes.
