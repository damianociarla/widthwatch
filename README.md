# WidthWatch

**Continuous responsive visual regression testing.** WidthWatch finds failures between the three breakpoints everybody remembered to screenshot.

Run a correctness-first full-page scan from npm:

```bash
npx widthwatch https://example.com \
  --output widthwatch.html \
  --json widthwatch.json
```

For a pinned CI dependency, use `npm install --save-dev widthwatch`. If Chromium is not already available in the runner, install the matching browser once with `npx playwright install chromium`.

Initialize a versioned TypeScript config and a read-only reusable GitHub Actions workflow:

```bash
npx widthwatch init
```

The engine returns versioned TypeScript objects, renders a portable interactive HTML report, and compares a candidate page with a baseline at matching widths. Its adaptive sampler discovers where geometry changes and spends the screenshot budget around those intervals instead of pretending that mobile/tablet/desktop are the whole responsive surface.

## What exists in v0.3

- adaptive 320–1440px width timeline;
- two-pass visual scanning: fast geometry discovery followed by bounded full-page evidence capture;
- document and element overflow detection;
- clipped-text and material leaf-overlap detection;
- layout discontinuity signals;
- observed issue ranges such as `742–811px`, with adjacent clean samples, instead of claiming unsampled boundaries;
- full-page visual mode with bounded scroll sweep and lazy-content activation;
- optional reload-per-width and application-specific Playwright readiness hook;
- optional compact JPEG evidence for standalone diagnostics;
- PNG pixel comparison with candidate/baseline regression output;
- CLI, TypeScript API and native standalone HTML reporter;
- `widthwatch.config.ts` plus a generated reusable GitHub workflow;
- product website, documentation and bounded public-scanner UI;
- shareable interactive online reports for completed public scans;
- protected AWS App Runner API with DNS-pinned egress, quotas and a one-instance hard cap;
- GitHub Actions for CI, Pages, npm trusted publishing and AWS OIDC deployment.

## TypeScript API

```ts
import {
  scanAtWidths,
  scanResponsive,
  compareReports,
  generateHtmlReport,
  type WidthWatchReport,
} from "widthwatch";

const candidate: WidthWatchReport = await scanAtWidths(
  "http://localhost:4173",
  baseline.frames.map((frame) => frame.width),
  {
    viewportHeight: baseline.range.height,
    mode: "visual",
    reloadPerWidth: true,
    pageReady: (page) => page.waitForSelector("[data-app-ready]"),
    readinessKey: "app-ready-v1",
    hideSelectors: ["[data-live-clock]"],
  },
);

const comparison = compareReports(baseline, candidate, {
  maxDiffRatio: 0.002,
  includeDiffImages: true,
});

const html = generateHtmlReport(comparison);
```

## Pull-request use

Build or deploy the candidate in CI and keep a trusted main-branch JSON baseline. The CLI reads that baseline before scanning and captures the candidate at exactly the same widths:

```bash
npx widthwatch "$CANDIDATE_URL" \
  --baseline .widthwatch/home.json \
  --json artifacts/home.json \
  --output artifacts/home.html \
  --fail-on-regression
```

Baseline and candidate must run in the same pinned browser container. Browser rendering can vary by operating system, fonts, browser version and other host details; a visual threshold cannot compensate for unrelated environments.

The CLI uses correctness-first visual capture and reloads each width. Adaptive visual scans probe up to 24 widths geometrically, then use `--max-captures` (default 8) to bound the expensive full-page evidence schedule. Exact-width baseline comparisons always capture every required width. For a fast diagnostic probe that only inspects the viewport, use `--layout-only`; add `--reload-per-width` when a layout-only application calculates responsive state only during startup.

The generated workflow is deliberately read-only and uploads the portable report as an artifact. It accepts a deployed preview URL through `workflow_call` or manual dispatch, and never uses `pull_request_target`. Connect it to the step that already deploys your application preview.

See the [regression observed at 742, 768 and 811px](https://damianociarla.github.io/widthwatch/proof.html) for a real baseline/candidate/diff report generated from the committed fixtures; 720 and 832px are the adjacent clean samples.

## Repository

```text
apps/web                 GitHub Pages site, docs and live demo client
apps/api                 bounded public API and pinned egress proxy
packages/widthwatch      npm engine, CLI, types, comparator and reporter
docs                     architecture and OpenAPI contract
infra/aws                App Runner, CloudFront and WAF infrastructure
```

## Local development

Node.js 24 and Chromium are required.

```bash
npm ci
npx playwright install chromium
npm run typecheck
npm test
npm run dev
```

Run the API separately:

```bash
npm run build
npm start --workspace @widthwatch/api
```

## Public demo limits

The hosted surface is intentionally not the local package in the cloud. It accepts one credential-free public page, uses 5 adaptive layout captures with compact JPEG evidence, blocks media, caps navigation at 15 seconds and 200 requests, admits at most three queued jobs, and runs one browser. Job status remains in memory for 30 minutes; when `AWS_INSTANCE_ROLE_ARN` is configured, completed HTML reports are stored in a private encrypted S3 bucket and expire automatically after 7 days. The admission request streams lightweight heartbeats while the browser works so App Runner does not throttle detached CPU, while status polling returns lightweight metadata rather than embedded screenshots. Separate client, target, global, CloudFront/WAF and compute limits prevent arbitrary scale-out. The local visual package uses 24 discovery probes, up to 8 lossless evidence captures by default, and exact schedules for CI comparison.

See [architecture](docs/architecture.md), [OpenAPI](docs/openapi.yml), and [security policy](SECURITY.md).

## Deployment bootstrap

1. Deploy `infra/aws/github-deploy-role.yml` once, reusing the account-level GitHub OIDC provider.
2. Configure protected GitHub environment `production`.
3. Add repository variables `AWS_ACCOUNT_ID`, `AWS_DEPLOY_ROLE_ARN`, `AWS_CLOUDFORMATION_ROLE_ARN`, `AWS_ECR_ACCESS_ROLE_ARN`, `AWS_INSTANCE_ROLE_ARN`, and `VITE_API_URL`.
4. Add `WIDTHWATCH_ORIGIN_VERIFY_TOKEN` as an environment secret.
5. Configure npm trusted publishing for repository `damianociarla/widthwatch`, workflow `release.yml`, environment `production`.
6. Enable GitHub Pages with GitHub Actions as its source.

A `v*` tag validates, deploys the API, publishes npm, publishes the website, and creates the GitHub Release. AWS credentials are short-lived through GitHub OIDC; npm trusted publishing also uses OIDC and emits provenance.

The `Deploy API` workflow can bootstrap or redeploy only the hosted scanner without publishing an npm release.

## License

MIT © Damiano Ciarla
