export type BrowserRoute = { name: "home" | "papers" | "reviews" | "not-found" } | {
  name: "paper";
  paperId: string;
  pdfOpen: boolean;
  page: number;
  anchor: string | null;
};

type BrowserLocation = Pick<Location, "pathname" | "search">;
export type PaperViewState = Pick<Extract<BrowserRoute, { name: "paper" }>, "pdfOpen" | "page" | "anchor">;

export function paperHref(paperId: string, view: PaperViewState = { pdfOpen: false, page: 1, anchor: null }): string {
  const query = new URLSearchParams();
  if (view.pdfOpen) query.set("pdf", "open");
  if (view.pdfOpen && view.page > 1) query.set("page", String(view.page));
  if (view.pdfOpen && view.anchor) query.set("anchor", view.anchor);
  const search = query.toString();
  return `/papers/${encodeURIComponent(paperId)}${search ? `?${search}` : ""}`;
}

export function readBrowserRoute(location: BrowserLocation): BrowserRoute {
  if (location.pathname === "/") return { name: "home" };
  if (location.pathname === "/papers") return { name: "papers" };
  if (location.pathname === "/reviews") return { name: "reviews" };
  const match = /^\/papers\/([^/]+)$/.exec(location.pathname);
  if (!match) return { name: "not-found" };
  const query = new URLSearchParams(location.search);
  const requestedPage = Number.parseInt(query.get("page") ?? "1", 10);
  return {
    name: "paper",
    paperId: decodeURIComponent(match[1]!),
    pdfOpen: query.get("pdf") === "open",
    page: Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1,
    anchor: query.get("anchor") || null,
  };
}
