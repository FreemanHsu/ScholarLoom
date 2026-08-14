ALTER TABLE paper_versions ADD COLUMN metadata_json TEXT CHECK(metadata_json IS NULL OR json_valid(metadata_json));
ALTER TABLE context_snapshots ADD COLUMN version_diff_json TEXT CHECK(version_diff_json IS NULL OR json_valid(version_diff_json));

-- Existing extraction/Summary copies under derived/ are reproducible from the
-- immutable PDF and authoritative vault Markdown; their prior historical label
-- contradicted the default snapshot contract.
UPDATE artifacts SET retention_class='rebuildable'
WHERE retention_class='historical' AND storage_ref LIKE 'derived/%';

UPDATE paper_versions
SET metadata_json=(SELECT identity.metadata_json FROM paper_external_identities identity
  WHERE identity.paper_id=paper_versions.paper_id
    AND identity.identity_type=CASE paper_versions.source_type WHEN 'arxiv' THEN 'arxiv' ELSE 'direct-pdf-url' END
  ORDER BY identity.created_at LIMIT 1)
WHERE metadata_json IS NULL;

CREATE TABLE paper_version_diffs (
  id TEXT PRIMARY KEY,
  before_version_id TEXT NOT NULL REFERENCES paper_versions(id) ON DELETE RESTRICT,
  after_version_id TEXT NOT NULL REFERENCES paper_versions(id) ON DELETE RESTRICT,
  contract_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running','ready','failed')),
  material_diff_json TEXT CHECK(material_diff_json IS NULL OR json_valid(material_diff_json)),
  semantic_diff_json TEXT CHECK(semantic_diff_json IS NULL OR json_valid(semantic_diff_json)),
  semantic_error TEXT,
  agent_run_id TEXT REFERENCES agent_runs(job_run_id) ON DELETE RESTRICT,
  artifact_id TEXT REFERENCES artifacts(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(before_version_id,after_version_id,contract_version)
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
  structured_json TEXT CHECK(structured_json IS NULL OR json_valid(structured_json)),
  skill_content_hash TEXT,
  agent_run_id TEXT REFERENCES agent_runs(job_run_id) ON DELETE RESTRICT,
  material_diff_json TEXT CHECK(material_diff_json IS NULL OR json_valid(material_diff_json)),
  semantic_diff_json TEXT CHECK(semantic_diff_json IS NULL OR json_valid(semantic_diff_json)),
  semantic_error TEXT,
  preparation_status TEXT NOT NULL DEFAULT 'detected'
    CHECK(preparation_status IN ('detected','processing','ready','failed','rejected','superseded','accepted')),
  prepared_at TEXT,
  accepted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX paper_version_candidates_paper_status
  ON paper_version_candidates(paper_id,preparation_status,updated_at);

CREATE TABLE message_citations_v34 (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id),
  ordinal INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('pdf_anchor','summary_locator','repo_lines','message','version_diff')),
  source_handle TEXT NOT NULL,
  locator_json TEXT NOT NULL CHECK(json_valid(locator_json)),
  verification_status TEXT NOT NULL CHECK(verification_status IN ('verified','unverified')),
  UNIQUE(message_id,ordinal)
) STRICT;

INSERT INTO message_citations_v34
SELECT id,message_id,ordinal,kind,source_handle,locator_json,verification_status FROM message_citations;
DROP TABLE message_citations;
ALTER TABLE message_citations_v34 RENAME TO message_citations;

-- Upgrade deterministic legacy arXiv update Proposals created before this contract.
INSERT OR IGNORE INTO paper_versions
  (id,paper_id,source_type,source_version,source_url,resolved_at,processing_status,accepted_at,created_at,updated_at,metadata_json)
SELECT 'paper-version:' || proposal.paper_id || ':arxiv:v' || json_extract(proposal.payload_json,'$.latestVersion'),
  proposal.paper_id,'arxiv','v' || json_extract(proposal.payload_json,'$.latestVersion'),
  'https://arxiv.org/abs/' || identity.normalized_value || 'v' || json_extract(proposal.payload_json,'$.latestVersion'),
  proposal.created_at,'detected',NULL,proposal.created_at,proposal.created_at,
  json_object('title',paper.title,
    'authors',json(COALESCE(json_extract(identity.metadata_json,'$.authors'),'[]')),
    'year',COALESCE(json_extract(identity.metadata_json,'$.year'),0))
