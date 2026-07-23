export type BrowserRoute = { name: "home" | "papers" | "reviews" | "not-found" } | {
  name: "paper";
  paperId: string;
  mode: "reading" | "discussion" | "knowledge";
  conversationId: string | null;
  pdfOpen: boolean;
  page: number;
  anchor: string | null;
  evidenceReceiptId: string | null;
  repositoriesOpen: boolean;
};

type BrowserLocation = Pick<Location, "pathname" | "search">;
export type PaperViewState = Pick<Extract<BrowserRoute, { name: "paper" }>, "pdfOpen" | "page" | "anchor"> & {
  mode?: "reading" | "discussion" | "knowledge";
  conversationId?: string | null;
  evidenceReceiptId?: string | null;
  repositoriesOpen?: boolean;
};

export function paperHref(paperId: string, view: PaperViewState = { pdfOpen: false, page: 1, anchor: null }): string {
  const query = new URLSearchParams();
  if (!view.conversationId && view.mode && view.mode !== "reading") query.set("mode", view.mode);
  if (view.pdfOpen) query.set("pdf", "open");
  if (view.pdfOpen && view.page > 1) query.set("page", String(view.page));
  if (view.pdfOpen && view.anchor) query.set("anchor", view.anchor);
  if (view.evidenceReceiptId) query.set("evidence", view.evidenceReceiptId);
  if (view.repositoriesOpen) query.set("repositories", "open");
  const search = query.toString();
  const path = view.conversationId
    ? `/papers/${encodeURIComponent(paperId)}/conversations/${encodeURIComponent(view.conversationId)}`
    : `/papers/${encodeURIComponent(paperId)}`;
  return `${path}${search ? `?${search}` : ""}`;
}

export function readBrowserRoute(location: BrowserLocation): BrowserRoute {
  if (location.pathname === "/") return { name: "home" };
  if (location.pathname === "/papers") return { name: "papers" };
  if (location.pathname === "/reviews") return { name: "reviews" };
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
  };
}
