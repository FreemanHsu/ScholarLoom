---
status: accepted
---

# Run a local modular monolith

ScholarLoom v1 runs as one TypeScript/Node.js process on the Mac mini, serving the
browser UI, coordinating durable jobs, owning the single KnowledgeWriter, and using
SQLite plus local files. External work is performed through bounded arXiv, Git, PDF,
and Codex adapters rather than separately deployed services. A distributed worker
or microservice design would add failure modes and operational burden before the
single-user workload requires independent scaling; the module interfaces preserve
seams that can be moved later if a second deployment becomes necessary.

Remote browser access uses a tailnet-private HTTPS endpoint managed by Tailscale
Serve. The application itself listens only on loopback; direct LAN/Tailscale-interface
binds and Tailscale Funnel are excluded.
