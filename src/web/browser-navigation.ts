export type PaperLibraryViewState = {
  view: "all" | "unclassified" | "starred";
  direction: string | null;
  domain?: string | null;
  relation: "all" | "primary";
  pending: boolean;
  query: string;
  sort: "recent" | "year" | "title";
};
export type PaperOrganizationViewState = {
  view: "pending" | "attention" | "all";
  section: "alias" | "primary" | "secondary" | null;
  direction: string | null;
  unclassified: boolean;
  query: string;
};

export type BrowserRoute = { name: "home" | "reviews" | "settings" | "not-found" } | {
  name: "questions";
  conversationId: string | null;
} | ({
  name: "papers";
} & PaperLibraryViewState) | {
  name: "paper-organization";
} & PaperOrganizationViewState | {
  name: "paper";
  paperId: string;
  mode: "reading" | "discussion" | "knowledge";
  conversationId: string | null;
  pdfOpen: boolean;
  page: number;
  anchor: string | null;
  evidenceReceiptId: string | null;
  repositoriesOpen: boolean;
  returnTo: string | null;
};

type BrowserLocation = Pick<Location, "pathname" | "search">;
export type PaperViewState = Pick<Extract<BrowserRoute, { name: "paper" }>, "pdfOpen" | "page" | "anchor"> & {
  mode?: "reading" | "discussion" | "knowledge";
  conversationId?: string | null;
  evidenceReceiptId?: string | null;
  repositoriesOpen?: boolean;
  returnTo?: string | null;
};

export function isCurrentKnowledgeRequest(requestGeneration: number, currentGeneration: number,
  route: BrowserRoute, selectedConversationId: string | null): boolean {
  return requestGeneration === currentGeneration && route.name === "questions"
    && route.conversationId === selectedConversationId;
}

export function knowledgePollingDisposition(pollGeneration: number, currentGeneration: number,
  route: BrowserRoute, submittedConversationId: string | null): "stale" | "observe" | "present" {
  if (pollGeneration !== currentGeneration) return "stale";
  return route.name === "questions" && route.conversationId === submittedConversationId ? "present" : "observe";
}

export function paperHref(paperId: string, view: PaperViewState = { pdfOpen: false, page: 1, anchor: null }): string {
  const query = new URLSearchParams();
  if (!view.conversationId && view.mode && view.mode !== "reading") query.set("mode", view.mode);
  if (view.pdfOpen) query.set("pdf", "open");
  if (view.pdfOpen && view.page > 1) query.set("page", String(view.page));
  if (view.pdfOpen && view.anchor) query.set("anchor", view.anchor);
  if (view.evidenceReceiptId) query.set("evidence", view.evidenceReceiptId);
  if (view.repositoriesOpen) query.set("repositories", "open");
  if (view.returnTo?.startsWith("/papers/organize")) query.set("return", view.returnTo);
  const search = query.toString();
  const path = view.conversationId
    ? `/papers/${encodeURIComponent(paperId)}/conversations/${encodeURIComponent(view.conversationId)}`
    : `/papers/${encodeURIComponent(paperId)}`;
  return `${path}${search ? `?${search}` : ""}`;
}

export function papersHref(view: PaperLibraryViewState): string {
  const query = new URLSearchParams();
  if (view.view !== "all") query.set("view", view.view);
  if (view.direction) query.set("direction", view.direction);
  if (view.domain) query.set("domain", view.domain);
  if (view.relation === "primary") query.set("relation", "primary");
  if (view.pending) query.set("pending", "true");
  if (view.query.trim()) query.set("q", view.query.trim());
  if (view.sort !== "recent") query.set("sort", view.sort);
  const search = query.toString();
  return `/papers${search ? `?${search}` : ""}`;
}

export function paperOrganizationHref(view: PaperOrganizationViewState): string {
  const query = new URLSearchParams();
  if (view.view !== "pending") query.set("view", view.view);
  if (view.section) query.set("section", view.section);
  if (view.direction) query.set("direction", view.direction);
  if (view.unclassified) query.set("unclassified", "true");
  if (view.query.trim()) query.set("q", view.query.trim());
  const search = query.toString();
  return `/papers/organize${search ? `?${search}` : ""}`;
}

export function readBrowserRoute(location: BrowserLocation): BrowserRoute {
  if (location.pathname === "/") return { name: "home" };
  const questionMatch = /^\/questions(?:\/([^/]+))?$/.exec(location.pathname);
  if (questionMatch) return {
    name: "questions",
    conversationId: questionMatch[1] ? decodeURIComponent(questionMatch[1]) : null,
  };
  if (location.pathname === "/papers") {
    const query = new URLSearchParams(location.search);
    const view = query.get("view");
    const sort = query.get("sort");
    return {
      name: "papers",
      view: view === "unclassified" || view === "starred" ? view : "all",
      direction: query.get("direction") || null,
      domain: query.get("domain") || null,
      relation: query.get("relation") === "primary" ? "primary" : "all",
      pending: query.get("pending") === "true",
      query: query.get("q") ?? "",
      sort: sort === "year" || sort === "title" ? sort : "recent",
    };
  }
  if (location.pathname === "/papers/organize") {
    const query = new URLSearchParams(location.search);
    const section = query.get("section");
    const view = query.get("view");
    return {
      name: "paper-organization",
      view: view === "attention" || view === "all" ? view : "pending",
      section: section === "alias" || section === "primary" || section === "secondary" ? section : null,
      direction: query.get("direction") || null,
      unclassified: query.get("unclassified") === "true",
      query: query.get("q") ?? "",
    };
  }
  if (location.pathname === "/reviews") return { name: "reviews" };
  if (location.pathname === "/settings") return { name: "settings" };
  const match = /^\/papers\/([^/]+)(?:\/conversations\/([^/]+))?$/.exec(location.pathname);
  if (!match) return { name: "not-found" };
  const query = new URLSearchParams(location.search);
  const requestedPage = Number.parseInt(query.get("page") ?? "1", 10);
  return {
    name: "paper",
    paperId: decodeURIComponent(match[1]!),
    mode: match[2] ? "discussion" : query.get("mode") === "knowledge" ? "knowledge"
      : query.get("mode") === "discussion" ? "discussion" : "reading",
    conversationId: match[2] ? decodeURIComponent(match[2]) : null,
    pdfOpen: query.get("pdf") === "open",
    page: Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1,
    anchor: query.get("anchor") || null,
    evidenceReceiptId: query.get("evidence") || null,
    repositoriesOpen: query.get("repositories") === "open",
    returnTo: query.get("return")?.startsWith("/papers/organize") ? query.get("return") : null,
  };
}
