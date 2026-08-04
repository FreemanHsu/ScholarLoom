import { describe, expect, it } from "vitest";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

import { createFixturePdf } from "../src/adapters/fixture.js";

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
});
