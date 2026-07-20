import { describe, expect, it, vi } from "vitest";

import { createImportMonitor, type ImportProgressAdapter } from "../src/web/import-monitor.js";

describe("import progress monitoring", () => {
  it("recovers a completed import through status polling when SSE never reports the terminal state", async () => {
    let poll: (() => Promise<void>) | undefined;
    const unsubscribe = vi.fn();
    const stopPolling = vi.fn();
    const onProgress = vi.fn();
    const adapter: ImportProgressAdapter = {
      subscribe() { return unsubscribe; },
      async read() { return "succeeded"; },
      repeat(callback) { poll = callback; return stopPolling; },
    };
    const monitor = createImportMonitor(adapter);

    const completion = monitor.wait("import:slow", onProgress);
    await poll?.();

    await expect(completion).resolves.toBeUndefined();
    expect(onProgress).toHaveBeenCalledWith("succeeded");
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(stopPolling).toHaveBeenCalledOnce();
  });

  it("treats an interrupted import as retryable terminal state", async () => {
    const adapter: ImportProgressAdapter = {
      subscribe() { return () => undefined; },
      async read() { return "interrupted"; },
      repeat(callback) { void callback(); return () => undefined; },
    };

    await expect(createImportMonitor(adapter).wait("import:interrupted", () => undefined))
      .rejects.toThrow("导入中断，请重试");
  });
});
