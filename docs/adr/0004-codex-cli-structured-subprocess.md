---
status: accepted
---

# Invoke Codex as a structured read-only subprocess

All v1 AI work runs through `codex exec` behind a typed CodexRunner module. Each
Agent Run receives a Paper-scoped immutable context, a JSON output schema, ephemeral
session state, and a read-only sandbox; the application validates output and owns
all downloads, database changes, Markdown writes, and review decisions. This gives
the product Codex's reasoning and existing authentication without allowing an Agent
Run to bypass domain invariants or make hidden knowledge changes.
