import assert from "node:assert/strict";
import test from "node:test";
import AxeBuilder from "@axe-core/playwright";
import { chromium } from "playwright";
import { generateHtmlReport } from "../dist/index.js";

const pixel = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function probe(width, issues = []) {
  return {
    width,
    height: 800,
    document: { width, height: 800 },
    layoutSignature: `layout-${width}`,
    issues,
    durationMs: 1,
  };
}

function report(issues, frames) {
  const widths = [900, 905, 910, 920];
  return {
    version: 1,
    url: "https://example.com/checkout",
    title: "Dense reporter fixture",
    scannedAt: new Date(0).toISOString(),
    durationMs: 10,
    range: { min: 800, max: 1200, height: 800 },
    environment: { browser: "chromium", platform: "test", packageVersion: "0.4.6" },
    sampling: {
      protocolVersion: 2,
      strategy: "adaptive-two-pass",
      discoveryWidths: widths,
      capturedWidths: frames.map((frame) => frame.width),
    },
    probes: widths.map((width) =>
      probe(
        width,
        issues.filter((issue) => issue.width === width),
      ),
    ),
    issues,
    frames,
    transitions: [],
    summary: {
      errors: issues.filter((issue) => issue.severity === "error").length,
      warnings: issues.filter((issue) => issue.severity === "warning").length,
      info: 0,
      sampledWidths: widths.length,
    },
  };
}

function comparisonFixture() {
  const element = { selector: ".checkout-actions > button", tagName: "button", rect: { x: 10, y: 20, width: 120, height: 32 } };
  const baselineIssue = {
    id: "baseline-warning",
    kind: "clipped-text",
    severity: "warning",
    width: 905,
    message: "CTA is nearly clipped",
    elements: [element],
    evidence: "discovery",
  };
  const candidateIssue = { ...baselineIssue, id: "candidate-error", severity: "error", message: "CTA is clipped" };
  const baseline = report(
    [baselineIssue],
    [
      { ...probe(900), screenshot: pixel },
      { ...probe(920), screenshot: pixel },
    ],
  );
  const candidate = report(
    [candidateIssue],
    [
      { ...probe(900), screenshot: pixel },
      { ...probe(920), screenshot: pixel },
    ],
  );
  return {
    version: 1,
    baseline,
    candidate,
    diffs: [
      { width: 900, changedPixels: 0, ratio: 0, diffScreenshot: pixel },
      { width: 920, changedPixels: 1, ratio: 0.01, diffScreenshot: pixel },
    ],
    regressions: [candidateIssue],
    escalated: [{ baseline: baselineIssue, candidate: candidateIssue }],
    deescalated: [],
    resolved: [],
    regressionRanges: [
      {
        kind: "clipped-text",
        severity: "error",
        message: candidateIssue.message,
        elements: [element],
        from: 905,
        to: 905,
        sampledWidths: [905],
        cleanBefore: 900,
        cleanAfter: 910,
      },
    ],
    valid: true,
    validationErrors: [],
    passed: false,
  };
}

async function assertNoSeriousAccessibilityViolations(page) {
  const results = await new AxeBuilder({ page }).analyze();
  const violations = results.violations
    .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
    .map((violation) => ({ id: violation.id, impact: violation.impact, targets: violation.nodes.map((node) => node.target.join(" ")) }));
  assert.deepEqual(violations, []);
}

