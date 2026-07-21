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
The immutable Paper Version, Summary Revision, Extraction Run, and Repository Snapshots available to a conversation segment.
_Avoid_: Current context

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
