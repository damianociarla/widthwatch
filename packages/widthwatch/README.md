# WidthWatch

Continuous responsive visual regression testing for Chromium. WidthWatch samples a width range, adaptively bisects intervals where the layout changes, detects deterministic layout failures, and emits typed objects plus a portable HTML report.

```bash
npx widthwatch https://example.com --output widthwatch.html --json widthwatch.json
```

```ts
import { scanResponsive, compareReports, generateHtmlReport } from "widthwatch";

const candidate = await scanResponsive("http://localhost:4173", {
  minWidth: 320,
  maxWidth: 1600,
  maxSamples: 28,
});

const comparison = compareReports(baseline, candidate, { maxDiffRatio: 0.002 });
const html = generateHtmlReport(comparison);
```

The hosted demo accepts only public HTTP(S) pages and applies separate safety limits. The local package intentionally gives the caller more control; do not scan untrusted URLs from a privileged network without an egress policy.

