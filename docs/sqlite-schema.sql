-- ScholarLoom SQLite target schema v1.1
-- This is the reviewed target model. Slice migrations introduce only the tables they use.
-- Designed for SQLite 3.37+ (STRICT tables) with FTS5/trigram enabled.
-- Timestamps are application-supplied ISO-8601 UTC strings unless a default is used.

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;

BEGIN IMMEDIATE;

CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    applied_at TEXT NOT NULL
) STRICT;

CREATE TABLE artifacts (
    id TEXT PRIMARY KEY,
    artifact_type TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    storage_ref TEXT NOT NULL UNIQUE,
    media_type TEXT,
    byte_size INTEGER CHECK (byte_size IS NULL OR byte_size >= 0),
    created_by_kind TEXT NOT NULL CHECK (
        created_by_kind IN ('external-source', 'job-run', 'agent-run', 'user')
    ),
    created_by_id TEXT,
    retention_class TEXT NOT NULL CHECK (
        retention_class IN ('irreplaceable', 'historical', 'rebuildable')
    ),
    integrity_status TEXT NOT NULL DEFAULT 'verified' CHECK (
        integrity_status IN ('pending', 'verified', 'missing', 'corrupt')
    ),
    created_at TEXT NOT NULL,
    UNIQUE (artifact_type, content_hash)
) STRICT;

CREATE TABLE artifact_parents (
    artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    parent_artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,
    relationship TEXT NOT NULL DEFAULT 'derived-from',
    ordinal INTEGER NOT NULL DEFAULT 0 CHECK (ordinal >= 0),
    PRIMARY KEY (artifact_id, parent_artifact_id, relationship),
    CHECK (artifact_id <> parent_artifact_id)
) STRICT;

CREATE TABLE papers (
    id TEXT PRIMARY KEY,
    title TEXT,
    acquisition_status TEXT NOT NULL CHECK (
        acquisition_status IN ('metadata-only', 'queued', 'ingested', 'unavailable', 'deleted')
    ),
    origin TEXT NOT NULL CHECK (origin IN ('manual-import', 'reference-discovery')),
    lifecycle_status TEXT NOT NULL DEFAULT 'active' CHECK (
        lifecycle_status IN ('active', 'archived', 'purged', 'forgotten')
    ),
    current_version_id TEXT REFERENCES paper_versions(id) ON DELETE SET NULL
        DEFERRABLE INITIALLY DEFERRED,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
) STRICT;

CREATE TABLE paper_external_identities (
    id TEXT PRIMARY KEY,
    paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE RESTRICT,
    identity_type TEXT NOT NULL CHECK (
        identity_type IN ('arxiv', 'doi', 'pmid', 'publisher', 'other')
    ),
    normalized_value TEXT NOT NULL,
    canonical_url TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
    created_at TEXT NOT NULL,
    UNIQUE (identity_type, normalized_value)
) STRICT;

CREATE TABLE paper_versions (
    id TEXT PRIMARY KEY,
    paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE RESTRICT,
    source_type TEXT NOT NULL CHECK (
        source_type IN ('arxiv', 'conference', 'journal', 'publisher', 'other')
    ),
    source_version TEXT NOT NULL,
    source_url TEXT NOT NULL,
    resolved_at TEXT NOT NULL,
    published_at TEXT,
    processing_status TEXT NOT NULL CHECK (
        processing_status IN (
            'detected', 'accepted', 'processing', 'available', 'failed', 'rejected'
        )
    ),
    pdf_artifact_id TEXT REFERENCES artifacts(id) ON DELETE RESTRICT,
    accepted_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (paper_id, source_type, source_version)
) STRICT;

CREATE INDEX idx_paper_versions_paper ON paper_versions(paper_id, created_at);

CREATE TABLE import_requests (
    id TEXT PRIMARY KEY,
    original_input TEXT NOT NULL,
    normalized_input TEXT,
    submitted_at TEXT NOT NULL,
    resolution_status TEXT NOT NULL CHECK (
        resolution_status IN ('pending', 'resolved', 'invalid', 'failed')
    ),
    resolved_paper_id TEXT REFERENCES papers(id) ON DELETE SET NULL,
    error_code TEXT,
    error_detail TEXT,
    idempotency_key TEXT,
    completed_at TEXT
) STRICT;

CREATE UNIQUE INDEX uq_import_idempotency
    ON import_requests(idempotency_key)
    WHERE idempotency_key IS NOT NULL;

