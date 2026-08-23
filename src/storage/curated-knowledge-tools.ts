import type {
  CuratedKnowledgeReader,
  CuratedLocator,
  CuratedSearchInput,
  CuratedSearchPage,
  CuratedSourceDocument,
  VerifiedCuratedCitation,
} from "./curated-knowledge-reader.js";

export type CuratedToolLimits = {
  resultsPerSearch: number;
  uniqueCandidates: number;
  openedSources: number;
  searchCalls: number;
  finalReceipts: number;
};

export const CURATED_TOOL_LIMITS: CuratedToolLimits = {
  resultsPerSearch: 30,
  uniqueCandidates: 60,
  openedSources: 20,
  searchCalls: 8,
  finalReceipts: 20,
} as const;

export type CuratedRetrievalSummary = {
  searched: boolean;
  queryCount: number;
  candidateCount: number;
  openedSourceCount: number;
  usedSourceCount: number;
  budgetExhausted: boolean;
  projectionStale: boolean;
  lastSuccessfulAt: string | null;
};

export type CuratedToolCitation = Omit<VerifiedCuratedCitation, "handle"> & {
  handle: string;
  whySelected: string;
};

export class CuratedKnowledgeToolAuthority {
  readonly #reader: CuratedKnowledgeReader;
  readonly #limits: CuratedToolLimits;
  readonly #authorityByReader = new Map<string, string>();
  readonly #readerByAuthority = new Map<string, string>();
  readonly #opened = new Set<string>();
  readonly #verified = new Map<string, CuratedToolCitation>();
  readonly #usedSources = new Set<string>();
  #queryCount = 0;
  #budgetExhausted = false;
  #projectionStale = false;
  #lastSuccessfulAt: string | null = null;

  constructor(reader: CuratedKnowledgeReader, limits: Partial<CuratedToolLimits> = {}) {
    this.#reader = reader;
    this.#limits = { ...CURATED_TOOL_LIMITS, ...limits };
    if (Object.values(this.#limits).some((value) => !Number.isInteger(value) || value < 1) ||
        this.#limits.resultsPerSearch > 30 || this.#limits.uniqueCandidates > 60 ||
        this.#limits.openedSources > 20 || this.#limits.searchCalls > 8 || this.#limits.finalReceipts > 20) {
      throw new Error("curated-tool-limits-invalid");
    }
  }

  search(input: CuratedSearchInput): CuratedSearchPage {
    if (this.#queryCount >= this.#limits.searchCalls) {
      this.#budgetExhausted = true;
      throw new Error("curated-search-budget-exhausted");
    }
    this.#queryCount += 1;
    const requested = Math.min(input.limit ?? this.#limits.resultsPerSearch, this.#limits.resultsPerSearch);
    const page = this.#reader.search({ ...input, limit: requested });
    this.#projectionStale ||= page.projection.stale;
    this.#lastSuccessfulAt = page.projection.lastSuccessfulAt ?? this.#lastSuccessfulAt;
    const results = [];
    for (const result of page.results) {
      let authorityHandle = this.#authorityByReader.get(result.handle);
      if (!authorityHandle) {
        if (this.#authorityByReader.size >= this.#limits.uniqueCandidates) {
          this.#budgetExhausted = true;
          break;
        }
        authorityHandle = `curated-source-${String(this.#authorityByReader.size + 1).padStart(2, "0")}`;
        this.#authorityByReader.set(result.handle, authorityHandle);
        this.#readerByAuthority.set(authorityHandle, result.handle);
      }
      results.push({ ...result, handle: authorityHandle });
    }
    return { results, projection: page.projection };
  }

  open(authorityHandle: string): CuratedSourceDocument {
    const readerHandle = this.#readerHandle(authorityHandle);
    if (!this.#opened.has(authorityHandle) && this.#opened.size >= this.#limits.openedSources) {
      this.#budgetExhausted = true;
      throw new Error("curated-open-budget-exhausted");
    }
    const document = this.#reader.open(readerHandle);
    this.#opened.add(authorityHandle);
    return { ...document, handle: authorityHandle };
  }

  verify(input: { handle: string; locator: CuratedLocator; quote: string; whySelected: string }): CuratedToolCitation {
    if (!this.#opened.has(input.handle)) throw new Error("curated-citation-source-not-opened");
    if (!input.whySelected.trim() || input.whySelected.length > 1_000) throw new Error("curated-citation-rationale-invalid");
    const readerHandle = this.#readerHandle(input.handle);
    const verified = this.#reader.verify({ handle: readerHandle, locator: input.locator, quote: input.quote });
    const citation = { ...verified, handle: input.handle, whySelected: input.whySelected.trim() };
    const key = citationKey(citation);
    if (!this.#verified.has(key) && this.#verified.size >= this.#limits.finalReceipts) {
      this.#budgetExhausted = true;
      throw new Error("curated-receipt-budget-exhausted");
    }
    this.#verified.set(key, citation);
    this.#usedSources.add(`${citation.sourceType}:${citation.sourceId}:${citation.revisionId}`);
    return citation;
  }

  summary(): CuratedRetrievalSummary {
    return {
      searched: this.#queryCount > 0,
      queryCount: this.#queryCount,
      candidateCount: this.#authorityByReader.size,
      openedSourceCount: this.#opened.size,
      usedSourceCount: this.#usedSources.size,
      budgetExhausted: this.#budgetExhausted,
      projectionStale: this.#projectionStale,
      lastSuccessfulAt: this.#lastSuccessfulAt,
    };
  }

  snapshot(): { summary: CuratedRetrievalSummary; verified: CuratedToolCitation[] } {
    return { summary: this.summary(), verified: [...this.#verified.values()] };
  }

  #readerHandle(authorityHandle: string): string {
    const handle = this.#readerByAuthority.get(authorityHandle);
    if (!handle) throw new Error("curated-tool-handle-foreign");
    return handle;
  }
}

export function citationKey(citation: Pick<CuratedToolCitation,
  "handle" | "locator" | "quote" | "whySelected">): string {
  return JSON.stringify([citation.handle, citation.locator.lineStart, citation.locator.lineEnd,
    citation.quote, citation.whySelected]);
}
