import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { EvidenceInspector } from "../src/web/evidence-inspector.js";

describe("Evidence inspector", () => {
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
