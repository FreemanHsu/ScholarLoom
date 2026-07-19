UPDATE artifacts
SET storage_ref = 'originals/' || storage_ref
WHERE storage_ref LIKE 'papers/%';
