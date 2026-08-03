# Implementation Slice 010: Entry Agent Alias Resolver

- Status: Implemented
- Date: 2026-08-01
- Parent design: [`paper-organization-feature-design.md`](paper-organization-feature-design.md)
- Depends on: Slice 001 Paper Catalog and Slice 009 Alias automation foundation

## 1. Outcome

Complete Slice 4B by resolving exact Paper Aliases before Entry Agent retrieval.
The resolver is deterministic application logic, not a new Agent. Paper Catalog
identifies candidate Paper identities; the Entry Agent continues to receive only
active Summary and confirmed knowledge documents from `global-curated`.

Alias metadata is never inserted into `global-curated` and never becomes evidence.

## 2. Resolver contract

`PaperResolver.resolve(question)` returns:

- `none` when no exact Catalog identity is mentioned;
- `resolved` with one to five unambiguous Paper IDs and each matched span;
- `ambiguous` with one or more collision groups that require owner selection.

Candidate order is deterministic:

1. exact Preferred Alias;
2. exact non-preferred Alias;
3. exact canonical title;
4. recent Paper activity, then stable Paper ID.

The ranking above orders candidate cards only. Per the owner's post-review decision,
every cross-Paper collision requires explicit disambiguation, including a Preferred
Alias that collides with another Paper's canonical title. There is no fuzzy, prefix,
semantic, or Agent-decided identity resolution in this
slice. Resolution normalizes NFKC, case, and whitespace with the Paper Catalog's
recorded normalization version. Alias matching requires a complete Unicode
letter/number token boundary for Latin aliases; quoted aliases and CJK spans are
matched as complete normalized spans. Longest spans win over contained spans.

Matcher version `paper-resolver.v1` defines:

- Latin/digit Aliases of at most three alphanumeric characters require quoting;
- CJK Aliases of at most two code points require quoting;
- a versioned bilingual common-term set requires quoting regardless of length;
- recognized post-NFKC quote pairs are `""`, `''`, `“”`, `‘’`, `「」`, `『』`, and
  `《》`;
- Latin/digit matching uses ASCII alphanumeric boundaries so an Alias adjacent to
  Chinese prose remains matchable; longer non-common CJK Aliases use exact spans;
- overlapping spans are selected by earlier start, longer span, then candidate rank;
- punctuation and hyphen variants are intentionally not folded.

Every resolved response provides “忽略 Paper 身份，检索全部已确认知识”. A request with
`resolutionMode: off` runs exactly the pre-Slice-4B broad-curated path.

## 3. Retrieval routing and trust boundary

For `none`, current curated FTS retrieval remains unchanged.

For `resolved`, retrieval is constrained to the resolved Papers and supplies:

- their active Summary Revisions;
- active confirmed Takeaway Revisions;
- later, active confirmed developed Topic Knowledge Revisions through Slice 4C.

The active Summary is included even when its body does not repeat the Alias. The
eight-source budget first assigns one Summary per Paper, then adds relevant
confirmed knowledge round-robin across Papers so one Paper cannot starve the rest.
Every source still uses a `curated:*` handle and is validated by the existing Entry
output contract. Zero curated sources returns deterministic `insufficient_evidence`
without invoking the Agent.

For `ambiguous`, the Entry Agent is not invoked. The API returns candidate cards;
choosing Papers replays the same question with a snapshot hash and one selection
keyed by each ambiguity-group ID. The server re-runs resolution, requires exactly
one valid Paper per group, rejects selections when there is no ambiguity, and fails
with a distinct stale-resolution outcome when the candidate snapshot changed.
This selection is request-scoped and does not mutate aliases or store a preference.

Questions naming multiple different, individually unambiguous Papers resolve to
their union (maximum five). Any ambiguous mention blocks the whole request rather
than silently dropping that mention.

## 4. API and response

Extend `POST /api/entry-agent/questions`:

```json
{
  "question": "GenCeption 的主要贡献是什么？",
  "resolutionMode": "auto | off",
  "resolutionSelection": {
    "snapshotHash": "...",
    "groups": { "group:...": "paper:..." }
  }
}
```

Normal answers retain the current response and add:

