export type ImportJobState = "queued" | "running" | "succeeded" | "failed" | "interrupted";

export interface ImportProgressAdapter {
  subscribe(importId: string, onState: (state: ImportJobState) => void): () => void;
  read(importId: string): Promise<ImportJobState>;
  repeat(callback: () => Promise<void>): () => void;
}

export function createImportMonitor(adapter: ImportProgressAdapter) {
  return {
    wait(importId: string, onProgress: (state: ImportJobState) => void): Promise<void> {
      return new Promise((resolve, reject) => {
        let settled = false;
        const cleanup: Array<() => void> = [];
        const finish = (state: ImportJobState) => {
          if (settled) return;
          onProgress(state);
          if (state !== "succeeded" && state !== "failed" && state !== "interrupted") return;
          settled = true;
          cleanup.forEach((stop) => stop());
          if (state === "succeeded") resolve();
          else reject(new Error(state === "interrupted" ? "导入中断，请重试" : "导入失败，请重试"));
        };
        const checkStatus = async () => {
          try { finish(await adapter.read(importId)); }
          catch { /* A transient status failure must not turn a durable import into a failure. */ }
        };

        const unsubscribe = adapter.subscribe(importId, finish);
        cleanup.push(unsubscribe);
        if (settled) unsubscribe();
        const stopPolling = adapter.repeat(checkStatus);
        cleanup.push(stopPolling);
        if (settled) stopPolling();
        void checkStatus();
      });
    },
  };
}

const browserAdapter: ImportProgressAdapter = {
  subscribe(importId, onState) {
    const events = new EventSource(`/api/events?scope=${encodeURIComponent(importId)}`);
    events.addEventListener("job-progress", (event) => {
      try {
        const job = JSON.parse((event as MessageEvent).data) as { state?: unknown };
        if (job.state === "queued" || job.state === "running" || job.state === "succeeded" || job.state === "failed" || job.state === "interrupted") {
          onState(job.state);
        }
      } catch { /* Ignore malformed events and let status polling remain authoritative. */ }
    });
    return () => events.close();
  },
  async read(importId) {
    const response = await fetch(`/api/imports/${encodeURIComponent(importId)}`);
    if (!response.ok) throw new Error("import-status-unavailable");
    const status = await response.json() as { jobs?: Array<{ jobType?: string; state?: unknown }> };
    const state = status.jobs?.filter((job) => job.jobType === "paper-import").at(-1)?.state;
    if (state === "queued" || state === "running" || state === "succeeded" || state === "failed" || state === "interrupted") return state;
    throw new Error("import-status-invalid");
  },
  repeat(callback) {
    const timer = window.setInterval(() => void callback(), 5_000);
    return () => window.clearInterval(timer);
  },
};

export const importMonitor = createImportMonitor(browserAdapter);
