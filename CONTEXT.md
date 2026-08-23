# ScholarLoom

ScholarLoom turns paper reading and discussion into traceable personal research
knowledge. This glossary defines the canonical language shared by product,
knowledge, and implementation work.

## Research objects

**Paper**:
A stable identity for one scholarly work across arXiv, DOI, and publication forms.
_Avoid_: PDF, paper file, arXiv version

**Paper Version**:
An immutable published form of a Paper, such as arXiv v2 or a conference camera-ready version.
_Avoid_: Paper revision, current paper

**Metadata-only Paper**:
A Paper known through a citation or discovery result but not yet ingested for reading.
_Avoid_: Paper stub, fake Paper

**Paper Alias**:
A human-friendly alternate name used to refer to and find a Paper without replacing
its canonical title or asserting an external scholarly identity. A model or method
name qualifies only when it can refer to the Paper as a whole.
_Avoid_: Paper title, External Identity, model entity

**Preferred Paper Alias**:
The single Paper Alias chosen as the Paper's primary human-friendly display name;
a Paper may have many aliases but at most one preferred alias.
_Avoid_: Paper title, canonical title

**Research Direction**:
A confirmed Topic used to organize Papers by the core research problem they address
or the contribution they make. A technique, model family, arXiv category, or title
keyword alone does not determine a Research Direction.
_Avoid_: Tag, Concept, arXiv category, implementation technique

**Classification-only Topic Revision**:
A confirmed Topic Revision whose title and Scope are sufficient for organizing Papers
but which is not approved as a source for global knowledge answers.
_Avoid_: Draft Topic, unconfirmed Topic, developed Topic

**Knowledge-ready Topic Revision**:
A confirmed Topic Revision containing substantive reusable knowledge and explicitly
approved as a source for global knowledge answers.
_Avoid_: Complete Topic, mature Topic, developed Topic

**Primary Research Direction**:
The single Research Direction that best represents a Paper's core research problem
or contribution and determines where it is grouped in the Paper Library.
_Avoid_: Primary category, first Topic

**Secondary Research Direction**:
One of up to three additional Research Directions to which a Paper makes a material
contribution; merely using a direction's technique does not qualify.
_Avoid_: Tag, technique used, incidental Topic

**Code Repository**:
A source-code project associated with one or more Papers.
_Avoid_: Paper code, code attachment

**Repository Snapshot**:
An immutable commit of a Code Repository used as evidence or Agent context.
_Avoid_: Current repository, cloned code

**Repository Association**:
A Paper-scoped, inspectable link to a Code Repository. Its origin and confirmation
state are distinct from Repository Snapshot materialization.
_Avoid_: Repository Snapshot, detected repository

**Repository Candidate**:
A Repository Association detected from a GitHub root URL written in Paper source
material but not yet user-confirmed or eligible for Conversation context.
_Avoid_: Confirmed repository, reliable code context

## Evidence and derived material

**Artifact**:
A versioned material object with traceable inputs, origin, and retention policy.
_Avoid_: File, output, blob

**Extraction Run**:
One attempt to derive structured document content from an immutable source asset.
_Avoid_: Parsed Paper

**Document Element**:
An addressable text, section, equation, table, figure, caption, or other unit produced by an Extraction Run.
_Avoid_: Chunk, passage

**Evidence Anchor**:
A stable locator from a claim back to a specific Paper Version, PDF location, or Repository Snapshot location.
_Avoid_: Citation, link

**Paper Summary**:
A structured technical reading derived from one Paper Version and governed by the paper-reading Skill.
_Avoid_: Abstract, Paper note

**Code Analysis**:
A source-distinct explanation of a Repository Snapshot in relation to a Paper.
_Avoid_: Code Summary inside the Paper Summary

## Reading and conversation

**Conversation**:
A Paper-scoped sequence of Messages whose meaning is fixed by one or more Context Snapshots.
_Avoid_: Knowledge, chat memory

**Knowledge Conversation**:
A global-curated sequence of successful user and Agent Messages. Each new turn may
search the current eligible curated corpus, while prior Messages remain immutable and
retain the exact Evidence Receipts used when they were created.
_Avoid_: Conversation, Entry query, chat memory

