import assert from "node:assert/strict";
import test from "node:test";
import { holdConnectionUntilSettled, scanStatusPayload } from "../dist/scan-response.js";

test("initial response waits for an active scan to settle", async () => {
  const job = { id: "scan-1", status: "running" };
  setTimeout(() => {
    job.status = "complete";
  }, 25);
  await holdConnectionUntilSettled(job, 500);
  assert.equal(job.status, "complete");
});

test("initial response emits heartbeats while a scan is active", async () => {
  const job = { id: "scan-1", status: "running" };
  let heartbeats = 0;
  setTimeout(() => {
    job.status = "complete";
  }, 130);
  await holdConnectionUntilSettled(
    job,
    500,
    () => {
      heartbeats += 1;
    },
    30,
  );
  assert.ok(heartbeats >= 2);
});

test("hosted status excludes screenshot payloads", () => {
  const job = {
    id: "scan-1",
    status: "complete",
    report: {
      version: 1,
      url: "https://example.com/",
      title: "Example",
      scannedAt: "2026-08-24T00:00:00.000Z",
      durationMs: 100,
      range: { min: 320, max: 1440, height: 800 },
      environment: { browser: "Chromium", platform: "test", packageVersion: "0.1.0" },
      probes: [
        {
          width: 640,
          height: 800,
          document: { width: 640, height: 800 },
          layoutSignature: "b",
          issues: [
            {
              id: "secret",
              kind: "clipped-text",
              severity: "error",
              width: 640,
              message: "private text",
              elements: [{ selector: "#private", tagName: "p", rect: { x: 0, y: 0, width: 1, height: 1 } }],
            },
          ],
          durationMs: 1,
        },
      ],
      frames: [
        {
          width: 320,
          height: 800,
          document: { width: 320, height: 800 },
          layoutSignature: "a",
          issues: [],
          screenshot: "data:image/png;base64,large",
          durationMs: 1,
        },
      ],
      transitions: [],
      summary: { errors: 0, warnings: 0, info: 0, sampledWidths: 1 },
    },
  };
  const payload = scanStatusPayload(job);
  assert.equal(JSON.stringify(payload).includes("base64"), false);
  assert.equal(JSON.stringify(payload).includes("#private"), false);
  assert.deepEqual(payload.report.probes, [{ width: 640, severities: ["error"] }]);
  assert.equal(payload.reportUrl, "/v1/reports/scan-1");
});
