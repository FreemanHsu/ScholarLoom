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
      async read() { return { state: "succeeded", error: null }; },
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
      async read() { return { state: "interrupted", error: null }; },
      repeat(callback) { void callback(); return () => undefined; },
    };

    await expect(createImportMonitor(adapter).wait("import:interrupted", () => undefined))
      .rejects.toThrow("导入中断，请重试");
  });

  it("treats a cancelled import as terminal without suggesting retry", async () => {
    const adapter: ImportProgressAdapter = {
      subscribe() { return () => undefined; },
      async read() { return { state: "cancelled", error: null }; },
      repeat(callback) { void callback(); return () => undefined; },
    };

    await expect(createImportMonitor(adapter).wait("import:cancelled", () => undefined))
      .rejects.toThrow("导入已取消");
  });

  it("reports the stored Job Run reason instead of a generic failure", async () => {
    const adapter: ImportProgressAdapter = {
      subscribe() { return () => undefined; },
      async read() { return { state: "failed", error: { code: "summary-generation-failed", message: "Codex CLI 超时",
        stage: "paper-summary", retryable: true, action: "retry" } }; },
      repeat(callback) { void callback(); return () => undefined; },
    };

    const result = await Promise.race([
      createImportMonitor(adapter).wait("import:failed", () => undefined).catch((error: Error) => error.message),
      new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 50)),
    ]);
    expect(result).toBe("Paper Summary 生成失败：Codex CLI 超时（summary-generation-failed）");
  });
});
