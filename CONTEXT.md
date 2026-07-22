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

**Code Repository**:
A source-code project associated with one or more Papers.
_Avoid_: Paper code, code attachment

**Repository Snapshot**:
An immutable commit of a Code Repository used as evidence or Agent context.
_Avoid_: Current repository, cloned code

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