CREATE TABLE job_runs (
    id TEXT PRIMARY KEY,
    job_type TEXT NOT NULL,
    parent_job_id TEXT REFERENCES job_runs(id) ON DELETE SET NULL,
    import_request_id TEXT REFERENCES import_requests(id) ON DELETE SET NULL,
    paper_id TEXT REFERENCES papers(id) ON DELETE SET NULL,
    state TEXT NOT NULL CHECK (
        state IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted')
    ),
    progress REAL NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 1),
    attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1),
    max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts >= 1),
    idempotency_key TEXT NOT NULL UNIQUE,
    input_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(input_json)),
    output_json TEXT CHECK (output_json IS NULL OR json_valid(output_json)),
    error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
    queued_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    heartbeat_at TEXT
) STRICT;

CREATE INDEX idx_job_runs_dispatch ON job_runs(state, job_type, queued_at);
CREATE INDEX idx_job_runs_import ON job_runs(import_request_id, queued_at);
CREATE INDEX idx_job_runs_paper ON job_runs(paper_id, queued_at);

CREATE TABLE agent_runs (
    job_run_id TEXT PRIMARY KEY REFERENCES job_runs(id) ON DELETE CASCADE,
    task_kind TEXT NOT NULL CHECK (
        task_kind IN ('paper-summary', 'paper-chat', 'knowledge-proposal', 'entry-answer')
    ),
    model TEXT,
    codex_version TEXT NOT NULL,
    skill_path TEXT,
    skill_content_hash TEXT,
    context_snapshot_id TEXT REFERENCES context_snapshots(id) ON DELETE SET NULL
        DEFERRABLE INITIALLY DEFERRED,
    output_schema_hash TEXT NOT NULL,
    prompt_hash TEXT NOT NULL,
    input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
    output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
    cost_micros INTEGER CHECK (cost_micros IS NULL OR cost_micros >= 0),
    events_artifact_id TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
    final_output_artifact_id TEXT REFERENCES artifacts(id) ON DELETE SET NULL
) STRICT;

CREATE TABLE code_repositories (
    id TEXT PRIMARY KEY,
    canonical_url TEXT NOT NULL UNIQUE,
    host TEXT NOT NULL,
    owner_name TEXT,
    repository_name TEXT,
    availability_status TEXT NOT NULL DEFAULT 'available' CHECK (
        availability_status IN ('available', 'unavailable', 'deleted')
    ),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE repository_snapshots (
    id TEXT PRIMARY KEY,
    repository_id TEXT NOT NULL REFERENCES code_repositories(id) ON DELETE CASCADE,
    commit_sha TEXT NOT NULL,
    tree_artifact_id TEXT REFERENCES artifacts(id) ON DELETE RESTRICT,
    indexed_status TEXT NOT NULL DEFAULT 'pending' CHECK (
        indexed_status IN ('pending', 'indexing', 'ready', 'failed')
    ),
    captured_at TEXT NOT NULL,
    UNIQUE (repository_id, commit_sha)
) STRICT;

CREATE TABLE paper_code_links (
    id TEXT PRIMARY KEY,
    paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
    repository_id TEXT NOT NULL REFERENCES code_repositories(id) ON DELETE CASCADE,
    default_snapshot_id TEXT REFERENCES repository_snapshots(id) ON DELETE SET NULL,
    relation_type TEXT NOT NULL CHECK (
        relation_type IN ('official', 'author', 'third-party-reproduction', 'unknown')
    ),
    evidence_kind TEXT NOT NULL CHECK (
        evidence_kind IN ('paper-explicit', 'project-page', 'search', 'third-party')
    ),
    evidence_ref TEXT,
    review_status TEXT NOT NULL CHECK (
        review_status IN ('auto-confirmed', 'proposed', 'confirmed', 'rejected')
    ),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (paper_id, repository_id)
) STRICT;

CREATE TABLE extraction_runs (
    id TEXT PRIMARY KEY,
    paper_version_id TEXT NOT NULL REFERENCES paper_versions(id) ON DELETE CASCADE,
    source_artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,
    output_artifact_id TEXT REFERENCES artifacts(id) ON DELETE RESTRICT,
    parser_name TEXT NOT NULL,
    parser_version TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN ('queued', 'running', 'succeeded', 'failed', 'discarded')
    ),
    is_active INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1)),
    started_at TEXT,
    completed_at TEXT,
    error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json))
) STRICT;

