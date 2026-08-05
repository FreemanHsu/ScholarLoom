import { describe, expect, it } from "vitest";

import { paperHref, paperOrganizationHref, papersHref, readBrowserRoute } from "../src/web/browser-navigation.js";

describe("browser navigation", () => {
  it("restores a Paper reading view from a direct URL", () => {
    expect(readBrowserRoute({
      pathname: "/papers/paper%3Afixture%3A2024%3Atraceable",
      search: "?pdf=open&page=7&anchor=evidence%3Aclaim%3A1",
    })).toEqual({
      name: "paper",
      paperId: "paper:fixture:2024:traceable",
      mode: "reading",
      conversationId: null,
      pdfOpen: true,
      page: 7,
      anchor: "evidence:claim:1",
      evidenceReceiptId: null,
      repositoriesOpen: false,
      returnTo: null,
    });
  });

  it("restores Discussion and Knowledge modes including a stable Conversation path", () => {
    expect(readBrowserRoute({
      pathname: "/papers/paper%3Afixture/conversations/conversation%3Aone",
      search: "?mode=knowledge&pdf=open&page=3&anchor=evidence%3A3",
    })).toEqual({
      name: "paper",
      paperId: "paper:fixture",
      mode: "discussion",
      conversationId: "conversation:one",
      pdfOpen: true,
      page: 3,
      anchor: "evidence:3",
      evidenceReceiptId: null,
      repositoriesOpen: false,
      returnTo: null,
    });
    expect(readBrowserRoute({ pathname: "/papers/paper%3Afixture", search: "?mode=knowledge" })).toMatchObject({
      mode: "knowledge",
      conversationId: null,
    });
    expect(paperHref("paper:fixture", { mode: "discussion", conversationId: "conversation:one",
      pdfOpen: false, page: 1, anchor: null })).toBe("/papers/paper%3Afixture/conversations/conversation%3Aone");
  });

  it("recognizes every top-level destination and rejects unknown paths", () => {
    expect(readBrowserRoute({ pathname: "/", search: "" })).toEqual({ name: "home" });
    expect(readBrowserRoute({ pathname: "/papers", search: "" })).toEqual({
      name: "papers",
      view: "all",
      direction: null,
      domain: null,
      relation: "all",
      pending: false,
      query: "",
      sort: "recent",
    });
    expect(readBrowserRoute({ pathname: "/reviews", search: "" })).toEqual({ name: "reviews" });
    expect(readBrowserRoute({ pathname: "/settings", search: "" })).toEqual({ name: "settings" });
    expect(readBrowserRoute({ pathname: "/missing", search: "" })).toEqual({ name: "not-found" });
  });

  it("restores Paper Library organization filters from the URL", () => {
    expect(readBrowserRoute({
      pathname: "/papers",
      search: "?view=unclassified&direction=topic%3Avideo-generation&relation=primary&pending=true&q=GenCeption",
    })).toEqual({
      name: "papers",
      view: "unclassified",
      direction: "topic:video-generation",
      domain: null,
      relation: "primary",
      pending: true,
      query: "GenCeption",
      sort: "recent",
    });
    expect(papersHref({
      view: "all",
      direction: "topic:video-generation",
      domain: null,
      relation: "all",
      pending: false,
      query: "",
      sort: "recent",
    })).toBe("/papers?direction=topic%3Avideo-generation");
  });

  it("round trips Domain and Ungrouped library filters", () => {
    expect(papersHref({ view: "all", direction: null, domain: "topic:vision", relation: "all",
      pending: false, query: "", sort: "recent" })).toBe("/papers?domain=topic%3Avision");
    expect(readBrowserRoute({ pathname: "/papers", search: "?domain=ungrouped&relation=primary" }))
      .toMatchObject({ domain: "ungrouped", direction: null, relation: "primary" });
  });

  it("round trips starred papers and catalog sorting", () => {
    const href = papersHref({ view: "starred", direction: null, domain: null, relation: "all",
      pending: false, query: "", sort: "year" });
    expect(href).toBe("/papers?view=starred&sort=year");
    expect(readBrowserRoute(new URL(href, "http://localhost"))).toMatchObject({
      name: "papers", view: "starred", sort: "year",
    });
  });

  it("round trips Paper Organization filters without cursor state", () => {
    const href = paperOrganizationHref({
      view: "attention",
      section: "secondary",
      direction: "topic:视频生成",
      unclassified: true,
      query: "视觉 表征",
    });
    const url = new URL(href, "http://localhost");
    expect(readBrowserRoute(url)).toEqual({
      name: "paper-organization",
      view: "attention",
      section: "secondary",
      direction: "topic:视频生成",
      unclassified: true,
      query: "视觉 表征",
    });
    expect(url.searchParams.has("cursor")).toBe(false);
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

  it("restores the verified Evidence Receipt inspector from the Conversation URL", () => {
    expect(readBrowserRoute({
      pathname: "/papers/paper%3Afixture/conversations/conversation%3Aone",
      search: "?evidence=evidence-receipt%3Aone",
    })).toMatchObject({ evidenceReceiptId: "evidence-receipt:one" });
    expect(paperHref("paper:fixture", { mode: "discussion", conversationId: "conversation:one",
      pdfOpen: false, page: 1, anchor: null, evidenceReceiptId: "evidence-receipt:one" }))
      .toBe("/papers/paper%3Afixture/conversations/conversation%3Aone?evidence=evidence-receipt%3Aone");
  });

  it("restores the repository panel from Paper URL state", () => {
    expect(readBrowserRoute({
      pathname: "/papers/paper%3Afixture",
      search: "?repositories=open",
    })).toMatchObject({ repositoriesOpen: true });
    expect(paperHref("paper:fixture", {
      pdfOpen: false,
      page: 1,
      anchor: null,
      repositoriesOpen: true,
    })).toBe("/papers/paper%3Afixture?repositories=open");
  });

  it("preserves only an organize-workspace return URL", () => {
    const href = paperHref("paper:fixture", {
      pdfOpen: false,
      page: 1,
      anchor: null,
      returnTo: "/papers/organize?view=attention&section=primary",
    });
    expect(href).toBe("/papers/paper%3Afixture?return=%2Fpapers%2Forganize%3Fview%3Dattention%26section%3Dprimary");
    expect(readBrowserRoute({
      pathname: "/papers/paper%3Afixture",
      search: "?return=%2Fpapers%2Forganize%3Fview%3Dattention",
    })).toMatchObject({ returnTo: "/papers/organize?view=attention" });
    expect(readBrowserRoute({
      pathname: "/papers/paper%3Afixture",
      search: "?return=https%3A%2F%2Fevil.example",
    })).toMatchObject({ returnTo: null });
  });
});
