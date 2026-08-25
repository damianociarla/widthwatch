import { Agent, createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import { connect, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import type { EgressTransferBudget } from "./egress-budget.js";
import { resolvePublicTarget, UnsafeUrlError } from "./network-policy.js";

export type EgressTargetResolver = (value: string) => ReturnType<typeof resolvePublicTarget>;
export type EgressConnector = (addresses: string[], port: number) => Promise<Socket>;

export interface PinnedEgressProxyOptions {
  budget: EgressTransferBudget;
  resolveTarget?: EgressTargetResolver;
  connectTarget?: EgressConnector;
}

export async function startPinnedEgressProxy(options: PinnedEgressProxyOptions): Promise<{ url: string; close(): Promise<void> }> {
  const { budget, resolveTarget = resolvePublicTarget, connectTarget = connectPinned } = options;
  const sockets = new Set<Socket>();
  const trackSocket = (socket: Socket): Socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    if (budget.signal.aborted) socket.destroy();
    return socket;
  };
  const abortConnections = () => {
    for (const socket of sockets) socket.destroy();
  };
  budget.signal.addEventListener("abort", abortConnections, { once: true });
  const server = createServer((request, response) => {
    void proxyHttp(request, response, resolveTarget, connectTarget, budget, trackSocket);
  });
  server.on("connect", (request, socket, head) => {
    void proxyTunnel(request.url ?? "", socket, head, resolveTarget, connectTarget, budget, trackSocket);
  });
  server.on("upgrade", (_request, socket) => socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"));
  server.on("connection", trackSocket);
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
        budget.signal.removeEventListener("abort", abortConnections);
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
  budget: EgressTransferBudget,
  trackSocket: (socket: Socket) => Socket,
): Promise<void> {
  try {
    budget.assertAvailable();
    if (!request.url) throw new UnsafeUrlError();
    const target = await resolveTarget(request.url);
    if (target.url.protocol !== "http:") throw new UnsafeUrlError();
    const socket = trackSocket(await connectTarget(target.addresses, Number(target.url.port || 80)));
    const agent = new Agent({ keepAlive: false });
    agent.createConnection = () => socket;
    const headers: IncomingHttpHeaders = { ...request.headers, host: target.url.host };
    delete headers["proxy-authorization"];
    const upstream = httpRequest({ method: request.method, path: `${target.url.pathname}${target.url.search}`, headers, agent });
    upstream.setTimeout(10_000, () => upstream.destroy());
    upstream.on("response", (source) => {
      const meter = budget.openResponse(parseContentLength(source.headers["content-length"]));
      source.on("data", (chunk) => meter.add(chunkBytes(chunk)));
      response.writeHead(source.statusCode ?? 502, source.headers);
      source.pipe(response);
    });
    upstream.on("error", () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    request.on("data", (chunk) => budget.addTransferredBytes(chunkBytes(chunk)));
    request.pipe(upstream);
  } catch {
    if (!response.destroyed && !response.headersSent)
      response.writeHead(budget.signal.aborted ? 502 : 403, { connection: "close" }).end("Blocked by WidthWatch egress policy.");
  }
}

async function proxyTunnel(
  authority: string,
  client: Duplex,
  head: Buffer,
  resolveTarget: EgressTargetResolver,
  connectTarget: EgressConnector,
  budget: EgressTransferBudget,
  trackSocket: (socket: Socket) => Socket,
): Promise<void> {
  try {
    budget.assertAvailable();
    const url = new URL(`https://${authority}`);
    if (Number(url.port || 443) !== 443 || url.username || url.password || url.pathname !== "/") throw new UnsafeUrlError();
    const target = await resolveTarget(url.toString());
    const upstream = trackSocket(await connectTarget(target.addresses, 443));
    const meter = budget.openTunnel();
    if (head.length && !meter.add(head.length)) throw budget.error;
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) upstream.write(head);
    client.on("data", (chunk) => meter.add(chunkBytes(chunk)));
    upstream.on("data", (chunk) => meter.add(chunkBytes(chunk)));
    upstream.pipe(client);
    client.pipe(upstream);
    upstream.setTimeout(12_000, () => upstream.destroy());
    client.once("close", () => upstream.destroy());
    upstream.once("close", () => client.destroy());
  } catch {
    if (!client.destroyed) client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
  }
}

function parseContentLength(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function chunkBytes(chunk: unknown): number {
  if (Buffer.isBuffer(chunk)) return chunk.length;
  if (typeof chunk === "string") return Buffer.byteLength(chunk);
  return Buffer.byteLength(String(chunk));
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
