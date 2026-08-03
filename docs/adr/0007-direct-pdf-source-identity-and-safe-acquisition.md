---
status: accepted
date: 2026-07-21
---

# Treat direct PDF URLs as source identities and content hashes as version identities

ScholarLoom accepts public HTTPS URLs only when the response is a directly downloadable,
validated PDF. The normalized submitted URL is a source identity; the final safely
redirected URL is its canonical source URL. A SHA-256 content hash identifies immutable
PDF content and the corresponding Paper Version and Artifact. Different URLs returning
the same bytes share one Paper Version while retaining separate source identities. A
known URL returning different bytes creates a reviewable Paper Version proposal and
never replaces current content silently. The candidate PDF must be opened before the
Review Decision can accept it; acceptance then runs the normal extraction and Summary pipeline.

Direct acquisition is implemented behind the PaperSource seam. Its production adapter
validates every DNS result and redirect target, rejects non-public IP space and URL
userinfo, pins the connection to a validated address, enforces time and size limits,
and checks media type, `%PDF-` magic bytes, and PDF parseability. Resolver and transport
adapters are injectable so tests do not weaken production SSRF policy.

When a credential-free loopback HTTP CONNECT proxy is explicitly configured, or safely
inherited from `ALL_PROXY`/`all_proxy`, acquisition remains direct-first. Only retryable
connectivity failures may fall back once to the proxy; HTTP responses, TLS certificate
failures, unsafe redirects, size failures, and document validation failures do not.
The CONNECT authority is the already validated and pinned target IP rather than the
submitted hostname, while end-to-end TLS continues to authenticate the submitted host.
Every redirect restarts DNS validation and the direct-first strategy. Runtime settings
expose only the effective strategy, proxy presence, configuration source, and loopback
scope, never the proxy endpoint or credentials.

Direct PDF metadata comes from embedded metadata and conservative first-page structure.
Missing title, authors, or year produces a durable `paper-metadata-incomplete` failure;
filenames and URL paths are never promoted to scholarly metadata. The Import Request is
created before acquisition, and safely validated bytes are frozen as an Artifact even
when this metadata check fails.
