# ScholarLoom Vault Agent Guide

## Mission

This vault is a personal, AI-native paper-reading and knowledge-synthesis store. Its
goal is to turn reading into a traceable knowledge graph that can answer questions,
expose disagreements, and support synthesis over time.

Optimize for traceability, accumulation, retrievability, honest uncertainty, and low
friction. Markdown/YAML is the durable knowledge authority. SQLite is operational
authority and must not silently overwrite externally edited knowledge.

## Vault map

```text
HOME.md                 Dashboard and navigation
inbox/                  Unprocessed links, files, citations, and thoughts
library/papers/         One canonical Paper manifest and Summary revisions
knowledge/concepts/     Atomic reusable concepts
knowledge/topics/       Territory maps
knowledge/questions/    Open and answered research questions
syntheses/              Cross-source arguments and literature reviews
assets/images/          Figures and diagrams used by notes
```

Original PDFs live outside the vault under `../originals/papers/`. Application-owned
templates and the `paper-reading` Skill live in `$HOME/Projects/ScholarLoom`.

## Source hierarchy

1. Original paper or primary source.
2. Canonical Paper note and Summary in `library/papers/`.
3. Concept, topic, and question notes.
4. Syntheses.
5. Inbox material and conversational context.

Never silently resolve conflicts. Record disagreement and cite both sides. A Summary
is not evidence independent of its Paper Version.

## Content contract

Canonical notes are UTF-8 Markdown with YAML frontmatter. Keep field names stable,
use ISO dates, YAML arrays, and `null` for unknown values. Filenames use lowercase
kebab-case. Wikilinks are vault-relative without `.md`.

Stable identifiers:

- Paper: `paper:<first-author-family-name>:<year>:<short-title>`
- Paper Version: `paper-version:<paper-id>:<source>:<version>`
- Takeaway: `takeaway:<paper-id>:<slug>`
- Insight: `insight:<slug>`
- Concept: `concept:<slug>`
- Topic: `topic:<slug>`
- Question: `question:<slug>`
- Synthesis: `synthesis:<yyyy-mm-dd>:<slug>`

Once published, do not change an ID merely to improve wording. If a file is renamed,
update all links in the same change.

## Evidence rules

- Prefer primary sources and label secondary orientation.
- Never claim full reading when only metadata or an abstract was available.
- Use locators such as `p. 7`, `§3.2`, `Fig. 4`, or `Table 2`.
- Distinguish Authors claim, Evidence, Reader note, and Agent inference.
- Store DOI values as canonical `https://doi.org/...` URLs.
- Never invent citations, quotations, pages, effect sizes, or bibliographic fields.

## Workflows

For capture, preserve original wording and source identity in `inbox/`. For Paper
ingestion, check duplicates, freeze the Paper Version, read the primary source deeply
enough to distinguish methods/results/limitations, and create artifacts from the
application templates. Update related concepts, topics, and questions only when the
evidence warrants it.

For questions, lead with the answer, show supporting and conflicting evidence, link
the notes used, label inference, and state gaps. Do not mutate the vault unless asked.

For synthesis across three or more sources, build an evidence table first and separate
consensus, disagreement, methodological differences, and missing evidence.

## Editing rules

- Preserve wording in `My notes` and `Reader notes`.
- Update `updated` on material changes and preserve `created`.
- Maintain reciprocal navigation between Papers and concepts.
- Prefer fewer than seven broad tags; links carry semantics.
- Supersede substantive notes instead of deleting them.
- Do not place generated caches or indexes in the vault.
- Do not commit PDFs, SQLite, credentials, or runtime data to vault Git.

Before finishing a knowledge change, verify frontmatter, stable IDs, duplicate checks,
source locators, links, voice separation, and relevant reciprocal updates. State what
changed and name remaining evidence gaps.
