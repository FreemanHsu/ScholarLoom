import { afterEach, describe, expect, it, vi } from "vitest";

import { ArxivPaperSource } from "../src/adapters/arxiv.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ArxivPaperSource", () => {
  it("resolves authors whose Atom entries include affiliation metadata", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(`<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <entry>
    <id>http://arxiv.org/abs/2501.12202v5</id>
    <title>
      Hunyuan3D 2.0: Scaling Diffusion Models for High Resolution Textured 3D Assets Generation
    </title>
    <published>2025-01-21T15:16:54Z</published>
    <author>
      <name>Zibo Zhao</name>
      <arxiv:affiliation>refer to the report for detailed contributions</arxiv:affiliation>
    </author>
    <author>
      <name>Zeqiang Lai</name>
      <arxiv:affiliation>refer to the report for detailed contributions</arxiv:affiliation>
    </author>
  </entry>
</feed>`, {
      status: 200,
      headers: { "content-type": "application/atom+xml; charset=utf-8" },
    })));

    await expect(new ArxivPaperSource().resolve("2501.12202")).resolves.toEqual({
      arxivId: "2501.12202",
      latestVersion: 5,
      title: "Hunyuan3D 2.0: Scaling Diffusion Models for High Resolution Textured 3D Assets Generation",
      authors: ["Zibo Zhao", "Zeqiang Lai"],
      year: 2025,
    });
  });
});
