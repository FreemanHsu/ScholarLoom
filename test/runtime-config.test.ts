import { describe, expect, it } from "vitest";

import { parsePort, requireLoopbackHost } from "../src/runtime-config.js";

describe("production listener configuration", () => {
  it("accepts loopback listeners and rejects wildcard, LAN, and tailnet binds", () => {
    expect(requireLoopbackHost("127.0.0.1")).toBe("127.0.0.1");
    expect(requireLoopbackHost("::1")).toBe("::1");
    for (const host of ["0.0.0.0", "::", "192.168.1.10", "100.64.0.1"]) expect(() => requireLoopbackHost(host)).toThrow(/loopback only/);
    expect(parsePort("3000")).toBe(3000);
    expect(() => parsePort("3000oops")).toThrow(/valid TCP port/);
  });
});
