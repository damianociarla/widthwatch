import assert from "node:assert/strict";
import test from "node:test";
import { PNG } from "pngjs";
import { compareReports } from "../dist/compare.js";

function screenshot(width = 2, height = 2, value = 0) {
  const png = new PNG({ width, height });
  png.data.fill(value);
  return `data:image/png;base64,${PNG.sync.write(png).toString("base64")}`;
}

function report(widths, overrides = {}) {
  const frames = widths.map((width) => ({
    width,
    height: 800,
    document: { width, height: 1000 },
    layoutSignature: "stable",
    issues: [],
    screenshot: screenshot(),
    durationMs: 1,
  }));
  return {
    version: 1,
    url: "https://example.com/",
    title: "Fixture",
    scannedAt: "2026-08-24T00:00:00.000Z",
    durationMs: 1,
    range: { min: Math.min(...widths), max: Math.max(...widths), height: 800 },
    environment: { browser: "Chromium 1", platform: "linux", packageVersion: "0.1.0" },
    capture: { mode: "visual", screenshot: "full-page", scrollSweep: true, reloadPerWidth: false, pageReady: false, readinessKey: null },
    frames,
    transitions: [],
    summary: { errors: 0, warnings: 0, info: 0, sampledWidths: frames.length },
    ...overrides,
  };
}

test("identical complete schedules produce a valid passing comparison", () => {
  const comparison = compareReports(report([320, 768]), report([320, 768]));
  assert.equal(comparison.valid, true);
  assert.equal(comparison.passed, true);
  assert.equal(comparison.diffs.length, 2);
  assert.deepEqual(comparison.validationErrors, []);
});

test("missing and unexpected widths fail closed", () => {
  const comparison = compareReports(report([320]), report([321]));
  assert.equal(comparison.valid, false);
  assert.equal(comparison.passed, false);
  assert.deepEqual(comparison.validationErrors.map((error) => error.code), ["range-mismatch", "missing-candidate-frame", "unexpected-candidate-frame"]);
});

test("different PNG dimensions fail closed", () => {
  const baseline = report([320]);
  const candidate = report([320]);
  candidate.frames[0].screenshot = screenshot(3, 2);
  const comparison = compareReports(baseline, candidate);
  assert.equal(comparison.valid, false);
  assert.equal(comparison.passed, false);
  assert.equal(comparison.validationErrors[0].code, "image-dimensions-mismatch");
});

test("different rendering environments fail closed", () => {
  const baseline = report([320]);
  const candidate = report([320], { environment: { browser: "Chromium 2", platform: "linux", packageVersion: "0.1.0" } });
  const comparison = compareReports(baseline, candidate);
  assert.equal(comparison.valid, false);
  assert.equal(comparison.passed, false);
  assert.equal(comparison.validationErrors[0].code, "environment-mismatch");
});

test("different capture modes fail closed", () => {
  const baseline = report([320]);
  const candidate = report([320], { capture: { mode: "layout", screenshot: "viewport", scrollSweep: false, reloadPerWidth: false, pageReady: false, readinessKey: null } });
  const comparison = compareReports(baseline, candidate);
  assert.equal(comparison.valid, false);
  assert.equal(comparison.passed, false);
  assert.equal(comparison.validationErrors[0].code, "capture-mismatch");
});

test("different readiness keys fail closed", () => {
  const baseline = report([320], { capture: { mode: "visual", screenshot: "full-page", scrollSweep: true, reloadPerWidth: true, pageReady: true, readinessKey: "ready-v1" } });
  const candidate = report([320], { capture: { mode: "visual", screenshot: "full-page", scrollSweep: true, reloadPerWidth: true, pageReady: true, readinessKey: "ready-v2" } });
  const comparison = compareReports(baseline, candidate);
  assert.equal(comparison.valid, false);
  assert.match(comparison.validationErrors[0].message, /readinessKey/);
});
