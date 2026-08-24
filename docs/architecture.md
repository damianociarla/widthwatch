# Architecture

## Product surfaces

1. `widthwatch` npm package: the engine, typed schema, comparison and native HTML reporter.
2. `@widthwatch/web`: static landing page, documentation and bounded public demo client on GitHub Pages.
3. `@widthwatch/api`: a deliberately small admission API and one in-process browser worker on AWS App Runner.

The package remains the product. The hosted demo is a constrained preview, not a free remote browser farm.

## Continuous-width engine

The first pass samples `minWidth`, `maxWidth`, and an initial coarse step. Each frame emits a layout signature based on stable element geometry and a finding fingerprint. Intervals whose signatures differ are prioritized and bisected until `minStep` or `maxSamples` is reached. The report therefore presents a continuous width timeline without paying for every pixel width.

Screenshots are intentionally captured in one pinned Chromium build. Playwright warns that host OS, browser version, fonts and other environment details affect image output, so baseline and candidate must use the same container.

## Public request path

```text
GitHub Pages → CloudFront → AWS WAF → App Runner (max 1 instance / concurrency 1)
                                           └→ pinned loopback egress proxy → public site
```

CloudFront injects a private origin header; the direct App Runner URL answers scan routes with `404`. WAF provides edge rate limiting and managed common rules. The application then applies separate atomic-in-process client, target, global, queue and job caps. The public surface cannot make AWS scale past one instance.

For a paid or multi-tenant product, replace the in-memory queue with DynamoDB + SQS and run one isolated ECS Fargate task per accepted job. Fargate tasks must remain behind an admission quota and a strict maximum task count; an unbounded queue only delays a cost attack rather than preventing it.

## Release order

A `v*` tag validates the exact artifact, deploys the bounded API, publishes npm through trusted OIDC publishing, deploys GitHub Pages, and creates the GitHub Release. AWS access uses GitHub OIDC and short-lived credentials. Production is a protected GitHub environment.