test("reporter executes dense timeline, accessible tabs, focus, and discovery-only mobile layout", { timeout: 30_000 }, async () => {
  const comparison = comparisonFixture();

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    const runtimeErrors = [];
    page.on("pageerror", (error) => runtimeErrors.push(error.message));
    await page.setContent(generateHtmlReport(comparison), { waitUntil: "load" });

    const slider = page.getByRole("slider", { name: "Responsive width probes" });
    assert.equal(await slider.getAttribute("aria-valuenow"), "905");
    assert.match(await slider.getAttribute("aria-valuetext"), /geometry probe only, error finding/);

    const markers = await page
      .locator(".tick")
      .evaluateAll((items) => items.map((item) => ({ left: item.getBoundingClientRect().left, clustered: item.classList.contains("clustered") })));
    assert.equal(markers.length, 4);
    assert.equal(
      markers.every((marker) => marker.clustered),
      true,
    );
    assert.deepEqual(
      markers.map((marker) => marker.left),
      [...markers.map((marker) => marker.left)].sort((a, b) => a - b),
    );

    const timelineBox = await page.locator("#timeline").boundingBox();
    assert.ok(timelineBox);
    await page.mouse.click(timelineBox.x + timelineBox.width * ((905 - 800) / 400), timelineBox.y + 52);
    assert.equal(await slider.getAttribute("aria-valuenow"), "905");

    assert.equal(await page.locator("#mobileDiagnostic .issue").isVisible(), true);
    assert.equal(await page.locator("#evidencePanel").isHidden(), true);
    assert.equal(await page.locator("#evidencePanel").getAttribute("class"), "viewer no-capture");
    const visibleDiagnostics = await page
      .getByText("Detected during discovery; visual evidence was not captured at this width.", { exact: true })
      .evaluateAll((items) => items.filter((item) => item.getClientRects().length > 0).length);
    assert.equal(visibleDiagnostics, 1);

    await slider.focus();
    await slider.press("End");
    assert.equal(await slider.getAttribute("aria-valuenow"), "920");
    assert.equal(await page.locator("#timelineTooltip").isHidden(), true);
    assert.equal(await page.locator("#evidencePanel").getAttribute("class"), "viewer");

    const tabs = page.getByRole("tab");
    assert.equal(await tabs.count(), 3);
    const baselineTab = page.getByRole("tab", { name: "Baseline" });
    await baselineTab.click();
    assert.equal(await baselineTab.getAttribute("aria-selected"), "true");
    await baselineTab.press("ArrowRight");
    const candidateTab = page.getByRole("tab", { name: "Candidate" });
    assert.equal(await candidateTab.getAttribute("aria-selected"), "true");
    assert.equal(await candidateTab.evaluate((element) => element === document.activeElement), true);
    await candidateTab.press("ArrowRight");
    const diffTab = page.getByRole("tab", { name: "Diff" });
    assert.equal(await diffTab.getAttribute("aria-selected"), "true");
    assert.equal(await page.getByRole("tabpanel").getAttribute("aria-labelledby"), "view-diff");
    assert.equal(await page.locator("#shot").getAttribute("alt"), "Diff capture at 920 pixels");

    await page.getByRole("button", { name: /First regression/ }).click();
    await page.waitForFunction(() => document.activeElement?.getAttribute("data-issue-id") === "candidate-error");
    assert.equal(await slider.getAttribute("aria-valuenow"), "905");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await assertNoSeriousAccessibilityViolations(page);
    assert.deepEqual(runtimeErrors, []);
  } finally {
    await browser.close();
  }
});

test("reporter keeps desktop evidence, responsive issue placement, and accessibility intact", { timeout: 30_000 }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const runtimeErrors = [];
    page.on("pageerror", (error) => runtimeErrors.push(error.message));
    await page.setContent(generateHtmlReport(comparisonFixture()), { waitUntil: "load" });

    const evidence = page.locator("#evidencePanel");
    assert.equal(await page.locator("#mobileDiagnostic").isHidden(), true);
    assert.equal(await evidence.isVisible(), true);
    assert.equal(await evidence.getAttribute("class"), "viewer no-capture");
    assert.equal(await page.locator("#issues").evaluate((element) => element.parentElement?.id), "desktopIssuesSlot");
    assert.equal(
      await page
        .getByText("Detected during discovery; visual evidence was not captured at this width.", { exact: true })
        .evaluateAll((items) => items.filter((item) => item.getClientRects().length > 0).length),
      1,
    );
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await assertNoSeriousAccessibilityViolations(page);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => document.querySelector("#issues")?.parentElement?.id === "mobileIssuesSlot");
    assert.equal(await page.locator("#issues").evaluate((element) => element.parentElement?.id), "mobileIssuesSlot");
    assert.equal(await evidence.isHidden(), true);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForFunction(() => document.querySelector("#issues")?.parentElement?.id === "desktopIssuesSlot");
    assert.equal(await page.locator("#issues").evaluate((element) => element.parentElement?.id), "desktopIssuesSlot");
    assert.equal(await evidence.isVisible(), true);
    assert.deepEqual(runtimeErrors, []);
  } finally {
    await browser.close();
  }
});
