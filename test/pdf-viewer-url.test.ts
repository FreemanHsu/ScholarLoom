import { describe, expect, it } from "vitest";

import { pdfViewerUrl } from "../src/web/pdf-viewer-url.js";

describe("PDF viewer URL", () => {
  it("opens the requested page fitted to the Paper Workspace width", () => {
    expect(pdfViewerUrl("/api/artifacts/abc/pdf#page=9", 2))
      .toBe("/api/artifacts/abc/pdf#page=2&view=FitH&navpanes=0");
  });
});
