# /papers 论文库 Design QA

## Visual truth

- Reference: local Codex-generated image (not committed)
- Implementation: local Playwright capture (not committed)
- Desktop viewport: 1440 × 1024, device pixel ratio 1
- Reference source: 1487 × 1058, aspect-fit into the 1440 × 1024 comparison canvas
- State: `/papers`, 全部论文，单条 fixture 论文，已星标，目录行 hover

## Combined comparison inputs

- Full screen: `output/playwright/paper-library-design-qa-desktop.png`
- Catalog crop: `output/playwright/paper-library-design-qa-catalog.png`

The catalog crop isolates the page heading, search/filter/sort toolbar, column hierarchy,
star affordance, hover state, and status presentation. The full-screen comparison covers
global navigation, sidebar proportions, content width, and overall visual density.

## Findings and iteration history

### Iteration 1

- P0: none.
- P1: none.
- P2: none.
- P3: the fixture has one paper instead of the reference's ten, so the implementation
  screenshot cannot demonstrate long-list density below the first row. Row height,
  column rhythm, hover fill, status pills, and typography match the selected direction.

Result: passed. No P0–P2 visual mismatch remained after the combined comparison.

## Interaction QA

- Star button updates independently and persists after navigation/reload.
- Starred navigation filters to `/papers?view=starred`.
- Clicking the row outside the star opens the Paper Workspace; there is no repeated arrow.
- Search persists in the URL and composes with sorting.
- Sorting persists in the URL (`?sort=year`).
- `/papers/organize` contains organization suggestions and Direction management.
- At 390 × 844, the sidebar becomes a filter drawer and the paper row remains readable.
- Browser console: 0 errors, 0 warnings.
