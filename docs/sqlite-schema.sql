-- ScholarLoom SQLite target schema v1.2
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

CREATE TABLE artifact_integrity_verifications (
    artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,
    stat_fingerprint TEXT NOT NULL,
    verified_at TEXT NOT NULL
) STRICT;

CREATE TABLE pdf_delivery_optimizations (
    id TEXT PRIMARY KEY,
    source_artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    output_artifact_id TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
    strategy TEXT NOT NULL CHECK (strategy IN ('lossless-linearization')),
    tool_name TEXT,
    tool_version TEXT,
    parameters_json TEXT NOT NULL CHECK (json_valid(parameters_json)),
    status TEXT NOT NULL CHECK (status IN ('selected', 'skipped', 'failed')),
    reason TEXT NOT NULL,
    source_byte_size INTEGER NOT NULL CHECK (source_byte_size >= 0),
    output_byte_size INTEGER CHECK (output_byte_size IS NULL OR output_byte_size >= 0),
    metrics_json TEXT NOT NULL CHECK (json_valid(metrics_json)),
    attempted_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (source_artifact_id, strategy)
) STRICT;

CREATE INDEX pdf_delivery_optimizations_output
    ON pdf_delivery_optimizations(output_artifact_id)
    WHERE output_artifact_id IS NOT NULL;

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
        identity_type IN ('arxiv', 'doi', 'pmid', 'publisher', 'direct-pdf-url', 'other')
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
        source_type IN ('arxiv', 'conference', 'journal', 'publisher', 'direct-pdf', 'other')
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
    source_content_hash TEXT,
    source_media_type TEXT,
    metadata_json TEXT CHECK (metadata_json IS NULL OR json_valid(metadata_json)),
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
    completed_at TEXT,
    reference_kind TEXT,
    frozen_input_json TEXT CHECK (frozen_input_json IS NULL OR json_valid(frozen_input_json))
) STRICT;

CREATE INDEX idx_paper_versions_content_hash ON paper_versions(source_content_hash);

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
        state IN ('queued', 'running', 'canceling', 'succeeded', 'failed', 'timed_out', 'canceled', 'interrupted')
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
    ,run_epoch INTEGER NOT NULL DEFAULT 0 CHECK (run_epoch >= 0)
    ,lease_owner TEXT
    ,lease_expires_at TEXT
    ,cancel_requested_at TEXT
    ,runner_kind TEXT CHECK (runner_kind IS NULL OR runner_kind IN ('legacy_one_shot','agentic_evidence'))
    ,failure_kind TEXT
    ,evidence_workspace_id TEXT REFERENCES evidence_workspaces(id) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE INDEX idx_job_runs_dispatch ON job_runs(state, job_type, queued_at);
CREATE INDEX idx_job_runs_import ON job_runs(import_request_id, queued_at);
CREATE INDEX idx_job_runs_paper ON job_runs(paper_id, queued_at);

