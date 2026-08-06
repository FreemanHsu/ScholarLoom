# Implementation Slice 003: Read-only Settings

- Status: Accepted for implementation
- Date: 2026-07-30
- Scope: application-owned Agent configuration, read-only Settings, and Codex CLI compatibility visibility

## Goal

ScholarLoom exposes one read-only Settings page that explains the configuration the
application actually uses. The page does not maintain a display-only copy: Agent
execution and Settings read the same application-owned configuration registry.

## Agent configuration

| Task | Model | Thinking budget | Product status |
|---|---|---|---|
| Paper Summary | `gpt-5.6-sol` | `high` | enabled |
| Discussion / Agentic Evidence | `gpt-5.6-sol` | `medium` | enabled |
| Entry Agent | `gpt-5.6-sol` | `medium` | enabled |
| Takeaway Selection | `gpt-5.6-sol` | `medium` | enabled or feature-disabled |
| Legacy Paper Chat | `gpt-5.6-sol` | `medium` | legacy |

Every Codex launch passes the full configured runtime model ID and
`model_reasoning_effort`; product-family labels such as `sol` are not valid values
for `codex exec --model`. New
Agent Run records store the model, thinking budget, Codex version, and configuration
version when those fields are available. Historical unknown values are never inferred.

## Codex CLI compatibility

`0.144.6` is the minimum supported version, not an exact allowlist. Newer versions are
accepted automatically when the application-owned capability canaries pass. An
unparseable version, an older version, or any failed capability canary remains
fail-closed.

The read model distinguishes installed version, minimum supported version, capability
status, and the time of the startup check.

## Browser information architecture

`/settings` is a secondary destination with three sections:

1. Overview: application/configuration versions, startup time, Codex compatibility,
   data root, listener, feature flags, and latest Agent activity.
2. Agents: status, model, thinking budget, timeout, concurrency, execution/security
   policy, prompt/Skill/Schema contract, provenance, and latest recorded run.
3. System: listener, storage, ingestion limits, execution limits, Visual Evidence,
   renderer, and a pointer to CLI diagnostics.

Prompt details may include application-owned templates, Skills, and JSON Schemas.
They never include runtime-materialized user questions, Paper text, manifests, Vault
content, secrets, credentials, or enumerated environment variables.

## Interface

The browser reads one versioned, allowlisted Settings snapshot. No POST, PUT, PATCH,
or DELETE Settings route exists. Static configured/effective values carry one
snapshot-level load time; observed values carry their own run identity and time.

## Acceptance

- Summary executes with `gpt-5.6-sol` and high reasoning; every other configured task
  executes with `gpt-5.6-sol` and medium reasoning.
- Settings and the Codex adapter consume the same registry.
- All five task kinds are visible with correct enabled, feature-disabled, or legacy
  status.
- Installed Codex CLI `0.145.0` is accepted when all canaries pass.
- The endpoint is closed and allowlisted; it cannot expose raw environment or
  runtime-materialized prompts.
- `/settings` is direct-linkable, refreshable, read-only, and usable at narrow widths.
- Tests, typecheck, build, `git diff --check`, and a real Playwright journey pass.

## Non-goals

- Browser editing, saving, reset, or mutation routes.
- A durable user-editable Settings aggregate.
- Full browser diagnostics for SQLite integrity, missing artifacts, or pending writes.
- Weakening permission, sandbox, schema, or network capability checks.