CREATE UNIQUE INDEX uq_active_extraction
    ON extraction_runs(paper_version_id)
    WHERE is_active = 1;

CREATE TABLE document_elements (
    id TEXT PRIMARY KEY,
    extraction_run_id TEXT NOT NULL REFERENCES extraction_runs(id) ON DELETE CASCADE,
    element_type TEXT NOT NULL CHECK (
        element_type IN ('section', 'text', 'equation', 'table', 'figure', 'caption')
    ),
    parent_element_id TEXT REFERENCES document_elements(id) ON DELETE SET NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    section_path TEXT,
    page_number INTEGER NOT NULL CHECK (page_number >= 1),
    bbox_json TEXT CHECK (bbox_json IS NULL OR json_valid(bbox_json)),
    content_text TEXT,
    media_artifact_id TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
    confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
    created_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_document_elements_page
    ON document_elements(extraction_run_id, page_number, ordinal);

CREATE TABLE code_elements (
    id TEXT PRIMARY KEY,
    repository_snapshot_id TEXT NOT NULL REFERENCES repository_snapshots(id) ON DELETE CASCADE,
    element_type TEXT NOT NULL CHECK (
        element_type IN ('file', 'symbol', 'block', 'readme', 'config')
    ),
    file_path TEXT NOT NULL,
    symbol_name TEXT,
    language TEXT,
    line_start INTEGER CHECK (line_start IS NULL OR line_start >= 1),
    line_end INTEGER CHECK (line_end IS NULL OR line_end >= line_start),
    content_hash TEXT NOT NULL,
    content_text TEXT,
    created_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_code_elements_path
    ON code_elements(repository_snapshot_id, file_path, line_start);

CREATE TABLE evidence_anchors (
    id TEXT PRIMARY KEY,
    source_kind TEXT NOT NULL CHECK (source_kind IN ('paper', 'code')),
    paper_version_id TEXT REFERENCES paper_versions(id) ON DELETE CASCADE,
    extraction_run_id TEXT REFERENCES extraction_runs(id) ON DELETE SET NULL,
    document_element_id TEXT REFERENCES document_elements(id) ON DELETE SET NULL,
    page_number INTEGER CHECK (page_number IS NULL OR page_number >= 1),
    bbox_json TEXT CHECK (bbox_json IS NULL OR json_valid(bbox_json)),
    repository_snapshot_id TEXT REFERENCES repository_snapshots(id) ON DELETE CASCADE,
    code_element_id TEXT REFERENCES code_elements(id) ON DELETE SET NULL,
    file_path TEXT,
    line_start INTEGER CHECK (line_start IS NULL OR line_start >= 1),
    line_end INTEGER CHECK (line_end IS NULL OR line_end >= line_start),
    quote_text TEXT,
    created_at TEXT NOT NULL,
    CHECK (
        (source_kind = 'paper' AND paper_version_id IS NOT NULL AND page_number IS NOT NULL
            AND repository_snapshot_id IS NULL)
        OR
        (source_kind = 'code' AND repository_snapshot_id IS NOT NULL AND file_path IS NOT NULL
            AND paper_version_id IS NULL)
    )
) STRICT;

CREATE TABLE markdown_documents (
    id TEXT PRIMARY KEY,
    owner_kind TEXT NOT NULL CHECK (
        owner_kind IN ('paper', 'summary-revision', 'takeaway-revision', 'knowledge-revision', 'code-analysis')
    ),
    owner_id TEXT NOT NULL,
    revision_number INTEGER NOT NULL CHECK (revision_number >= 1),
    repository_path TEXT NOT NULL UNIQUE,
    content_hash TEXT NOT NULL,
    reconciliation_status TEXT NOT NULL DEFAULT 'in-sync' CHECK (
        reconciliation_status IN ('in-sync', 'external-change', 'invalid', 'conflicted', 'missing')
    ),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (owner_kind, owner_id, revision_number)
) STRICT;

CREATE TABLE summary_revisions (
    id TEXT PRIMARY KEY,
    paper_version_id TEXT NOT NULL REFERENCES paper_versions(id) ON DELETE CASCADE,
    extraction_run_id TEXT NOT NULL REFERENCES extraction_runs(id) ON DELETE RESTRICT,
    artifact_id TEXT NOT NULL UNIQUE REFERENCES artifacts(id) ON DELETE RESTRICT,
    markdown_document_id TEXT NOT NULL UNIQUE REFERENCES markdown_documents(id) ON DELETE RESTRICT,
    agent_job_run_id TEXT NOT NULL REFERENCES agent_runs(job_run_id) ON DELETE RESTRICT,
    revision_number INTEGER NOT NULL CHECK (revision_number >= 1),
    status TEXT NOT NULL CHECK (status IN ('active', 'candidate', 'superseded')),
    read_status TEXT NOT NULL CHECK (read_status IN ('abstract', 'skimmed', 'read')),
    skill_content_hash TEXT NOT NULL,
    generated_at TEXT NOT NULL,
    activated_at TEXT,
    UNIQUE (paper_version_id, revision_number)
) STRICT;

CREATE UNIQUE INDEX uq_active_summary
    ON summary_revisions(paper_version_id)
    WHERE status = 'active';

CREATE TABLE summary_sections (
    id TEXT PRIMARY KEY,
    summary_revision_id TEXT NOT NULL REFERENCES summary_revisions(id) ON DELETE CASCADE,
    section_key TEXT NOT NULL,
    title TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    markdown_fragment TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    UNIQUE (summary_revision_id, section_key)
) STRICT;

CREATE TABLE summary_claims (
    id TEXT PRIMARY KEY,
    summary_revision_id TEXT NOT NULL REFERENCES summary_revisions(id) ON DELETE CASCADE,
    section_id TEXT REFERENCES summary_sections(id) ON DELETE SET NULL,
    voice TEXT NOT NULL CHECK (
        voice IN ('authors-claim', 'paper-evidence', 'agent-assessment')
    ),
    claim_text TEXT NOT NULL,
    confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0)
) STRICT;

CREATE TABLE summary_claim_evidence (
    summary_claim_id TEXT NOT NULL REFERENCES summary_claims(id) ON DELETE CASCADE,
    evidence_anchor_id TEXT NOT NULL REFERENCES evidence_anchors(id) ON DELETE RESTRICT,
    relationship TEXT NOT NULL DEFAULT 'supports' CHECK (
        relationship IN ('supports', 'challenges', 'context')
    ),
    PRIMARY KEY (summary_claim_id, evidence_anchor_id, relationship)
) STRICT;

CREATE TABLE repository_digests (
    id TEXT PRIMARY KEY,
    repository_snapshot_id TEXT NOT NULL REFERENCES repository_snapshots(id) ON DELETE CASCADE,
    artifact_id TEXT NOT NULL UNIQUE REFERENCES artifacts(id) ON DELETE RESTRICT,
    agent_job_run_id TEXT REFERENCES agent_runs(job_run_id) ON DELETE SET NULL,
    revision_number INTEGER NOT NULL CHECK (revision_number >= 1),
    status TEXT NOT NULL CHECK (status IN ('active', 'candidate', 'superseded')),
    created_at TEXT NOT NULL,
    UNIQUE (repository_snapshot_id, revision_number)
) STRICT;

CREATE UNIQUE INDEX uq_active_repository_digest
    ON repository_digests(repository_snapshot_id)
    WHERE status = 'active';

CREATE TABLE code_analyses (
    id TEXT PRIMARY KEY,
    paper_version_id TEXT NOT NULL REFERENCES paper_versions(id) ON DELETE CASCADE,
    repository_snapshot_id TEXT NOT NULL REFERENCES repository_snapshots(id) ON DELETE CASCADE,
    artifact_id TEXT NOT NULL UNIQUE REFERENCES artifacts(id) ON DELETE RESTRICT,
    markdown_document_id TEXT REFERENCES markdown_documents(id) ON DELETE RESTRICT,
    agent_job_run_id TEXT REFERENCES agent_runs(job_run_id) ON DELETE SET NULL,
    revision_number INTEGER NOT NULL CHECK (revision_number >= 1),
    status TEXT NOT NULL CHECK (status IN ('active', 'candidate', 'superseded')),
    created_at TEXT NOT NULL,
    UNIQUE (paper_version_id, repository_snapshot_id, revision_number)
) STRICT;

CREATE TABLE conversations (
    id TEXT PRIMARY KEY,
    paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
    title TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'deleted')),
    current_context_snapshot_id TEXT REFERENCES context_snapshots(id) ON DELETE SET NULL
        DEFERRABLE INITIALLY DEFERRED,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT,
    deleted_at TEXT
) STRICT;