CREATE TABLE agent_runs (
    job_run_id TEXT PRIMARY KEY REFERENCES job_runs(id),
    task_kind TEXT NOT NULL,
    model TEXT,
    reasoning_effort TEXT CHECK (
        reasoning_effort IS NULL OR reasoning_effort IN ('medium', 'high')
    ),
    codex_version TEXT NOT NULL,
    configuration_version TEXT,
    skill_path TEXT,
    skill_content_hash TEXT,
    context_snapshot_id TEXT REFERENCES context_snapshots(id),
    output_schema_hash TEXT NOT NULL,
    prompt_hash TEXT NOT NULL,
    output_json TEXT NOT NULL CHECK (json_valid(output_json))
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
    page_count INTEGER CHECK (page_count IS NULL OR page_count >= 1),
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
    canonical_sections_hash TEXT NOT NULL,
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
    title TEXT NOT NULL DEFAULT '新对话',
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    active_context_snapshot_id TEXT REFERENCES context_snapshots(id) ON DELETE SET NULL
        DEFERRABLE INITIALLY DEFERRED,
    continued_from_conversation_id TEXT REFERENCES conversations(id),
    snapshot_integrity TEXT NOT NULL CHECK (snapshot_integrity IN ('frozen', 'legacy')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT
) STRICT;

CREATE TABLE context_snapshots (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    paper_version_id TEXT NOT NULL REFERENCES paper_versions(id) ON DELETE RESTRICT,
    summary_revision_id TEXT NOT NULL REFERENCES summary_revisions(id) ON DELETE RESTRICT,
    extraction_run_id TEXT NOT NULL REFERENCES extraction_runs(id) ON DELETE RESTRICT,
    repositories_json TEXT NOT NULL CHECK (json_valid(repositories_json)),
    knowledge_corpus_manifest_id TEXT NOT NULL REFERENCES knowledge_corpus_manifests(id) ON DELETE RESTRICT,
    version_diff_json TEXT CHECK (version_diff_json IS NULL OR json_valid(version_diff_json)),
    created_at TEXT NOT NULL
) STRICT;

CREATE TRIGGER context_snapshots_one_per_new_conversation
BEFORE INSERT ON context_snapshots
WHEN EXISTS (SELECT 1 FROM context_snapshots WHERE conversation_id = NEW.conversation_id)
BEGIN
    SELECT RAISE(ABORT, 'conversation-context-snapshot-immutable');
END;

CREATE TRIGGER conversations_context_snapshot_set_once
BEFORE UPDATE OF active_context_snapshot_id ON conversations
WHEN OLD.active_context_snapshot_id IS NOT NULL
    AND NEW.active_context_snapshot_id IS NOT OLD.active_context_snapshot_id
BEGIN
    SELECT RAISE(ABORT, 'conversation-context-snapshot-immutable');
END;

CREATE TRIGGER context_snapshots_no_update
BEFORE UPDATE ON context_snapshots
BEGIN
    SELECT RAISE(ABORT, 'conversation-context-snapshot-immutable');
END;

CREATE TRIGGER context_snapshots_no_delete
BEFORE DELETE ON context_snapshots
BEGIN
    SELECT RAISE(ABORT, 'conversation-context-snapshot-immutable');
END;

CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    context_snapshot_id TEXT NOT NULL REFERENCES context_snapshots(id) ON DELETE RESTRICT,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    citations_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(citations_json)),
    grounding_status TEXT CHECK (grounding_status IS NULL OR grounding_status IN
        ('answered','partially_answered','insufficient_evidence','conflicting_evidence')),
    ordinal INTEGER CHECK (ordinal >= 1),
    in_reply_to_message_id TEXT REFERENCES messages(id),
    created_at TEXT NOT NULL,
    UNIQUE (conversation_id, ordinal)
) STRICT;

CREATE UNIQUE INDEX messages_one_assistant_reply
    ON messages(in_reply_to_message_id)
    WHERE role = 'assistant' AND in_reply_to_message_id IS NOT NULL;

-- Global Knowledge Conversations are independent from Paper-scoped conversations.
-- Only a successfully validated turn creates knowledge_messages.
CREATE TABLE knowledge_conversations (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT
) STRICT;

CREATE INDEX idx_knowledge_conversations_activity
    ON knowledge_conversations(status, updated_at DESC, id);

CREATE TABLE knowledge_messages (
    id TEXT PRIMARY KEY,
    knowledge_conversation_id TEXT NOT NULL REFERENCES knowledge_conversations(id) ON DELETE RESTRICT,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    reply_to_message_id TEXT REFERENCES knowledge_messages(id) ON DELETE RESTRICT,
    content TEXT NOT NULL,
    answer_basis TEXT CHECK (
        answer_basis IS NULL OR answer_basis IN ('curated-evidence', 'conversation-context', 'model-knowledge')
    ),
    coverage TEXT CHECK (
        coverage IS NULL OR coverage IN ('supported', 'partial', 'none', 'conflicting')
    ),
    structured_answer_json TEXT CHECK (
        structured_answer_json IS NULL OR json_valid(structured_answer_json)
    ),
    created_at TEXT NOT NULL,
    UNIQUE (knowledge_conversation_id, ordinal),
    CHECK (
        (role = 'user' AND reply_to_message_id IS NULL AND answer_basis IS NULL
            AND coverage IS NULL AND structured_answer_json IS NULL)
        OR
        (role = 'assistant' AND reply_to_message_id IS NOT NULL AND answer_basis IS NOT NULL
            AND coverage IS NOT NULL AND structured_answer_json IS NOT NULL)
    )
) STRICT;

