# WidthWatch

Continuous responsive visual regression testing for Chromium. WidthWatch samples a width range, adaptively bisects intervals where the layout changes, detects deterministic layout failures, and emits typed objects plus a portable HTML report.

```bash
npx widthwatch https://example.com --output widthwatch.html --json widthwatch.json
```

```bash
npx widthwatch init
```

`init` creates `widthwatch.config.ts` and a reusable, read-only GitHub workflow. The config can hold scan defaults, comparison thresholds, output paths and application-specific `pageReady` logic without turning the CLI into a wall of flags.

```ts
import { scanAtReportSchedule, compareReports, generateHtmlReport } from "widthwatch";

const candidate = await scanAtReportSchedule(
  "http://localhost:4173",
  baseline,
  {
    pageReady: (page) => page.waitForSelector("[data-app-ready]"),
    readinessKey: "app-ready-v1",
  },
);

const comparison = compareReports(baseline, candidate, { maxDiffRatio: 0.002 });
const html = generateHtmlReport(comparison);
```

`visual` mode is the default. Adaptive scans first run a fast geometry discovery pass, then open a fresh page and capture full-page evidence only at the final schedule. `maxSamples` bounds discovery (24 by default) and `maxCaptureSamples` bounds expensive evidence (8 by default). Distinct finding identities are represented before remaining evidence slots are spent on transitions and width coverage. `scanAtReportSchedule()` reproduces both schedules for comparison.

The evidence pass waits for fonts, performs a bounded scroll sweep to activate lazy content and IntersectionObservers, returns to the top, and captures a full-page PNG. Use `{ mode: "layout" }` for a faster single-pass viewport probe. Standalone diagnostic reports can opt into `{ imageFormat: "jpeg", imageQuality: 70 }`; pixel comparisons intentionally require lossless PNG evidence. `reloadPerWidth` reruns page initialization at each width, while `pageReady` receives a `phase` of `discovery` or `capture`. Every hook requires a versioned `readinessKey`, which is stored in the report and checked during comparison.

Use `maxRequestsPerNavigation` to bound one page load and `maxTotalRequests` as a separate hard cap for the complete scan. Resources rejected by `blockResourceTypes` or `allowedUrl` do not consume those budgets.

Comparisons fail closed when widths, viewport dimensions, the rendering fingerprint, browser, platform, or PNG dimensions are incompatible. The capture protocol is versioned separately from the npm package, so a non-rendering patch release does not invalidate every baseline. `comparison.valid` explains whether a visual pass/fail decision is meaningful.

Reports group repeated findings into typed `issueRanges`, recording affected samples and adjacent clean samples without claiming exact unsampled boundaries. Comparison reports additionally expose new findings, resolved findings, regression ranges and the exact pixel threshold used. The HTML UI opens on the first regression and provides baseline, candidate and a truthful diff view when diff images were generated.

New reports expose optional `sampling` metadata, geometry `probes`, and a canonical `issues` union. `frames` contains only screenshot evidence. Each canonical issue identifies whether it was reproduced during capture or observed only during discovery. These fields remain optional on schema-v1 objects so existing report producers stay source-compatible.

The published package supports Node.js 22 and 24.

The hosted demo accepts only public HTTP(S) pages and applies separate safety limits. The local package intentionally gives the caller more control; do not scan untrusted URLs from a privileged network without an egress policy.
