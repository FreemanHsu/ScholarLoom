import { describe, expect, it } from "vitest";

import {
  IMPORT_JOB_STATES,
  isRetryableImportJobState,
  isTerminalImportJobState,
  parseImportJobState,
} from "../src/domain/import-job.js";

describe("import job state", () => {
  it("parses only durable states shared by storage and browser clients", () => {
    expect(IMPORT_JOB_STATES.map(parseImportJobState)).toEqual(IMPORT_JOB_STATES);
    expect(parseImportJobState("unknown")).toBeNull();
    expect(parseImportJobState(null)).toBeNull();
  });

  it("keeps failed and interrupted attempts terminal and retryable", () => {
    expect(IMPORT_JOB_STATES.filter(isRetryableImportJobState)).toEqual(["failed", "interrupted"]);
    expect(IMPORT_JOB_STATES.filter(isTerminalImportJobState)).toEqual(["succeeded", "failed", "cancelled", "interrupted"]);
  });
});
