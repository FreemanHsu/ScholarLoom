ALTER TABLE paper_catalog_documents
  ADD COLUMN external_identities_json TEXT NOT NULL DEFAULT '[]'
  CHECK(json_valid(external_identities_json));
