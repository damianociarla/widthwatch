import assert from "node:assert/strict";
import { createServer } from "node:http";
import { request } from "node:http";
import test from "node:test";
import { scanResponsive } from "widthwatch";
import { EgressBudgetExceededError } from "../dist/egress-budget.js";
import { createHostedScanRunner, hostedScanConfig } from "../dist/hosted-scan.js";

function report(url) {
  return {
    version: 1,
    url,
    title: "Hosted fixture",
    scannedAt: new Date(0).toISOString(),
    durationMs: 1,
    range: { min: 320, max: 320, height: 800 },
    frames: [],
    transitions: [],
    summary: { errors: 0, warnings: 0, info: 0, sampledWidths: 0 },
  };
}

async function listen(t, server) {
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
  return address.port;
}

function requestThroughProxy(proxyUrl, targetUrl) {
  const proxy = new URL(proxyUrl);
  return new Promise((resolve, reject) => {
    const outgoing = request({ hostname: proxy.hostname, port: proxy.port, path: targetUrl, headers: { host: new URL(targetUrl).host } }, (response) => {
      response.resume();
      response.once("end", resolve);
      response.once("error", reject);
    });
    outgoing.once("error", reject);
    outgoing.end();
  });
}

test("hosted scan config exposes explicit byte defaults and environment overrides", () => {
  assert.deepEqual(hostedScanConfig({}), {
    maxBytesPerResponse: 10 * 1024 * 1024,
    maxBytesPerTunnel: 25 * 1024 * 1024,
    maxTransferredBytes: 75 * 1024 * 1024,
  });
  assert.deepEqual(hostedScanConfig({ MAX_BYTES_PER_RESPONSE: "10", MAX_BYTES_PER_TUNNEL: "20", MAX_TRANSFERRED_BYTES: "30" }), {
    maxBytesPerResponse: 10,
    maxBytesPerTunnel: 20,
    maxTransferredBytes: 30,
  });
});

test("bounded egress sessions abort an oversized job and give the next job a fresh allowance", async (t) => {
  const upstreamPort = await listen(
    t,
    createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.write("123456");
      response.end("abcdef");
    }),
  );
  const signals = [];
  let calls = 0;
  const run = createHostedScanRunner(
    {
      resolveTarget: async (value) => ({ url: new URL(value), addresses: ["127.0.0.1"] }),
      scan: async (url, options) => {
        signals.push(options.signal);
        calls += 1;
        if (calls === 1) {
          const transfer = requestThroughProxy(options.proxyServer, `http://public.example:${upstreamPort}/chunked`).catch(() => undefined);
          if (!options.signal.aborted) await new Promise((resolve) => options.signal.addEventListener("abort", resolve, { once: true }));
          await transfer;
          throw options.signal.reason;
        }
        assert.equal(options.signal.aborted, false);
        return report(url);
      },
    },
    { maxBytesPerResponse: 10, maxBytesPerTunnel: 20, maxTransferredBytes: 30 },
  );

  await assert.rejects(
    () => run("https://first.example/", {}),
    (error) => error instanceof EgressBudgetExceededError && error.scope === "response",
  );
  const successful = await run("https://second.example/", {});
  assert.equal(successful.url, "https://second.example/");
  assert.notEqual(signals[0], signals[1]);
  assert.equal(signals[0].aborted, true);
  assert.equal(signals[1].aborted, false);
});

test("bounded egress sessions preserve external cancellation and connector adapters", async () => {
  const reason = new Error("caller cancelled");
  const controller = new AbortController();
  controller.abort(reason);
  const connector = async () => {
    throw new Error("unused connector");
  };
  const run = createHostedScanRunner(
    {
      resolveTarget: async (value) => ({ url: new URL(value), addresses: ["127.0.0.1"] }),
      connectTarget: connector,
      scan: async (_url, options) => {
        assert.equal(options.signal.aborted, true);
        assert.equal(options.signal.reason, reason);
        throw options.signal.reason;
      },
    },
    { maxBytesPerResponse: 10, maxBytesPerTunnel: 20, maxTransferredBytes: 30 },
  );
  await assert.rejects(
    () => run("https://cancelled.example/", { signal: controller.signal }),
    (error) => error === reason,
  );
});

test("a bounded egress session aborts a real Chromium scan when chunked HTML exceeds its allowance", async (t) => {
  const upstreamPort = await listen(
    t,
    createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.write("<!doctype html><title>oversized</title>");
      response.end("x".repeat(100));
    }),
  );
  const run = createHostedScanRunner(
    {
      scan: scanResponsive,
      resolveTarget: async (value) => {
        const url = new URL(value);
        assert.equal(url.hostname, "public.example");
        return { url, addresses: ["127.0.0.1"] };
      },
    },
    { maxBytesPerResponse: 64, maxBytesPerTunnel: 128, maxTransferredBytes: 256 },
  );
  await assert.rejects(
    () =>
      run(`http://public.example:${upstreamPort}/`, {
        mode: "layout",
        exactWidths: [320],
        viewportHeight: 480,
        settleMs: 0,
        timeoutMs: 5_000,
      }),
    (error) => error instanceof EgressBudgetExceededError && error.scope === "response",
  );
});
