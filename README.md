# WidthWatch

**Continuous responsive visual regression testing.** WidthWatch finds failures between the three breakpoints everybody remembered to screenshot.

```bash
npx widthwatch https://example.com --output widthwatch.html --json widthwatch.json
```

The engine returns versioned TypeScript objects, renders a portable interactive HTML report, and compares a candidate page with a baseline at matching widths. Its adaptive sampler discovers where geometry changes and spends the screenshot budget around those intervals instead of pretending that mobile/tablet/desktop are the whole responsive surface.

## What exists in v0.1

- adaptive 320–1440px width timeline;
- document and element overflow detection;
- clipped-text and material leaf-overlap detection;
- layout discontinuity signals;
- PNG pixel comparison with candidate/baseline regression output;
- CLI, TypeScript API and native standalone HTML reporter;
- product website, documentation and bounded public-scanner UI;
- shareable interactive online reports for completed public scans;
- protected AWS App Runner API with DNS-pinned egress, quotas and a one-instance hard cap;
- GitHub Actions for CI, Pages, npm trusted publishing and AWS OIDC deployment.

## TypeScript API

```ts
import {
  scanResponsive,
  compareReports,
  generateHtmlReport,
  type WidthWatchReport,
} from "widthwatch";

const candidate: WidthWatchReport = await scanResponsive("http://localhost:4173", {
  minWidth: 320,
  maxWidth: 1600,
  maxSamples: 28,
  hideSelectors: ["[data-live-clock]"],
});

const comparison = compareReports(baseline, candidate, {
  maxDiffRatio: 0.002,
  includeDiffImages: true,
});

const html = generateHtmlReport(comparison);
```

## Pull-request use

Build or deploy the candidate in CI, keep a trusted main-branch JSON baseline, then run:

```bash
npx widthwatch "$CANDIDATE_URL" \
  --baseline .widthwatch/home.json \
  --json artifacts/home.json \
  --output artifacts/home.html \
  --fail-on-regression
```

Baseline and candidate must run in the same pinned browser container. Browser rendering can vary by operating system, fonts, browser version and other host details; a visual threshold cannot compensate for unrelated environments.

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

The hosted surface is intentionally not the local package in the cloud. It accepts one credential-free public page, uses 12 adaptive widths, blocks media, caps navigation at 15 seconds and 250 requests, admits at most three queued jobs, runs one browser, and exposes a shareable interactive report for 30 minutes. Separate client, target, global, CloudFront/WAF and compute limits prevent arbitrary scale-out.

See [architecture](docs/architecture.md), [OpenAPI](docs/openapi.yml), and [security policy](SECURITY.md).

## Deployment bootstrap

1. Deploy `infra/aws/github-deploy-role.yml` once, reusing the account-level GitHub OIDC provider.
2. Configure protected GitHub environment `production`.
3. Add repository variables `AWS_ACCOUNT_ID`, `AWS_DEPLOY_ROLE_ARN`, `AWS_CLOUDFORMATION_ROLE_ARN`, `AWS_ECR_ACCESS_ROLE_ARN`, and `VITE_API_URL`.
4. Add `WIDTHWATCH_ORIGIN_VERIFY_TOKEN` as an environment secret.
5. Configure npm trusted publishing for repository `damianociarla/widthwatch`, workflow `release.yml`, environment `production`.
6. Enable GitHub Pages with GitHub Actions as its source.

A `v*` tag validates, deploys the API, publishes npm, publishes the website, and creates the GitHub Release. AWS credentials are short-lived through GitHub OIDC; npm trusted publishing also uses OIDC and emits provenance.

The `Deploy API` workflow can bootstrap or redeploy only the hosted scanner without publishing an npm release.

## License

MIT © Damiano Ciarla
