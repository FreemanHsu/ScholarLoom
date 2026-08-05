export function requireLoopbackHost(host: string): "127.0.0.1" | "::1" {
  if (host !== "127.0.0.1" && host !== "::1") throw new Error("ScholarLoom production server must bind to loopback only");
  return host;
}

export function parsePort(value: string): number {
  const port = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || String(port) !== value) throw new Error("SCHOLARLOOM_PORT must be a valid TCP port");
  return port;
}

export type PdfJsRequestPolicy = "default" | "range-first";

export function resolvePdfJsRequestPolicy(value: string | undefined): PdfJsRequestPolicy {
  return value === "range-first" ? "range-first" : "default";
}

export type PdfProxyConfiguration = {
  url: URL;
  source: "SCHOLARLOOM_PDF_PROXY" | "ALL_PROXY" | "all_proxy";
};

export function resolvePdfProxyConfiguration(
  environment: Record<string, string | undefined>,
): PdfProxyConfiguration | null {
  for (const source of ["SCHOLARLOOM_PDF_PROXY", "ALL_PROXY", "all_proxy"] as const) {
    const value = environment[source];
    if (!value) continue;
    let url: URL;
    try { url = new URL(value); }
    catch {
      if (source === "SCHOLARLOOM_PDF_PROXY") throw new Error("SCHOLARLOOM_PDF_PROXY must be a valid loopback HTTP proxy URL");
      continue;
    }
    const valid = url.protocol === "http:" && !url.username && !url.password &&
      ["127.0.0.1", "[::1]"].includes(url.hostname) && url.pathname === "/" && !url.search && !url.hash;
    if (valid) return { url, source };
    if (source === "SCHOLARLOOM_PDF_PROXY") {
      throw new Error("SCHOLARLOOM_PDF_PROXY must be an origin-only, credential-free loopback HTTP proxy URL");
    }
  }
  return null;
}
