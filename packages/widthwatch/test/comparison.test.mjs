import assert from "node:assert/strict";
import test from "node:test";
import { PNG } from "pngjs";
import { compareReports } from "../dist/compare.js";
import { issueIdentity } from "../dist/issue-identity.js";

function screenshot(width = 2, height = 2, value = 0) {
  const png = new PNG({ width, height });
  png.data.fill(value);
  return `data:image/png;base64,${PNG.sync.write(png).toString("base64")}`;
}

function capture(overrides = {}) {
  return {
    protocolVersion: 1,
    mode: "visual",
    screenshot: "full-page",
    imageFormat: "png",
    imageQuality: 80,
    scrollSweep: true,
    maxScrollSteps: 20,
    settleMs: 120,
    reloadPerWidth: false,
    hideSelectors: [],
    deviceScaleFactor: 1,
    colorScheme: "light",
    reducedMotion: "reduce",
    locale: "en-US",
    timezoneId: "UTC",
    pageReady: false,
    readinessKey: null,
    ...overrides,
  };
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
    capture: capture(),
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
  assert.deepEqual(comparison.resolved, []);
  assert.deepEqual(comparison.settings, { threshold: 0.2, maxDiffRatio: 0.001 });
});

test("finding identity is stable across selector order and excludes occurrence metadata", () => {
  const first = {
    id: "first",
    kind: "element-overlap",
    severity: "error",
    width: 480,
    message: "first",
    elements: [
      { selector: "#beta", tagName: "div", rect: { x: 0, y: 0, width: 1, height: 1 } },
      { selector: "#alpha", tagName: "div", rect: { x: 0, y: 0, width: 1, height: 1 } },
    ],
  };
  const second = { ...first, id: "second", width: 960, message: "second", elements: [...first.elements].reverse() };
  assert.equal(issueIdentity(first), issueIdentity(second));
  assert.notEqual(issueIdentity(first), issueIdentity({ ...second, kind: "element-overflow" }));
});

test("comparison reports new, resolved and ranged issues", () => {
  const baseline = report([320, 640]);
  const candidate = report([320, 640]);
  baseline.frames[0].issues = [{ id: "old", kind: "clipped-text", severity: "error", width: 320, message: "old", elements: [{ selector: "#old", tagName: "p", rect: { x: 0, y: 0, width: 1, height: 1 } }] }];
  for (const frame of candidate.frames) frame.issues = [{ id: `new-${frame.width}`, kind: "element-overflow", severity: "warning", width: frame.width, message: "new", elements: [{ selector: "#new", tagName: "p", rect: { x: 0, y: 0, width: 1, height: 1 } }] }];
  const comparison = compareReports(baseline, candidate);
  assert.equal(comparison.regressions.length, 2);
  assert.equal(comparison.resolved.length, 1);
  assert.deepEqual(comparison.regressionRanges.map((range) => [range.from, range.to, range.occurrences]), [[320, 640, 2]]);
});

test("missing and unexpected widths fail closed", () => {
  const comparison = compareReports(report([320]), report([321]));
  assert.equal(comparison.valid, false);
  assert.equal(comparison.passed, false);
  assert.deepEqual(comparison.validationErrors.map((error) => error.code), ["range-mismatch", "probe-schedule-mismatch", "missing-candidate-frame", "unexpected-candidate-frame"]);
});

test("probe schedules fail closed independently from visual evidence schedules", () => {
  const probe = (width) => ({ width, height: 800, document: { width, height: 1000 }, layoutSignature: "stable", issues: [], durationMs: 1 });
  const baseline = report([320, 1120], { probes: [probe(320), probe(640), probe(1120)] });
  const candidate = report([320, 1120], { probes: [probe(320), probe(1120)] });
  const comparison = compareReports(baseline, candidate);
  assert.equal(comparison.valid, false);
  assert.ok(comparison.validationErrors.some((error) => error.code === "probe-schedule-mismatch"));
});

test("probe-only findings remain valid regressions without entering pixel decoding", () => {
  const finding = { id: "probe-only", kind: "clipped-text", severity: "error", width: 640, message: "probe regression", elements: [{ selector: "#probe", tagName: "p", rect: { x: 0, y: 0, width: 20, height: 10 } }], evidence: "discovery" };
  const probe = (width, issues = []) => ({ width, height: 800, document: { width, height: 1000 }, layoutSignature: "stable", issues, durationMs: 1 });
  const baseline = report([320, 1120], { probes: [probe(320), probe(640), probe(1120)], issues: [] });
  const candidate = report([320, 1120], { probes: [probe(320), probe(640, [finding]), probe(1120)], issues: [finding] });
  const comparison = compareReports(baseline, candidate);
  assert.equal(comparison.valid, true);
  assert.equal(comparison.passed, false);
  assert.deepEqual(comparison.regressions, [finding]);
  assert.deepEqual(comparison.regressionRanges.map((range) => [range.from, range.to]), [[640, 640]]);
  assert.equal(comparison.diffs.length, 2);
});

test("probe-only severity escalation is a regression without becoming resolved", () => {
  const finding = (severity) => ({ id: `overlap-${severity}`, kind: "overlap", severity, width: 640, message: severity, elements: [{ selector: "#alpha", tagName: "div", rect: { x: 0, y: 0, width: 20, height: 10 } }, { selector: "#beta", tagName: "div", rect: { x: 10, y: 0, width: 20, height: 10 } }], evidence: "discovery" });
  const probe = (width, issues = []) => ({ width, height: 800, document: { width, height: 1000 }, layoutSignature: "stable", issues, durationMs: 1 });
  const baseline = report([320, 640], { probes: [probe(320), probe(640, [finding("warning")])] });
  const candidate = report([320, 640], { probes: [probe(320), probe(640, [finding("error")])] });
  const comparison = compareReports(baseline, candidate);
  assert.equal(comparison.valid, true);
  assert.equal(comparison.passed, false);
  assert.deepEqual(comparison.regressions, [finding("error")]);
  assert.deepEqual(comparison.escalated, [{ baseline: finding("warning"), candidate: finding("error") }]);
  assert.deepEqual(comparison.resolved, []);
  assert.deepEqual(comparison.deescalated, []);
});

