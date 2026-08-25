# Migration notes

## v0.4.6

This patch adds hosted operability without changing report schema, sampling protocol or capture protocol. Existing baselines compatible with v0.4.0–v0.4.5 remain compatible with v0.4.6.

Failed hosted jobs retain the generic public message and now add one non-sensitive `failureCode`: `transfer_limit`, `request_limit`, `timeout`, `browser_failure`, `network_failure` or `internal_failure`. A production adapter writes a redacted JSON job outcome containing only job ID, phase, duration and optional numeric transfer metadata. CloudWatch metric filters and alarms consume this stable event; raw errors, target addresses and page data are never emitted.

Hosted egress environment values are validated when the runner is constructed. Invalid, fractional, zero or inconsistent byte limits now prevent startup instead of allowing a healthy process that fails every scan.

AWS deployments now require the budget/operational alert email and provision regional SNS routing plus App Runner, failed-scan, transfer-limit, CloudFront and WAF alarms. The protected `WIDTHWATCH_PUBLIC_SCANNER_ENABLED` GitHub variable controls a highest-priority WAF emergency rule. Follow the [incident runbook](runbooks/public-scanner.md) to disable or restore new scans without taking health, status or existing reports offline.

## v0.4.5

This patch hard-bounds hosted transfer volume without changing report schema, sampling protocol or capture protocol. Existing baselines compatible with v0.4.0–v0.4.4 remain compatible with v0.4.5.

Every hosted job now owns a bounded egress session with a fresh pinned proxy and byte allowance. Plain HTTP rejects an oversized declared body before transfer and meters chunked bodies up to 10 MiB per response. Opaque CONNECT traffic is counted in both directions up to 25 MiB per tunnel, including the initial head. Both protocols share a 75 MiB job total. Exceeding any limit closes all session sockets, aborts Chromium through the new additive `ScanOptions.signal`, and records a sanitized failed job; the next queued scan starts with a new allowance. Limits can be overridden with `MAX_BYTES_PER_RESPONSE`, `MAX_BYTES_PER_TUNNEL` and `MAX_TRANSFERRED_BYTES` byte values.

The previously accepted CLI flag `--full-page` now appears in help. Its combination with `--layout-only` is explicitly supported: capture the full document while retaining layout mode's disabled scroll sweep.

## v0.4.4

This patch strengthens hosted HTTPS egress verification without changing report schema, sampling protocol or capture protocol. Existing baselines compatible with v0.4.0–v0.4.3 remain compatible with v0.4.4.

The pinned proxy's successful `CONNECT` path now runs against a real local TCP upstream. The suite verifies the 200 handshake, pre-read head forwarding, bidirectional bytes, fallback from an unreachable first address, and closure propagation in both directions. Production networking is unchanged; an injected connection adapter only maps the privileged port to an ephemeral test listener. The focused egress gate rises to 95% lines, 80% branches and 80% functions.

## v0.4.3

This patch hardens the hosted HTTP admission path without changing report schema, sampling protocol or capture protocol. Existing baselines compatible with v0.4.0–v0.4.2 remain compatible with v0.4.3.

Empty or malformed JSON now returns `400 invalid_json`, valid JSON with an invalid URL shape returns `400 invalid_url`, and request bodies above 2048 bytes return `413 payload_too_large`. HTTP admission is now instantiable without process startup and is tested through real ephemeral HTTP listeners. DNS policy and pinned egress use injected test adapters, while production retains system DNS and the same SSRF policy.

Coverage is enforced independently for the engine, hosted API, critical HTTP/network/egress modules, and the browser-executed web client. The OpenAPI server now identifies the bounded public CloudFront endpoint.

## v0.4.2

This patch improves the public product surface and repository quality gates without changing report schema, sampling protocol or capture protocol. Existing baselines compatible with v0.4.0 and v0.4.1 remain compatible with v0.4.2.

On narrow viewports, discovery-only results now omit the empty evidence viewer and show a single concise diagnostic. The landing discloses the bounded five-sample public schedule before a scan begins and uses a stable npm availability label instead of a patch-sensitive hero badge. Biome lint and format checks, minimum Node coverage thresholds, axe accessibility audits, and desktop plus mobile Chromium reporter E2E tests now run in CI.

## v0.4.1

This patch improves the standalone reporter without changing report schema, sampling protocol or capture protocol. Existing baselines compatible with v0.4.0 remain compatible with v0.4.1.

Discovery-only findings now precede a compact evidence placeholder on narrow viewports. Visual evidence controls use semantic tabs with Left/Right and Home/End navigation, and the summary metric previously labelled “regression types” is now correctly labelled “regression ranges”. The repository and every workspace now declare the same Node.js `>=22` runtime contract verified by CI on Node.js 22 and 24.

## v0.4.0

WidthWatch now treats finding severity changes as first-class comparison results. Escalations are regressions; de-escalations are exposed separately from resolved findings. Schema-v1 reports that omit the optional canonical `issues` field are reconstructed from both probes and evidence frames.

The reporter timeline is now one accessible interactive graph. Use Arrow keys to move between adjacent probes, Page Up or Page Down to move five samples, and Home or End to reach a range endpoint.

Baselines created by v0.3.0 or earlier use capture protocol 2 and must be recaptured. Baselines created by v0.3.1 already use capture protocol 3 and remain compatible with v0.4.0 when their environment and report schedules match.
