import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

import { createFixturePdf, createLargeFixturePdf } from "../src/adapters/fixture.js";

describe("browser PDF fixture", () => {
  it("uses real A4 and Letter page dimensions", async () => {
    const loadingTask = getDocument({ data: await createFixturePdf() });
    const document = await loadingTask.promise;
    const a4 = (await document.getPage(1)).getViewport({ scale: 1 });
    const letter = (await document.getPage(2)).getViewport({ scale: 1 });

    expect([a4.width, a4.height]).toEqual([595.28, 841.89]);
    expect([letter.width, letter.height]).toEqual([612, 792]);

    await loadingTask.destroy();
  });

  it("provides an independently selectable large-PDF browser corpus", async () => {
    const bytes = await createLargeFixturePdf();
    expect(bytes.byteLength).toBe(12_588_462);
    expect(createHash("sha256").update(bytes).digest("hex"))
      .toBe("a167661f12ae6f251492db8a0646a4d0bb13463162ff4340a105cbbbdd9f1a4e");

    const loadingTask = getDocument({ data: bytes });
    const document = await loadingTask.promise;
    expect(document.numPages).toBe(2);
    await loadingTask.destroy();
  });
});