CREATE TRIGGER knowledge_messages_reply_owner
BEFORE INSERT ON knowledge_messages
WHEN NEW.role = 'assistant' AND NOT EXISTS (
    SELECT 1 FROM knowledge_messages parent
    WHERE parent.id = NEW.reply_to_message_id
      AND parent.knowledge_conversation_id = NEW.knowledge_conversation_id
      AND parent.role = 'user'
)
BEGIN
    SELECT RAISE(ABORT, 'knowledge-message-reply-invalid');
END;

CREATE TRIGGER knowledge_messages_no_update
BEFORE UPDATE ON knowledge_messages
BEGIN
    SELECT RAISE(ABORT, 'knowledge-message-immutable');
END;

CREATE TRIGGER knowledge_messages_no_delete
BEFORE DELETE ON knowledge_messages
BEGIN
    SELECT RAISE(ABORT, 'knowledge-message-immutable');
END;

CREATE TABLE knowledge_turn_attempts (
    id TEXT PRIMARY KEY,
    job_run_id TEXT NOT NULL UNIQUE REFERENCES job_runs(id) ON DELETE RESTRICT,
    knowledge_conversation_id TEXT REFERENCES knowledge_conversations(id) ON DELETE RESTRICT,
    submission_id TEXT NOT NULL UNIQUE,
    cancel_idempotency_key TEXT UNIQUE,
    question_hash TEXT NOT NULL,
    run_epoch INTEGER NOT NULL DEFAULT 0 CHECK (run_epoch >= 0),
    state TEXT NOT NULL CHECK (state IN ('running', 'succeeded', 'failed', 'canceled', 'interrupted')),
    user_message_id TEXT REFERENCES knowledge_messages(id) ON DELETE RESTRICT,
    assistant_message_id TEXT REFERENCES knowledge_messages(id) ON DELETE RESTRICT,
    error_code TEXT,
    error_detail TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT,
    CHECK (
        (state = 'succeeded' AND knowledge_conversation_id IS NOT NULL
            AND user_message_id IS NOT NULL AND assistant_message_id IS NOT NULL)
        OR
        (state <> 'succeeded' AND user_message_id IS NULL AND assistant_message_id IS NULL)
    )
) STRICT;

CREATE INDEX idx_knowledge_turn_attempts_conversation
    ON knowledge_turn_attempts(knowledge_conversation_id, created_at DESC);

-- Immutable, invocation-verified curated evidence committed with a successful answer.
CREATE TABLE knowledge_evidence_receipts (
    id TEXT PRIMARY KEY,
    assistant_message_id TEXT NOT NULL REFERENCES knowledge_messages(id) ON DELETE RESTRICT,
    job_run_id TEXT NOT NULL REFERENCES job_runs(id) ON DELETE RESTRICT,
    run_epoch INTEGER NOT NULL CHECK (run_epoch >= 1),
    ordinal INTEGER NOT NULL CHECK (ordinal >= 1 AND ordinal <= 20),
    source_type TEXT NOT NULL CHECK (source_type IN ('summary', 'takeaway', 'topic-knowledge')),
    source_id TEXT NOT NULL,
    source_revision_id TEXT NOT NULL,
    content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
    source_title TEXT NOT NULL,
    trust_label TEXT NOT NULL CHECK (trust_label IN ('generated-from-primary-source', 'user-confirmed')),
    locator_json TEXT NOT NULL CHECK (json_valid(locator_json)),
    quote_text TEXT NOT NULL,
    why_selected TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (assistant_message_id, ordinal),
    UNIQUE (job_run_id, run_epoch, ordinal)
) STRICT;

CREATE INDEX idx_knowledge_evidence_receipts_source
    ON knowledge_evidence_receipts(source_type, source_id, source_revision_id);

