import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { generateHtmlReport, type ScanOptions, type WidthWatchReport } from "widthwatch";
import { createJobFailureEvent, type JobFailureCode, type JobFailureObserver, type JobFailurePhase } from "./job-outcome.js";
import { UnsafeUrlError } from "./network-policy.js";
import { holdConnectionUntilSettled, scanStatusPayload, type HostedScanStatus } from "./scan-response.js";
import { persistReportBestEffort, type ReportStore } from "./report-store.js";
import { consumeRateLimits, SlidingWindowLimiter } from "./security.js";
import { API_VERSION } from "./version.js";

type Job = {
  id: string;
  url: string;
  createdAt: number;
  status: HostedScanStatus;
  report?: WidthWatchReport;
  reportHtml?: string;
  error?: string;
  failureCode?: JobFailureCode;
};

export interface HttpAdmissionAdapters {
  scan(url: string, options: ScanOptions): Promise<WidthWatchReport>;
  acceptTarget(value: string): Promise<URL>;
  allowResource(value: string): Promise<boolean>;
  reports: Pick<ReportStore, "get" | "put">;
  createId(): string;
  now(): number;
  onJobFailed: JobFailureObserver;
}

export interface HttpAdmissionConfig {
  allowedOrigins: ReadonlySet<string>;
  originToken: string;
  clientLimit: number;
  targetLimit: number;
  globalLimit: number;
  initialResponseWaitMs: number;
  maxQueuedJobs: number;
  maxJobs: number;
  retentionMs: number;
  pruneIntervalMs: number;
}

export class InvalidJsonError extends Error {
  constructor() {
    super("Request body must contain valid JSON.");
    this.name = "InvalidJsonError";
  }
}

export class PayloadTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`Request body exceeds ${limit} bytes.`);
    this.name = "PayloadTooLargeError";
  }
}

export function createHttpAdmissionServer(adapters: HttpAdmissionAdapters, config: HttpAdmissionConfig): Server {
  const jobs = new Map<string, Job>();
  const queue: Job[] = [];
  const clientLimit = new SlidingWindowLimiter(config.clientLimit, 600_000);
  const targetLimit = new SlidingWindowLimiter(config.targetLimit, 3_600_000);
  const globalLimit = new SlidingWindowLimiter(config.globalLimit, 3_600_000);
  let running = false;

  const server = createServer((request, response) => {
    void route(request, response).catch((error) => {
      if (!response.headersSent) return json(response, 500, { error: "internal_error" });
      if (!response.destroyed && !response.writableEnded) response.destroy(error instanceof Error ? error : undefined);
    });
  });

  const pruneTimer = setInterval(() => {
    const cutoff = adapters.now() - config.retentionMs;
    for (const [id, job] of jobs) if (job.createdAt < cutoff) jobs.delete(id);
  }, config.pruneIntervalMs);
  pruneTimer.unref();
  server.once("close", () => clearInterval(pruneTimer));
  return server;

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    setCors(request, response, config.allowedOrigins);
    if (request.method === "OPTIONS") return void response.writeHead(204).end();
    if (request.url === "/health" && request.method === "GET") return json(response, 200, { ok: true, version: API_VERSION });
    if (!validOriginToken(request, config.originToken)) return json(response, 404, { error: "not_found" });
    if (request.url === "/v1/scans" && request.method === "POST") return createScan(request, response);
    const match = request.method === "GET" ? request.url?.match(/^\/v1\/scans\/([a-f0-9-]+)$/) : null;
    if (match?.[1]) return getScan(match[1], response);
    const reportMatch = request.method === "GET" ? request.url?.match(/^\/v1\/reports\/([a-f0-9-]+)$/) : null;
    if (reportMatch?.[1]) return getReport(reportMatch[1], response);
    return json(response, 404, { error: "not_found" });
  }

  async function createScan(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const body = await readJson(request, 2_048);
      if (!body || typeof body !== "object" || Array.isArray(body) || typeof (body as { url?: unknown }).url !== "string")
        return json(response, 400, { error: "invalid_url" });
      const url = (body as { url: string }).url;
      if (url.length > 2_000) return json(response, 400, { error: "invalid_url" });
      const target = await adapters.acceptTarget(url);
      const client = clientAddress(request);
      if (queue.length >= config.maxQueuedJobs || jobs.size >= config.maxJobs) return json(response, 503, { error: "capacity_reached" });
      if (
        !consumeRateLimits([
          { limiter: clientLimit, key: client },
          { limiter: targetLimit, key: target.hostname },
          { limiter: globalLimit, key: "global" },
        ])
      )
        return json(response, 429, { error: "rate_limited", retryAfterSeconds: 600 });
      const job: Job = { id: adapters.createId(), url: target.toString(), createdAt: adapters.now(), status: "queued" };
      jobs.set(job.id, job);
      queue.push(job);
      void drain();
      response.writeHead(202, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.write("\n");
      await holdConnectionUntilSettled(job, config.initialResponseWaitMs, () => {
        if (!response.destroyed && !response.writableEnded) response.write(" \n");
      });
      if (!response.destroyed && !response.writableEnded) response.end(JSON.stringify({ ...scanStatusPayload(job), pollUrl: `/v1/scans/${job.id}` }));
    } catch (error) {
      const mapped = mapAdmissionError(error);
      if (!response.headersSent) json(response, mapped.status, { error: mapped.code });
      else if (!response.destroyed && !response.writableEnded) response.end(JSON.stringify({ error: mapped.code }));
    }
  }

  function getScan(id: string, response: ServerResponse): void {
    const job = jobs.get(id);
    if (!job) {
      json(response, 404, { error: "not_found" });
      return;
    }
    json(response, 200, scanStatusPayload(job));
  }

  async function getReport(id: string, response: ServerResponse): Promise<void> {
    const job = jobs.get(id);
    try {
      const memoryHtml = job?.status === "complete" ? (job.reportHtml ?? (job.report ? generateHtmlReport(job.report) : undefined)) : undefined;
      const html = memoryHtml ?? (await adapters.reports.get(id));
      if (!html) return json(response, 404, { error: "not_found" });
      response
        .writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "private, max-age=60",
          "content-security-policy":
            "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff",
        })
        .end(html);
    } catch {
      json(response, 503, { error: "report_unavailable" });
    }
  }

  async function drain(): Promise<void> {
    if (running) return;
    running = true;
    while (queue.length) {
      const job = queue.shift()!;
      job.status = "running";
      const startedAt = adapters.now();
      let phase: JobFailurePhase = "scan";
      try {
        job.report = await adapters.scan(job.url, {
          mode: "layout",
          imageFormat: "jpeg",
          imageQuality: 70,
          minWidth: 320,
          maxWidth: 1440,
          viewportHeight: 800,
          initialStep: 400,
          minStep: 32,
          maxSamples: 5,
          maxElements: 250,
          maxDomNodes: 2_500,
          timeoutMs: 15_000,
          settleMs: 50,
          maxRequestsPerNavigation: 200,
          maxTotalRequests: 1_000,
          blockResourceTypes: ["media", "websocket"],
          allowedUrl: adapters.allowResource,
        });
        phase = "report";
        job.reportHtml = generateHtmlReport(job.report);
        job.status = "complete";
        void persistReportBestEffort(adapters.reports, job.id, job.reportHtml);
      } catch (error) {
        const outcome = createJobFailureEvent({ jobId: job.id, phase, durationMs: adapters.now() - startedAt, error });
        job.status = "failed";
        job.error = "The bounded scan could not complete.";
        job.failureCode = outcome.failureCode;
        try {
          adapters.onJobFailed(outcome);
        } catch {
          // Telemetry must not change public job state or stop the queue.
        }
      }
    }
    running = false;
  }
}

