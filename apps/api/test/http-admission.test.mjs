import assert from "node:assert/strict";
import test from "node:test";
import { createHttpAdmissionServer, httpAdmissionConfig } from "../dist/http-admission.js";
import { UnsafeUrlError } from "../dist/network-policy.js";

function report(url = "https://example.com/") {
  return {
    version: 1,
    url,
    title: "HTTP fixture",
    scannedAt: new Date(0).toISOString(),
    durationMs: 1,
    range: { min: 320, max: 320, height: 800 },
    environment: { browser: "test", platform: "test", packageVersion: "0.4.7" },
    frames: [
      {
        width: 320,
        height: 800,
        document: { width: 320, height: 800 },
        layoutSignature: "fixture",
        issues: [],
        screenshot: "data:image/jpeg;base64,",
        durationMs: 1,
      },
    ],
    transitions: [],
    summary: { errors: 0, warnings: 0, info: 0, sampledWidths: 1 },
  };
}

async function fixture(t, options = {}) {
  const scans = [];
  const events = [];
  const stored = new Map();
  let ids = 0;
  const adapters = {
    scan: async (url, scanOptions) => {
      scans.push({ url, scanOptions });
      return report(url);
    },
    acceptTarget: async (value) => {
      if (value === "unsafe.test") throw new UnsafeUrlError();
      return new URL(/^https?:\/\//.test(value) ? value : `https://${value}`);
    },
    allowResource: async () => true,
    reports: {
      get: async (id) => stored.get(id),
      put: async (id, html) => void stored.set(id, html),
    },
    createId: () => `abc-${++ids}`,
    now: () => Date.now(),
    onOperationalEvent: (event) => events.push(event),
    ...options.adapters,
  };
  const config = {
    ...httpAdmissionConfig({}),
    allowedOrigins: new Set(["https://allowed.example"]),
    initialResponseWaitMs: 500,
    pruneIntervalMs: 60_000,
    ...options.config,
  };
  const server = createHttpAdmissionServer(adapters, config);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(
    () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { origin: `http://127.0.0.1:${address.port}`, scans, stored, events };
}

async function post(origin, body, headers = {}) {
  return fetch(`${origin}/v1/scans`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body }),
  });
}

test("HTTP admission classifies empty and malformed JSON as client errors", async (t) => {
  const { origin } = await fixture(t);
  for (const body of [undefined, "{not-json}"]) {
    const response = await post(origin, body);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid_json" });
  }
});

test("HTTP admission enforces the request body byte limit", async (t) => {
  const { origin } = await fixture(t);
  const response = await post(origin, JSON.stringify({ url: "x".repeat(2_100) }));
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: "payload_too_large" });
});

test("HTTP admission distinguishes invalid URL shapes and unsafe targets", async (t) => {
  const { origin } = await fixture(t);
  for (const body of [{ url: 123 }, null, [], { missing: "url" }]) {
    const invalid = await post(origin, JSON.stringify(body));
    assert.equal(invalid.status, 400);
    assert.deepEqual(await invalid.json(), { error: "invalid_url" });
  }
  const unsafe = await post(origin, JSON.stringify({ url: "unsafe.test" }));
  assert.equal(unsafe.status, 400);
  assert.deepEqual(await unsafe.json(), { error: "unsafe_url" });
});

test("HTTP admission exposes health without the private origin token", async (t) => {
  const { origin } = await fixture(t, { config: { originToken: "secret" } });
  const response = await fetch(`${origin}/health`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
});

test("HTTP admission hides scan routes when the private origin token is absent", async (t) => {
  const { origin, scans } = await fixture(t, { config: { originToken: "secret" } });
  const hidden = await post(origin, JSON.stringify({ url: "example.com" }));
  assert.equal(hidden.status, 404);
  assert.deepEqual(await hidden.json(), { error: "not_found" });
  assert.equal(scans.length, 0);

  const accepted = await post(origin, JSON.stringify({ url: "example.com" }), { "x-widthwatch-origin": "secret" });
  assert.equal(accepted.status, 202);
  assert.equal((await accepted.json()).status, "complete");
});

test("HTTP admission applies CORS only to configured origins", async (t) => {
  const { origin } = await fixture(t, { config: { originToken: "secret" } });
  const allowed = await fetch(`${origin}/v1/scans`, { method: "OPTIONS", headers: { origin: "https://allowed.example" } });
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get("access-control-allow-origin"), "https://allowed.example");
  assert.equal(allowed.headers.get("vary"), "origin");

  const denied = await fetch(`${origin}/v1/scans`, { method: "OPTIONS", headers: { origin: "https://denied.example" } });
  assert.equal(denied.status, 204);
  assert.equal(denied.headers.get("access-control-allow-origin"), null);
});

