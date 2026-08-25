import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { PNG } from "pngjs";
import { scanAtReportSchedule, scanAtWidths, scanResponsive } from "../dist/scanner.js";

async function fixture(context, handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

function html(response, body) {
  response.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><meta charset="utf-8">${body}`);
}

test("invalid numeric options fail before launching a browser", async () => {
  await assert.rejects(scanResponsive("https://example.com", { initialStep: 0 }), /initialStep/);
  await assert.rejects(scanResponsive("https://example.com", { minStep: Number.NaN }), /minStep/);
  await assert.rejects(scanResponsive("https://example.com", { viewportHeight: 0 }), /viewportHeight/);
  await assert.rejects(scanResponsive("https://example.com", { exactWidths: [320, 320] }), /duplicates/);
  await assert.rejects(scanResponsive("https://example.com", { maxElements: 20, maxDomNodes: 10 }), /maxDomNodes/);
  await assert.rejects(scanResponsive("https://example.com", { imageQuality: 0 }), /imageQuality/);
  await assert.rejects(scanResponsive("https://example.com", { maxScrollSteps: 0 }), /maxScrollSteps/);
  await assert.rejects(scanResponsive("https://example.com", { pageReadyTimeoutMs: Number.NaN }), /pageReadyTimeoutMs/);
  await assert.rejects(scanResponsive("https://example.com", { maxRequestsPerNavigation: 0 }), /maxRequestsPerNavigation/);
  await assert.rejects(scanResponsive("https://example.com", { maxTotalRequests: 0 }), /maxTotalRequests/);
  await assert.rejects(scanResponsive("https://example.com", { pageReady: async () => {} }), /readinessKey/);
  await assert.rejects(scanResponsive("https://example.com", { exactWidths: [320, 640], probeWidths: [320] }), /subset/);
});

test("scanAtWidths captures exactly the requested deterministic schedule", async (context) => {
  const url = await fixture(context, (_request, response) => html(response, "<title>Fixture</title><main>stable</main>"));
  const result = await scanAtWidths(url, [777, 321], { viewportHeight: 480, settleMs: 0 });
  assert.deepEqual(result.frames.map((frame) => frame.width), [321, 777]);
  assert.deepEqual(result.range, { min: 321, max: 777, height: 480 });
  assert.equal(result.capture.protocolVersion, 3);
  assert.deepEqual(result.sampling, { protocolVersion: 2, strategy: "exact", discoveryWidths: [], capturedWidths: [321, 777] });
  assert.equal(result.probes, undefined);
});

test("adaptive visual scans discover broadly and capture a bounded final schedule", async (context) => {
  const url = await fixture(context, (_request, response) => html(response, `
    <style>
      #target{width:80px}
      @media(min-width:500px){#target{transform:translateY(120px)}}
      @media(min-width:900px){#target{transform:translateY(260px)}}
    </style>
    <div id="target">target</div>
  `));
  const phases = [];
  const captureTaint = [];
  const result = await scanResponsive(url, {
    mode: "visual",
    minWidth: 320,
    maxWidth: 1120,
    initialStep: 200,
    minStep: 8,
    maxSamples: 7,
    maxCaptureSamples: 3,
    viewportHeight: 480,
    settleMs: 0,
    scrollSweep: false,
    pageReady: async (page, { phase }) => {
      phases.push(phase);
      if (phase === "discovery") await page.evaluate(() => {
        document.body.dataset.discoveryTaint = "true";
        localStorage.setItem("widthwatch-discovery-taint", "true");
      });
      else captureTaint.push(await page.evaluate(() => ({ dom: document.body.dataset.discoveryTaint ?? null, storage: localStorage.getItem("widthwatch-discovery-taint") })));
    },
    readinessKey: "two-pass-v1",
  });
  assert.equal(result.sampling.strategy, "adaptive-two-pass");
  assert.equal(result.sampling.discoveryWidths.length, 7);
  assert.equal(result.frames.length, 3);
  assert.deepEqual(result.sampling.capturedWidths, result.frames.map((frame) => frame.width));
  assert.deepEqual([result.frames[0].width, result.frames.at(-1).width], [320, 1120]);
  assert.equal(phases.filter((phase) => phase === "capture").length, 3);
  assert.ok(phases.filter((phase) => phase === "discovery").length > 3);
  assert.deepEqual(captureTaint, [
    { dom: null, storage: null },
    { dom: null, storage: null },
    { dom: null, storage: null },
  ]);
});

test("maxCaptureSamples remains a hard cap when every discovery probe has a finding", async (context) => {
  const url = await fixture(context, (_request, response) => html(response, '<p style="width:20px;white-space:nowrap;overflow:hidden">always clipped</p>'));
  const result = await scanResponsive(url, { mode: "visual", minWidth: 320, maxWidth: 1120, initialStep: 160, maxSamples: 6, maxCaptureSamples: 3, viewportHeight: 480, settleMs: 0, scrollSweep: false });
  assert.equal(result.sampling.discoveryWidths.length, 6);
  assert.equal(result.frames.length, 3);
  assert.equal(result.probes.length, 6);
  assert.equal(result.issues.filter((issue) => issue.kind === "clipped-text").length, 6);
  assert.ok(result.issues.some((issue) => issue.evidence === "discovery" && !result.frames.some((frame) => frame.width === issue.width)));
  assert.equal(result.summary.errors, 6);
  assert.deepEqual(result.issueRanges.map((range) => [range.from, range.to, range.occurrences]), [[320, 1120, 6]]);
});

test("evidence selection covers distinct finding identities before transition-only widths", async (context) => {
  const url = await fixture(context, (_request, response) => html(response, `
    <style>
      .finding{display:none;width:20px;white-space:nowrap;overflow:hidden}
      @media(min-width:450px) and (max-width:550px){#first{display:block}}
      @media(min-width:610px) and (max-width:690px){#second{display:block}}
      @media(min-width:770px) and (max-width:830px){#third{display:block}}
    </style>
    <p class="finding" id="first">first clipped content</p>
    <p class="finding" id="second">second clipped content</p>
    <p class="finding" id="third">third clipped content</p>
  `));
  const result = await scanResponsive(url, { mode: "visual", minWidth: 320, maxWidth: 1120, initialStep: 160, maxSamples: 6, maxCaptureSamples: 5, viewportHeight: 480, settleMs: 0, scrollSweep: false });
  assert.deepEqual(result.frames.map((frame) => frame.width), [320, 480, 640, 800, 1120]);
  assert.deepEqual(new Set(result.issues.filter((issue) => issue.evidence === "capture").map((issue) => issue.elements[0]?.selector)), new Set(["#first", "#second", "#third"]));
});

test("visual evidence prioritizes a sampled error while preserving range endpoints", async (context) => {
  const url = await fixture(context, (_request, response) => html(response, `
    <style>
      #target{display:none}
      @media(min-width:600px) and (max-width:700px){#target{display:block;width:20px;white-space:nowrap;overflow:hidden}}
    </style>
    <p id="target">mid-range clipped content</p>
  `));
  const result = await scanResponsive(url, { mode: "visual", minWidth: 320, maxWidth: 1120, initialStep: 160, maxSamples: 6, maxCaptureSamples: 3, viewportHeight: 480, settleMs: 0, scrollSweep: false });
  assert.deepEqual(result.frames.map((frame) => frame.width), [320, 640, 1120]);
  assert.ok(result.frames[1].issues.some((issue) => issue.kind === "clipped-text"));
});

test("maxCaptureSamples is normalized to the discovery budget", async (context) => {
  const url = await fixture(context, (_request, response) => html(response, "<main>stable</main>"));
  const result = await scanResponsive(url, { mode: "visual", minWidth: 320, maxWidth: 1120, initialStep: 200, maxSamples: 4, maxCaptureSamples: 10, viewportHeight: 480, settleMs: 0, scrollSweep: false });
  assert.equal(result.sampling.discoveryWidths.length, 4);
  assert.equal(result.frames.length, 4);
});

test("standalone scans can use bounded JPEG evidence", async (context) => {
  const url = await fixture(context, (_request, response) => html(response, "<main>jpeg evidence</main>"));
  const result = await scanAtWidths(url, [320], { mode: "layout", imageFormat: "jpeg", imageQuality: 60, viewportHeight: 480, settleMs: 0 });
  assert.equal(result.capture.imageFormat, "jpeg");
  assert.match(result.frames[0].screenshot, /^data:image\/jpeg;base64,/);
});

test("viewport layout scans do not wait for offscreen lazy images", async (context) => {
  const url = await fixture(context, (request, response) => {
    if (request.url === "/never-loads.png") return;
    html(response, '<div style="height:2000px"></div><img loading="lazy" src="/never-loads.png" alt="offscreen">');
  });
  const started = Date.now();
  await scanAtWidths(url, [320], { mode: "layout", viewportHeight: 480, settleMs: 0 });
  assert.ok(Date.now() - started < 1_500, "Offscreen image extended a viewport-only scan.");
});

test("visual mode scrolls through lazy content and captures the full page", async (context) => {
  const url = await fixture(context, (_request, response) => html(response, `
    <div style="height:900px">above fold</div>
    <div id="lazy" style="width:40px;white-space:nowrap;overflow:hidden;opacity:0">lazy clipped content</div>
    <div style="height:300px"></div>
    <script>const target=document.querySelector('#lazy');new IntersectionObserver(entries=>{if(entries.some(entry=>entry.isIntersecting))target.style.opacity='1'}).observe(target)</script>
  `));
  const result = await scanAtWidths(url, [320], { viewportHeight: 480, settleMs: 5, mode: "visual", maxScrollSteps: 6 });
  assert.ok(result.frames[0].issues.some((issue) => issue.kind === "clipped-text" && issue.elements[0]?.selector === "#lazy"));
  assert.ok(result.issues.some((issue) => issue.kind === "clipped-text" && issue.elements[0]?.selector === "#lazy" && issue.evidence === "capture"));
  const png = PNG.sync.read(Buffer.from(result.frames[0].screenshot.split(",")[1], "base64"));
  assert.ok(png.height > 480);
});

test("settleMs zero still waits for resize animation frames", async (context) => {
  const url = await fixture(context, (_request, response) => html(response, `
    <body data-observed="0"><script>document.body.dataset.observed=String(innerWidth);addEventListener('resize',()=>requestAnimationFrame(()=>{document.body.dataset.observed=String(innerWidth)}))</script>
  `));
  const observed = [];
  await scanAtWidths(url, [320, 480, 1120], {
    mode: "layout",
    settleMs: 0,
    pageReady: async (page, { width }) => observed.push([width, await page.evaluate(() => Number(document.body.dataset.observed))]),
    readinessKey: "resize-raf-v1",
  });
  assert.deepEqual(observed, [[320, 320], [480, 480], [1120, 1120]]);
});

test("scanAtReportSchedule reproduces probe and evidence schedules", async (context) => {
  const url = await fixture(context, (_request, response) => html(response, "<main>stable</main>"));
  const baseline = await scanResponsive(url, { mode: "visual", minWidth: 320, maxWidth: 1120, initialStep: 160, maxSamples: 6, maxCaptureSamples: 3, viewportHeight: 480, settleMs: 0, scrollSweep: false });
  const candidate = await scanAtReportSchedule(url, baseline);
  assert.equal(candidate.sampling.strategy, "planned-two-pass");
  assert.deepEqual(candidate.probes.map((probe) => probe.width), baseline.probes.map((probe) => probe.width));
  assert.deepEqual(candidate.frames.map((frame) => frame.width), baseline.frames.map((frame) => frame.width));
});

test("pageReady waits for application-specific asynchronous state", async (context) => {
  const url = await fixture(context, (_request, response) => html(response, `
    <script>setTimeout(()=>{const node=document.createElement('div');node.id='ready';node.style.cssText='width:30px;white-space:nowrap;overflow:hidden';node.textContent='ready content';document.body.append(node)},80)</script>
  `));
  const calls = [];
  const result = await scanAtWidths(url, [320], {
    mode: "layout",
    settleMs: 0,
    pageReady: async (page, hookContext) => { calls.push([hookContext.width, hookContext.phase]); await page.waitForSelector("#ready"); },
    readinessKey: "fixture-ready-v1",
  });
  assert.deepEqual(calls, [[320, "capture"]]);
  assert.ok(result.frames[0].issues.some((issue) => issue.kind === "clipped-text" && issue.elements[0]?.selector === "#ready"));
});

test("reloadPerWidth navigates once at every requested width", async (context) => {
  let navigations = 0;
  const url = await fixture(context, (request, response) => {
    if (request.url === "/") navigations += 1;
    html(response, "<main>stable</main>");
  });
  await scanAtWidths(url, [320, 640], { mode: "layout", reloadPerWidth: true, viewportHeight: 480, settleMs: 0 });
  assert.equal(navigations, 2);
});

test("request budgets reset per navigation while retaining a separate total cap", async (context) => {
  const scripts = Array.from({ length: 25 }, (_, index) => `<script src="/asset-${index}.js"></script>`).join("");
  const url = await fixture(context, (request, response) => {
    if (request.url === "/") return html(response, scripts);
    response.writeHead(200, { "content-type": "text/javascript" }).end("void 0");
  });
  const options = { mode: "layout", reloadPerWidth: true, viewportHeight: 480, settleMs: 0, maxRequestsPerNavigation: 30, maxTotalRequests: 100 };
  const report = await scanAtWidths(url, [320, 480, 640], options);
  assert.equal(report.frames.length, 3);
  await assert.rejects(
    scanAtWidths(url, [320, 480, 640], { ...options, maxTotalRequests: 50 }),
    /WidthWatch total request budget exceeded \(50 allowed requests\)/,
  );
});

test("adaptive discovery and evidence share one total request budget", async (context) => {
  const scripts = Array.from({ length: 4 }, (_, index) => `<script src="/asset-${index}.js"></script>`).join("");
  const url = await fixture(context, (request, response) => {
    if (request.url === "/") return html(response, scripts);
    response.writeHead(200, { "content-type": "text/javascript" }).end("void 0");
  });
  await assert.rejects(
    scanResponsive(url, { mode: "visual", minWidth: 320, maxWidth: 640, initialStep: 320, maxSamples: 2, maxCaptureSamples: 2, viewportHeight: 480, settleMs: 0, scrollSweep: false, maxRequestsPerNavigation: 10, maxTotalRequests: 7 }),
    /WidthWatch total request budget exceeded \(7 allowed requests\)/,
  );
});

test("resources blocked by policy do not consume the request budget", async (context) => {
  const url = await fixture(context, (_request, response) => html(response, '<video autoplay src="/large.mp4"></video>'));
  const report = await scanAtWidths(url, [320], { mode: "layout", viewportHeight: 480, settleMs: 0, maxRequestsPerNavigation: 1, maxTotalRequests: 1, blockResourceTypes: ["media"] });
  assert.equal(report.frames.length, 1);
});

test("maxElements is applied after invisible nodes are filtered", async (context) => {
  const hidden = Array.from({ length: 8 }, (_, index) => `<div style="display:none">hidden ${index}</div>`).join("");
  const url = await fixture(context, (_request, response) => html(response, `${hidden}<div id="important" style="width:30px;white-space:nowrap;overflow:hidden">important clipped content</div>`));
  const result = await scanAtWidths(url, [320], { mode: "layout", maxElements: 1, maxDomNodes: 20, settleMs: 0 });
  assert.ok(result.frames[0].issues.some((issue) => issue.kind === "clipped-text" && issue.elements[0]?.selector === "#important"));
});

test("scanner groups the same finding across consecutive sampled widths", async (context) => {
  const url = await fixture(context, (_request, response) => html(response, `
    <style>@media(min-width:450px){#clipped{display:none}}</style>
    <p id="clipped" style="width:30px;white-space:nowrap;overflow:hidden">important clipped content</p>
  `));
  const result = await scanAtWidths(url, [320, 400, 480], { mode: "layout", viewportHeight: 480, settleMs: 0 });
  const range = result.issueRanges.find((item) => item.kind === "clipped-text" && item.elements[0]?.selector === "#clipped");
  assert.deepEqual([range.from, range.to, range.occurrences], [320, 400, 2]);
  assert.equal(range.cleanAfter, 480);
});

test("adaptive refinement spends budget across separate transition bands", async (context) => {
  const url = await fixture(context, (_request, response) => html(response, `
    <style>
      #first,#second{width:100px;height:20px}
      @media(min-width:500px){#first{transform:translateY(180px)}}
      @media(min-width:900px){#second{transform:translateY(240px)}}
    </style>
    <div id="first">first</div><div id="second">second</div>
  `));
  const result = await scanResponsive(url, { mode: "layout", minWidth: 320, maxWidth: 1120, initialStep: 400, minStep: 8, maxSamples: 5, viewportHeight: 480, settleMs: 0 });
  assert.ok(result.frames.some((frame) => frame.width > 720 && frame.width < 1120), `Expected refinement near the second transition, got ${result.frames.map((frame) => frame.width).join(", ")}`);
  assert.equal(result.sampling.strategy, "adaptive-single-pass");
  assert.deepEqual(result.sampling.discoveryWidths, result.sampling.capturedWidths);
});
