CREATE TABLE pdf_delivery_optimizations (
  id TEXT PRIMARY KEY,
  source_artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  output_artifact_id TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
  strategy TEXT NOT NULL CHECK(strategy IN ('lossless-linearization')),
  tool_name TEXT,
  tool_version TEXT,
  parameters_json TEXT NOT NULL CHECK(json_valid(parameters_json)),
  status TEXT NOT NULL CHECK(status IN ('selected','skipped','failed')),
  reason TEXT NOT NULL,
  source_byte_size INTEGER NOT NULL CHECK(source_byte_size >= 0),
  output_byte_size INTEGER CHECK(output_byte_size IS NULL OR output_byte_size >= 0),
  metrics_json TEXT NOT NULL CHECK(json_valid(metrics_json)),
  attempted_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(source_artifact_id,strategy)
) STRICT;

CREATE INDEX pdf_delivery_optimizations_output
  ON pdf_delivery_optimizations(output_artifact_id)
  WHERE output_artifact_id IS NOT NULL;
