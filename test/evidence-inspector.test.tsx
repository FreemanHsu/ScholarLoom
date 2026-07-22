import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { EvidenceInspector } from "../src/web/evidence-inspector.js";

describe("Evidence inspector", () => {
  it("renders a verified visual page separately from its bounded observation", () => {
    const html = renderToStaticMarkup(<EvidenceInspector evidence={{ id: "receipt:visual", evidenceKind: "visual",
      sourceId: "paper-version:1", sourceRevision: "extraction:1", workspacePath: null, quote: null,
      verificationStatus: "verified", locator: { page: 1 }, page: 1,
      visualObservation: "The orange bar labelled B is tallest.", rendererName: "pdfjs-napi-canvas",
      rendererVersion: "6.1.200+1.0.2", rendererFingerprint: "a".repeat(64),
      renderSettings: { scale: 2 }, imageHash: "b".repeat(64), imageUrl: "/api/evidence/receipt%3Avisual/image" }}
      onClose={() => undefined} />);

    expect(html).toContain("VISUAL EVIDENCE");
    expect(html).toContain("Visual · p. 1");
    expect(html).toContain("The orange bar labelled B is tallest.");
    expect(html).toContain("/api/evidence/receipt%3Avisual/image");
    expect(html).toContain("6.1.200+1.0.2");
  });

  it("keeps verified evidence visually separate from Agent activity", () => {
    const html = renderToStaticMarkup(<EvidenceInspector evidence={{ id: "receipt:1", evidenceKind: "code",
      sourceId: "snapshot:1", sourceRevision: "abc123", workspacePath: "repositories/demo/src/main.ts",
      quote: "return grounded;", verificationStatus: "verified", locator: { path: "src/main.ts", lineStart: 8, lineEnd: 8 } }}
      onClose={() => undefined} />);
    expect(html).toContain("VERIFIED EVIDENCE");
    expect(html).toContain("return grounded;");
    expect(html).toContain("src/main.ts");
    expect(html).not.toContain("Agent Activity");
  });
});