test("severity de-escalation is reported separately from resolved findings", () => {
  const finding = (severity) => ({ id: `clipped-${severity}`, kind: "clipped-text", severity, width: 640, message: severity, elements: [{ selector: "#copy", tagName: "p", rect: { x: 0, y: 0, width: 20, height: 10 } }], evidence: "discovery" });
  const probe = (issues) => ({ width: 640, height: 800, document: { width: 640, height: 1000 }, layoutSignature: "stable", issues, durationMs: 1 });
  const baseline = report([640], { probes: [probe([finding("error")])] });
  const candidate = report([640], { probes: [probe([finding("warning")])] });
  const comparison = compareReports(baseline, candidate);
  assert.equal(comparison.passed, true);
  assert.deepEqual(comparison.regressions, []);
  assert.deepEqual(comparison.resolved, []);
  assert.deepEqual(comparison.deescalated, [{ baseline: finding("error"), candidate: finding("warning") }]);
});

test("optional canonical fallback retains capture-only findings when probes exist", () => {
  const finding = { id: "lazy-capture", kind: "clipped-text", severity: "error", width: 640, message: "lazy", elements: [{ selector: "#lazy", tagName: "p", rect: { x: 0, y: 0, width: 20, height: 10 } }] };
  const probe = { width: 640, height: 800, document: { width: 640, height: 1000 }, layoutSignature: "stable", issues: [], durationMs: 1 };
  const baseline = report([640], { probes: [probe] });
  const candidate = report([640], { probes: [probe] });
  candidate.frames[0].issues = [finding];
  const comparison = compareReports(baseline, candidate);
  assert.equal(comparison.passed, false);
  assert.deepEqual(comparison.regressions, [{ ...finding, evidence: "capture" }]);
});

test("optional canonical fallback lets capture severity prevail over the same probe occurrence", () => {
  const finding = (severity) => ({ id: `overlap-${severity}`, kind: "overlap", severity, width: 640, message: severity, elements: [{ selector: "#same", tagName: "div", rect: { x: 0, y: 0, width: 20, height: 10 } }] });
  const probe = (issue) => ({ width: 640, height: 800, document: { width: 640, height: 1000 }, layoutSignature: "stable", issues: [issue], durationMs: 1 });
  const baseline = report([640], { probes: [probe(finding("warning"))] });
  baseline.frames[0].issues = [finding("warning")];
  const candidate = report([640], { probes: [probe(finding("warning"))] });
  candidate.frames[0].issues = [finding("error")];
  const comparison = compareReports(baseline, candidate);
  assert.equal(comparison.passed, false);
  assert.equal(comparison.escalated.length, 1);
  assert.equal(comparison.escalated[0].candidate.severity, "error");
  assert.equal(comparison.escalated[0].candidate.evidence, "capture");
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

test("package patches do not invalidate an unchanged capture protocol", () => {
  const baseline = report([320]);
  const candidate = report([320], { environment: { ...baseline.environment, packageVersion: "0.2.3" } });
  assert.equal(compareReports(baseline, candidate).valid, true);
});

test("different capture modes fail closed", () => {
  const baseline = report([320]);
  const candidate = report([320], { capture: capture({ mode: "layout", screenshot: "viewport", scrollSweep: false }) });
  const comparison = compareReports(baseline, candidate);
  assert.equal(comparison.valid, false);
  assert.equal(comparison.passed, false);
  assert.equal(comparison.validationErrors[0].code, "capture-mismatch");
});

test("lossy screenshots fail closed for pixel comparison", () => {
  const baseline = report([320]);
  const candidate = report([320]);
  baseline.capture.imageFormat = "jpeg";
  candidate.capture.imageFormat = "jpeg";
  baseline.frames[0].screenshot = "data:image/jpeg;base64,AA==";
  candidate.frames[0].screenshot = "data:image/jpeg;base64,AA==";
  const result = compareReports(baseline, candidate);
  assert.equal(result.valid, false);
  assert.ok(result.validationErrors.some((error) => error.code === "invalid-screenshot"));
});

test("different readiness keys fail closed", () => {
  const baseline = report([320], { capture: capture({ reloadPerWidth: true, pageReady: true, readinessKey: "ready-v1" }) });
  const candidate = report([320], { capture: capture({ reloadPerWidth: true, pageReady: true, readinessKey: "ready-v2" }) });
  const comparison = compareReports(baseline, candidate);
  assert.equal(comparison.valid, false);
  assert.match(comparison.validationErrors[0].message, /readinessKey/);
});

test("render-affecting selectors and protocol versions fail closed", () => {
  const baseline = report([320]);
  const hiddenCandidate = report([320], { capture: capture({ hideSelectors: [".clock"] }) });
  assert.match(compareReports(baseline, hiddenCandidate).validationErrors[0].message, /hideSelectors/);
  const protocolCandidate = report([320], { capture: capture({ protocolVersion: 2 }) });
  assert.match(compareReports(baseline, protocolCandidate).validationErrors[0].message, /protocolVersion/);
});