test("HTTP admission runs a scan, emits completion telemetry and serves a protected report", async (t) => {
  const { origin, scans, events } = await fixture(t);
  const accepted = await post(origin, JSON.stringify({ url: "example.com" }), { "cloudfront-viewer-address": "203.0.113.1:443" });
  assert.equal(accepted.status, 202);
  const body = await accepted.json();
  assert.equal(body.status, "complete");
  assert.equal(body.pollUrl, "/v1/scans/abc-1");
  assert.equal(scans.length, 1);
  assert.equal(scans[0].scanOptions.maxSamples, 5);
  assert.equal(scans[0].scanOptions.proxyServer, undefined);

  const status = await fetch(`${origin}${body.pollUrl}`);
  assert.equal(status.status, 200);
  assert.equal((await status.json()).reportUrl, "/v1/reports/abc-1");

  const reportResponse = await fetch(`${origin}/v1/reports/abc-1`);
  assert.equal(reportResponse.status, 200);
  assert.match(reportResponse.headers.get("content-security-policy"), /default-src 'none'/);
  assert.equal(reportResponse.headers.get("cache-control"), "private, no-store");
  assert.equal(reportResponse.headers.get("x-robots-tag"), "noindex, nofollow, noarchive");
  assert.match(await reportResponse.text(), /WidthWatch/);
  assert.deepEqual(events, [
    {
      event: "hosted_scan_completed",
      jobId: "abc-1",
      durationMs: events[0].durationMs,
      queueMs: events[0].queueMs,
      scanMs: events[0].scanMs,
      reportMs: events[0].reportMs,
      probes: 1,
      captures: 1,
    },
  ]);
});

test("HTTP admission returns not-found and report-unavailable status codes", async (t) => {
  const { origin } = await fixture(t, {
    adapters: {
      reports: {
        get: async () => {
          throw new Error("storage outage");
        },
        put: async () => {},
      },
    },
  });
  assert.equal((await fetch(`${origin}/v1/scans/dead-beef`)).status, 404);
  const unavailable = await fetch(`${origin}/v1/reports/dead-beef`);
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { error: "report_unavailable" });
  assert.equal((await fetch(`${origin}/missing`)).status, 404);
});

test("persisted reports retain the bearer-link noindex and no-store policy", async (t) => {
  const { origin, stored } = await fixture(t);
  stored.set("dead-beef", "<!doctype html><title>Persisted report</title>");
  const response = await fetch(`${origin}/v1/reports/dead-beef`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow, noarchive");
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.match(await response.text(), /Persisted report/);
});

test("HTTP admission rate limits atomically and emits a redacted rejection", async (t) => {
  const { origin, events } = await fixture(t, { config: { clientLimit: 1, targetLimit: 10, globalLimit: 10 } });
  const headers = { "cloudfront-viewer-address": "203.0.113.2:443" };
  assert.equal((await post(origin, JSON.stringify({ url: "example.com" }), headers)).status, 202);
  const limited = await post(origin, JSON.stringify({ url: "example.com" }), headers);
  assert.equal(limited.status, 429);
  assert.deepEqual(await limited.json(), { error: "rate_limited", retryAfterSeconds: 600 });
  assert.deepEqual(events.at(-1), { event: "hosted_scan_rejected", rejectionCode: "rate_limit" });
});

test("HTTP admission enforces retained-job capacity and emits a redacted rejection", async (t) => {
  const { origin, scans, events } = await fixture(t, { config: { maxJobs: 1, clientLimit: 10, targetLimit: 10, globalLimit: 10 } });
  assert.equal((await post(origin, JSON.stringify({ url: "one.example" }))).status, 202);
  const full = await post(origin, JSON.stringify({ url: "two.example" }));
  assert.equal(full.status, 503);
  assert.deepEqual(await full.json(), { error: "capacity_reached" });
  assert.equal(scans.length, 1);
  assert.deepEqual(events.at(-1), { event: "hosted_scan_rejected", rejectionCode: "capacity_limit" });
});

test("HTTP admission exposes safe failure codes and sends one redacted job outcome", async (t) => {
  const raw = new Error("total request budget exceeded for https://secret.example/?token=private");
  const { origin, events } = await fixture(t, {
    adapters: {
      scan: async () => {
        throw raw;
      },
    },
  });
  const response = await post(origin, JSON.stringify({ url: "public.example" }));
  assert.equal(response.status, 202);
  const body = await response.json();
  assert.deepEqual(
    { status: body.status, error: body.error, failureCode: body.failureCode },
    { status: "failed", error: "The bounded scan could not complete.", failureCode: "request_limit" },
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].jobId, "abc-1");
  assert.equal(events[0].phase, "scan");
  assert.equal(JSON.stringify(events).includes("secret.example"), false);
  assert.equal(JSON.stringify(events).includes("private"), false);
});

test("telemetry failures never change job state or stop the queue", async (t) => {
  let calls = 0;
  const { origin } = await fixture(t, {
    config: { clientLimit: 10, targetLimit: 10, globalLimit: 10 },
    adapters: {
      scan: async (url) => {
        calls += 1;
        if (calls === 1) throw new Error("browser crashed");
        return report(url);
      },
      onOperationalEvent: () => {
        throw new Error("telemetry unavailable");
      },
    },
  });
  const first = await (await post(origin, JSON.stringify({ url: "first.example" }))).json();
  const second = await (await post(origin, JSON.stringify({ url: "second.example" }))).json();
  assert.equal(first.failureCode, "browser_failure");
  assert.equal(second.status, "complete");
  assert.equal(calls, 2);
});

test("report generation failures are classified in the report phase", async (t) => {
  const { origin, events } = await fixture(t, {
    adapters: {
      scan: async () => null,
    },
  });
  const body = await (await post(origin, JSON.stringify({ url: "public.example" }))).json();
  assert.equal(body.failureCode, "internal_failure");
  assert.equal(events[0].phase, "report");
});