CREATE TABLE context_snapshots (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    paper_version_id TEXT NOT NULL REFERENCES paper_versions(id) ON DELETE RESTRICT,
    summary_revision_id TEXT NOT NULL REFERENCES summary_revisions(id) ON DELETE RESTRICT,
    extraction_run_id TEXT NOT NULL REFERENCES extraction_runs(id) ON DELETE RESTRICT,
    created_at TEXT NOT NULL
) STRICT;

CREATE TABLE context_snapshot_repositories (
    context_snapshot_id TEXT NOT NULL REFERENCES context_snapshots(id) ON DELETE CASCADE,
    repository_snapshot_id TEXT NOT NULL REFERENCES repository_snapshots(id) ON DELETE RESTRICT,
    PRIMARY KEY (context_snapshot_id, repository_snapshot_id)
) STRICT;

CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    context_snapshot_id TEXT NOT NULL REFERENCES context_snapshots(id) ON DELETE RESTRICT,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
    content_text TEXT NOT NULL,
    agent_job_run_id TEXT REFERENCES agent_runs(job_run_id) ON DELETE SET NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    created_at TEXT NOT NULL,
    deleted_at TEXT,
    UNIQUE (conversation_id, ordinal)
) STRICT;

CREATE TABLE message_evidence (
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    evidence_anchor_id TEXT NOT NULL REFERENCES evidence_anchors(id) ON DELETE RESTRICT,
    ordinal INTEGER NOT NULL DEFAULT 0 CHECK (ordinal >= 0),
    PRIMARY KEY (message_id, evidence_anchor_id)
) STRICT;