CREATE TRIGGER knowledge_evidence_receipts_assistant_owner
BEFORE INSERT ON knowledge_evidence_receipts
WHEN NOT EXISTS (
    SELECT 1 FROM knowledge_turn_attempts attempt
    JOIN knowledge_messages message ON message.id = attempt.assistant_message_id
    WHERE attempt.job_run_id = NEW.job_run_id
      AND attempt.assistant_message_id = NEW.assistant_message_id
      AND attempt.run_epoch = NEW.run_epoch
      AND attempt.state = 'succeeded'
      AND message.role = 'assistant'
)
BEGIN
    SELECT RAISE(ABORT, 'knowledge-evidence-receipt-owner-invalid');
END;

CREATE TRIGGER knowledge_evidence_receipts_no_update
BEFORE UPDATE ON knowledge_evidence_receipts
BEGIN
    SELECT RAISE(ABORT, 'knowledge-evidence-receipt-immutable');
END;

CREATE TRIGGER knowledge_evidence_receipts_no_delete
BEFORE DELETE ON knowledge_evidence_receipts
BEGIN
    SELECT RAISE(ABORT, 'knowledge-evidence-receipt-immutable');
END;

CREATE TABLE conversation_turn_attempts (
    job_run_id TEXT PRIMARY KEY REFERENCES job_runs(id),
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    user_message_id TEXT NOT NULL REFERENCES messages(id),
    attempt_no INTEGER NOT NULL CHECK (attempt_no > 0),
    created_at TEXT NOT NULL,
    UNIQUE (user_message_id, attempt_no)
) STRICT;

CREATE TABLE knowledge_corpus_manifests (
    id TEXT PRIMARY KEY,
    manifest_hash TEXT NOT NULL UNIQUE,
    manifest_json TEXT NOT NULL CHECK (json_valid(manifest_json)),
    created_at TEXT NOT NULL
) STRICT;

CREATE TABLE evidence_workspaces (
    id TEXT PRIMARY KEY,
    context_snapshot_id TEXT NOT NULL REFERENCES context_snapshots(id),
    knowledge_corpus_manifest_id TEXT NOT NULL REFERENCES knowledge_corpus_manifests(id),
    workspace_hash TEXT NOT NULL UNIQUE,
    root_ref TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK (status IN ('building','built','failed','evicted')),
    builder_version TEXT NOT NULL,
    byte_size INTEGER NOT NULL DEFAULT 0 CHECK (byte_size >= 0),
    last_accessed_at TEXT, created_at TEXT NOT NULL, completed_at TEXT, failed_at TEXT, evicted_at TEXT,
    error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json))
) STRICT;

CREATE TABLE agent_run_activities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_run_id TEXT NOT NULL REFERENCES job_runs(id),
    run_epoch INTEGER NOT NULL CHECK (run_epoch >= 1),
    event_type TEXT NOT NULL,
    display_text TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
    created_at TEXT NOT NULL
) STRICT;

CREATE TABLE agent_run_usage (
    job_run_id TEXT NOT NULL REFERENCES job_runs(id), run_epoch INTEGER NOT NULL CHECK (run_epoch >= 1),
    status TEXT NOT NULL CHECK (status IN ('reported','estimated','unavailable')),
    input_tokens INTEGER, cached_input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER,
    elapsed_ms INTEGER, recorded_at TEXT NOT NULL, PRIMARY KEY (job_run_id,run_epoch)
) STRICT;

CREATE TABLE evidence_receipts (
    id TEXT PRIMARY KEY, job_run_id TEXT NOT NULL REFERENCES job_runs(id), run_epoch INTEGER NOT NULL,
    message_id TEXT REFERENCES messages(id), ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
    evidence_kind TEXT NOT NULL CHECK (evidence_kind IN ('pdf','summary','code','library','visual')),
    source_id TEXT NOT NULL, source_revision TEXT, workspace_path TEXT NOT NULL,
    locator_json TEXT NOT NULL CHECK (json_valid(locator_json)), content_hash TEXT NOT NULL,
    quote_text TEXT NOT NULL CHECK (length(quote_text) <= 500),
    verification_status TEXT NOT NULL CHECK (verification_status IN ('verified','render-drift')),
    visual_observation TEXT, created_at TEXT NOT NULL,
    UNIQUE (job_run_id,run_epoch,ordinal)
) STRICT;

