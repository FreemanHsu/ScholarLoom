ALTER TABLE knowledge_write_requests ADD COLUMN payload_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(payload_json));
