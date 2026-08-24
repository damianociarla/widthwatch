# WidthWatch

Continuous responsive visual regression testing for Chromium. WidthWatch samples a width range, adaptively bisects intervals where the layout changes, detects deterministic layout failures, and emits typed objects plus a portable HTML report.

```bash
npx widthwatch https://example.com --output widthwatch.html --json widthwatch.json
```

```ts
import { scanAtWidths, compareReports, generateHtmlReport } from "widthwatch";

const candidate = await scanAtWidths(
  "http://localhost:4173",
  baseline.frames.map((frame) => frame.width),
  {
    viewportHeight: baseline.range.height,
    mode: "visual",
    reloadPerWidth: true,
    pageReady: (page) => page.waitForSelector("[data-app-ready]"),
    readinessKey: "app-ready-v1",
  },
);

const comparison = compareReports(baseline, candidate, { maxDiffRatio: 0.002 });
const html = generateHtmlReport(comparison);
```

`visual` mode is the default: it waits for fonts, performs a bounded scroll sweep to activate lazy content and IntersectionObservers, returns to the top, and captures a full-page PNG. Use `{ mode: "layout" }` for a faster viewport-only geometry probe. `reloadPerWidth` reruns page initialization at each width, while `pageReady` provides an application-specific Playwright hook. Every hook requires a versioned `readinessKey`, which is stored in the report and checked during comparison.

Comparisons fail closed when widths, viewport dimensions, capture settings, browser, platform, package version, or PNG dimensions are incompatible. `comparison.valid` explains whether a visual pass/fail decision is meaningful.

The hosted demo accepts only public HTTP(S) pages and applies separate safety limits. The local package intentionally gives the caller more control; do not scan untrusted URLs from a privileged network without an egress policy.
