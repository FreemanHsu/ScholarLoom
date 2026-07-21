import { describe, expect, it } from "vitest";

import { paperHref, readBrowserRoute } from "../src/web/browser-navigation.js";

describe("browser navigation", () => {
  it("restores a Paper reading view from a direct URL", () => {
    expect(readBrowserRoute({
      pathname: "/papers/paper%3Afixture%3A2024%3Atraceable",
      search: "?pdf=open&page=7&anchor=evidence%3Aclaim%3A1",
    })).toEqual({
      name: "paper",
      paperId: "paper:fixture:2024:traceable",
      pdfOpen: true,
      page: 7,
      anchor: "evidence:claim:1",
    });
  });

  it("recognizes every top-level destination and rejects unknown paths", () => {
    expect(readBrowserRoute({ pathname: "/", search: "" })).toEqual({ name: "home" });
    expect(readBrowserRoute({ pathname: "/papers", search: "" })).toEqual({ name: "papers" });
    expect(readBrowserRoute({ pathname: "/reviews", search: "" })).toEqual({ name: "reviews" });
    expect(readBrowserRoute({ pathname: "/missing", search: "" })).toEqual({ name: "not-found" });
  });

  it("creates a stable encoded URL for a selected Evidence Anchor", () => {
    expect(paperHref("paper:fixture:2024:traceable", {
      pdfOpen: true,
      page: 2,
      anchor: "evidence:claim:table 1",
    })).toBe("/papers/paper%3Afixture%3A2024%3Atraceable?pdf=open&page=2&anchor=evidence%3Aclaim%3Atable+1");
    expect(paperHref("paper:fixture:2024:traceable", { pdfOpen: false, page: 1, anchor: null }))
      .toBe("/papers/paper%3Afixture%3A2024%3Atraceable");
  });
});
