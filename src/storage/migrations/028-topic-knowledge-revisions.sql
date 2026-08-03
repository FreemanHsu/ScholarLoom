CREATE TABLE topic_knowledge_revisions (
  id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL,
  revision_number INTEGER NOT NULL CHECK(revision_number >= 1),
  usage_level TEXT NOT NULL CHECK(usage_level IN ('classification','knowledge-ready')),
  review_status TEXT NOT NULL CHECK(review_status IN ('confirmed','needs-review','superseded','provenance-missing')),
  epistemic_status TEXT NOT NULL CHECK(epistemic_status IN ('evidence-backed','interpretation','hypothesis','open-question')),
  markdown_path TEXT NOT NULL,
  markdown_hash TEXT NOT NULL,
  history_path TEXT,
  knowledge_body_hash TEXT NOT NULL,
  provenance_json TEXT NOT NULL CHECK(json_valid(provenance_json)),
  owner_attested INTEGER NOT NULL CHECK(owner_attested IN (0,1)),
  eligibility_status TEXT NOT NULL CHECK(eligibility_status IN (
    'classification','eligible','invalid-content','invalid-provenance','external-drift','superseded'
  )),
  active INTEGER NOT NULL CHECK(active IN (0,1)),
  confirmed_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(topic_id,revision_number)
) STRICT;

CREATE UNIQUE INDEX topic_knowledge_one_active_revision
  ON topic_knowledge_revisions(topic_id) WHERE active=1;

CREATE TABLE topic_knowledge_provenance (
  topic_revision_id TEXT NOT NULL REFERENCES topic_knowledge_revisions(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  source_type TEXT NOT NULL CHECK(source_type IN ('summary','takeaway')),
  source_id TEXT NOT NULL,
  PRIMARY KEY(topic_revision_id,ordinal),
  UNIQUE(topic_revision_id,source_type,source_id)
) STRICT;

CREATE INDEX topic_knowledge_provenance_source
  ON topic_knowledge_provenance(source_type,source_id,topic_revision_id);

CREATE TABLE topic_knowledge_paper_scope (
  topic_revision_id TEXT NOT NULL REFERENCES topic_knowledge_revisions(id) ON DELETE CASCADE,
  paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  source_count INTEGER NOT NULL CHECK(source_count > 0),
  rebuilt_at TEXT NOT NULL,
  PRIMARY KEY(topic_revision_id,paper_id)
) STRICT;

CREATE TABLE topic_knowledge_history_findings (
  id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  history_path TEXT NOT NULL,
  expected_hash TEXT NOT NULL,
  actual_hash TEXT,
  finding_kind TEXT NOT NULL CHECK(finding_kind IN ('missing','hash-mismatch')),
  detected_at TEXT NOT NULL,
  resolved_at TEXT
) STRICT;

INSERT INTO topic_knowledge_revisions(
  id,topic_id,revision_number,usage_level,review_status,epistemic_status,
  markdown_path,markdown_hash,history_path,knowledge_body_hash,provenance_json,
  owner_attested,eligibility_status,active,confirmed_at,created_at
)
SELECT revision_id,topic_id,revision_number,'classification',review_status,
  'evidence-backed',markdown_path,markdown_hash,NULL,'','[]',0,'classification',1,
  CASE WHEN review_status='confirmed' THEN updated_at ELSE NULL END,created_at
FROM direction_catalog;

DROP INDEX entry_source_open_source;
ALTER TABLE entry_source_open_events RENAME TO entry_source_open_events_old;

CREATE TABLE entry_source_open_events (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL CHECK(source_type IN ('summary','takeaway','topic-knowledge')),
  source_id TEXT NOT NULL,
  opened_at TEXT NOT NULL
) STRICT;

INSERT INTO entry_source_open_events(id,source_type,source_id,opened_at)
SELECT id,source_type,source_id,opened_at FROM entry_source_open_events_old;

DROP TABLE entry_source_open_events_old;

CREATE INDEX entry_source_open_source
  ON entry_source_open_events(source_type,source_id,opened_at);
