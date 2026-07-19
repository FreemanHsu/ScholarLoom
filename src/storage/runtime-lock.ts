import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

import type { StorageLayout } from "./layout.js";

type RuntimeLock = { pid: number; token: string; startedAt: string };

export function acquireRuntimeLock(layout: StorageLayout): () => void {
  clearStaleLock(layout);
  const token = randomUUID();
  let descriptor: number;
  try { descriptor = openSync(layout.runtimeLockPath, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("ScholarLoom is already running for this data root");
    throw error;
  }
  const lock: RuntimeLock = { pid: process.pid, token, startedAt: new Date().toISOString() };
  writeFileSync(descriptor, `${JSON.stringify(lock)}\n`, "utf8");
  closeSync(descriptor);
  return () => {
    try {
      const current = readLock(layout);
      if (current?.token === token) unlinkSync(layout.runtimeLockPath);
    } catch { /* Releasing a missing lock is safe during process shutdown. */ }
  };
}

export function assertRuntimeStopped(layout: StorageLayout): void {
  clearStaleLock(layout);
  if (existsSync(layout.runtimeLockPath)) throw new Error("ScholarLoom is still running; stop it before creating a data snapshot");
}

function clearStaleLock(layout: StorageLayout): void {
  const lock = readLock(layout);
  if (!lock) return;
  if (processIsAlive(lock.pid)) return;
  unlinkSync(layout.runtimeLockPath);
}

function readLock(layout: StorageLayout): RuntimeLock | null {
  if (!existsSync(layout.runtimeLockPath)) return null;
  try {
    const lock = JSON.parse(readFileSync(layout.runtimeLockPath, "utf8")) as Partial<RuntimeLock>;
    return typeof lock.pid === "number" && typeof lock.token === "string" && typeof lock.startedAt === "string"
      ? lock as RuntimeLock : { pid: process.pid, token: "invalid", startedAt: "invalid" };
  } catch { return { pid: process.pid, token: "invalid", startedAt: "invalid" }; }
}

function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
