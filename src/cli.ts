import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { ImportStore } from "./storage/import-store.js";

const command = process.argv[2];
const dataRoot = process.env.SCHOLARLOOM_DATA_ROOT ?? ".scholarloom";
mkdirSync(dataRoot, { recursive: true });
const knowledgeRoot = process.env.SCHOLARLOOM_KNOWLEDGE_ROOT ?? (existsSync(join(dataRoot, "knowledge")) ? join(dataRoot, "knowledge") : process.cwd());
const store = new ImportStore(join(dataRoot, "scholarloom.sqlite3"), join(dataRoot, "assets"), knowledgeRoot, join(dataRoot, "repositories"));
try {
  if (command === "migrate") console.log(JSON.stringify({ migrated: true, diagnostics: store.diagnostics() }, null, 2));
  else if (command === "diagnostics") console.log(JSON.stringify(store.diagnostics(), null, 2));
  else if (command === "rebuild-index") console.log(JSON.stringify(store.rebuildCuratedProjection(), null, 2));
  else { console.error("Usage: tsx src/cli.ts <migrate|diagnostics|rebuild-index>"); process.exitCode = 2; }
} finally { store.close(); }
