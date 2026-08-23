import { validateKnowledgeAnswer, type KnowledgeAnswer } from "./knowledge-answer.js";
import type { CuratedKnowledgeReader } from "../storage/curated-knowledge-reader.js";
import type { CuratedRetrievalSummary, CuratedToolCitation } from "../storage/curated-knowledge-tools.js";

export function preflightCuratedKnowledgeAnswer(answer: KnowledgeAnswer,
  snapshot: { summary: CuratedRetrievalSummary; verified: CuratedToolCitation[] },
  reader: CuratedKnowledgeReader): KnowledgeAnswer {
  const verifiedByValue = new Map(snapshot.verified.map((citation) => [stableCitation(citation), citation]));
  const citations = answer.citations.map((citation) => {
    const verified = verifiedByValue.get(stableCitation(citation));
    if (!verified) throw new Error("knowledge-answer-citation-not-verified");
    const canonical = reader.verifyIdentity({ sourceType: verified.sourceType, sourceId: verified.sourceId,
      revisionId: verified.revisionId, contentHash: verified.contentHash, locator: verified.locator,
      quote: verified.quote });
    if (canonical.sourceId !== verified.sourceId || canonical.revisionId !== verified.revisionId ||
        canonical.contentHash !== verified.contentHash || canonical.title !== verified.title ||
        canonical.trustLabel !== verified.trustLabel) throw new Error("knowledge-answer-citation-canonical-mismatch");
    return verified;
  });
  const usedSourceCount = new Set(citations.map((citation) =>
    `${citation.sourceType}:${citation.sourceId}:${citation.revisionId}`)).size;
  const result: KnowledgeAnswer = { ...answer, citations,
    retrievalSummary: { ...snapshot.summary, usedSourceCount } };
  validateKnowledgeAnswer(result);
  return result;
}

function stableCitation(citation: CuratedToolCitation): string {
  return JSON.stringify({ handle: citation.handle, sourceType: citation.sourceType, sourceId: citation.sourceId,
    revisionId: citation.revisionId, contentHash: citation.contentHash, title: citation.title,
    trustLabel: citation.trustLabel, locator: citation.locator, quote: citation.quote,
    whySelected: citation.whySelected });
}
