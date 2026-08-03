# Fable Review: Implementation Slice 010

- Date: 2026-08-01
- Canvas: `640dd587-a26d-45ba-9cb4-1d90c35a80bf`
- Prompt node: `e22e8a4e-2306-4271-8f8c-d342a3e86baa`
- Response node: `8b552df2-e303-49c2-a6f2-335461d704a1`
- Model: `claude-fable-5`
- Verdict: Sound architecture, not implementable as written pending one owner decision

## Major conflict

The design said every cross-Paper collision is ambiguous, while the confirmed Paper
Library ranking says an exact Alias match ranks above a canonical-title match. Fable
requires the owner to decide whether that ranking is merely result ordering or may
silently resolve identity for Entry retrieval.

The implementation is paused at this boundary as requested by the owner.

## Owner resolution

The owner chose universal cross-Paper disambiguation. Ranking orders candidates but
never silently chooses a Paper when the same normalized span maps to more than one
Paper, including Preferred-Alias-versus-canonical-title collisions.

## Mandatory amendments accepted independently of the conflict

1. Add a deterministic generic/short-Alias quoting guard and a visible
   “忽略 Paper 身份，检索全部已确认知识” bypass on every resolved answer.
2. Freeze short thresholds, Chinese/ASCII quote forms, CJK/overlap semantics, and an
   exact lookup path that does not depend on trigram support.
3. When a resolved Paper has no curated sources, return deterministic
   `insufficient_evidence` without invoking the Agent.
4. Replace flat `resolvedPaperIds` with selections keyed by ambiguity group; validate
   exactly one selection per group, reject injection outside ambiguity, enforce the
   five-Paper cap after union, and return a distinct stale-resolution response.
5. Use one shared normalization function/version for Catalog and resolver; mismatch
   degrades to broad curated retrieval.
6. Define an extensible response fallback, a future source-kind registry, fair
   per-Paper allocation under the eight-source cap, and prompt-purity tests proving
   Catalog metadata never reaches the Entry Agent.
7. Add a bounded resolver-outcome operational log and a resolver-off kill switch.

## Recommended rollout

Fable recommends a shadow phase that records would-resolve outcomes without
constraining retrieval, followed by explicit enablement with the resolution banner
and bypass available from day one.

## Sound areas to preserve

- deterministic, non-fuzzy, non-Agent identity resolution;
- read-only use of the rebuildable Paper Catalog;
- strict separation of identity routing from epistemic evidence;
- request-scoped fail-closed selection;
- hard Paper/source caps and existing curated source-handle validation.
