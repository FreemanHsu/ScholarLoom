# Paper Workspace Design QA

- Source target: local Codex-generated image (not committed)
- Implementation capture: `.playwright-cli/page-2026-08-03T14-17-41-040Z.png`
- Combined comparison: `output/playwright/paper-workspace-comparison.png`
- Viewport: 1440 × 1024

## Visual comparison

| Priority | Finding | Resolution |
|---|---|---|
| P0 | None | — |
| P1 | The first pass rendered both an app PDF toolbar and the browser PDF toolbar. | Removed the duplicate toolbar and requested native viewer fitting with the navigation pane collapsed; the later real-paper regression below corrected the fragment to Chromium's `view=FitH`. |
| P1 | The compact Discussion conversation rail allowed the new-conversation action to overflow. | Stacked the heading and action and constrained the button to the rail width. |
| P2 | The original workspace header repeated the canonical title, author, source version, and source action. | Reduced the identity block to alias-or-title plus year and merged version/source into one interactive control. |
| P2 | The outline occupied permanent reading width. | Added a 68px collapsed rail with numbered anchors, active marker, and an accessible expand/collapse control. |

## Interaction verification

- Default Paper route opens Summary and the original PDF side by side.
- Summary evidence `p. 2` navigates to `pdf=open&page=2&anchor=page:2` and reloads the PDF at page 2.
- Original, Discussion, and Knowledge switch only the right-hand work area; Summary remains visible.
- Discussion can create a fixture conversation and render the resulting evidence-backed answer.
- Outline expands to labeled sections and collapses back to the numbered rail.
- The vertical separator supports pointer resizing and keyboard left/right adjustment.
- Fresh-load browser console: no errors or warnings from the application.
- Narrow layouts were checked at 800 × 1000 and 390 × 844 without horizontal overflow.

Final result: passed.

## Paper Library year-column alignment

- Source visual truth: local Codex attachment (not committed)
- Implementation screenshot: `.playwright-cli/page-2026-08-05T12-03-50-822Z.png`
- Full-view comparison: `output/playwright/paper-library-year-column-comparison.png`
- Focused catalog comparison: `output/playwright/paper-library-year-column-focused.png`
- Source and implementation pixels: 2560 × 1318
- Implementation CSS viewport: 2560 × 1318 at device scale factor 1; no density normalization required
- State: `/papers?sort=year`, 44 real Papers, one starred Paper, EgoScale row hovered

**Findings**

- [P3] The source annotation identifies the year column as slightly too far right. The revised grid reduces the original-title track from `2.5fr` to `2.3fr` and expands the Direction track from `1.1fr` to `1.2fr`, moving the year heading and values approximately 30px left at this viewport without crowding either adjacent column.
- P0: none.
- P1: none.
- P2: none.

**Required fidelity surfaces**

- Fonts and typography: unchanged.
- Spacing and layout rhythm: year, Direction, and status remain aligned across header and rows; only the requested horizontal track distribution changed.
- Colors and visual tokens: unchanged.
- Image quality and asset fidelity: no image assets are involved in the catalog grid.
- Copy and content: unchanged; the live counts differ only where real production state changed after the source capture.

**Comparison history**

- Initial: the year column sat close to the right-side Direction group, leaving an oversized original-title track.
- Revised: same-size and same-hover-state comparison shows the year column shifted left while long titles, Direction pills, and status pills remain readable.
- Browser console: 0 errors, 0 warnings in a fresh post-deployment session.

final result: passed

### Iteration 2 — substantial year-rail correction

- Source visual truth: local Codex attachment (not committed)
- Implementation screenshot: `.playwright-cli/page-2026-08-05T12-26-25-068Z.png`
- Full-view comparison: `output/playwright/paper-library-year-column-v2-comparison.png`
- Focused catalog comparison: `output/playwright/paper-library-year-column-v2-focused.png`
- Source and implementation pixels: 2560 × 1318
- Implementation CSS viewport: 2560 × 1318 at device scale factor 1; no density normalization required
- State: default `/papers`, 44 real Papers, one starred Paper, LingBot-VA 2.0 row hovered

**Findings**

- [P2] The first correction moved the Year rail only about 30px, which remained visibly too far right in the user's same-size production capture.
  - Fix: gave Alias a responsive bounded width, changed Original Title to the main flexible track, and gave Year a dedicated `clamp(120px, 10vw, 260px)` rail before Direction. This shifts the Year heading and values substantially left while keeping Direction and Status stable and readable.
- P0: none.
- P1: none.
- Remaining P2: none.

**Required fidelity surfaces**

