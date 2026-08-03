CREATE TABLE paper_organization_batches (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  action TEXT NOT NULL CHECK(action IN ('accept','reject')),
  state TEXT NOT NULL CHECK(state IN (
    'reserved','applying','complete','complete-with-issues','abandoned'
  )),
  preview_json TEXT NOT NULL CHECK(json_valid(preview_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
) STRICT;

CREATE UNIQUE INDEX one_active_paper_organization_batch
  ON paper_organization_batches((1))
  WHERE state IN ('reserved','applying');

CREATE TABLE paper_organization_batch_members (
  batch_id TEXT NOT NULL REFERENCES paper_organization_batches(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  proposal_id TEXT NOT NULL REFERENCES proposals(id) ON DELETE RESTRICT,
  paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  section_kind TEXT NOT NULL CHECK(section_kind IN (
    'alias','primary-direction','secondary-direction'
  )),
  member_state TEXT NOT NULL CHECK(member_state IN (
    'pending','applying','succeeded','failed','conflicted','skipped-stale','skipped-external'
  )),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK(attempt >= 0),
  result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(batch_id,ordinal),
  UNIQUE(batch_id,proposal_id)
) STRICT;

CREATE INDEX paper_organization_batch_members_state
  ON paper_organization_batch_members(batch_id,member_state,ordinal);

CREATE TABLE topic_redirects (
  source_topic_id TEXT PRIMARY KEY,
  direct_target_topic_id TEXT NOT NULL,
  canonical_target_topic_id TEXT NOT NULL,
  depth INTEGER NOT NULL CHECK(depth BETWEEN 1 AND 32),
  lineage_json TEXT NOT NULL CHECK(json_valid(lineage_json)),
  source_markdown_hash TEXT NOT NULL,
  rebuilt_at TEXT NOT NULL
) STRICT;

CREATE TABLE direction_merge_commands (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  source_topic_id TEXT NOT NULL,
  target_topic_id TEXT NOT NULL,
  source_semantic_hash TEXT NOT NULL,
  target_semantic_hash TEXT NOT NULL,
  source_markdown_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN (
    'reserved','superseding','migrating','complete','complete-with-exceptions','failed'
  )),
  proposal_id TEXT NOT NULL UNIQUE REFERENCES proposals(id) ON DELETE RESTRICT,
  preview_json TEXT NOT NULL CHECK(json_valid(preview_json)),
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  CHECK(source_topic_id <> target_topic_id)
) STRICT;

CREATE UNIQUE INDEX one_active_direction_merge
  ON direction_merge_commands((1))
  WHERE state IN ('reserved','superseding','migrating');

CREATE TABLE direction_merge_members (
  merge_id TEXT NOT NULL REFERENCES direction_merge_commands(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  expected_manifest_hash TEXT NOT NULL,
  organization_json TEXT NOT NULL CHECK(json_valid(organization_json)),
  member_state TEXT NOT NULL CHECK(member_state IN (
    'pending','applying','succeeded','failed','conflicted'
  )),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK(attempt >= 0),
  result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(merge_id,ordinal),
  UNIQUE(merge_id,paper_id)
) STRICT;

CREATE INDEX direction_merge_members_state
  ON direction_merge_members(merge_id,member_state,ordinal);
