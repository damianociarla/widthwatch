import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { connect, createServer as createTcpServer } from "node:net";
import test from "node:test";
import { connectPinned, startPinnedEgressProxy } from "../dist/egress-proxy.js";
import { UnsafeUrlError } from "../dist/network-policy.js";

async function listen(t, server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(
    () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        if ("closeAllConnections" in server) server.closeAllConnections();
      }),
  );
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}

async function proxyRequest(proxyUrl, targetUrl, headers = {}) {
  const proxy = new URL(proxyUrl);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: proxy.hostname,
        port: proxy.port,
        path: targetUrl,
        method: "GET",
        headers: { host: new URL(targetUrl).host, ...headers },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body }));
      },
    );
    request.once("error", reject);
    request.end();
  });
}

async function rawProxyRequest(proxyUrl, request) {
  const proxy = new URL(proxyUrl);
  return new Promise((resolve, reject) => {
    const socket = connect({ host: proxy.hostname, port: Number(proxy.port) });
    let response = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(request));
    socket.on("data", (chunk) => (response += chunk));
    socket.once("end", () => resolve(response));
    socket.once("error", reject);
  });
}

async function exchangeTunnel(proxyUrl, authority, head, afterHandshake) {
  const proxy = new URL(proxyUrl);
  return new Promise((resolve, reject) => {
    const socket = connect({ host: proxy.hostname, port: Number(proxy.port) });
    let response = Buffer.alloc(0);
    let established = false;
    socket.once("connect", () => socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n${head}`));
    socket.on("data", (chunk) => {
      response = Buffer.concat([response, chunk]);
      if (!established && response.includes(Buffer.from("\r\n\r\n"))) {
        established = true;
        socket.write(afterHandshake);
      }
    });
    socket.once("close", () => resolve(response.toString("utf8")));
    socket.once("error", reject);
  });
}

test("pinned egress proxy forwards HTTP through the resolved address and strips proxy credentials", async (t) => {
  const received = [];
  const upstreamPort = await listen(
    t,
    createServer((request, response) => {
      received.push({ url: request.url, proxyAuthorization: request.headers["proxy-authorization"] });
      response.writeHead(200, { "content-type": "text/plain" }).end("upstream ok");
    }),
  );
  const proxy = await startPinnedEgressProxy(async (value) => {
    const url = new URL(value);
    if (url.hostname !== "public.example") throw new UnsafeUrlError();
    return { url, addresses: ["127.0.0.1"] };
  });
  t.after(() => proxy.close());

  const response = await proxyRequest(proxy.url, `http://public.example:${upstreamPort}/asset?q=1`, { "proxy-authorization": "Basic secret" });
  assert.equal(response.status, 200);
  assert.equal(response.body, "upstream ok");
  assert.deepEqual(received, [{ url: "/asset?q=1", proxyAuthorization: undefined }]);
});

test("pinned egress proxy returns 403 when target policy rejects HTTP", async (t) => {
  const proxy = await startPinnedEgressProxy(async () => {
    throw new UnsafeUrlError();
  });
  t.after(() => proxy.close());
  const response = await proxyRequest(proxy.url, "http://blocked.example/");
  assert.equal(response.status, 403);
  assert.match(response.body, /Blocked by WidthWatch/);
});

test("pinned egress proxy tunnels CONNECT through a fallback IP and closes both sockets", async (t) => {
  let upstreamPayload = "";
  let resolveUpstreamClosed;
  const upstreamClosed = new Promise((resolve) => {
    resolveUpstreamClosed = resolve;
  });
  const upstream = createTcpServer((socket) => {
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      upstreamPayload += chunk;
      if (upstreamPayload.includes("head-before-handshake\nafter-handshake\n")) socket.end("reply-from-upstream\n");
    });
    socket.once("close", resolveUpstreamClosed);
  });
  const upstreamPort = await listen(t, upstream);
  const connectionAttempts = [];
  const proxy = await startPinnedEgressProxy(
    async (value) => {
      const url = new URL(value);
      assert.equal(url.toString(), "https://public.example/");
      return { url, addresses: ["::1", "127.0.0.1", "127.0.0.1"] };
    },
    async (addresses, port) => {
      connectionAttempts.push({ addresses, port });
      return connectPinned(addresses, upstreamPort);
    },
  );
  t.after(() => proxy.close());

  const response = await exchangeTunnel(proxy.url, "public.example:443", "head-before-handshake\n", "after-handshake\n");
  assert.match(response, /^HTTP\/1\.1 200 Connection Established\r\n\r\n/);
  assert.match(response, /reply-from-upstream/);
  assert.equal(upstreamPayload, "head-before-handshake\nafter-handshake\n");
  await upstreamClosed;
  assert.deepEqual(connectionAttempts, [{ addresses: ["::1", "127.0.0.1", "127.0.0.1"], port: 443 }]);
});

test("closing a CONNECT client closes the pinned upstream socket", async (t) => {
  let resolveUpstreamClosed;
  const upstreamClosed = new Promise((resolve) => {
    resolveUpstreamClosed = resolve;
  });
  const upstream = createTcpServer((socket) => socket.once("close", resolveUpstreamClosed));
  const upstreamPort = await listen(t, upstream);
  const proxy = await startPinnedEgressProxy(
    async (value) => ({ url: new URL(value), addresses: ["127.0.0.1"] }),
    (addresses, port) => {
      assert.equal(port, 443);
      return connectPinned(addresses, upstreamPort);
    },
  );
  t.after(() => proxy.close());
  const proxyUrl = new URL(proxy.url);
  const client = connect({ host: proxyUrl.hostname, port: Number(proxyUrl.port) });
  await new Promise((resolve, reject) => {
    let response = "";
    client.setEncoding("utf8");
    client.once("connect", () => client.write("CONNECT public.example:443 HTTP/1.1\r\nHost: public.example:443\r\n\r\n"));
    client.on("data", (chunk) => {
      response += chunk;
      if (response.includes("200 Connection Established")) {
        client.destroy();
        resolve();
      }
    });
    client.once("error", reject);
  });
  await upstreamClosed;
});

test("pinned egress proxy rejects unsafe CONNECT ports and protocol upgrades", async (t) => {
  const proxy = await startPinnedEgressProxy(async () => {
    throw new Error("resolver must not run");
  });
  t.after(() => proxy.close());
  const connectResponse = await rawProxyRequest(proxy.url, "CONNECT example.com:444 HTTP/1.1\r\nHost: example.com:444\r\n\r\n");
  assert.match(connectResponse, /^HTTP\/1\.1 403 Forbidden/);
  const upgradeResponse = await rawProxyRequest(
    proxy.url,
    "GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
  );
  assert.match(upgradeResponse, /^HTTP\/1\.1 403 Forbidden/);
});
