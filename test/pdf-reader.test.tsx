import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PdfReader } from "../src/web/pdf-reader.js";

describe("PDF reader request policy", () => {
  it("exposes the active range-first policy on the PDF.js reader", () => {
    const html = renderToStaticMarkup(<PdfReader engine="pdfjs" requestPolicy="range-first"
      url="/api/artifacts/abc/pdf" page={1} />);

    expect(html).toContain('data-viewer-engine="pdfjs"');
    expect(html).toContain('data-request-policy="range-first"');
  });
});
