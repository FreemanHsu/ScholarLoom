import { describe, expect, it } from "vitest";

import { parsePort, requireLoopbackHost, resolvePdfProxyConfiguration } from "../src/runtime-config.js";

describe("production listener configuration", () => {
  it("accepts loopback listeners and rejects wildcard, LAN, and tailnet binds", () => {
    expect(requireLoopbackHost("127.0.0.1")).toBe("127.0.0.1");
    expect(requireLoopbackHost("::1")).toBe("::1");
    for (const host of ["0.0.0.0", "::", "192.168.1.10", "100.64.0.1"]) expect(() => requireLoopbackHost(host)).toThrow(/loopback only/);
    expect(parsePort("3000")).toBe(3000);
    expect(() => parsePort("3000oops")).toThrow(/valid TCP port/);
  });

  it("prefers an explicit PDF proxy and otherwise accepts a safe loopback all_proxy", () => {
    expect(resolvePdfProxyConfiguration({
      SCHOLARLOOM_PDF_PROXY: "http://127.0.0.1:7891",
      all_proxy: "http://127.0.0.1:7890",
    })).toMatchObject({ url: new URL("http://127.0.0.1:7891"), source: "SCHOLARLOOM_PDF_PROXY" });
    expect(resolvePdfProxyConfiguration({ all_proxy: "http://127.0.0.1:7890" }))
      .toMatchObject({ url: new URL("http://127.0.0.1:7890"), source: "all_proxy" });
  });

  it("fails closed for an unsafe explicit proxy and ignores unsafe inherited proxy variables", () => {
    for (const value of [
      "https://127.0.0.1:7890",
      "http://user:secret@127.0.0.1:7890",
      "http://192.168.1.20:7890",
      "http://127.0.0.1:7890/path",
    ]) {
      expect(() => resolvePdfProxyConfiguration({ SCHOLARLOOM_PDF_PROXY: value }))
        .toThrow(/SCHOLARLOOM_PDF_PROXY/);
    }
    expect(resolvePdfProxyConfiguration({ ALL_PROXY: "http://proxy.example.test:7890" })).toBeNull();
    expect(resolvePdfProxyConfiguration({ all_proxy: "not a url" })).toBeNull();
  });
});
