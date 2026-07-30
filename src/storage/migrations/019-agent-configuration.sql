ALTER TABLE agent_runs ADD COLUMN reasoning_effort TEXT
  CHECK (reasoning_effort IS NULL OR reasoning_effort IN ('medium','high'));

ALTER TABLE agent_runs ADD COLUMN configuration_version TEXT;
