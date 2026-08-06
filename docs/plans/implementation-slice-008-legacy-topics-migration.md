# Implementation Slice 008: Legacy `topics:` Inventory and Migration

- Status: Implemented and verified
- Date: 2026-07-31
- Parent design: [`paper-organization-feature-design.md`](../paper-organization-feature-design.md)
- Depends on:
  [`implementation-slice-007-batch-decisions-topic-lifecycle.md`](implementation-slice-007-batch-decisions-topic-lifecycle.md)

## 1. Outcome

Complete Slice 3 without guessing that a legacy `topics:` value is a Research
Direction or a Primary assignment.

This slice adds a read-only inventory, a versioned migration plan, and a
copy-first executor. It does not remove `topics:`, edit a running production root,
or switch ScholarLoom to a migrated root. A migrated root becomes eligible for
owner-controlled cutover only after snapshot verification, parser validation,
catalog rebuild, and SQLite diagnostics all pass.

The production inventory performed before this design found 29 Paper manifests.
All 29 contain `topics: []`; none contains a non-empty or malformed `topics:` value,
and none currently contains `aliases:` or `directions:`. Only aggregate shape
counts are recorded here; production paths, titles, IDs, authors, and Markdown
content are not review material.

Therefore the current production vault needs no semantic assignment migration.
The tooling remains necessary so the conclusion is reproducible and future
non-empty legacy values fail closed instead of being silently interpreted.

## 2. Authority and safety boundary

Inventory is read-only and may run while the application is available. It reads
Paper Markdown only and never opens PDFs, calls an Agent, writes SQLite, or mutates
the vault.

An inventory taken while the runtime may be active is provisional and records
`runtime_observed: active | stopped | unknown`. Plan authority is established only
by a complete byte-equivalent re-inventory after the source runtime has stopped.

Execution is offline and copy-first:

1. require a valid source `StorageLayout`;
2. require the source runtime lock to be available;
3. require a new, absent destination outside the source root;
4. create and verify a source snapshot;
5. restore the snapshot into the destination;
6. abort if the restored operational state contains any pending/recoverable KWR or
   resumable batch, merge, taxonomy, backfill, or Job command;
7. assert that every persisted operational path is root-relative, run schema
   migrations, rebuild Paper Catalog from Markdown, and verify parity;
8. apply the frozen plan only inside the destination;
9. rebuild and validate every Paper Markdown and logical catalog row;
10. emit a result report and a new verified snapshot of the destination.

The source root is never chmod'ed, renamed, deleted, or edited. Cutover and cleanup
are explicitly outside this command. The existing restore rule that refuses an
existing target remains in force.

## 3. Inventory artifact

Add:

```text
npm run data:paper-topics -- inventory <data-root> <new-report.json>
```

The destination report must not exist. The JSON schema is
`scholarloom.paper-topics-inventory/v1` and contains:

- tool/schema version and creation time;
- data-format and SQLite schema versions;
- a root fingerprint derived from the data manifest plus sorted Paper
  relative-path/hash pairs;
- aggregate counts for missing, empty sequence, non-empty sequence, scalar, map,
  null, malformed frontmatter, and unknown legacy item shapes;
- one frozen Paper entry with relative path, Markdown SHA-256, `topics:` shape,
  item type descriptors, and whether canonical `aliases:`/`directions:` exist;
- no Paper title, author, external ID, PDF data, or Markdown body.

Fingerprint algorithm `paper-markdown-set/v1` hashes canonical JSON containing the
data-manifest format version plus sorted Paper relative-path/SHA-256 pairs. It
includes only regular canonical `library/papers/**/paper.md` files. SQLite/WAL/SHM,
runtime journals, derived/cache/log/tmp content, editor files, OS metadata, PDFs,
and symlinks are excluded. The stopped-source execution inventory must equal the
plan input report in schema, sorted Paper set, hashes, and structural descriptors;
otherwise execution aborts before creating a destination.

