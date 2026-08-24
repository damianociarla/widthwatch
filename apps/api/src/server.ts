import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { generateHtmlReport, scanResponsive, type WidthWatchReport } from "widthwatch";
import { startPinnedEgressProxy } from "./egress-proxy.js";
import { assertPublicUrl, resolvePublicTarget, UnsafeUrlError } from "./network-policy.js";
import { holdConnectionUntilSettled, scanStatusPayload, type HostedScanStatus } from "./scan-response.js";
import { consumeRateLimits, SlidingWindowLimiter } from "./security.js";

type Job = { id: string; url: string; createdAt: number; status: HostedScanStatus; report?: WidthWatchReport; error?: string };
const jobs = new Map<string, Job>();
const queue: Job[] = [];
const clientLimit = new SlidingWindowLimiter(Number(process.env.RATE_LIMIT_PER_10_MINUTES ?? 2), 600_000);
const targetLimit = new SlidingWindowLimiter(Number(process.env.TARGET_RATE_LIMIT_PER_HOUR ?? 2), 3_600_000);
const globalLimit = new SlidingWindowLimiter(Number(process.env.GLOBAL_RATE_LIMIT_PER_HOUR ?? 30), 3_600_000);
const allowedOrigins = new Set((process.env.ALLOWED_ORIGINS ?? "https://damianociarla.github.io,http://localhost:5173").split(","));
const originToken = process.env.ORIGIN_VERIFY_TOKEN ?? "";
const proxy = await startPinnedEgressProxy();
let running = false;

const server = createServer(async (request, response) => {
  setCors(request, response);
  if (request.method === "OPTIONS") return void response.writeHead(204).end();
  if (request.url === "/health" && request.method === "GET") return json(response, 200, { ok: true, version: "0.1.0" });
  if (!validOriginToken(request)) return json(response, 404, { error: "not_found" });
  if (request.url === "/v1/scans" && request.method === "POST") return void createScan(request, response);
  const match = request.method === "GET" ? request.url?.match(/^\/v1\/scans\/([a-f0-9-]+)$/) : null;
  if (match?.[1]) return void getScan(match[1], response);
  const reportMatch = request.method === "GET" ? request.url?.match(/^\/v1\/reports\/([a-f0-9-]+)$/) : null;
  if (reportMatch?.[1]) return void getReport(reportMatch[1], response);
  return json(response, 404, { error: "not_found" });
});

async function createScan(request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    const body = await readJson(request, 2_048) as { url?: unknown };
    if (typeof body.url !== "string" || body.url.length > 2_000) return json(response, 400, { error: "invalid_url" });
    const target = await assertPublicUrl(body.url);
    const client = clientAddress(request);
    if (queue.length >= 3 || jobs.size >= 50) return json(response, 503, { error: "capacity_reached" });
    if (!consumeRateLimits([{ limiter: clientLimit, key: client }, { limiter: targetLimit, key: target.hostname }, { limiter: globalLimit, key: "global" }])) return json(response, 429, { error: "rate_limited", retryAfterSeconds: 600 });
    const job: Job = { id: randomUUID(), url: target.toString(), createdAt: Date.now(), status: "queued" };
    jobs.set(job.id, job); queue.push(job); void drain();
    response.writeHead(202, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    response.write("\n");
    await holdConnectionUntilSettled(
      job,
      Number(process.env.INITIAL_RESPONSE_WAIT_MS ?? 55_000),
      () => { if (!response.destroyed && !response.writableEnded) response.write(" \n"); },
    );
    if (!response.destroyed && !response.writableEnded) response.end(JSON.stringify({ ...scanStatusPayload(job), pollUrl: `/v1/scans/${job.id}` }));
  } catch (error) {
    if (!response.headersSent) json(response, error instanceof UnsafeUrlError ? 400 : 500, { error: error instanceof UnsafeUrlError ? "unsafe_url" : "internal_error" });
    else if (!response.destroyed && !response.writableEnded) response.end(JSON.stringify({ error: "internal_error" }));
  }
}

function getScan(id: string, response: ServerResponse): void {
  const job = jobs.get(id);
  if (!job) return json(response, 404, { error: "not_found" });
  json(response, 200, scanStatusPayload(job));
}

function getReport(id: string, response: ServerResponse): void {
  const job = jobs.get(id);
  if (!job?.report || job.status !== "complete") return json(response, 404, { error: "not_found" });
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "private, max-age=60",
    "content-security-policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  }).end(generateHtmlReport(job.report));
}

async function drain(): Promise<void> {
  if (running) return; running = true;
  while (queue.length) {
    const job = queue.shift()!; job.status = "running";
    try {
      job.report = await scanResponsive(job.url, {
        minWidth: 320, maxWidth: 1440, viewportHeight: 800, initialStep: 224, minStep: 24, maxSamples: 8,
        maxElements: 350, timeoutMs: 15_000, settleMs: 80, maxRequests: 250, blockResourceTypes: ["media", "websocket"],
        proxyServer: proxy.url, allowedUrl: async (url) => resolvePublicTarget(url).then(() => true, () => false),
      });
      job.status = "complete";
    } catch { job.status = "failed"; job.error = "The bounded scan could not complete."; }
  }
  running = false;
}

function setCors(request: IncomingMessage, response: ServerResponse): void {
  const origin = request.headers.origin;
  if (origin && allowedOrigins.has(origin)) response.setHeader("access-control-allow-origin", origin);
  response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS"); response.setHeader("access-control-allow-headers", "content-type"); response.setHeader("vary", "origin");
}
function validOriginToken(request: IncomingMessage): boolean {
  if (!originToken) return true;
  const provided = request.headers["x-widthwatch-origin"];
  if (typeof provided !== "string") return false;
  const expected = Buffer.from(originToken); const actual = Buffer.from(provided);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
function clientAddress(request: IncomingMessage): string { const value = request.headers["cloudfront-viewer-address"] ?? request.headers["x-forwarded-for"]; return typeof value === "string" ? value.split(",")[0]!.replace(/:\d+$/, "") : request.socket.remoteAddress ?? "unknown"; }
async function readJson(request: IncomingMessage, limit: number): Promise<unknown> { let body = ""; for await (const chunk of request) { body += String(chunk); if (body.length > limit) throw new Error("Body too large"); } return JSON.parse(body); }
function json(response: ServerResponse, status: number, body: unknown): void { response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }).end(JSON.stringify(body)); }

const port = Number(process.env.PORT ?? 8080);
server.listen(port, "0.0.0.0", () => console.log(`WidthWatch API listening on ${port}`));
const cleanup = () => { server.close(() => void proxy.close().finally(() => process.exit(0))); };
process.on("SIGTERM", cleanup); process.on("SIGINT", cleanup);
setInterval(() => { const cutoff = Date.now() - 30 * 60_000; for (const [id, job] of jobs) if (job.createdAt < cutoff) jobs.delete(id); }, 60_000).unref();
