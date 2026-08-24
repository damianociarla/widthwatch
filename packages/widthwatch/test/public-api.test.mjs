import assert from "node:assert/strict";
import test from "node:test";
import { generateHtmlReport } from "../dist/index.js";

test("native reporter embeds a versioned report safely", () => {
  const report = { version: 1, url: "https://example.com/?q=<script>", title: "Example", scannedAt: new Date(0).toISOString(), durationMs: 1, range: { min: 320, max: 1440, height: 800 }, environment: { browser: "test", platform: "test", packageVersion: "0.1.0" }, frames: [{ width: 320, height: 800, document: { width: 320, height: 800 }, layoutSignature: "x", issues: [], screenshot: "data:image/png;base64,", durationMs: 1 }], transitions: [], summary: { errors: 0, warnings: 0, info: 0, sampledWidths: 1 } };
  const html = generateHtmlReport(report);
  assert.match(html, /widthwatch/i);
  assert.doesNotMatch(html, /<script>[^]*<script>/);
  assert.match(html, /\\u003cscript>/);
});

test("comparison reporter omits a misleading diff control when no diff image exists", () => {
  const report = { version: 1, url: "https://example.com/", title: "Example", scannedAt: new Date(0).toISOString(), durationMs: 1, range: { min: 320, max: 320, height: 800 }, environment: { browser: "test", platform: "test", packageVersion: "0.1.0" }, frames: [{ width: 320, height: 800, document: { width: 320, height: 800 }, layoutSignature: "x", issues: [], screenshot: "data:image/png;base64,", durationMs: 1 }], transitions: [], summary: { errors: 0, warnings: 0, info: 0, sampledWidths: 1 } };
  const comparison = { version: 1, baseline: report, candidate: report, diffs: [], regressions: [], valid: false, validationErrors: [{ code: "environment-mismatch", message: "Rendering environments differ." }], passed: false };
  const html = generateHtmlReport(comparison);
  assert.match(html, /comparison invalid/);
  assert.match(html, /Rendering environments differ/);
  assert.match(html, /data-view="baseline"/);
  assert.match(html, /data-view="candidate"/);
  assert.doesNotMatch(html, /data-view="diff"/);
  assert.match(html, /Diff image not generated/);
  assert.match(html, /First regression|comparison invalid/);
});

test("comparison reporter exposes the diff control only for generated diff evidence", () => {
  const frame = { width: 320, height: 800, document: { width: 320, height: 800 }, layoutSignature: "x", issues: [], screenshot: "data:image/png;base64,", durationMs: 1 };
  const report = { version: 1, url: "https://example.com/", title: "Example", scannedAt: new Date(0).toISOString(), durationMs: 1, range: { min: 320, max: 320, height: 800 }, environment: { browser: "test", platform: "test", packageVersion: "0.2.3" }, frames: [frame], transitions: [], summary: { errors: 0, warnings: 0, info: 0, sampledWidths: 1 } };
  const comparison = { version: 1, baseline: report, candidate: report, diffs: [{ width: 320, changedPixels: 1, ratio: 0.1, diffScreenshot: "data:image/png;base64,AA==" }], regressions: [], valid: true, validationErrors: [], passed: true };
  assert.match(generateHtmlReport(comparison), /data-view="diff"/);
});
