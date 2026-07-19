# ScholarLoom Agent Guide

## Mission

ScholarLoom is a personal, AI-native paper-reading and knowledge-synthesis repository.
Its goal is not to collect PDFs or produce isolated summaries. Its goal is to turn
reading into a traceable knowledge graph that can answer questions, expose
disagreements, and support new synthesis over time.

Agents working in this repository should optimize for:

1. **Traceability** — every important claim points back to a paper and, when
   available, a page, section, figure, table, or quoted passage.
2. **Accumulation** — new reading updates existing concepts, topics, and open
   questions instead of creating disconnected notes.
3. **Retrievability** — notes use predictable paths, frontmatter, headings, and
   links so both humans and tools can find them.
4. **Honest uncertainty** — distinguish what a source says, what the reader
   thinks, and what an agent infers.
5. **Low friction** — capture first, structure during ingestion, synthesize only
   when evidence warrants it.

## Repository map

```text
HOME.md                 Human/agent dashboard and navigation entry point
CONTEXT.md              Canonical domain language
docs/                   Product, data-model, and architectural decisions
inbox/                  Unprocessed links, files, citations, and rough thoughts
library/papers/         One canonical reading note per paper
knowledge/concepts/     Atomic, reusable concept notes
knowledge/topics/       Topic maps that connect papers, concepts, and questions
knowledge/questions/    Open or answered research questions
syntheses/              Cross-paper arguments, comparisons, and literature reviews
assets/papers/          Local paper files when legally and practically appropriate
assets/images/          Figures or diagrams used by notes
templates/              Canonical templates; update these before inventing variants
skills/                 Versioned Agent skills used to generate durable artifacts
```

Directory-level `README.md` files are indexes and local instructions. Keep them
useful; do not turn them into full notes.

## Source-of-truth hierarchy

When information conflicts, use this order:

1. The original paper or primary source.
2. The canonical note in `library/papers/`.
3. Concept and topic notes in `knowledge/`.
4. Synthesis documents.
5. Inbox material and conversational context.

Never silently resolve a source conflict. Record the disagreement and cite both
sides. A summary is not evidence independent of its source.

## Content contract

All canonical notes are Markdown with YAML frontmatter. UTF-8 is required.
Frontmatter is a machine interface: keep field names stable, use ISO dates
(`YYYY-MM-DD`), use YAML arrays for multi-value fields, and use `null` rather than
inventing missing data.

Use lowercase kebab-case filenames. Prefer stable semantic names over titles copied
verbatim. Wikilinks use repository-relative paths without the `.md` suffix, for
example `[[knowledge/concepts/retrieval-augmented-generation]]`.

### Stable identifiers

- Paper: `paper:<first-author-family-name>:<year>:<short-title>`
- Paper version: `paper-version:<paper-id>:<source>:<version>`
- Takeaway: `takeaway:<paper-id>:<slug>`
- Insight: `insight:<slug>`
- Concept: `concept:<slug>`
- Topic: `topic:<slug>`
- Question: `question:<slug>`
- Synthesis: `synthesis:<yyyy-mm-dd>:<slug>`

Once published in a canonical note, do not change an ID merely to improve wording.
If a file is renamed, update all links in the same change.

### Note boundaries

- A **paper note** is the stable identity and navigation manifest for one scholarly work.
- A **paper summary** is a versioned technical reading of exactly one paper version.
- A **takeaway** is a confirmed atomic conclusion about exactly one paper.
- An **insight** is reusable knowledge that may combine multiple papers, discussions,
  or a user-confirmed hypothesis.
- A **concept note** describes one reusable idea. It should become more precise as
  papers accumulate and should mention disagreements or alternate definitions.
- A **topic note** is a map of the territory, not a long essay.
- A **question note** tracks an answerable research question, evidence for and
  against, and what remains unknown.
- A **synthesis** makes an explicit cross-source argument. It must not masquerade as
  a neutral source summary.

Use the corresponding file in `templates/` whenever creating a canonical note.
Do not remove a required field; use `null`, `[]`, or a short explanation when the
value is unknown.

## Standard workflows

Interpret the following intents whether or not the user uses these exact command
names.

### Capture

For “save this”, “remember this”, or raw material:

1. Append a dated item to `inbox/README.md`, or add a clearly named file under
   `inbox/` when the material is substantial.
2. Preserve the source URL or local path and the user's original wording.
3. Do not fabricate metadata or prematurely summarize an unread source.

### Ingest a paper

For “read/import/ingest this paper”:

1. Identify the paper reliably. Prefer DOI, arXiv ID, PMID, or publisher URL.
2. Check for an existing paper note by ID, DOI, title, and aliases before creating
   one. Merge rather than duplicate.
