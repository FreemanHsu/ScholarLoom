export const IMPORT_JOB_STATES = ["queued", "running", "succeeded", "failed", "cancelled", "interrupted"] as const;

export type ImportJobState = typeof IMPORT_JOB_STATES[number];
export type RetryableImportJobState = Extract<ImportJobState, "failed" | "interrupted">;

export type ImportStage = "pdf-download" | "pdf-storage" | "pdf-extraction" | "paper-summary" | "knowledge-write";

export type ImportJobError = {
  code: string;
  message: string;
  stage: ImportStage;
  retryable: boolean;
  action: string | null;
};

export function parseImportJobState(value: unknown): ImportJobState | null {
  return typeof value === "string" && (IMPORT_JOB_STATES as readonly string[]).includes(value)
    ? value as ImportJobState
    : null;
}

export function isRetryableImportJobState(value: unknown): value is RetryableImportJobState {
  return value === "failed" || value === "interrupted";
}

export function isTerminalImportJobState(value: ImportJobState): boolean {
  return value === "succeeded" || value === "cancelled" || isRetryableImportJobState(value);
}

export function requireImportJobState(value: unknown): ImportJobState {
  const state = parseImportJobState(value);
  if (!state) throw new Error(`invalid-import-job-state:${String(value)}`);
  return state;
}
