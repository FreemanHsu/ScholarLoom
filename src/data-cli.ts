import { createSnapshot, migrateLegacyData, repairDataRootPermissions, restoreSnapshot, verifySnapshot } from "./storage/data-operations.js";
import { defaultDataRoot, initializeDataRoot, openDataRoot } from "./storage/layout.js";
import {
  createPaperTopicsPlan,
  inventoryPaperTopics,
  migratePaperTopicsCopy,
  openPaperTopicsDataRoot,
  paperTopicsSchemas,
  readInventory,
  readMapping,
  readPlan,
  writeExclusiveJson,
} from "./storage/paper-topics-migration.js";

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
  if (command === "paper-topics") {
    const [action, ...args] = process.argv.slice(3);
    if (action === "inventory") {
      const [root, report, flag] = args;
      if (!root || !report) throw new Error("Usage: ... paper-topics inventory <data-root> <new-report.json> [--include-values]");
      const inventory = inventoryPaperTopics(openPaperTopicsDataRoot(root), {
        includeValues: flag === "--include-values",
      });
      writeExclusiveJson(report, inventory);
      console.log(JSON.stringify({
        created: true,
        report,
        rootFingerprint: inventory.rootFingerprint,
        evidenceHash: inventory.evidenceHash,
        counts: inventory.counts,
        localOnly: inventory.localOnly,
        valuesIncluded: inventory.valuesIncluded,
      }, null, 2));
      return;
    }
    if (action === "plan") {
      const [root, inventoryPath, mappingPath, planPath] = args;
      if (!root || !inventoryPath || !mappingPath || !planPath) {
        throw new Error("Usage: ... paper-topics plan <data-root> <inventory.json> <mapping.json> <new-plan.json>");
      }
      const plan = createPaperTopicsPlan(
        openPaperTopicsDataRoot(root),
        readInventory(inventoryPath),
        readMapping(mappingPath),
      );
      writeExclusiveJson(planPath, plan);
      console.log(JSON.stringify({
        created: true,
        plan: planPath,
        planHash: plan.planHash,
        executable: plan.executable,
        counts: {
          unchanged: plan.papers.filter((paper) => paper.action === "unchanged").length,
          canonicalize: plan.papers.filter((paper) => paper.action === "canonicalize").length,
          unresolved: plan.papers.filter((paper) => paper.action === "unresolved").length,
        },
      }, null, 2));
      if (!plan.executable) process.exitCode = 2;
      return;
    }
    if (action === "migrate-copy") {
      const [root, planPath, destination] = args;
      if (!root || !planPath || !destination) {
        throw new Error("Usage: ... paper-topics migrate-copy <source-data-root> <plan.json> <new-destination-root>");
      }
      console.log(JSON.stringify(await migratePaperTopicsCopy(
        openPaperTopicsDataRoot(root),
        readPlan(planPath),
        destination,
      ), null, 2));
      return;
    }
    if (action === "schemas") {
      console.log(JSON.stringify(paperTopicsSchemas(), null, 2));
      return;
    }
    throw new Error("Usage: ... paper-topics <inventory|plan|migrate-copy|schemas>");
  }
  throw new Error("Usage: tsx src/data-cli.ts <init|snapshot|verify|restore|migrate-legacy|repair-permissions|paper-topics>");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