3. Read enough of the primary source to separate abstract claims from actual
   methods, results, and limitations.
4. Create or update the Paper manifest from `templates/paper.md`. Generate a separate
   Paper Summary from `templates/paper-summary.md` using
   `skills/paper-reading/SKILL.md`; record the Paper Version, Extraction Run, Agent
   Run, and Skill content hash with the generated Artifact.
5. Add only concepts that are useful beyond this one paper. Link existing concepts
   before creating new ones.
6. Update relevant topic and question notes, including evidence that contradicts
   the current view.
7. Remove or mark the corresponding inbox item as processed.
8. Update `HOME.md` only when the item changes current priorities or navigation.

### Answer a question

For questions about the knowledge base:

1. Search paper notes, concept notes, topic maps, question notes, and syntheses.
2. Lead with the answer, then show supporting and conflicting evidence.
3. Link the repository notes used. Include source locators when available.
4. Label inference explicitly and state important gaps.
5. Do not mutate the repository unless the user asks to save the answer or the
   request clearly includes knowledge-base maintenance.

### Synthesize

For comparisons, literature reviews, or “what do I currently believe?”:

1. Define the question and inclusion boundary.
2. Build an evidence table before writing a narrative when three or more sources
   are involved.
3. Separate consensus, disagreement, methodological differences, and missing
   evidence.
4. Create a synthesis from `templates/synthesis.md` and link every material claim.
5. Feed durable conclusions back into concept, topic, and question notes.

### Review the garden

For maintenance or periodic review:

1. Triage old inbox items.
2. Find broken links, duplicate paper identities, missing source locators, and
   orphan concepts.
3. Review stale open questions and syntheses whose evidence has changed.
4. Prefer small, reviewable edits. Report unresolved ambiguity instead of making
   broad speculative rewrites.

## Evidence and citation rules

- Prefer primary sources. Use secondary sources for orientation and label them.
- Never claim to have read a paper when only its abstract, metadata, or a summary
  was available. Record reading depth in `read_status`.
- Use short quotations sparingly. Record the locator as `p. 7`, `§3.2`, `Fig. 4`,
  or the closest equivalent.
- Keep these voices distinct in paper notes:
  - **Authors claim** — what the source asserts.
  - **Evidence** — what the source actually presents.
  - **Reader note** — the repository owner's observation.
  - **Agent inference** — a derived interpretation that needs verification.
- A DOI is stored in canonical URL form: `https://doi.org/...`.
- Do not invent citations, page numbers, quotations, effect sizes, or bibliographic
  fields. Unknown is preferable to plausible-sounding.

## Editing rules

- Inspect nearby notes and templates before editing.
- Preserve the user's wording in sections labeled `My notes` or `Reader notes`.
  Agents may clarify around it but must not silently rewrite the user's position.
- Update `updated` whenever a canonical note changes materially. Preserve
  `created`.
- Maintain reciprocal navigability: a concept should link to supporting papers,
  and paper notes should link to the concepts they inform.
- Tags are broad retrieval facets, not a substitute for links. Reuse existing tags
  and prefer fewer than seven per note.
- Do not commit copyrighted paper files unless the user explicitly chooses to and
  has the right to store them. A bibliographic note and local untracked file are
  safer defaults.
- Never delete substantive notes merely because they seem obsolete. Mark them
  `status: superseded` and link the replacement unless deletion was requested.
- Keep generated artifacts out of the knowledge directories unless they are part
  of the durable knowledge base.

## Quality checklist

Before finishing a knowledge-changing task, verify:

- The note uses the correct template and has a stable ID.
- Required frontmatter parses as YAML.
- The source identity was checked for duplicates.
- Claims and quotations have the best available locator.
- Links point to real notes, or clearly intentional future notes.
- Author claims, reader opinions, and agent inferences are distinguishable.
- Relevant concept, topic, and question notes were updated.
- The response says what changed and names any evidence gaps.

## Tooling and implementation

Markdown is the durable source of truth. Search indexes, embeddings, graph views,
and interactive applications are derived views and must be reproducible from the
repository. Never make a database or vector store the only home of user knowledge.

When adding software:

- Keep ingestion, domain model, storage, retrieval, and presentation separable.
- Store generated indexes in an ignored cache directory.
- Add tests for parsers, migrations, link resolution, and retrieval behavior.
- Document one-command setup and verification in `README.md`.
- Prefer transparent retrieval that can show which notes and source passages were
  used to answer a question.

## Communication

The repository's default working language is Chinese; retain original English
technical terms when translation would reduce precision. Paper titles and direct
quotes stay in their source language. Be concise, cite the relevant local notes,
and surface uncertainty early.