CREATE TABLE conversation_digests (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    context_snapshot_id TEXT NOT NULL REFERENCES context_snapshots(id) ON DELETE RESTRICT,
    first_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE RESTRICT,
    last_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE RESTRICT,
    artifact_id TEXT NOT NULL UNIQUE REFERENCES artifacts(id) ON DELETE RESTRICT,
    agent_job_run_id TEXT NOT NULL REFERENCES agent_runs(job_run_id) ON DELETE RESTRICT,
    revision_number INTEGER NOT NULL CHECK (revision_number >= 1),
    created_at TEXT NOT NULL,
    UNIQUE (conversation_id, revision_number)
) STRICT;

CREATE TABLE annotations (
    id TEXT PRIMARY KEY,
    paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
    target_kind TEXT NOT NULL CHECK (
        target_kind IN ('evidence-anchor', 'summary-section', 'summary-claim')
    ),
    target_id TEXT NOT NULL,
    content_text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'deleted')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
) STRICT;

CREATE TABLE takeaways (
    id TEXT PRIMARY KEY,
    paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
    active_revision_id TEXT REFERENCES takeaway_revisions(id) ON DELETE SET NULL
        DEFERRABLE INITIALLY DEFERRED,
    lifecycle_status TEXT NOT NULL DEFAULT 'active' CHECK (
        lifecycle_status IN ('active', 'superseded', 'deleted')
    ),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE takeaway_revisions (
    id TEXT PRIMARY KEY,
    takeaway_id TEXT NOT NULL REFERENCES takeaways(id) ON DELETE CASCADE,
    revision_number INTEGER NOT NULL CHECK (revision_number >= 1),
    markdown_document_id TEXT NOT NULL UNIQUE REFERENCES markdown_documents(id) ON DELETE RESTRICT,
    claim_text TEXT NOT NULL,
    review_status TEXT NOT NULL CHECK (
        review_status IN ('confirmed', 'needs-review', 'superseded', 'provenance-missing')
    ),
    epistemic_status TEXT NOT NULL DEFAULT 'evidence-backed' CHECK (
        epistemic_status = 'evidence-backed'
    ),
    confirmed_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (takeaway_id, revision_number)
) STRICT;

CREATE TABLE takeaway_evidence (
    takeaway_revision_id TEXT NOT NULL REFERENCES takeaway_revisions(id) ON DELETE CASCADE,
    evidence_anchor_id TEXT NOT NULL REFERENCES evidence_anchors(id) ON DELETE RESTRICT,
    relationship TEXT NOT NULL CHECK (relationship IN ('supports', 'challenges', 'context')),
    PRIMARY KEY (takeaway_revision_id, evidence_anchor_id, relationship)
) STRICT;

CREATE TABLE knowledge_nodes (
    id TEXT PRIMARY KEY,
    node_type TEXT NOT NULL CHECK (
        node_type IN ('insight', 'concept', 'topic', 'question', 'synthesis')
    ),
    active_revision_id TEXT REFERENCES knowledge_revisions(id) ON DELETE SET NULL
        DEFERRABLE INITIALLY DEFERRED,
    lifecycle_status TEXT NOT NULL DEFAULT 'active' CHECK (
        lifecycle_status IN ('active', 'superseded', 'deleted')
    ),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE knowledge_revisions (
    id TEXT PRIMARY KEY,
    knowledge_node_id TEXT NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
    revision_number INTEGER NOT NULL CHECK (revision_number >= 1),
    markdown_document_id TEXT NOT NULL UNIQUE REFERENCES markdown_documents(id) ON DELETE RESTRICT,
    title TEXT NOT NULL,
    review_status TEXT NOT NULL CHECK (
        review_status IN ('confirmed', 'needs-review', 'superseded', 'provenance-missing')
    ),
    epistemic_status TEXT NOT NULL CHECK (
        epistemic_status IN ('evidence-backed', 'interpretation', 'hypothesis', 'open-question')
    ),
    confirmed_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (knowledge_node_id, revision_number)
) STRICT;

CREATE TABLE proposals (
    id TEXT PRIMARY KEY,
    proposal_type TEXT NOT NULL CHECK (
        proposal_type IN (
            'paper-version-update', 'repository-link', 'summary-replacement',
            'takeaway', 'knowledge-node', 'knowledge-revision', 'semantic-relation',
            'markdown-reconciliation'
        )
    ),
    target_kind TEXT,
    target_id TEXT,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    source_refs_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(source_refs_json)),
    confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
    proposed_by_job_run_id TEXT REFERENCES job_runs(id) ON DELETE SET NULL,
    fingerprint TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending' CHECK (
        state IN ('pending', 'accepted', 'rejected', 'superseded', 'expired', 'archived')
    ),
    created_at TEXT NOT NULL,
    decided_at TEXT
) STRICT;

