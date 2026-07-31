import { describe, expect, it } from "vitest";

import { paperHref, papersHref, readBrowserRoute } from "../src/web/browser-navigation.js";

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
      relation: "all",
      pending: false,
      query: "",
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
      relation: "primary",
      pending: true,
      query: "GenCeption",
    });
    expect(papersHref({
      view: "all",
      direction: "topic:video-generation",
      relation: "all",
      pending: false,
      query: "",
    })).toBe("/papers?direction=topic%3Avideo-generation");
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
});
