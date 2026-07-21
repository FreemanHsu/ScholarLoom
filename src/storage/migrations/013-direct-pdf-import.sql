ALTER TABLE paper_versions ADD COLUMN source_content_hash TEXT;
ALTER TABLE paper_versions ADD COLUMN source_media_type TEXT;
ALTER TABLE import_requests ADD COLUMN reference_kind TEXT;
ALTER TABLE import_requests ADD COLUMN frozen_input_json TEXT CHECK(frozen_input_json IS NULL OR json_valid(frozen_input_json));

CREATE INDEX idx_paper_versions_content_hash ON paper_versions(source_content_hash);
