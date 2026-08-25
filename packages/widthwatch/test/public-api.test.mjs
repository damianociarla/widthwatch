import assert from "node:assert/strict";
import test from "node:test";
import { generateHtmlReport } from "../dist/index.js";

test("native reporter embeds a versioned report safely", () => {
  const report = {
    version: 1,
    url: "https://example.com/?q=<script>",
    title: "Example",
    scannedAt: new Date(0).toISOString(),
    durationMs: 1,
    range: { min: 320, max: 1440, height: 800 },
    environment: { browser: "test", platform: "test", packageVersion: "0.1.0" },
    frames: [
      { width: 320, height: 800, document: { width: 320, height: 800 }, layoutSignature: "x", issues: [], screenshot: "data:image/png;base64,", durationMs: 1 },
    ],
    transitions: [],
    summary: { errors: 0, warnings: 0, info: 0, sampledWidths: 1 },
  };
  const html = generateHtmlReport(report);
  assert.match(html, /widthwatch/i);
  assert.doesNotMatch(html, /<script>[\s\S]*<script>/);
  assert.match(html, /\\u003cscript>/);
});

test("comparison reporter omits a misleading diff control when no diff image exists", () => {
  const report = {
    version: 1,
    url: "https://example.com/",
    title: "Example",
    scannedAt: new Date(0).toISOString(),
    durationMs: 1,
    range: { min: 320, max: 320, height: 800 },
    environment: { browser: "test", platform: "test", packageVersion: "0.1.0" },
    frames: [
      { width: 320, height: 800, document: { width: 320, height: 800 }, layoutSignature: "x", issues: [], screenshot: "data:image/png;base64,", durationMs: 1 },
    ],
    transitions: [],
    summary: { errors: 0, warnings: 0, info: 0, sampledWidths: 1 },
  };
  const comparison = {
    version: 1,
    baseline: report,
    candidate: report,
    diffs: [],
    regressions: [],
    valid: false,
    validationErrors: [{ code: "environment-mismatch", message: "Rendering environments differ." }],
    passed: false,
  };
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
  const frame = {
    width: 320,
    height: 800,
    document: { width: 320, height: 800 },
    layoutSignature: "x",
    issues: [],
    screenshot: "data:image/png;base64,",
    durationMs: 1,
  };
  const report = {
    version: 1,
    url: "https://example.com/",
    title: "Example",
    scannedAt: new Date(0).toISOString(),
    durationMs: 1,
    range: { min: 320, max: 320, height: 800 },
    environment: { browser: "test", platform: "test", packageVersion: "0.2.3" },
    frames: [frame],
    transitions: [],
    summary: { errors: 0, warnings: 0, info: 0, sampledWidths: 1 },
  };
  const comparison = {
    version: 1,
    baseline: report,
    candidate: report,
    diffs: [{ width: 320, changedPixels: 1, ratio: 0.1, diffScreenshot: "data:image/png;base64,AA==" }],
    regressions: [],
    valid: true,
    validationErrors: [],
    passed: true,
  };
  const html = generateHtmlReport(comparison);
  assert.match(html, /data-view="diff"/);
  assert.match(html, /role="tablist"/);
  assert.match(html, /role="tab" aria-selected="true"/);
  assert.match(html, /role="tabpanel" aria-labelledby="view-candidate"/);
  assert.match(html, /regression ranges/);
});

test("reporter distinguishes geometry probes from visual evidence", () => {
  const finding = {
    id: "probe-only",
    kind: "clipped-text",
    severity: "error",
    width: 640,
    message: "discovered",
    elements: [{ selector: "#probe", tagName: "p", rect: { x: 0, y: 0, width: 10, height: 10 } }],
    evidence: "discovery",
  };
  const frame = {
    width: 320,
    height: 800,
    document: { width: 320, height: 800 },
    layoutSignature: "x",
    issues: [],
    screenshot: "data:image/png;base64,",
    durationMs: 1,
  };
  const report = {
    version: 1,
    url: "https://example.com/",
    title: "Example",
    scannedAt: new Date(0).toISOString(),
    durationMs: 1,
    range: { min: 320, max: 640, height: 800 },
    environment: { browser: "test", platform: "test", packageVersion: "0.3.1" },
    probes: [frame, { ...frame, width: 640, document: { width: 640, height: 800 }, issues: [finding] }],
    issues: [finding],
    frames: [frame],
    transitions: [],
    summary: { errors: 1, warnings: 0, info: 0, sampledWidths: 2 },
  };
  const html = generateHtmlReport(report);
  assert.match(html, /geometry probe/);
  assert.match(html, /visual evidence/);
  assert.match(html, /Detected during discovery; visual evidence was not captured/);
  assert.match(html, /discovery only/);
  assert.match(html, /viewer\.no-capture\{display:none\}/);
  assert.match(html, /mobile-diagnostic/);
  assert.match(html, /syncIssuePlacement/);
  assert.match(html, /probes\.findIndex/);
});

test("reporter canonicalizes capture-only fallback findings", () => {
  const finding = {
    id: "lazy-capture",
    kind: "clipped-text",
    severity: "error",
    width: 640,
    message: "capture only",
    elements: [{ selector: "#lazy", tagName: "p", rect: { x: 0, y: 0, width: 10, height: 10 } }],
  };
  const probe = { width: 640, height: 800, document: { width: 640, height: 800 }, layoutSignature: "x", issues: [], durationMs: 1 };
  const report = {
    version: 1,
    url: "https://example.com/",
    title: "Example",
    scannedAt: new Date(0).toISOString(),
    durationMs: 1,
    range: { min: 640, max: 640, height: 800 },
    environment: { browser: "test", platform: "test", packageVersion: "0.4.0" },
    probes: [probe],
    frames: [{ ...probe, issues: [finding], screenshot: "data:image/png;base64," }],
    transitions: [],
    summary: { errors: 1, warnings: 0, info: 0, sampledWidths: 1 },
  };
  const html = generateHtmlReport(report);
  assert.match(html, /lazy-capture/);
  assert.match(html, /capture only/);
  assert.match(html, /"evidence":"capture"/);
});

test("reporter timeline uses one interactive hit layer with clustered passive markers", () => {
  const probe = (width) => ({ width, height: 800, document: { width, height: 800 }, layoutSignature: "x", issues: [], durationMs: 1 });
  const report = {
    version: 1,
    url: "https://example.com/",
    title: "Example",
    scannedAt: new Date(0).toISOString(),
    durationMs: 1,
    range: { min: 900, max: 920, height: 800 },
    environment: { browser: "test", platform: "test", packageVersion: "0.4.0" },
    probes: [probe(900), probe(905), probe(910), probe(920)],
    frames: [
      { ...probe(900), screenshot: "data:image/png;base64," },
      { ...probe(920), screenshot: "data:image/png;base64," },
    ],
    transitions: [],
    summary: { errors: 0, warnings: 0, info: 0, sampledWidths: 4 },
  };
  const html = generateHtmlReport(report);
  assert.equal((html.match(/class="timeline-hit"/g) ?? []).length, 1);
  assert.match(html, /role="slider"/);
  assert.match(html, /pointer-events:none/);
  assert.match(html, /ArrowRight/);
  assert.match(html, /Cluster:/);
});
