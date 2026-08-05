# PDF.js Request Policy Benchmark - 2026-08-05

## Decision

Keep native Chromium as the default reader. Keep PDF.js `range-first` separately
opt-in while expanding the corpus, but retain the implementation: it removed the
full-response race and materially improved first render for the affected ViT sample
without regressing the GPT-3 sample.

Enable the spike with both flags:

```bash
SCHOLARLOOM_PDF_VIEWER=pdfjs \
SCHOLARLOOM_PDFJS_REQUEST_POLICY=range-first \
npm start
```

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

- Retain `range-first` behind its own runtime flag; do not couple it to qpdf delivery.
- Do not promote PDF.js or range-first from two single-run samples. Repeat across the
  versioned 20-Paper promotion corpus, including far-page navigation and idle traffic.
- Measure worker-inclusive RSS/CPU before release. The current CDP values cover only
  the page target.
- Keep native fallback and native new-window access. Request-policy improvement does
  not provide text selection, search, print, or document accessibility.

## Reproduction

Start one mode at a time, with lossless delivery disabled so both modes receive the
same original bytes:

```bash
SCHOLARLOOM_BENCHMARK_ARXIV_ID=2010.11929 \
SCHOLARLOOM_BENCHMARK_PDF_OPTIMIZATION=off \
SCHOLARLOOM_PORT=3018 \
npm run benchmark:pdf-delivery:serve

SCHOLARLOOM_BENCHMARK_ARXIV_ID=2010.11929 \
SCHOLARLOOM_BENCHMARK_PDF_OPTIMIZATION=off \
SCHOLARLOOM_PDFJS_REQUEST_POLICY=range-first \
SCHOLARLOOM_PORT=3018 \
npm run benchmark:pdf-delivery:serve
```

For each server, use a fresh Playwright CLI session:

```bash
$HOME/.codex/skills/playwright/scripts/playwright_cli.sh --session pdfjs-policy open http://127.0.0.1:3018/ --headed
$HOME/.codex/skills/playwright/scripts/playwright_cli.sh --session pdfjs-policy run-code --filename src/benchmark/pdf-first-render.playwright.mjs
```
