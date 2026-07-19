ALTER TABLE paper_versions ADD COLUMN pdf_artifact_id TEXT REFERENCES artifacts(id);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  artifact_type TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  storage_ref TEXT NOT NULL UNIQUE,
  media_type TEXT,
  byte_size INTEGER,
  created_by_kind TEXT NOT NULL,
  retention_class TEXT NOT NULL,
  integrity_status TEXT NOT NULL DEFAULT 'verified',
  created_at TEXT NOT NULL,
  UNIQUE(artifact_type, content_hash)
) STRICT;

CREATE TABLE extraction_runs (
  id TEXT PRIMARY KEY,
  paper_version_id TEXT NOT NULL REFERENCES paper_versions(id),
  source_artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  extractor_name TEXT NOT NULL,
  extractor_version TEXT NOT NULL,
  status TEXT NOT NULL,
  page_count INTEGER,
  started_at TEXT NOT NULL,
  completed_at TEXT
) STRICT;

CREATE TABLE document_elements (
  id TEXT PRIMARY KEY,
  extraction_run_id TEXT NOT NULL REFERENCES extraction_runs(id),
  element_type TEXT NOT NULL,
  page_number INTEGER NOT NULL,
  ordinal INTEGER NOT NULL,
  text_content TEXT,
  bbox_json TEXT CHECK(bbox_json IS NULL OR json_valid(bbox_json)),
  UNIQUE(extraction_run_id,page_number,ordinal)
) STRICT;

CREATE TABLE evidence_anchors (
  id TEXT PRIMARY KEY,
  anchor_type TEXT NOT NULL,
  paper_version_id TEXT REFERENCES paper_versions(id),
  extraction_run_id TEXT REFERENCES extraction_runs(id),
  document_element_id TEXT REFERENCES document_elements(id),
  page_number INTEGER,
  quote_text TEXT,
  verification_status TEXT NOT NULL,
  locator_json TEXT NOT NULL CHECK(json_valid(locator_json)),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE summary_revisions (
  id TEXT PRIMARY KEY,
  paper_id TEXT NOT NULL REFERENCES papers(id),
  paper_version_id TEXT NOT NULL REFERENCES paper_versions(id),
  extraction_run_id TEXT NOT NULL REFERENCES extraction_runs(id),
  revision INTEGER NOT NULL,
  status TEXT NOT NULL,
  read_status TEXT NOT NULL,
  markdown_path TEXT NOT NULL,
  markdown_hash TEXT NOT NULL,
  structured_json TEXT NOT NULL CHECK(json_valid(structured_json)),
  skill_path TEXT NOT NULL,
  skill_content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(paper_id,paper_version_id,revision)
) STRICT;

CREATE TABLE summary_claim_evidence (
  summary_revision_id TEXT NOT NULL REFERENCES summary_revisions(id),
  claim_ordinal INTEGER NOT NULL,
  evidence_anchor_id TEXT NOT NULL REFERENCES evidence_anchors(id),
  PRIMARY KEY(summary_revision_id,claim_ordinal,evidence_anchor_id)
) STRICT;

CREATE TABLE knowledge_write_requests (
  id TEXT PRIMARY KEY,
  request_type TEXT NOT NULL,
  target_path TEXT NOT NULL,
  staged_path TEXT NOT NULL,
  result_hash TEXT NOT NULL,
  phase TEXT NOT NULL,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE curated_search_documents (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE VIRTUAL TABLE curated_search_fts USING fts5(title,body,content='curated_search_documents',content_rowid='rowid',tokenize='trigram');
CREATE TRIGGER curated_search_documents_ai AFTER INSERT ON curated_search_documents BEGIN
  INSERT INTO curated_search_fts(rowid,title,body) VALUES(new.rowid,new.title,new.body);
END;
CREATE TRIGGER curated_search_documents_ad AFTER DELETE ON curated_search_documents BEGIN
  INSERT INTO curated_search_fts(curated_search_fts,rowid,title,body) VALUES('delete',old.rowid,old.title,old.body);
END;
