import { createSnapshot, migrateLegacyData, repairDataRootPermissions, restoreSnapshot, verifySnapshot } from "./storage/data-operations.js";
import { defaultDataRoot, initializeDataRoot, openDataRoot } from "./storage/layout.js";

async function main(): Promise<void> {
  const [command, first, second] = process.argv.slice(2);
  if (command === "init") {
    const layout = initializeDataRoot(first ?? process.env.SCHOLARLOOM_DATA_ROOT ?? defaultDataRoot());
    console.log(JSON.stringify({ initialized: true, dataRoot: layout.root }, null, 2));
    return;
  }
  if (command === "snapshot") {
    if (!first) throw new Error("Usage: npm run backup -- <new-snapshot-directory>");
    const layout = openDataRoot(process.env.SCHOLARLOOM_DATA_ROOT ?? defaultDataRoot());
    await createSnapshot(layout, first, { includeDerived: second === "--include-derived" });
    console.log(JSON.stringify({ created: true, snapshotRoot: first, verification: verifySnapshot(first) }, null, 2));
    return;
  }
  if (command === "verify") {
    if (!first) throw new Error("Usage: npm run backup:verify -- <snapshot-directory>");
    const report = verifySnapshot(first);
    console.log(JSON.stringify(report, null, 2));
    if (!report.healthy) process.exitCode = 1;
    return;
  }
  if (command === "restore") {
    if (!first || !second) throw new Error("Usage: npm run restore -- <snapshot-directory> <new-data-root>");
    const layout = restoreSnapshot(first, second);
    console.log(JSON.stringify({ restored: true, dataRoot: layout.root }, null, 2));
    return;
  }
  if (command === "migrate-legacy") {
    if (!first || !second) throw new Error("Usage: npm run data:migrate -- <legacy-repository> <new-data-root>");
    const layout = await migrateLegacyData(first, second);
    console.log(JSON.stringify({ migrated: true, dataRoot: layout.root }, null, 2));
    return;
  }
  if (command === "repair-permissions") {
    const layout = openDataRoot(first ?? process.env.SCHOLARLOOM_DATA_ROOT ?? defaultDataRoot());
    repairDataRootPermissions(layout);
    console.log(JSON.stringify({ repaired: true, dataRoot: layout.root }, null, 2));
    return;
  }
  throw new Error("Usage: tsx src/data-cli.ts <init|snapshot|verify|restore|migrate-legacy|repair-permissions>");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