CREATE UNIQUE INDEX uq_pending_proposal_fingerprint
    ON proposals(fingerprint)
    WHERE state = 'pending';

CREATE TABLE review_decisions (
    id TEXT PRIMARY KEY,
    proposal_id TEXT REFERENCES proposals(id) ON DELETE SET NULL,
    target_kind TEXT NOT NULL,
    target_id TEXT NOT NULL,
    action TEXT NOT NULL CHECK (
        action IN (
            'accept', 'accept-with-edit', 'reject', 'set-active',
            'supersede', 'request-reprocess'
        )
    ),
    before_revision_id TEXT,
    after_revision_id TEXT,
    reason TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    decided_at TEXT NOT NULL
) STRICT;

CREATE TABLE provenance_links (
    id TEXT PRIMARY KEY,
    target_kind TEXT NOT NULL CHECK (
        target_kind IN ('takeaway-revision', 'knowledge-revision', 'semantic-relation')
    ),
    target_id TEXT NOT NULL,
    source_kind TEXT NOT NULL CHECK (
        source_kind IN (
            'evidence-anchor', 'message', 'summary-claim', 'annotation',
            'takeaway-revision', 'knowledge-revision', 'code-analysis'
        )
    ),
    source_id TEXT NOT NULL,
    relationship TEXT NOT NULL CHECK (
        relationship IN ('supported-by', 'challenged-by', 'derived-from', 'informed-by', 'context')
    ),
    ordinal INTEGER NOT NULL DEFAULT 0 CHECK (ordinal >= 0),
    created_at TEXT NOT NULL,
    UNIQUE (target_kind, target_id, source_kind, source_id, relationship)
) STRICT;

CREATE INDEX idx_provenance_target ON provenance_links(target_kind, target_id);
CREATE INDEX idx_provenance_source ON provenance_links(source_kind, source_id);

