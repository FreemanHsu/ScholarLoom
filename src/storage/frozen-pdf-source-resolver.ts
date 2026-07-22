import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute, join, normalize, relative } from "node:path";

import type { StorageLayout } from "./layout.js";
import type { FrozenPdfSource } from "./pdf-page-renderer.js";
import { assertNoSymlinkPath } from "./safe-local-path.js";

export type FrozenPdfArtifact = {
  artifactId: string;
  contentHash: string;
  storageRef: string;
  byteSize: number;
};

export class FrozenPdfSourceResolver {
  constructor(private readonly layout: StorageLayout) {}

  open(artifact: FrozenPdfArtifact): FrozenPdfSource {
    const expectedRef = join("originals", "papers", artifact.contentHash.slice(0, 2), `${artifact.contentHash}.pdf`);
    if (artifact.storageRef !== expectedRef || isAbsolute(artifact.storageRef) || normalize(artifact.storageRef).startsWith("..")) {
      throw new Error("visual-source-path-unsafe");
    }
    const absolute = join(this.layout.root, artifact.storageRef);
    const fromOriginals = relative(this.layout.originalsRoot, absolute);
    if (!fromOriginals || fromOriginals.startsWith("..") || isAbsolute(fromOriginals)) throw new Error("visual-source-path-unsafe");
    assertNoSymlinkPath(this.layout.originalsRoot, absolute, "visual-source-path-unsafe");
    const link = lstatSync(absolute);
    if (!link.isFile() || link.isSymbolicLink() || link.nlink !== 1) throw new Error("visual-source-link-unsafe");
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    const fd = openSync(absolute, constants.O_RDONLY | noFollow);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size !== artifact.byteSize) throw new Error("visual-source-file-invalid");
      const bytes = readFileSync(fd);
      if (createHash("sha256").update(bytes).digest("hex") !== artifact.contentHash) throw new Error("visual-source-drift");
      return { artifactId: artifact.artifactId, contentHash: artifact.contentHash, bytes };
    } finally { closeSync(fd); }
  }
}
