import { Agent, createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import { connect, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { resolvePublicTarget, UnsafeUrlError } from "./network-policy.js";

export type EgressTargetResolver = (value: string) => ReturnType<typeof resolvePublicTarget>;
export type EgressConnector = (addresses: string[], port: number) => Promise<Socket>;

export async function startPinnedEgressProxy(
  resolveTarget: EgressTargetResolver = resolvePublicTarget,
  connectTarget: EgressConnector = connectPinned,
): Promise<{ url: string; close(): Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = createServer((request, response) => {
    void proxyHttp(request, response, resolveTarget, connectTarget);
  });
  server.on("connect", (request, socket, head) => {
    void proxyTunnel(request.url ?? "", socket, head, resolveTarget, connectTarget);
  });
  server.on("upgrade", (_request, socket) => socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"));
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not start the egress proxy.");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        for (const socket of sockets) socket.destroy();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function proxyHttp(
  request: IncomingMessage,
  response: ServerResponse,
  resolveTarget: EgressTargetResolver,
  connectTarget: EgressConnector,
): Promise<void> {
  try {
    if (!request.url) throw new UnsafeUrlError();
    const target = await resolveTarget(request.url);
    if (target.url.protocol !== "http:") throw new UnsafeUrlError();
    const socket = await connectTarget(target.addresses, Number(target.url.port || 80));
    const agent = new Agent({ keepAlive: false });
    agent.createConnection = () => socket;
    const headers: IncomingHttpHeaders = { ...request.headers, host: target.url.host };
    delete headers["proxy-authorization"];
    const upstream = httpRequest({ method: request.method, path: `${target.url.pathname}${target.url.search}`, headers, agent });
    upstream.setTimeout(10_000, () => upstream.destroy());
    upstream.on("response", (source) => {
      response.writeHead(source.statusCode ?? 502, source.headers);
      source.pipe(response);
    });
    upstream.on("error", () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    request.pipe(upstream);
  } catch {
    response.writeHead(403, { connection: "close" }).end("Blocked by WidthWatch egress policy.");
  }
}

async function proxyTunnel(
  authority: string,
  client: Duplex,
  head: Buffer,
  resolveTarget: EgressTargetResolver,
  connectTarget: EgressConnector,
): Promise<void> {
  try {
    const url = new URL(`https://${authority}`);
    if (Number(url.port || 443) !== 443 || url.username || url.password || url.pathname !== "/") throw new UnsafeUrlError();
    const target = await resolveTarget(url.toString());
    const upstream = await connectTarget(target.addresses, 443);
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
    upstream.setTimeout(12_000, () => upstream.destroy());
    client.once("close", () => upstream.destroy());
    upstream.once("close", () => client.destroy());
  } catch {
    client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
  }
}

export async function connectPinned(addresses: string[], port: number): Promise<Socket> {
  let lastError: unknown;
  for (const address of [...new Set(addresses)].slice(0, 4)) {
    try {
      return await new Promise<Socket>((resolve, reject) => {
        const socket = connect({ host: address, port, family: address.includes(":") ? 6 : 4 });
        const timer = setTimeout(() => socket.destroy(new Error("Connection timeout")), 5_000);
        socket.once("connect", () => {
          clearTimeout(timer);
          resolve(socket);
        });
        socket.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("No public address could be reached.");
}