FROM proposals proposal
JOIN papers paper ON paper.id=proposal.paper_id
JOIN paper_versions current_version ON current_version.id=paper.current_version_id AND current_version.source_type='arxiv'
JOIN paper_external_identities identity ON identity.paper_id=paper.id AND identity.identity_type='arxiv'
WHERE proposal.proposal_type='paper-version-update' AND proposal.review_status='pending'
  AND json_extract(proposal.payload_json,'$.candidateVersionId') IS NULL
  AND COALESCE(json_extract(proposal.payload_json,'$.sourceType'),'arxiv')<>'direct-pdf'
  AND json_type(proposal.payload_json,'$.latestVersion')='integer'
  AND json_extract(proposal.payload_json,'$.latestVersion') >
    CAST(REPLACE(current_version.source_version,'v','') AS INTEGER);

UPDATE proposals AS proposal
SET payload_json=json_set(proposal.payload_json,
  '$.contractVersion','paper-version-update.v1',
  '$.sourceType','arxiv',
  '$.arxivId',(SELECT identity.normalized_value FROM paper_external_identities identity
    WHERE identity.paper_id=proposal.paper_id AND identity.identity_type='arxiv' LIMIT 1),
  '$.currentVersionId',(SELECT paper.current_version_id FROM papers paper WHERE paper.id=proposal.paper_id),
  '$.currentVersion',(SELECT CAST(REPLACE(version.source_version,'v','') AS INTEGER)
    FROM papers paper JOIN paper_versions version ON version.id=paper.current_version_id WHERE paper.id=proposal.paper_id),
  '$.candidateVersionId','paper-version:' || proposal.paper_id || ':arxiv:v' || json_extract(proposal.payload_json,'$.latestVersion'),
  '$.candidateVersion',json_extract(proposal.payload_json,'$.latestVersion'),
  '$.sourceUrl','https://arxiv.org/abs/' || (SELECT identity.normalized_value FROM paper_external_identities identity
    WHERE identity.paper_id=proposal.paper_id AND identity.identity_type='arxiv' LIMIT 1) ||
    'v' || json_extract(proposal.payload_json,'$.latestVersion'),
  '$.metadata',json_object('title',(SELECT paper.title FROM papers paper WHERE paper.id=proposal.paper_id),
    'authors',json(COALESCE((SELECT json_extract(identity.metadata_json,'$.authors') FROM paper_external_identities identity
      WHERE identity.paper_id=proposal.paper_id AND identity.identity_type='arxiv' LIMIT 1),'[]')),
    'year',COALESCE((SELECT json_extract(identity.metadata_json,'$.year') FROM paper_external_identities identity
      WHERE identity.paper_id=proposal.paper_id AND identity.identity_type='arxiv' LIMIT 1),0)),
  '$.detectedAt',proposal.created_at)
WHERE proposal.proposal_type='paper-version-update' AND proposal.review_status='pending'
  AND json_extract(proposal.payload_json,'$.candidateVersionId') IS NULL
  AND EXISTS (SELECT 1 FROM paper_versions version WHERE version.id=
    'paper-version:' || proposal.paper_id || ':arxiv:v' || json_extract(proposal.payload_json,'$.latestVersion'));

INSERT OR IGNORE INTO paper_version_candidates
  (proposal_id,paper_id,before_version_id,candidate_version_id,preparation_status,created_at,updated_at)
SELECT proposal.id,proposal.paper_id,json_extract(proposal.payload_json,'$.currentVersionId'),
  json_extract(proposal.payload_json,'$.candidateVersionId'),'detected',proposal.created_at,proposal.created_at
FROM proposals proposal
WHERE proposal.proposal_type='paper-version-update' AND proposal.review_status='pending'
  AND json_extract(proposal.payload_json,'$.sourceType')='arxiv'
  AND json_extract(proposal.payload_json,'$.candidateVersionId') IS NOT NULL;

UPDATE proposals
SET review_status='superseded',decided_at=COALESCE(decided_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
WHERE proposal_type='paper-version-update' AND review_status='pending'
  AND COALESCE(json_extract(payload_json,'$.sourceType'),'arxiv')<>'direct-pdf'
  AND json_extract(payload_json,'$.latestVersion') <= COALESCE(json_extract(payload_json,'$.currentVersion'),-1);

UPDATE proposals
SET review_status='archived',archived_at=COALESCE(archived_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  payload_json=json_set(payload_json,'$.archiveReason','legacy-version-proposal-invalid')
WHERE proposal_type='paper-version-update' AND review_status='pending'
  AND COALESCE(json_extract(payload_json,'$.sourceType'),'arxiv')<>'direct-pdf'
  AND json_extract(payload_json,'$.candidateVersionId') IS NULL;
