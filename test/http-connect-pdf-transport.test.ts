import { once } from "node:events";
import { createServer } from "node:http";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import { createServer as createTlsServer } from "node:tls";

import { expect, it } from "vitest";

import { HttpConnectPdfTransport } from "../src/adapters/safe-pdf-downloader.js";
import { proxyTestCertificate, proxyTestPrivateKey } from "./fixtures/proxy-test-certificate.js";

it("opens the proxy tunnel to the validated IP instead of asking the proxy to resolve the hostname", async () => {
  let connectTarget = "";
  const proxy = createServer();
  proxy.on("connect", (request, socket) => {
    connectTarget = request.url ?? "";
    socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const address = proxy.address();
  if (!address || typeof address === "string") throw new Error("proxy fixture did not bind a TCP port");

  try {
    const transport = new HttpConnectPdfTransport(new URL(`http://127.0.0.1:${address.port}`));
    await expect(transport.request({
      url: new URL("https://papers.example.test/paper.pdf"),
      address: "203.0.113.10",
      connectTimeoutMs: 1_000,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: "EPROXYCONNECT" });
    expect(connectTarget).toBe("203.0.113.10:443");
  } finally {
    proxy.close();
    await once(proxy, "close");
  }
});

it("rejects promptly when the proxy closes before completing the CONNECT response", async () => {
  const proxy = createServer();
  proxy.on("connect", (_request, socket) => socket.end());
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const address = proxy.address();
  if (!address || typeof address === "string") throw new Error("proxy fixture did not bind a TCP port");

  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), 250);
  try {
    const transport = new HttpConnectPdfTransport(new URL(`http://127.0.0.1:${address.port}`));
    await expect(transport.request({
      url: new URL("https://papers.example.test/paper.pdf"),
      address: "203.0.113.10",
      connectTimeoutMs: 1_000,
      signal: controller.signal,
    })).rejects.toMatchObject({ code: "EPROXYCONNECT" });
  } finally {
    clearTimeout(abortTimer);
    proxy.close();
    await once(proxy, "close");
  }
});

it("downloads an HTTPS response through a CONNECT tunnel", async () => {
  const openSockets = new Set<Duplex>();
  const origin = createTlsServer({ cert: proxyTestCertificate, key: proxyTestPrivateKey }, (socket) => {
    openSockets.add(socket);
    socket.once("close", () => openSockets.delete(socket));
    socket.once("data", (chunk) => {
      if (!chunk.byteLength) return;
      socket.end("HTTP/1.1 200 OK\r\nContent-Type: application/pdf\r\nContent-Length: 9\r\nConnection: close\r\n\r\n%PDF-test");
    });
  });
  origin.listen(0, "127.0.0.1");
  await once(origin, "listening");
  const originAddress = origin.address();
  if (!originAddress || typeof originAddress === "string") throw new Error("origin fixture did not bind a TCP port");

  const proxy = createServer();
  proxy.on("connect", (_request, socket) => {
    openSockets.add(socket);
    socket.once("close", () => openSockets.delete(socket));
    const upstream = connect(originAddress.port, "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    openSockets.add(upstream);
    upstream.once("close", () => openSockets.delete(upstream));
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const proxyAddress = proxy.address();
  if (!proxyAddress || typeof proxyAddress === "string") throw new Error("proxy fixture did not bind a TCP port");

  try {
    const transport = new HttpConnectPdfTransport(new URL(`http://127.0.0.1:${proxyAddress.port}`), {
      ca: proxyTestCertificate,
    });
    const response = await transport.request({
      url: new URL("https://papers.example.test/paper.pdf"),
      address: "203.0.113.10",
      connectTimeoutMs: 1_000,
      signal: new AbortController().signal,
    });
    const chunks: Uint8Array[] = [];
    for await (const chunk of response.body) chunks.push(chunk);
    expect(response.status).toBe(200);
    expect(Buffer.concat(chunks).toString()).toBe("%PDF-test");
  } finally {
    for (const socket of openSockets) socket.destroy();
    proxy.close();
    origin.close();
    await Promise.all([once(proxy, "close"), once(origin, "close")]);
  }
});