- Fonts and typography: Newsreader and DM Sans hierarchy, weights, truncation, and line height are unchanged; the narrower title track still preserves single-line catalog scanning.
- Spacing and layout rhythm: the Year rail now has intentional breathing room on both sides and remains vertically aligned across the header and every Paper row; Alias, Direction, and Status do not overlap.
- Colors and visual tokens: the warm paper background, muted green hover treatment, and semantic pills are unchanged.
- Image quality and asset fidelity: no raster or illustrative assets participate in this catalog grid.
- Copy and content: production content and labels are unchanged; the source and implementation use the same 44-Paper state and hovered second row.

**Comparison history**

- Earlier pass: a small fractional redistribution produced an approximately 30px shift and was rejected by the user as still visibly off-center.
- Revised pass: the equal-size full-view and focused comparisons show a materially left-shifted Year rail, with Direction staying adjacent and Status remaining at the far right.
- Primary interaction: second row hover remains continuous across the row; the star control remains independently actionable.
- Browser console: 0 errors, 0 warnings after the production restart.

The focused comparison was required because the correction concerns the horizontal relationship among Original Title, Year, and Direction, which is difficult to judge precisely from the full page alone.

final result: passed

### Iteration 3 — catalog header and row alignment

- Source visual truth: local Codex attachment (not committed)
- Implementation screenshot: `.playwright-cli/page-2026-08-05T12-40-50-225Z.png`
- Full-view comparison: `output/playwright/paper-library-header-alignment-comparison.png`
- Focused table comparison: `output/playwright/paper-library-header-alignment-focused.png`
- Source and implementation pixels: 2560 × 1318
- Implementation CSS viewport: 2560 × 1318 at device scale factor 1; no density normalization required
- State: default `/papers`, 44 real Papers, one starred Paper

**Findings**

- [P2] Every visible header label started 8px before the corresponding row content. The star control did not change the grid tracks; the mismatch came from `.paper-catalog-row-link > span` having 8px horizontal padding while header cells had none.
  - Fix: applied the same `padding: 0 8px` and `min-width: 0` to `.paper-catalog-table-head > span` without changing the existing index or star tracks.
- P0: none.
- P1: none.
- Remaining P2: none.

**Measured alignment**

- Alias header/cell border-box x: 418px / 418px; both have 8px left padding.
- Original Title header/cell border-box x: 798px / 798px; both have 8px left padding.
- Year header/cell border-box x: 1574px / 1574px; both have 8px left padding.
- Direction header/cell border-box x: 1830px / 1830px; header text uses 8px and pill text uses its intentional 9px badge inset.
- Status header/cell border-box x: 2412px / 2412px; header text uses 8px and pill text uses its intentional 9px badge inset.

**Required fidelity surfaces**

- Fonts and typography: Newsreader and DM Sans families, weights, truncation, and line heights are unchanged.
- Spacing and layout rhythm: the five desktop header tracks now share the exact border-box origins and base inset of their row cells; the sequence number and independent star button remain in their original 42px tracks.
- Colors and visual tokens: unchanged.
- Image quality and asset fidelity: no image assets participate in the catalog header.
- Copy and content: unchanged; source and implementation use the same production Paper inventory.

**Comparison history**

- Earlier state: the focused source capture shows all headers visibly offset left from their column content by the missing 8px inset.
- Revised state: equal-size full-view and focused comparisons show the table hierarchy unchanged and every header aligned with its content column.
- Primary interactions: the starred row/control semantics and full-row navigation remain unchanged.
- Browser console: 0 errors, 0 warnings.

The focused comparison was required because the issue is an 8px offset that is not reliably judgeable from the full page alone.

final result: passed

## Native PDF fit-width regression

- Browser: installed Google Chrome, headed through Playwright
- Viewport: 1600 × 1000
- Fixture: page 1 uses A4 dimensions (595.28 × 841.89 pt); page 2 uses Letter dimensions (612 × 792 pt)
- Automated command: `npm run test:browser:pdf`
- Artifacts: `output/playwright/pdf-fit-width/test-results/`

The earlier `zoom=page-width` fragment was not recognized by Chromium. Small fixture
pages obscured that failure, while a real Paper showed the native toolbar at 100% and
left substantial unused horizontal space. The reader now emits
`#page=N&view=FitH&navpanes=0` and keeps the existing iframe remount and new-window
fallback.

The real-browser regression verifies:

