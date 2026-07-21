UPDATE proposals
SET review_status = 'superseded',
    decided_at = COALESCE(decided_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
WHERE proposal_type = 'repository-retry'
  AND review_status = 'pending'
  AND EXISTS (
    SELECT 1
    FROM paper_code_links AS link
    JOIN code_repositories AS repository ON repository.id = link.code_repository_id
    WHERE link.paper_id = proposals.paper_id
      AND link.status = 'confirmed'
      AND repository.canonical_url = json_extract(proposals.payload_json, '$.url')
  );
