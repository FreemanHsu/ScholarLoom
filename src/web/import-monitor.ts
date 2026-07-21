import { isTerminalImportJobState, parseImportJobState, type ImportJobError, type ImportJobState } from "../domain/import-job.js";

export type { ImportJobState } from "../domain/import-job.js";

type ImportProgress = { state: ImportJobState; error: ImportJobError | null };

export interface ImportProgressAdapter {
  subscribe(importId: string, onProgress: (progress: ImportProgress) => void): () => void;
  read(importId: string): Promise<ImportProgress>;
  repeat(callback: () => Promise<void>): () => void;
}

function describeImportFailure(error: ImportJobError): string {
  const stage = error.stage === "pdf-download" ? "PDF 下载失败"
    : error.stage === "pdf-storage" ? "PDF 保存失败"
      : error.stage === "pdf-extraction" ? "PDF 解析失败"
        : error.stage === "paper-summary" ? "Paper Summary 生成失败" : "Summary 保存失败";
  return `${stage}：${error.message}（${error.code}）`;
}

export function createImportMonitor(adapter: ImportProgressAdapter) {
  return {
    wait(importId: string, onProgress: (state: ImportJobState) => void): Promise<void> {
      return new Promise((resolve, reject) => {
        let settled = false;
        const cleanup: Array<() => void> = [];
        const finish = ({ state, error }: ImportProgress) => {
          if (settled) return;
          onProgress(state);
          if (!isTerminalImportJobState(state)) return;
          settled = true;
          cleanup.forEach((stop) => stop());
          if (state === "succeeded") resolve();
          else if (state === "cancelled") reject(new Error("导入已取消"));
          else if (state === "interrupted") reject(new Error("导入中断，请重试"));
          else reject(new Error(error ? describeImportFailure(error) : "导入失败，请重试"));
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
        const job = JSON.parse((event as MessageEvent).data) as { state?: unknown; error?: ImportJobError | null };
        const state = parseImportJobState(job.state);
        if (state) onState({ state, error: job.error ?? null });
      } catch { /* Ignore malformed events and let status polling remain authoritative. */ }
    });
    return () => events.close();
  },
  async read(importId) {
    const response = await fetch(`/api/imports/${encodeURIComponent(importId)}`);
    if (!response.ok) throw new Error("import-status-unavailable");
    const status = await response.json() as { jobs?: Array<{ jobType?: string; state?: unknown; error?: ImportJobError | null }> };
    const job = status.jobs?.filter((candidate) => candidate.jobType === "paper-import").at(-1);
    const parsed = parseImportJobState(job?.state);
    if (parsed) return { state: parsed, error: job?.error ?? null };
    throw new Error("import-status-invalid");
  },
  repeat(callback) {
    const timer = window.setInterval(() => void callback(), 5_000);
    return () => window.clearInterval(timer);
  },
};

export const importMonitor = createImportMonitor(browserAdapter);