Legacy item descriptors expose only structural type by default. A local
`--include-values` diagnostic may include the exact YAML scalar/map value in the
report, but the default and all repository tests use structural descriptors. A
value-bearing report is stamped `local_only: true`; it, the mapping, plan, and any
path-bearing result report must stay outside the repository and external review.

Unknown YAML fields and ordering are not an inventory error. Malformed frontmatter,
unsafe/symlinked paths, duplicate relative paths, or unreadable files make the
inventory incomplete and block planning.

## 4. Versioned plan

Add:

```text
npm run data:paper-topics -- plan <inventory.json> <mapping.json> <new-plan.json>
```

The mapping is owner-authored. It maps a frozen legacy item in one Paper to either:

- `preserve-only`, meaning no Research Direction assertion is made; or
- `{topic_id, role: primary | secondary}`.

There is no global title/slug-to-Topic inference. The same visible scalar may mean
different things in different Papers, so mapping identity is the tuple
`paper_markdown_hash + item_ordinal + item_fingerprint`.

The plan schema is `scholarloom.paper-topics-migration/v1`. It freezes:

- source root fingerprint and every Paper hash;
- mapping-file hash;
- existing canonical aliases/directions hashes;
- exact post-migration aliases/directions;
- the legacy `topics:` node serialized exactly as parsed;
- per-Paper action `unchanged | canonicalize | unresolved`;
- validation results for one Primary, at most three Secondary, no duplicates, and
  references to confirmed active classification Topics.

Empty/missing `topics:` produces `unchanged`; the planner does not add empty
canonical fields merely to create a diff. Any non-empty item not explicitly mapped
is `unresolved`. A plan containing unresolved/invalid Papers cannot execute.
Missing and explicit `topics: []` remain distinct preserved byte states.

If valid canonical `directions:` is already present, it is authoritative and the
legacy `topics:` value is classified `inert`, excluded from planning even if
non-empty. Every mapped direction records the legacy item fingerprint in the
operational migration ledger. Planning validates every mapped Topic as active,
confirmed, classification-usable, and not superseded; execution repeats the same
validation against the restored catalog.

## 5. Copy-first executor

Add:

```text
npm run data:paper-topics -- migrate-copy \
  <source-data-root> <plan.json> <new-destination-data-root>
```

Before copying, the executor recomputes the inventory fingerprint and every
Markdown hash by performing the complete stopped-runtime inventory again. Any
report difference returns `paper-topics-plan-stale`.

Inside the destination, each changed Paper is written with the ordinary
frontmatter parser/renderer and the same Paper organization validator. The
executor:

- writes `directions:` only from explicit plan mappings;
- preserves existing `aliases:` byte-equivalent at the YAML value level;
- preserves `topics:` exactly and never clears it;
- preserves unknown keys and Markdown body;
- records a migration ledger in SQLite with plan hash, source/destination Paper
  hashes, source item fingerprints, state, timestamps, and closed error codes;
- uses one recoverable `KnowledgeWriteRequest` per Paper so crash recovery and
  external-hash conflict behavior match normal organization writes;
- rebuilds the Paper Catalog only after every planned Paper is terminal.

If one destination Paper conflicts, successful Papers remain valid, the command
finishes `complete-with-issues`, and rerun uses the same plan/idempotency keys.
Source data remains untouched in all cases.

Execution is a sequential Paper loop. It has no parallelism or separate batch
coordinator. An interrupted `applying` member is reconciled by checking the KWR and
manifest effect before retry, exactly like Slice 007.

For the observed all-empty production inventory, execution is a verified no-op:
the destination is still restored and validated, but no Paper KWR or Markdown
rewrite is created.

## 6. Reports, approval, and cleanup

The result report lists only relative paths, hashes, action/outcome, and validation
codes. It includes:

