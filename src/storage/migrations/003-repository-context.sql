CREATE TABLE code_repositories (
  id TEXT PRIMARY KEY,
  canonical_url TEXT NOT NULL UNIQUE,
  host TEXT NOT NULL,
  owner_name TEXT,
  repository_name TEXT,
  availability_status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE repository_snapshots (
  id TEXT PRIMARY KEY,
  code_repository_id TEXT NOT NULL REFERENCES code_repositories(id),
  commit_sha TEXT NOT NULL,
  local_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(code_repository_id,commit_sha)
) STRICT;

CREATE TABLE paper_code_links (
  id TEXT PRIMARY KEY,
  paper_id TEXT NOT NULL REFERENCES papers(id),
  code_repository_id TEXT NOT NULL REFERENCES code_repositories(id),
  link_type TEXT NOT NULL,
  origin TEXT NOT NULL,
  status TEXT NOT NULL,
  repository_snapshot_id TEXT REFERENCES repository_snapshots(id),
  created_at TEXT NOT NULL,
  UNIQUE(paper_id,code_repository_id)
) STRICT;

CREATE TABLE code_elements (
  id TEXT PRIMARY KEY,
  repository_snapshot_id TEXT NOT NULL REFERENCES repository_snapshots(id),
  relative_path TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  text_content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  UNIQUE(repository_snapshot_id,relative_path,start_line,end_line)
) STRICT;