CREATE TABLE semantic_relations (
    id TEXT PRIMARY KEY,
    source_kind TEXT NOT NULL,
    source_id TEXT NOT NULL,
    target_kind TEXT NOT NULL,
    target_id TEXT NOT NULL,
    relation_type TEXT NOT NULL,
    confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
    review_status TEXT NOT NULL CHECK (
        review_status IN ('auto-confirmed', 'proposed', 'confirmed', 'rejected', 'superseded')
    ),
    proposal_id TEXT REFERENCES proposals(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (source_kind <> target_kind OR source_id <> target_id),
    UNIQUE (source_kind, source_id, target_kind, target_id, relation_type)
) STRICT;

CREATE INDEX idx_semantic_source ON semantic_relations(source_kind, source_id);
CREATE INDEX idx_semantic_target ON semantic_relations(target_kind, target_id);

CREATE TABLE paper_citations (
    id TEXT PRIMARY KEY,
    citing_paper_version_id TEXT NOT NULL REFERENCES paper_versions(id) ON DELETE CASCADE,
    cited_paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE RESTRICT,
    evidence_anchor_id TEXT REFERENCES evidence_anchors(id) ON DELETE SET NULL,
    reference_label TEXT,
    resolution_status TEXT NOT NULL CHECK (
        resolution_status IN ('auto-confirmed', 'ambiguous', 'confirmed', 'rejected')
    ),
    confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
    created_at TEXT NOT NULL,
    UNIQUE (citing_paper_version_id, cited_paper_id, reference_label)
) STRICT;

CREATE TABLE knowledge_write_requests (
    id TEXT PRIMARY KEY,
    request_type TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    owner_kind TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    planned_revision_id TEXT NOT NULL,
    target_path TEXT NOT NULL UNIQUE,
    staged_path TEXT,
    expected_content_hash TEXT,
    result_content_hash TEXT,
    state TEXT NOT NULL CHECK (
        state IN ('reserved', 'staged', 'renamed', 'metadata-committed', 'indexed', 'complete', 'failed', 'conflicted')
    ),
    idempotency_key TEXT NOT NULL UNIQUE,
    requested_at TEXT NOT NULL,
    staged_at TEXT,
    renamed_at TEXT,
    metadata_committed_at TEXT,
    indexed_at TEXT,
    completed_at TEXT,
    reconciliation_proposal_id TEXT REFERENCES proposals(id) ON DELETE RESTRICT,
    error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json))
) STRICT;

CREATE TABLE index_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    projection_kind TEXT NOT NULL CHECK (
        projection_kind IN ('working-search', 'curated-search')
    ),
    source_kind TEXT NOT NULL,
    source_id TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('upsert', 'remove')),
    content_hash TEXT,
    state TEXT NOT NULL DEFAULT 'pending' CHECK (
        state IN ('pending', 'processing', 'succeeded', 'failed')
    ),
    attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
    created_at TEXT NOT NULL,
    processed_at TEXT
) STRICT;

CREATE INDEX idx_index_outbox_dispatch ON index_outbox(projection_kind, state, id);

CREATE TABLE search_documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stable_id TEXT NOT NULL UNIQUE,
    corpus TEXT NOT NULL CHECK (corpus IN ('global-curated', 'paper-working')),
    paper_id TEXT REFERENCES papers(id) ON DELETE CASCADE,
    source_kind TEXT NOT NULL CHECK (
        source_kind IN (
            'summary-section', 'takeaway-revision', 'knowledge-revision',
            'document-element', 'message', 'conversation-digest', 'annotation',
            'repository-digest', 'code-element', 'code-analysis'
        )
    ),
    source_id TEXT NOT NULL,
    source_revision_id TEXT,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    trust_label TEXT NOT NULL CHECK (
        trust_label IN ('generated-from-primary-source', 'user-confirmed', 'working-context')
    ),
    content_hash TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (
        (corpus = 'global-curated' AND source_kind IN (
            'summary-section', 'takeaway-revision', 'knowledge-revision'
        ))
        OR
        (corpus = 'paper-working' AND paper_id IS NOT NULL AND source_kind IN (
            'document-element', 'message', 'conversation-digest', 'annotation',
            'repository-digest', 'code-element', 'code-analysis'
        ))
    )
) STRICT;

CREATE INDEX idx_search_documents_scope
    ON search_documents(corpus, paper_id, is_active, source_kind);

CREATE VIRTUAL TABLE search_fts USING fts5(
    title,
    body,
    content = 'search_documents',
    content_rowid = 'id',
    tokenize = 'trigram'
);

CREATE TRIGGER search_documents_ai AFTER INSERT ON search_documents BEGIN
    INSERT INTO search_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
END;

CREATE TRIGGER search_documents_ad AFTER DELETE ON search_documents BEGIN
    INSERT INTO search_fts(search_fts, rowid, title, body)
    VALUES ('delete', old.id, old.title, old.body);
END;

CREATE TRIGGER search_documents_au AFTER UPDATE OF title, body ON search_documents BEGIN
    INSERT INTO search_fts(search_fts, rowid, title, body)
    VALUES ('delete', old.id, old.title, old.body);
    INSERT INTO search_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