-- Migration 017 keeps quote_text semantics intact by storing visual receipts separately.
CREATE TABLE visual_render_artifacts (
    id TEXT PRIMARY KEY, source_artifact_id TEXT NOT NULL REFERENCES artifacts(id),
    source_content_hash TEXT NOT NULL, page_number INTEGER NOT NULL CHECK (page_number >= 1),
    page_count INTEGER NOT NULL CHECK (page_count >= page_number),
    renderer_name TEXT NOT NULL, renderer_version TEXT NOT NULL, renderer_fingerprint TEXT NOT NULL,
    render_settings_json TEXT NOT NULL CHECK (json_valid(render_settings_json)),
    image_content_hash TEXT NOT NULL, storage_ref TEXT NOT NULL UNIQUE,
    media_type TEXT NOT NULL CHECK (media_type = 'image/png'), byte_size INTEGER NOT NULL,
    pixel_width INTEGER NOT NULL, pixel_height INTEGER NOT NULL,
    cache_state TEXT NOT NULL CHECK (cache_state IN ('complete','missing','render-drift')),
    created_at TEXT NOT NULL, last_accessed_at TEXT NOT NULL,
    UNIQUE (source_content_hash,page_number,renderer_fingerprint,render_settings_json)
) STRICT;

CREATE TABLE visual_page_inspections (
    id TEXT PRIMARY KEY, job_run_id TEXT NOT NULL REFERENCES job_runs(id),
    run_epoch INTEGER NOT NULL, source_artifact_id TEXT NOT NULL REFERENCES artifacts(id),
    source_content_hash TEXT NOT NULL, page_number INTEGER NOT NULL,
    render_artifact_id TEXT REFERENCES visual_render_artifacts(id) ON DELETE SET NULL,
    inspection_status TEXT NOT NULL CHECK (inspection_status IN ('ready','failed_infra')),
    failure_count INTEGER NOT NULL DEFAULT 0, first_inspected_at TEXT NOT NULL,
    last_inspected_at TEXT NOT NULL,
    UNIQUE (job_run_id,run_epoch,source_artifact_id,page_number)
) STRICT;

CREATE TABLE visual_evidence_receipts (
    id TEXT PRIMARY KEY, job_run_id TEXT NOT NULL REFERENCES job_runs(id), run_epoch INTEGER NOT NULL,
    message_id TEXT NOT NULL REFERENCES messages(id), ordinal INTEGER NOT NULL,
    source_id TEXT NOT NULL, source_revision TEXT,
    source_artifact_id TEXT NOT NULL REFERENCES artifacts(id), source_content_hash TEXT NOT NULL,
    page_number INTEGER NOT NULL, renderer_name TEXT NOT NULL, renderer_version TEXT NOT NULL,
    renderer_fingerprint TEXT NOT NULL, render_settings_json TEXT NOT NULL CHECK (json_valid(render_settings_json)),
    render_artifact_id TEXT NOT NULL REFERENCES visual_render_artifacts(id), image_content_hash TEXT NOT NULL,
    visual_observation TEXT NOT NULL CHECK (length(visual_observation) BETWEEN 1 AND 1000),
    verification_status TEXT NOT NULL CHECK (verification_status = 'verified'), created_at TEXT NOT NULL,
    UNIQUE (job_run_id,run_epoch,ordinal)
) STRICT;

CREATE TRIGGER evidence_receipts_text_only
BEFORE INSERT ON evidence_receipts
WHEN NEW.evidence_kind = 'visual'
BEGIN
  SELECT RAISE(ABORT, 'visual-receipt-requires-visual-table');
END;

