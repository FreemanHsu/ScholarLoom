import type { FastifyReply, FastifyRequest } from "fastify";

import type { PdfArtifactDescriptor } from "./storage/import-store.js";

type ByteRange = { start: number; end: number };

function matchesIfNoneMatch(value: string | undefined, etag: string): boolean {
  return value?.split(",").some((candidate) => {
    const validator = candidate.trim();
    return validator === "*" || validator.replace(/^W\//, "") === etag;
  }) ?? false;
}

function parseSingleRange(value: string | undefined, byteSize: number): ByteRange | "unsatisfiable" | null {
  if (!value || value.includes(",")) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return null;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return "unsatisfiable";
    return { start: Math.max(0, byteSize - suffixLength), end: byteSize - 1 };
  }
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : byteSize - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) ||
      start >= byteSize || requestedEnd < start) return "unsatisfiable";
  return { start, end: Math.min(requestedEnd, byteSize - 1) };
}

export function sendPdfArtifact(request: FastifyRequest, reply: FastifyReply,
  pdf: PdfArtifactDescriptor): FastifyReply {
  const etag = `"${pdf.contentHash}"`;
  reply.type("application/pdf")
    .header("accept-ranges", "bytes")
    .header("cache-control", "private, max-age=31536000, immutable")
    .header("etag", etag);

  if (matchesIfNoneMatch(request.headers["if-none-match"], etag)) {
    return reply.code(304).send();
  }

  const range = request.method === "HEAD" ||
    (request.headers["if-range"] && request.headers["if-range"] !== etag)
    ? null : parseSingleRange(request.headers.range, pdf.byteSize);
  if (range === "unsatisfiable") {
    return reply.code(416).header("content-range", `bytes */${pdf.byteSize}`).header("content-length", 0).send();
  }
  if (range) {
    const contentLength = range.end - range.start + 1;
    reply.code(206)
      .header("content-range", `bytes ${range.start}-${range.end}/${pdf.byteSize}`)
      .header("content-length", contentLength);
    return reply.send(pdf.open(range));
  }

  reply.header("content-length", pdf.byteSize);
  return reply.send(pdf.open());
}
