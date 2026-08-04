CREATE TABLE artifact_integrity_verifications (
  artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,
  stat_fingerprint TEXT NOT NULL,
  verified_at TEXT NOT NULL
) STRICT;
