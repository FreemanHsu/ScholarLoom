CREATE TABLE topic_navigation (
  topic_id TEXT PRIMARY KEY REFERENCES direction_catalog(topic_id) ON DELETE CASCADE,
  navigation_role TEXT NOT NULL CHECK(navigation_role IN ('domain','direction')),
  parent_domain_id TEXT,
  projected_at TEXT NOT NULL,
  CHECK(
    (navigation_role='domain' AND parent_domain_id IS NULL) OR
    navigation_role='direction'
  )
) STRICT;

CREATE INDEX topic_navigation_parent
  ON topic_navigation(parent_domain_id,navigation_role,topic_id);

INSERT INTO topic_navigation(topic_id,navigation_role,parent_domain_id,projected_at)
SELECT topic_id,'direction',NULL,datetime('now') FROM direction_catalog;

INSERT OR IGNORE INTO paper_catalog_metadata(metadata_key,metadata_value)
VALUES ('hierarchy-enabled','false');

INSERT OR IGNORE INTO paper_catalog_metadata(metadata_key,metadata_value)
VALUES ('hierarchy-ever-enabled','false');