END;

-- The Entry Agent never queries the shared search_documents/search_fts corpus.
CREATE TABLE curated_search_documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stable_id TEXT NOT NULL UNIQUE,
    source_kind TEXT NOT NULL CHECK (
        source_kind IN ('summary-section', 'takeaway-revision', 'knowledge-revision')
    ),
    source_id TEXT NOT NULL,
    source_revision_id TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    trust_label TEXT NOT NULL CHECK (
        trust_label IN ('generated-from-primary-source', 'user-confirmed')
    ),
    content_hash TEXT NOT NULL,
    is_active INTEGER NOT NULL CHECK (is_active IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
) STRICT;

CREATE VIRTUAL TABLE curated_search_fts USING fts5(
    title,
    body,
    content = 'curated_search_documents',
    content_rowid = 'id',
    tokenize = 'trigram'
);

CREATE TRIGGER curated_search_documents_ai AFTER INSERT ON curated_search_documents BEGIN
    INSERT INTO curated_search_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
END;

CREATE TRIGGER curated_search_documents_ad AFTER DELETE ON curated_search_documents BEGIN
    INSERT INTO curated_search_fts(curated_search_fts, rowid, title, body)
    VALUES ('delete', old.id, old.title, old.body);
END;

CREATE TRIGGER curated_search_documents_au AFTER UPDATE OF title, body ON curated_search_documents BEGIN
    INSERT INTO curated_search_fts(curated_search_fts, rowid, title, body)
    VALUES ('delete', old.id, old.title, old.body);
    INSERT INTO curated_search_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
END;

CREATE TABLE projection_state (
    projection_kind TEXT PRIMARY KEY CHECK (
        projection_kind IN ('working-search', 'curated-search')
    ),
    last_successful_outbox_id INTEGER,
    last_successful_at TEXT,
    stale_since TEXT,
    last_rebuilt_at TEXT,
    updated_at TEXT NOT NULL
) STRICT;

CREATE TRIGGER immutable_papers_no_delete BEFORE DELETE ON papers BEGIN
    SELECT RAISE(ABORT, 'immutable papers are tombstoned, not deleted');
END;

CREATE TRIGGER immutable_paper_versions_no_delete BEFORE DELETE ON paper_versions BEGIN
    SELECT RAISE(ABORT, 'immutable paper versions are not deleted');
END;

CREATE TRIGGER immutable_artifacts_no_delete BEFORE DELETE ON artifacts BEGIN
    SELECT RAISE(ABORT, 'immutable artifacts are not deleted');
END;

CREATE TRIGGER immutable_extraction_runs_no_delete BEFORE DELETE ON extraction_runs BEGIN
    SELECT RAISE(ABORT, 'referenced extraction runs are not deleted');
END;

CREATE TRIGGER immutable_repository_snapshots_no_delete BEFORE DELETE ON repository_snapshots BEGIN
    SELECT RAISE(ABORT, 'immutable repository snapshots are not deleted');
END;

CREATE TRIGGER immutable_summary_revisions_no_delete BEFORE DELETE ON summary_revisions BEGIN
    SELECT RAISE(ABORT, 'immutable summary revisions are not deleted');
END;

CREATE TRIGGER immutable_takeaway_revisions_no_delete BEFORE DELETE ON takeaway_revisions BEGIN
    SELECT RAISE(ABORT, 'immutable takeaway revisions are not deleted');
END;

CREATE TRIGGER immutable_knowledge_revisions_no_delete BEFORE DELETE ON knowledge_revisions BEGIN
    SELECT RAISE(ABORT, 'immutable knowledge revisions are not deleted');
END;

CREATE VIEW current_paper_summaries AS
SELECT
    p.id AS paper_id,
    p.current_version_id AS paper_version_id,
    sr.id AS summary_revision_id,
    sr.markdown_document_id,
    sr.generated_at
FROM papers p
JOIN summary_revisions sr
    ON sr.paper_version_id = p.current_version_id
   AND sr.status = 'active'
WHERE p.lifecycle_status = 'active';

CREATE VIEW pending_review_queue AS
SELECT
    id,
    proposal_type,
    target_kind,
    target_id,
    confidence,
    created_at
FROM proposals
WHERE state = 'pending';

INSERT INTO schema_migrations(version, name, applied_at)
VALUES (1, 'scholarloom-v1', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

COMMIT;

PRAGMA foreign_key_check;