- A4 page 1 opens with Chromium reporting `fit-to-width`;
- clicking a Summary Evidence Anchor remounts the viewer on Letter page 2 while preserving `fit-to-width`;
- resizing the source pane from 50% to 44% and 62% keeps `fit-to-width` and changes native zoom in the expected direction;
- the A4, Letter, narrow-source, and wide-source screenshots all show the fixture page border fitted to the available width;
- every run creates a fresh temporary ScholarLoom data root and removes it on shutdown; production data is never opened.

Final result: passed.

Native iframe reuse was also tested as a way to remove the transient page-1 flash during
Evidence navigation. It was rejected: keeping the frame stable and changing only
`#page=2` updated the iframe's DOM `src`, but Chromium continued rendering page 1. The
permanent regression therefore inspects the native viewer's actual current page, not only
the outer URL. Remounting remains the correctness-preserving native-viewer behavior; a
flash-free transition remains unavailable through Chromium's private viewer surface.

## Retired embedded PDF.js spike

This historical spike was evaluated in installed Google Chrome through headed Playwright.
Its runtime flags and dedicated browser commands have since been removed.

The spike keeps a single lazily loaded PDF.js document and renders one fit-width canvas.
It removes the previous canvas before an Evidence page render, exposes loading progress,
re-renders after pane resize, and falls back to a correctly targeted native iframe after
PDF.js failure. Thirty Evidence/Back cycles (60 renders) preserved the reader instance and
issued no PDF reload.

Observed on the two-page A4/Letter fixture:

- first render: 230 ms;
- page-transition p95 / maximum: 80 ms / 82 ms;
- PDF requests: 1 total, 0 Range requests (the PDF is only 1.5 KB);
- JS heap after the transition run: 9.6 MB; main-thread task time across the run: 0.68 s;
- build assets: lazy PDF.js chunk 432 KB (128 KB gzip), worker 1.26 MB.

The retired independent large-PDF journey used a deterministic 12,588,462-byte PDF and observed:

- first render: 0.29–0.39 seconds across repeated runs;
- requests: one complete `200` plus one 5.6 KB tail `Range 206`;
- page-target heap growth: 6.5–6.9 MB; page-target task time: 0.15–0.16 s;
- worker-process CPU and memory are not included in those CDP page-target values.

The result verifies Range compatibility but also shows that this non-linearized PDF transfers
all original bytes before first render. It does not demonstrate compression or byte savings.

The retired lossless-delivery browser journey enabled qpdf 12.3.2 and throttled Chrome to
2 MiB/s with 40 ms latency. qpdf produced 12,589,790 bytes from the
12,588,462-byte original. Page 1 rendered in 1.41 seconds after a 64 KiB leading Range and a
6.8 KiB tail Range, while the complete representation was still in progress. Isolated
renderer checks produced identical image hashes for both A4 and Letter pages before and after
linearization. This is a synthetic-fixture result; real-Paper corpus thresholds remain open.

The pinned five-Paper corpus closed that evidence gap. Three eligible Papers produced 0.60%-3.08%
smaller delivery files and all nine first/middle/last renderer comparisons matched. Browser A/B
samples did not show a first-page latency gain: GPT-3 v4 measured 1.900 s original versus 1.906 s
linearized, while ViT v2 measured 3.414 s versus 3.411 s and completed the full response before
render in both modes. Attention v7 linearized measured 2.411 s with the full response complete.
These are single-run diagnostics, but they reject promotion on current evidence. qpdf output also
proved non-deterministic until `--deterministic-id` was added and regression-tested.

The follow-up request-policy spike compared PDF.js default behavior with `disableStream` plus
`disableAutoFetch` in fresh headed Chrome sessions. GPT-3 v4 remained neutral at 1.904 s versus
1.914 s and 411,052 completed response-body bytes in both modes. ViT v2 improved from 3.408 s
with the complete 3.74 MB response finished to 1.906 s with 467,014 completed Range bytes.
Its Evidence page-2 transition changed from 53 ms to 79 ms. This was a strong transport result
for the affected sample, but only a two-Paper, single-run diagnostic.

Decision: **retire** the embedded reader and request-policy flags. A real Hunyuan3D v5 journey
showed that the canvas-only reader exposed only one current page, loaded about 3.4 MB of a
6.51 MB PDF for the first page plus the PDF.js bundle/worker, and still lacked text selection,
search, print UI, continuous-page reading, and document-content accessibility. Chromium native
viewer remains the sole browser reader and the new-window action remains visible.

## Paper Workspace bottom-edge regression

- Source visual truth: local Codex attachment (not committed)
- Implementation screenshot: `.playwright-cli/page-2026-08-04T06-02-12-125Z.png`
- Full-view comparison: `output/playwright/paper-workspace-bottom-gap-comparison.png`
- Focused bottom-edge comparison: `output/playwright/paper-workspace-bottom-gap-focused.png`
- Viewport and CSS size: 2048 × 1054 at device scale factor 1
- Source pixels: 2048 × 1054; implementation pixels: 2048 × 1054; no density normalization required
- State: Paper Workspace desktop reading split, Summary independently scrolled near the end

