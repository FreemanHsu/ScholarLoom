export function requireLoopbackHost(host: string): "127.0.0.1" | "::1" {
  if (host !== "127.0.0.1" && host !== "::1") throw new Error("ScholarLoom production server must bind to loopback only");
  return host;
}

export function parsePort(value: string): number {
  const port = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || String(port) !== value) throw new Error("SCHOLARLOOM_PORT must be a valid TCP port");
  return port;
}
