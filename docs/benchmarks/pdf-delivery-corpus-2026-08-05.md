# PDF Delivery Corpus Benchmark - 2026-08-05

## Decision

Keep `SCHOLARLOOM_PDF_OPTIMIZATION=lossless-linearization` opt-in. The real-Paper
corpus supports the pipeline's safety and rebuildability, but does **not** show a
repeatable first-page latency improvement large enough to enable it by default.

The benchmark also found that qpdf's default document ID is non-deterministic.
Production linearization now uses `--deterministic-id --linearize`; the generation
parameters record `deterministicId: true`, and two runs over the same source must
produce the same delivery hash.

## Corpus and method

The manifest pins five public arXiv Paper Versions by URL and source SHA-256. PDFs
are downloaded sequentially into a system temporary directory, imported through
the ordinary ScholarLoom Import Request path, and deleted after the run. No PDF or
production data is written to the repository.

Selected delivery Artifacts must pass qpdf structure/linearization validation,
PDF.js page-count parity, the 102% size gate, and deterministic renderer parity for
the first, middle, and last pages. Browser samples use headed Chrome, PDF.js, a warm
application shell, 2 MiB/s throughput, and 40 ms latency.

Sources:

- [Attention Is All You Need, arXiv:1706.03762v7](https://arxiv.org/abs/1706.03762v7)
- [BERT, arXiv:1810.04805v2](https://arxiv.org/abs/1810.04805v2)
- [Language Models are Few-Shot Learners, arXiv:2005.14165v4](https://arxiv.org/abs/2005.14165v4)
- [LLaMA, arXiv:2302.13971v1](https://arxiv.org/abs/2302.13971v1)
- [An Image is Worth 16x16 Words, arXiv:2010.11929v2](https://arxiv.org/abs/2010.11929v2)

## Structural results

| Paper Version | Pages | Original | Decision | Delivery | Size change | qpdf | Render parity |
|---|---:|---:|---|---:|---:|---:|---|
| Attention v7 | 15 | 2,215,244 B | selected | 2,146,996 B | -3.08% | 373 ms | 3/3 |
| BERT v2 | 16 | 775,166 B | below minimum | - | - | <1 ms | n/a |
| GPT-3 v4 | 75 | 6,768,044 B | selected | 6,727,187 B | -0.60% | 196 ms | 3/3 |
| LLaMA v1 | 27 | 726,566 B | below minimum | - | - | <1 ms | n/a |
| ViT v2 | 22 | 3,743,814 B | selected | 3,703,352 B | -1.08% | 90 ms | 3/3 |

All five originals were non-linearized. Three were selected, two were skipped by
the 1 MiB gate, none failed, and all nine sampled selected pages had identical
source/delivery image hashes.

## Browser comparison

| Paper Version | Mode | First page | Full PDF complete first? | Observation |
|---|---|---:|---|---|
| GPT-3 v4 | original | 1.900 s | no | 411,052 completed Range bytes |
| GPT-3 v4 | linearized | 1.906 s | no | 239,123 completed Range bytes |
| ViT v2 | original | 3.414 s | yes | complete 3.74 MiB response before render |
| ViT v2 | linearized | 3.411 s | yes | complete 3.70 MiB response before render |
| Attention v7 | linearized | 2.411 s | yes | complete 2.15 MiB response before render |

These are single-run diagnostic samples, not statistical performance claims. GPT-3
showed lower pre-render Range traffic after linearization but no latency change.
ViT showed neither a meaningful latency nor transport change; its result suggests
render work, not PDF byte layout, dominates the observed first page.

## Consequences and next experiment

- Keep native PDF as the default reader and lossless delivery disabled by default.
- Keep the qpdf pipeline available for gated evaluation: it preserved sampled
  rendering and reduced total bytes for all three eligible sources.
- Do not use the synthetic attached-payload fixture as evidence of real-Paper speedup.
- The follow-up PDF.js request-policy spike found a ViT transport improvement but failed
  broader reading acceptance on Hunyuan3D v5. Its embedded reader and runtime policy were
  removed; see the historical
  [PDF.js Request Policy Benchmark](pdfjs-request-policy-2026-08-05.md).

## Reproduction

```bash
npm run benchmark:pdf-delivery
```