**Knowledge Answer Basis**:
The declared basis of one Knowledge Conversation answer: curated evidence,
conversation-context clarification, or model knowledge without knowledge-base evidence.
_Avoid_: confidence score, source type, grounding status

**Context Snapshot**:
The immutable Paper Version, Summary Revision, Extraction Run, Repository Snapshots, and Knowledge Corpus Manifest available to a Conversation.
_Avoid_: Current context

**Knowledge Corpus Manifest**:
The immutable content-addressed list of other papers' active Summaries and confirmed knowledge frozen when a Conversation is created.
_Avoid_: Current library, live search results

**Evidence Workspace**:
A rebuildable, content-addressed, read-only filesystem projection of one Context Snapshot for a single Agentic Evidence Attempt.
_Avoid_: Vault, production data root, Codex session

**Evidence Receipt**:
A final verified citation that fixes source ownership, revision, content hash, locator, and bounded verbatim quote.
_Avoid_: Activity, search result, read log

**Conversation Digest**:
A generated compression of a bounded range of Messages for restoring Paper-scoped context.
_Avoid_: Insight, confirmed summary

**Annotation**:
A user-authored highlight or note anchored to a Paper Version or Summary Revision.
_Avoid_: Takeaway, Insight

## Knowledge

**Takeaway**:
A user-confirmed atomic conclusion about exactly one Paper, grounded in Paper or code evidence.
_Avoid_: Insight, Summary claim

**Knowledge Node**:
A versioned, confirmed unit of reusable knowledge typed as Insight, Concept, Topic, Question, or Synthesis.
_Avoid_: Note, document

**Insight**:
A reusable interpretation, hypothesis, or evidence-backed claim that is not limited to one Paper.
_Avoid_: Takeaway, fact

**Provenance Link**:
A link explaining which evidence or prior material a revision came from.
_Avoid_: Semantic Relation

**Semantic Relation**:
A reviewable claim about how two research or knowledge objects relate.
_Avoid_: Provenance Link, backlink

## Review and operation

**Proposal**:
A non-authoritative suggested change awaiting a Review Decision.
_Avoid_: Draft knowledge, pending fact

**Review Decision**:
An immutable record that accepts, edits, rejects, activates, or supersedes a Proposal or revision.
_Avoid_: Status change

**Import Request**:
A record of user intent to resolve and ingest a supplied paper reference.
_Avoid_: Paper, inbox Paper

**Paper Import Reference**:
A classified user input that is either an arXiv reference or a public HTTPS Direct PDF Reference.
_Avoid_: arXiv URL field, arbitrary URL

**Direct PDF Reference**:
A normalized public HTTPS URL whose response is expected to be the PDF itself, not a landing page.
_Avoid_: project page, DOI, local PDF path

**Source Identity**:
The normalized external identity used to recognize a source across Import Requests; for direct PDFs,
this is the submitted normalized URL, while the safely redirected final URL is its canonical source URL.
_Avoid_: content hash, Paper ID

**Job Run**:
One observable execution of a download, extraction, indexing, reconciliation, or AI task.
_Avoid_: Paper status, Agent session

**Agent Run**:
A Job Run performed through Codex CLI with a recorded model, Skill, and Context Snapshot.
_Avoid_: Conversation, Message

**Agent Activity**:
A sanitized append-only progress/audit event emitted by a running Agent. It is never verified evidence.
_Avoid_: chain of thought, Evidence Receipt

**Visual Evidence Receipt**:
A verified, recoverable citation to one page of a frozen PDF, binding the PDF hash, page, deterministic
renderer identity/settings, rendered image hash, and a bounded visual observation.
_Avoid_: PDF text quote, Evidence Anchor, Agent Activity

**Visual Page Inspection**:
An Attempt-scoped audit record that a frozen PDF page was requested through the epoch-validated visual shim.
It consumes the Attempt's unique-page budget but is not evidence until grounding commits a Visual Evidence Receipt.
_Avoid_: Visual Evidence Receipt, arbitrary image read

**Render Drift**:
A fail-closed recovery state where re-rendering the same frozen PDF page with the frozen renderer/settings produces
an image hash different from the verified Visual Evidence Receipt.
_Avoid_: cache miss, renderer unavailable