- source snapshot verification;
- changed/unchanged/unresolved/conflicted counts;
- catalog logical-row hash before and after;
- SQLite integrity and foreign-key results;
- destination snapshot path/hash;
- a cutover checklist.

The checklist is advisory and never constitutes cutover approval.

No command in this slice changes the configured production root. No command deletes
or rewrites legacy `topics:`. A later owner-controlled cutover may point the
service at the verified destination after stopping the old service. Destructive
cleanup of either legacy fields or the former root always requires a separate,
explicit owner request after cutover verification.

## 7. Recovery and determinism

- reports and plans are content-addressed by canonical JSON hashes;
- all output destinations must be absent;
- plan application is idempotent by plan hash and Paper relative path;
- a KWR effect check wins over an interrupted ledger state;
- startup recovery completes open KWRs before catalog rebuild;
- inventory over a destination after migration must reproduce the planned hashes;
- rebuilding the Paper Catalog twice produces byte-equivalent logical rows;
- no report, plan, or ledger becomes epistemic knowledge or enters
  `global-curated`.
- readers always prefer canonical `directions:` when present and never combine it
  with legacy `topics:`.

## 8. Interaction

This slice is CLI-only. Settings may later surface a read-only readiness summary,
but no browser migration wizard is added. The CLI prints concise Chinese guidance,
machine-readable JSON, and distinct exit codes for:

- incomplete inventory;
- unresolved mapping;
- stale plan;
- source runtime active;
- invalid Topic reference;
- destination KWR conflict;
- snapshot/restore or SQLite verification failure.

## 9. Implementation increments

1. inventory schema/parser, symlink/path safety, and structural report;
2. mapping and plan schemas with explicit per-item identity;
3. migration ledger and copy-first coordinator;
4. KWR-based destination writes and catalog rebuild;
5. fixture coverage for empty, scalar, mixed, unknown, stale, crash, and conflict
   cases;
6. production read-only inventory, migrated temporary-root rehearsal, snapshot
   verification, and restore.

## 10. Acceptance

- no legacy value is inferred as Primary or Secondary;
- the observed production inventory is reproducibly classified as 29 empty lists;
- unknown/malformed shapes fail closed;
- missing mappings make a plan non-executable;
- source drift invalidates a plan before any destination is created;
- source root is byte-identical before and after every success/failure path;
- `topics:` and unknown YAML content are preserved in migrated copies;
- every changed Paper uses a recoverable KWR and passes current organization
  invariants;
- destination catalog rebuild is deterministic;
- verified no-op plans create no Markdown writes;
- tests, typecheck, build, `git diff --check`, snapshot/restore, and destination
  diagnostics pass.

## 11. Non-goals

- semantic inference from legacy values;
- in-place production mutation;
- runtime cutover;
- deletion of legacy fields or roots;
- Alias generation;
- taxonomy creation;
- browser UI.

## 12. Verification

Implemented on 2026-07-31.

- Production read-only inventory reproduced 29 `empty-sequence`, zero non-empty,
  scalar, map, null, inert, or malformed Paper `topics:` values. Its report and
  path-bearing plan remain under `/tmp`, outside the repository.
- The resulting production plan is executable with 29 unchanged, zero
  canonicalize, and zero unresolved entries. Production runtime was observed
  active, so no service stop, production snapshot, migrated copy, or cutover was
  attempted.
- Synthetic copy-first rehearsals cover the current all-empty no-op and a non-empty
  explicit mapping. They verify source byte identity, preserved legacy `topics:`,
  canonical `directions:`, inert re-inventory, KWR materialization, and verified
  destination snapshots.
- Stale-plan preflight aborts before creating a snapshot/destination; copied
  resumable Job state aborts before destination migration writes.
- All new Slice 3 tests and data-operation regressions pass. The full repository
  run passed 250 tests and exposed one unrelated repository-materialization timing
  failure; that exact test file then passed all 21 tests on immediate isolated
  rerun. Typecheck, production build, and `git diff --check` pass.