CREATE TRIGGER evidence_receipts_visual_ordinal_guard
BEFORE INSERT ON evidence_receipts
WHEN EXISTS (
  SELECT 1 FROM visual_evidence_receipts visual
  WHERE visual.job_run_id=NEW.job_run_id AND visual.run_epoch=NEW.run_epoch AND visual.ordinal=NEW.ordinal
)
BEGIN
  SELECT RAISE(ABORT, 'evidence-receipt-ordinal-conflict');
END;

CREATE TRIGGER visual_evidence_receipts_text_ordinal_guard
BEFORE INSERT ON visual_evidence_receipts
WHEN EXISTS (
  SELECT 1 FROM evidence_receipts text_receipt
  WHERE text_receipt.job_run_id=NEW.job_run_id AND text_receipt.run_epoch=NEW.run_epoch
    AND text_receipt.ordinal=NEW.ordinal
)
BEGIN
  SELECT RAISE(ABORT, 'evidence-receipt-ordinal-conflict');
END;

CREATE VIEW all_evidence_receipts AS
SELECT id,job_run_id,run_epoch,message_id,ordinal,'text' citation_kind,evidence_kind,source_id,source_revision,
       workspace_path,locator_json,content_hash,quote_text,NULL visual_observation,NULL source_artifact_id,
       NULL source_content_hash,NULL page_number,NULL renderer_name,NULL renderer_version,NULL renderer_fingerprint,
       NULL render_settings_json,NULL render_artifact_id,NULL image_content_hash,verification_status,created_at
FROM evidence_receipts
UNION ALL
SELECT id,job_run_id,run_epoch,message_id,ordinal,'visual','visual',source_id,source_revision,NULL,
       json_object('page',page_number),source_content_hash,NULL,visual_observation,source_artifact_id,
       source_content_hash,page_number,renderer_name,renderer_version,renderer_fingerprint,render_settings_json,
       render_artifact_id,image_content_hash,verification_status,created_at
FROM visual_evidence_receipts;

CREATE TABLE message_citations (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL REFERENCES messages(id),
    ordinal INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('pdf_anchor', 'summary_locator', 'repo_lines', 'message', 'version_diff')),
    source_handle TEXT NOT NULL,
    locator_json TEXT NOT NULL CHECK (json_valid(locator_json)),
    verification_status TEXT NOT NULL CHECK (verification_status IN ('verified', 'unverified')),
    UNIQUE (message_id, ordinal)
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
    title TEXT NOT NULL,
    claim_text TEXT NOT NULL,
    review_status TEXT NOT NULL CHECK (
        review_status IN ('confirmed', 'needs-review', 'superseded', 'provenance-missing')
    ),
    epistemic_status TEXT NOT NULL CHECK (
        epistemic_status IN ('evidence-backed', 'interpretation', 'hypothesis')
    ),
    contract_version TEXT NOT NULL,
    structured_json TEXT NOT NULL CHECK (json_valid(structured_json)),
    source_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE RESTRICT,
    distillation_job_run_id TEXT NOT NULL REFERENCES job_runs(id) ON DELETE RESTRICT,
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

CREATE TABLE paper_version_diffs (
    id TEXT PRIMARY KEY,
    before_version_id TEXT NOT NULL REFERENCES paper_versions(id) ON DELETE RESTRICT,
    after_version_id TEXT NOT NULL REFERENCES paper_versions(id) ON DELETE RESTRICT,
    contract_version TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('running', 'ready', 'failed')),
    material_diff_json TEXT CHECK (material_diff_json IS NULL OR json_valid(material_diff_json)),
    semantic_diff_json TEXT CHECK (semantic_diff_json IS NULL OR json_valid(semantic_diff_json)),
    semantic_error TEXT,
    agent_run_id TEXT REFERENCES agent_runs(job_run_id) ON DELETE RESTRICT,
    artifact_id TEXT REFERENCES artifacts(id) ON DELETE RESTRICT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (before_version_id, after_version_id, contract_version)
) STRICT;

