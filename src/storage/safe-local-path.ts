import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

export function assertNoSymlinkPath(root: string, target: string, errorCode: string, allowMissingLeaf = false): void {
  const absoluteRoot = resolve(root);
  const absoluteTarget = resolve(target);
  const rel = relative(absoluteRoot, absoluteTarget);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error(errorCode);
  const rootStat = lstatSync(absoluteRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error(errorCode);
  let current = absoluteRoot;
  const parts = rel.split(/[\\/]/);
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index]!);
    if (!existsSync(current)) {
      if (allowMissingLeaf) return;
      throw new Error(errorCode);
    }
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory())) throw new Error(errorCode);
  }
  const realRoot = realpathSync(absoluteRoot);
  const realTarget = realpathSync(absoluteTarget);
  const realRel = relative(realRoot, realTarget);
  if (!realRel || realRel.startsWith("..") || isAbsolute(realRel)) throw new Error(errorCode);
}

export function ensureNoSymlinkDirectory(root: string, directory: string, errorCode: string): void {
  const absoluteRoot = resolve(root);
  const absoluteDirectory = resolve(directory);
  const rel = relative(absoluteRoot, absoluteDirectory);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error(errorCode);
  const rootStat = lstatSync(absoluteRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error(errorCode);
  let current = absoluteRoot;
  for (const part of rel.split(/[\\/]/)) {
    current = join(current, part);
    if (!existsSync(current)) mkdirSync(current, { mode: 0o700 });
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(errorCode);
  }
}

export function readRegularFileNoFollow(root: string, file: string, errorCode: string):
  { bytes: Buffer; size: number; links: number } {
  assertNoSymlinkPath(root, file, errorCode);
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const fd = openSync(file, constants.O_RDONLY | noFollow);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error(errorCode);
    return { bytes: readFileSync(fd), size: stat.size, links: stat.nlink };
  } finally { closeSync(fd); }
}
