import { ImportStore } from "./storage/import-store.js";
import { defaultDataRoot, openDataRoot } from "./storage/layout.js";
import { acquireRuntimeLock } from "./storage/runtime-lock.js";

const command = process.argv[2];
const layout = openDataRoot(process.env.SCHOLARLOOM_DATA_ROOT ?? defaultDataRoot());
const releaseRuntimeLock = acquireRuntimeLock(layout);
const store = ImportStore.open(layout);
try {
  if (command === "migrate") console.log(JSON.stringify({ migrated: true, diagnostics: store.diagnostics() }, null, 2));
  else if (command === "diagnostics") console.log(JSON.stringify(store.diagnostics(), null, 2));
  else if (command === "rebuild-index") console.log(JSON.stringify({
    curated: store.rebuildCuratedProjection(),
    paperCatalog: store.rebuildPaperCatalog(),
  }, null, 2));
  else { console.error("Usage: tsx src/cli.ts <migrate|diagnostics|rebuild-index>"); process.exitCode = 2; }
} finally { store.close(); releaseRuntimeLock(); }