export function httpAdmissionConfig(env: NodeJS.ProcessEnv = process.env): HttpAdmissionConfig {
  return {
    allowedOrigins: new Set((env.ALLOWED_ORIGINS ?? "https://damianociarla.github.io,http://localhost:5173").split(",")),
    originToken: env.ORIGIN_VERIFY_TOKEN ?? "",
    clientLimit: Number(env.RATE_LIMIT_PER_10_MINUTES ?? 2),
    targetLimit: Number(env.TARGET_RATE_LIMIT_PER_HOUR ?? 2),
    globalLimit: Number(env.GLOBAL_RATE_LIMIT_PER_HOUR ?? 30),
    initialResponseWaitMs: Number(env.INITIAL_RESPONSE_WAIT_MS ?? 55_000),
    maxQueuedJobs: 3,
    maxJobs: 50,
    retentionMs: 30 * 60_000,
    pruneIntervalMs: 60_000,
  };
}

async function readJson(request: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new PayloadTooLargeError(limit);
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new InvalidJsonError();
  }
}

function mapAdmissionError(error: unknown): { status: number; code: string } {
  if (error instanceof PayloadTooLargeError) return { status: 413, code: "payload_too_large" };
  if (error instanceof InvalidJsonError) return { status: 400, code: "invalid_json" };
  if (error instanceof UnsafeUrlError) return { status: 400, code: "unsafe_url" };
  return { status: 500, code: "internal_error" };
}

function setCors(request: IncomingMessage, response: ServerResponse, allowedOrigins: ReadonlySet<string>): void {
  const origin = request.headers.origin;
  if (origin && allowedOrigins.has(origin)) response.setHeader("access-control-allow-origin", origin);
  response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type");
  response.setHeader("vary", "origin");
}

function validOriginToken(request: IncomingMessage, expectedToken: string): boolean {
  if (!expectedToken) return true;
  const provided = request.headers["x-widthwatch-origin"];
  if (typeof provided !== "string") return false;
  const expected = Buffer.from(expectedToken);
  const actual = Buffer.from(provided);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function clientAddress(request: IncomingMessage): string {
  const value = request.headers["cloudfront-viewer-address"] ?? request.headers["x-forwarded-for"];
  return typeof value === "string" ? value.split(",")[0]!.replace(/:\d+$/, "") : (request.socket.remoteAddress ?? "unknown");
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }).end(JSON.stringify(body));
}
