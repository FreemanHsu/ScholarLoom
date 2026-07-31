CREATE TABLE direction_catalog (
  topic_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  aliases_json TEXT NOT NULL CHECK(json_valid(aliases_json)),
  scope TEXT NOT NULL,
  usage_level TEXT NOT NULL CHECK(usage_level IN ('classification','knowledge-ready')),
  lifecycle_status TEXT NOT NULL CHECK(lifecycle_status IN ('active','superseded','deleted')),
  superseded_by TEXT,
  revision_id TEXT NOT NULL,
  revision_number INTEGER NOT NULL CHECK(revision_number >= 1),
  review_status TEXT NOT NULL CHECK(review_status IN ('confirmed','needs-review','superseded','provenance-missing')),
  markdown_path TEXT NOT NULL UNIQUE,
  markdown_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX direction_catalog_superseded_by ON direction_catalog(superseded_by);

CREATE TABLE paper_manifests (
  paper_id TEXT PRIMARY KEY REFERENCES papers(id) ON DELETE CASCADE,
  markdown_path TEXT NOT NULL UNIQUE,
  markdown_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE paper_catalog_documents (
  paper_id TEXT PRIMARY KEY REFERENCES papers(id) ON DELETE CASCADE,
  canonical_title TEXT NOT NULL,
  preferred_alias TEXT,
  authors_json TEXT NOT NULL CHECK(json_valid(authors_json)),
  publication_year INTEGER NOT NULL,
  search_text TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE paper_aliases (
  paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  alias_kind TEXT NOT NULL CHECK(alias_kind IN ('model-name','method-name','acronym','project-name','user-defined')),
  preferred INTEGER NOT NULL CHECK(preferred IN (0,1)),
  ordinal INTEGER NOT NULL,
  PRIMARY KEY(paper_id,normalized_name)
) STRICT;

CREATE INDEX paper_aliases_normalized_name ON paper_aliases(normalized_name,preferred DESC,paper_id);

CREATE TABLE paper_direction_assignments (
  paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  topic_id TEXT NOT NULL REFERENCES direction_catalog(topic_id) ON DELETE RESTRICT,
  assignment_role TEXT NOT NULL CHECK(assignment_role IN ('primary','secondary')),
  ordinal INTEGER NOT NULL,
  PRIMARY KEY(paper_id,topic_id)
) STRICT;

CREATE UNIQUE INDEX paper_one_primary_direction
  ON paper_direction_assignments(paper_id)
  WHERE assignment_role='primary';

CREATE INDEX paper_direction_membership
  ON paper_direction_assignments(topic_id,assignment_role,paper_id);

CREATE VIRTUAL TABLE paper_catalog_fts USING fts5(
  paper_id UNINDEXED,
  search_text,
  tokenize='trigram'
);

CREATE TABLE paper_catalog_metadata (
  metadata_key TEXT PRIMARY KEY,
  metadata_value TEXT NOT NULL
) STRICT;

INSERT INTO paper_catalog_metadata(metadata_key,metadata_value)
VALUES ('normalization-version','paper-lookup-v1');

INSERT INTO projection_state(projection,last_successful_at,rebuilt_at,updated_at)
VALUES ('paper-catalog',NULL,NULL,datetime('now'));