**Findings**

- [P1] The shared `.app { min-height: 100vh }` rule forced the Paper Workspace itself to one viewport below the 70px global navigation, leaving a 70px background strip at the document bottom.
  - Fix: override the Paper Workspace minimum height to `calc(100vh - 70px)`, matching its position below the global navigation.
  - Post-fix evidence: `document.body.scrollHeight` and `window.innerHeight` both measure 1054px; the focused comparison shows the split workbench reaching the viewport edge.

**Required fidelity surfaces**

- Fonts and typography: unchanged.
- Spacing and layout rhythm: corrected only the outer Paper Workspace height; internal Summary and PDF rhythm is unchanged.
- Colors and visual tokens: the unintended page-background strip is no longer exposed.
- Image quality and asset fidelity: unchanged; the native PDF frame remains intact.
- Copy and content: unchanged.

**Comparison history**

- Initial: P1 bottom strip visible after scrolling the document to its end.
- Fix: scoped the workspace minimum height to the viewport area remaining below the 70px app navigation.
- Revised: no document-level vertical overflow and no bottom strip at 2048 × 1054.

Focused comparison was required because the issue is confined to the bottom 70px; the full view uses different paper content but the same Paper Workspace layout and viewport.

Final result: passed.

## Hunyuan3D Summary regression

- User reference: local Codex attachment (not committed)
- Detail reference: local Codex attachment (not committed)
- Implementation capture: `.playwright-cli/page-2026-08-03T14-49-01-884Z.png`
- Combined comparison: `output/playwright/paper-workspace-regression-comparison.png`
- Viewport: 2048 × 1054

| Priority | Finding | Resolution |
|---|---|---|
| P1 | The active outline marker occupied the same horizontal track as the section number. | Kept the marker on the 29px rail and moved the number start to 44px (39px on narrow screens). |
| P1 | The Summary body retained a 66ch reading cap inside a half-width workbench, leaving a large unused column. | Removed the nested max-width and let the body fill the available Summary pane. |
| P1 | CommonMark kept some `**Agent 评价：**` labels literal when CJK prose immediately followed the closing delimiter. | Normalized supported Agent labels before parsing, preserving semantic `<strong>` output and the inference block treatment. |
| P2 | Clicking a section number could scroll the document instead of the independently scrolling Summary pane. | Scoped navigation to the Summary pane and calculated active sections relative to that scroll container. |

Interaction verification:

- Section 07 is visibly active without overlapping its number.
- The section body, Agent inference block, and evidence cards use the full Summary content width.
- All Agent labels in the Hunyuan3D 2.1 Summary render as bold text without exposing Markdown delimiters.
- Outline navigation lands on the selected section while the application header and PDF pane remain fixed.

Final result: passed.

## Key Claims heading regression

- Source visual truth: local Codex attachment (not committed)
- Desktop implementation: `.playwright-cli/page-2026-08-04T06-08-48-210Z.png`
- Desktop focused crop: `output/playwright/key-claims-heading-fixed.png`
- Focused comparison: `output/playwright/key-claims-heading-comparison.png`
- Mobile implementation: `.playwright-cli/page-2026-08-04T06-10-19-157Z.png`
- Source and focused implementation pixels: 317 × 103; desktop CSS viewport: 2048 × 1054; device scale factor 1; no density normalization required
- State: Key Claims section heading visible in the Summary pane

**Findings**

- [P2] `KEY CLAIMS` exceeded the 50px section-number gutter and collided with the Chinese heading.
  - Fix: scope the claims section with `summary-claims-section` and expand its desktop heading gutter to 92px, producing a measured 16px gap between label and heading.
  - Responsive fix: below 560px, stack the label above the heading and restore the ordinary 34px content inset.

**Required fidelity surfaces**

- Fonts and typography: unchanged; the eyebrow and Newsreader heading retain their existing treatments.
- Spacing and layout rhythm: the label and heading no longer overlap at desktop or narrow width.
- Colors and visual tokens: unchanged.
- Image quality and asset fidelity: no image assets involved.
- Copy and content: unchanged.

**Comparison history**

- Initial: label and heading visibly intersected in the 317 × 103 source crop.
- Revised desktop: label and heading are separated while remaining on the same editorial baseline.
- Revised mobile: label stacks above the heading to preserve readable claim-card width.

Final result: passed.
