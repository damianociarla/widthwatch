# Architecture

## Product surfaces

1. `widthwatch` npm package: the engine, typed schema, comparison and native HTML reporter.
2. `@widthwatch/web`: static landing page, documentation and bounded public demo client on GitHub Pages.
3. `@widthwatch/api`: a deliberately small admission API and one in-process browser worker on AWS App Runner.

Completed demo scans expose the same standalone reporter used by the npm package at `/v1/reports/{id}`. Job metadata remains in memory for 30 minutes. When the report runtime role is configured, the standalone HTML is stored in a private, encrypted S3 bucket with a seven-day lifecycle, so a shared report survives worker restarts without making the bucket public. Persistent team history beyond that bounded demo window belongs in an authenticated product tier.

The scan admission response remains open while the in-process browser is active. App Runner otherwise throttles CPU after returning the `202`, which makes detached background browser work unsuitable. Poll responses contain only timeline metadata; screenshots stay in the dedicated HTML report endpoint.

The package remains the product. The hosted demo is a constrained preview, not a free remote browser farm.

HTTP admission is a deep in-process module with one request interface. It owns routing, bounded JSON parsing, typed client-error mapping, CORS, origin verification, public-target policy, capacity, rate limits, queue state and retention. App Runner startup is a small production adapter; integration tests use an ephemeral listener and controlled scan, DNS, report and clock adapters while crossing the same HTTP seam. The pinned egress proxy is tested against real local HTTP and TCP upstreams through injected resolution and connection adapters. Its HTTPS contract covers the CONNECT handshake, pre-read head forwarding, bidirectional traffic, pinned-address fallback and coordinated socket closure.

## Continuous-width engine

The first pass samples `minWidth`, `maxWidth`, and an initial coarse step. Each probe emits a layout signature based on normalized, quantized element geometry and a finding fingerprint. Intervals whose signatures differ are prioritized and bisected until `minStep` or `maxSamples` is reached. A refinement penalty per coarse band prevents one high-scoring transition from consuming the entire budget.

Visual scans then open a fresh browser context and capture a bounded evidence subset. Range endpoints are invariant; distinct finding identities are represented before remaining slots are spent on strong transitions and width coverage. Probes and evidence remain separate in the report. Canonical issues are the deduplicated union of both phases, so a discovery-only finding is never discarded and a lazy finding visible only after scroll sweep is also retained. Repeated canonical findings are grouped across consecutive probe widths into explicit issue ranges.

Screenshots are intentionally captured in one pinned Chromium build. Playwright warns that host OS, browser version, fonts and other environment details affect image output, so baseline and candidate must use the same container.

Explore scans choose widths adaptively. CI comparisons are deterministic: the baseline defines an ordered report schedule, the candidate repeats every probe width and recaptures the exact evidence subset. The comparator fails closed if either schedule, any frame, viewport, capture mode, PNG dimension, or rendering-environment field is incompatible. Pixel comparison only decodes evidence frames; geometry regressions use canonical issues at every probe width. Occurrences are compared by stable identity before severity: new findings and severity escalations are regressions, de-escalations are explicit improvements, and only absent candidate occurrences are resolved.

The standalone reporter treats the responsive timeline as one interactive graph. Passive markers never compete for pointer hit testing; the graph maps pointer position to the nearest probe and exposes an accessible slider-like keyboard surface for exact sample navigation. Baseline, candidate and diff form a semantic tab set with roving keyboard focus. On narrow viewports, discovery-only findings move ahead of evidence and the empty capture viewer is omitted, leaving one concise diagnostic. Mobile and desktop reporter layouts run through Chromium E2E tests and axe accessibility checks.

`widthwatch init` creates a TypeScript config and a reusable GitHub Actions workflow. The workflow accepts a candidate preview URL, runs with read-only repository permissions and uploads the standalone HTML as an artifact. It intentionally avoids automatic writable PR comments and `pull_request_target`; a future authenticated GitHub App can add comments without weakening fork safety.

The local engine has two explicit capture modes. `visual` waits for fonts, runs a bounded scroll sweep to activate lazy loading and IntersectionObservers, returns to the top and records a full-page image. `layout` avoids the sweep and records only the viewport for fast geometry exploration. Callers can reload at every width and supply a bounded Playwright `pageReady` hook plus a versioned `readinessKey` for application-specific readiness. The hosted demo deliberately pins `layout` mode, five adaptive widths and compact JPEG evidence to preserve its public time and compute budgets; CI keeps lossless PNG evidence.

## Public request path

```text
GitHub Pages → CloudFront → AWS WAF → App Runner (max 1 instance / concurrency 1)
                                           ├→ pinned loopback egress proxy → public site
                                           └→ private S3 report objects (7-day lifecycle)
```

CloudFront injects a private origin header; the direct App Runner URL answers scan routes with `404`. WAF provides edge rate limiting and managed common rules. The application then applies separate atomic-in-process client, target, global, queue and job caps. The public surface cannot make AWS scale past one instance. App Runner's runtime role can only read and write the `reports/` prefix of its private bucket; lifecycle deletion is enforced by S3.

Coverage gates are local to each risk-bearing module. The engine retains aggregate thresholds, HTTP admission and public-target policy have stricter focused thresholds, and the egress proxy requires 95% lines, 80% branches and 80% functions. The web client is measured in Chromium against its original TypeScript through temporary source maps. Only the process-startup adapter is excluded from API coverage.

For a paid or multi-tenant product, replace the in-memory queue with DynamoDB + SQS and run one isolated ECS Fargate task per accepted job. Fargate tasks must remain behind an admission quota and a strict maximum task count; an unbounded queue only delays a cost attack rather than preventing it.

## Release order

A `v*` tag validates the exact artifact, then deploys the bounded API and publishes npm through trusted OIDC in parallel. The idempotent GitHub Release waits for both. Pushes to `main` deploy GitHub Pages, keeping Pages environment protection independent from release tags. AWS access uses GitHub OIDC and short-lived credentials. Production is a protected GitHub environment.
