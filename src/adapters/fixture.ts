import { PDFDocument, StandardFonts } from "pdf-lib";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export async function createFixturePdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage().drawText("ScholarLoom fixture introduction", { x: 40, y: 700, font });
  pdf.addPage().drawText("Table 1 reports accuracy 91.2. Code: https://github.com/example/fixture", { x: 40, y: 700, font, size: 10 });
  return pdf.save();
}

export const fixtureSummary = {
  sections: [
    { key: "overview", title: "论文概述", body: "这篇 fixture paper 展示了一个可验证的端到端研究工作流。" },
    { key: "motivation", title: "核心想法与动机", body: "核心目标是让技术结论始终能够回到固定版本的原始证据。" },
    { key: "method", title: "方法详解", body: "系统把 PDF、Summary 与代码快照作为不同信源，并以 Evidence Anchor 连接。" },
    { key: "experiments", title: "实验分析", body: "Table 1 报告 accuracy 91.2，作为固定验收证据。" },
    { key: "thoughts", title: "总结与思考", body: "优势是可追溯性；fixture 不代表真实模型质量评估。" },
  ],
  claims: [{ voice: "paper-evidence" as const, claim: "Table 1 reports accuracy 91.2.", sourceHandle: "pdf-page:2" }],
  readStatus: "read" as const,
};

export function prepareFixtureRepository(dataRoot: string): string {
  const root = join(dataRoot, "fixture-source");
  if (existsSync(join(root, ".git"))) return root;
  mkdirSync(root, { recursive: true });
  execFileSync("git", ["init", root]);
  execFileSync("git", ["-C", root, "config", "user.email", "fixture@example.test"]);
  execFileSync("git", ["-C", root, "config", "user.name", "ScholarLoom Fixture"]);
  writeFileSync(join(root, "README.md"), "# Fixture implementation\nEvidence connects the experiment to code.\n", "utf8");
  execFileSync("git", ["-C", root, "add", "README.md"]);
  execFileSync("git", ["-C", root, "commit", "-m", "fixture snapshot"]);
  return root;
}