CREATE TABLE paper_version_candidates (
    proposal_id TEXT PRIMARY KEY REFERENCES proposals(id) ON DELETE RESTRICT,
    paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE RESTRICT,
    before_version_id TEXT NOT NULL REFERENCES paper_versions(id) ON DELETE RESTRICT,
    candidate_version_id TEXT NOT NULL UNIQUE REFERENCES paper_versions(id) ON DELETE RESTRICT,
    summary_id TEXT,
    summary_artifact_id TEXT REFERENCES artifacts(id) ON DELETE RESTRICT,
    version_diff_id TEXT REFERENCES paper_version_diffs(id) ON DELETE RESTRICT,
    extraction_run_id TEXT REFERENCES extraction_runs(id) ON DELETE RESTRICT,
    read_status TEXT,
    structured_json TEXT CHECK (structured_json IS NULL OR json_valid(structured_json)),
    skill_content_hash TEXT,
    agent_run_id TEXT REFERENCES agent_runs(job_run_id) ON DELETE RESTRICT,
    material_diff_json TEXT CHECK (material_diff_json IS NULL OR json_valid(material_diff_json)),
    semantic_diff_json TEXT CHECK (semantic_diff_json IS NULL OR json_valid(semantic_diff_json)),
    semantic_error TEXT,
    preparation_status TEXT NOT NULL CHECK (
        preparation_status IN ('detected', 'processing', 'ready', 'failed', 'rejected', 'superseded', 'accepted')
    ),
    prepared_at TEXT,
    accepted_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX paper_version_candidates_paper_status
    ON paper_version_candidates(paper_id, preparation_status, updated_at);

CREATE TABLE source_open_events (
    id TEXT PRIMARY KEY,
    proposal_id TEXT NOT NULL REFERENCES proposals(id),
    source_handle TEXT NOT NULL,
    opened_at TEXT NOT NULL
) STRICT;

CREATE INDEX source_open_events_proposal_source
    ON source_open_events(proposal_id, source_handle, opened_at);

CREATE TABLE takeaway_distillation_manifests (
    id TEXT PRIMARY KEY,
    manifest_hash TEXT NOT NULL UNIQUE,
    manifest_json TEXT NOT NULL CHECK (json_valid(manifest_json)),
    created_at TEXT NOT NULL
) STRICT;

CREATE TABLE takeaway_distillation_runs (
    job_run_id TEXT PRIMARY KEY REFERENCES job_runs(id) ON DELETE RESTRICT,
    assistant_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE RESTRICT,
    manifest_id TEXT NOT NULL REFERENCES takeaway_distillation_manifests(id) ON DELETE RESTRICT,
    contract_version TEXT NOT NULL,
    trigger TEXT NOT NULL CHECK (trigger IN ('automatic', 'explicit-save')),
    focus_hash TEXT NOT NULL,
    outcome_kind TEXT CHECK (outcome_kind IS NULL OR outcome_kind IN ('candidate', 'no-proposal')),
    reason_code TEXT CHECK (reason_code IS NULL OR reason_code IN (
        'not-durable', 'duplicate', 'insufficient-evidence', 'multiple-claims'
    )),
    proposal_id TEXT REFERENCES proposals(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX uq_takeaway_distillation_terminal_identity
    ON takeaway_distillation_runs(assistant_message_id, contract_version, trigger, focus_hash)
    WHERE outcome_kind IS NOT NULL;

CREATE TABLE takeaway_review_requirements (
    proposal_id TEXT PRIMARY KEY REFERENCES proposals(id) ON DELETE RESTRICT,
    evidence_review_required INTEGER NOT NULL DEFAULT 0 CHECK (evidence_review_required IN (0,1)),
    duplicate_acknowledged INTEGER NOT NULL DEFAULT 0 CHECK (duplicate_acknowledged IN (0,1)),
    live_duplicate_warning INTEGER NOT NULL DEFAULT 0 CHECK (live_duplicate_warning IN (0,1)),
    live_duplicate_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(live_duplicate_ids_json)),
    reviewed_receipt_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(reviewed_receipt_ids_json)),
    updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE entry_source_open_events (
    id TEXT PRIMARY KEY,
    source_type TEXT NOT NULL CHECK (source_type IN ('summary', 'takeaway')),
    source_id TEXT NOT NULL,
    opened_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_entry_source_open_source
    ON entry_source_open_events(source_type, source_id, opened_at);

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