```json
{
  "resolution": {
    "state": "none | resolved",
    "matches": [{ "text": "GenCeption", "paperId": "paper:...", "kind": "preferred-alias" }]
  }
}
```

An ambiguity response is HTTP 200, does not call the Agent, and returns
`answerStatus: "resolution_required"`, a concise explanation, empty `sources`,
the current projection state, and candidate groups. Candidates show canonical
title, matched Alias, authors/year, Primary Direction, and collision warning.

The browser shows the resolution notice above the answer. Ambiguous candidates are
text-labeled buttons; choosing one issues the validated replay. Mobile cards remain
single-column. URL state is unchanged because the Entry question currently lives
only in Home component state.

## 5. Failure and edge behavior

- A selected Paper outside the re-derived candidate set returns 409
  `entry-paper-resolution-invalid`.
- A changed group/candidate snapshot returns 409 `entry-paper-resolution-stale`.
- A resolved Paper without curated documents yields deterministic
  `insufficient_evidence`; the resolver never treats Catalog metadata as an answer.
- Superseded Direction redirects affect display only and never Paper identity.
- A Catalog rebuild or Alias edit takes effect on the next request; no resolver
  cache is authoritative.
- More than five unambiguous Paper mentions returns a bounded
  `resolution_required` response asking the owner to narrow the question.
- If `global-curated` is stale, the existing notice remains visible after
  resolution.

## 6. Authority, privacy, and observability

No new knowledge authority is introduced. Resolution is a read-only query over the
rebuildable Paper Catalog projection. A bounded operational event stores question
hash, mode, outcome, match kinds, and Paper IDs—never question text or the Alias
catalog. Agent Run input contains only the question and curated sources; it does not
contain resolved IDs, matched Alias text, authors, directions, or unselected
candidates. The browser attaches resolution metadata after the Agent run.

Catalog rebuild and resolver import the same normalization function/version. A
metadata version mismatch degrades to broad retrieval. Settings exposes resolver
mode/version and normalization version. `off | shadow | enabled` is a permanent
runtime kill switch; shadow records would-resolve outcomes but never constrains
retrieval. Diagnostics can rebuild Paper Catalog and curated search independently.

## 7. Rollout and acceptance

1. pure resolver with collision/boundary/normalization tests;
2. Paper-scoped curated retrieval and selection validation;
3. API response extension and ambiguity path;
4. Home interaction and desktop/mobile Playwright;
5. snapshot/restore and deterministic rebuild regression.

Acceptance requires:

- `GenCeption` resolves its Paper even when Summary text omits that Alias;
- the Agent sees only that Paper's curated sources;
- collisions never invoke the Agent without an explicit selection;
- forged or stale selections fail closed;
- multiple unique aliases can support a cross-Paper question;
- no Alias/author/direction metadata enters `global-curated`;
- existing no-resolution Entry behavior remains compatible;
- tests, typecheck, build, `git diff --check`, Playwright, and snapshot/restore pass.

## 8. Non-goals

- a new Agent or LLM mention extractor;
- fuzzy Alias resolution;
- persisting preferred collision choices;
- using Paper Catalog metadata as epistemic evidence;
- indexing developed Topic knowledge before Slice 4C.

## 9. Verification

- `$fable-review` completed on Canvas `640dd587-a26d-45ba-9cb4-1d90c35a80bf`;
  the owner resolved its only major conflict in favor of universal cross-Paper
  disambiguation.
- `npm test`: 48 files, 255 tests passed.
- `npm run typecheck`, `npm run build`, and `git diff --check`: passed.
- Target tests cover Alias-to-Paper scoped retrieval when Summary omits the Alias,
  prompt purity, Preferred-Alias/title collision, forged and stale selections,
  short/common Alias quoting, and broad-retrieval bypass.
- Real Playwright desktop/mobile journeys confirmed the collision chooser, selected
  Paper banner, and bypass affordance. Artifacts:
  `output/playwright/slice-010-entry-alias-resolver.png` and
  `output/playwright/slice-010-entry-alias-resolver-mobile.png`.
- Fixture snapshot verification passed SQLite integrity/foreign-key checks and
  restored successfully into a new empty `/tmp` root.
