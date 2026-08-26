# Migration notes

## v0.4.11

This patch makes scanner control-plane upgrades transactional without changing report schema, sampling protocol or capture protocol. Existing baselines compatible with v0.4.0–v0.4.10 remain compatible with v0.4.11.

Before installing a candidate template, the release now captures the live CloudFormation template, `PublicScannerEnabled` value and `ControlPlaneRevision`. If state, revision or edge verification fails after installation, the release restores the captured template and parameters, verifies the restored edge contract and remains failed. A rollback that cannot be applied or verified is reported as a critical operational failure rather than being hidden by the original candidate error.

The narrow scanner switch role gains only `cloudformation:GetTemplate` on its existing dedicated stack. Apply the additive `infra/aws/scanner-switch-iam.yml` update before the first v0.4.11 release; no application runtime permission changes. The release reusable workflow no longer inherits caller secrets, and the canary removes its complete temporary response directory.

Every release now parses `scanner-switch.yml` and evaluates both enabled and disabled WAF contracts. Live verification continues to exercise only the preserved state, so a scanner disabled during an incident is never enabled automatically for testing.

## v0.4.10

This patch adds a reproducible scanner control-plane migration without changing report schema, sampling protocol or capture protocol. Existing baselines compatible with v0.4.0–v0.4.9 remain compatible with v0.4.10.

Every release now calls the dedicated `upgrade-scanner-switch.yml` workflow before the application deploy. The workflow accepts only the immutable release tag and SHA, reads the current `PublicScannerEnabled` value, installs the complete versioned `scanner-switch.yml` template through the existing narrow execution role, preserves the state exactly and verifies the installed SHA-256 `ControlPlaneRevision`. The operational enable/disable workflow remains independent and continues to use the previously installed template.

Release validation now requires the tag version to match the root, API, web and npm package manifests, their lockfile entries, OpenAPI metadata and landing JSON-LD before any AWS or npm credentials are obtained. Disabled-state verification now checks the complete `403 scanner_paused` contract: JSON content type and body, landing-origin CORS and `Cache-Control: no-store`.

Existing installations require no manual migration when releasing v0.4.10: the protected release workflow applies and records the control-plane revision. If the upgrade cannot preserve state or verify its revision and edge behavior, application deployment and GitHub Release creation remain blocked.

## v0.4.9

This patch closes release-ref and cross-origin scanner-control gaps without changing report schema, sampling protocol or capture protocol. Existing baselines compatible with v0.4.0–v0.4.8 remain compatible with v0.4.9.

Releases now start only from a pushed stable semantic-version tag. Manual release dispatch was removed; failed releases are resumed with GitHub's native rerun operation. A release gate verifies the exact tag, event commit and ancestry from `main`, and every job checks out the immutable event SHA rather than a caller-controlled ref.

The independent scanner switch returns a JSON `403` with the landing origin's CORS header and `Cache-Control: no-store`; the edge rate limit returns the equivalent JSON/CORS response with status `429`. The browser can therefore distinguish a paused scanner and edge quota from a generic network outage. GitHub deployment branch policies are now reconciled against versioned allowlist manifests: unexpected refs are deleted, missing refs are restored and residual drift fails the policy run.

## v0.4.8

This patch hardens the GitHub/AWS supply chain without changing report schema, sampling protocol or capture protocol. Existing baselines compatible with v0.4.0–v0.4.7 remain compatible with v0.4.8.

Emergency disable no longer reads the operational email secret; enable remains gated by both confirmed regional SNS subscriptions. The ordinary deploy role loses every switch mutation capability—including change-set execution—and retains only `DescribeStacks`. New installations bootstrap the disabled switch once through the dedicated control-plane execution role before an application deploy is allowed. A dedicated `widthwatch-canary` OIDC role can only describe the switch state, and the canary opens or updates one GitHub incident when the public path fails, then closes it after recovery.

All GitHub Actions are pinned to full commit SHAs and Dependabot maintains those references. Repository settings require pinned selected actions, protect `main` with pull requests and both Node CI jobs, protect immutable `v*` release tags, and restrict deployment environments to their intended branch or tag patterns. Existing installations must update `scanner-switch-iam.yml`, set its `CanaryRoleArn` output as `AWS_CANARY_ROLE_ARN` in the `monitoring` environment, and apply the versioned GitHub supply-chain runbook before enabling the scheduled canary.

The hosted landing now distinguishes a paused public scanner and unavailable accepted results from admission rejection.

## v0.4.7

This patch separates emergency scan admission from application deployment without changing report schema, sampling protocol or capture protocol. Existing baselines compatible with v0.4.0–v0.4.6 remain compatible with v0.4.7.

Before the first v0.4.7 release, deploy the additive `infra/aws/scanner-switch-iam.yml` stack against the existing GitHub OIDC provider and deploy role. Configure its `ScannerSwitchRoleArn` and `ScannerSwitchExecutionRoleArn` outputs as protected environment variables `AWS_SCANNER_SWITCH_ROLE_ARN` and `AWS_SCANNER_SWITCH_EXECUTION_ROLE_ARN`. The next API deploy bootstraps `widthwatch-scanner-switch` disabled and updates the ordinary Web ACL to reference it. Confirm both existing SNS email subscriptions, then enable through `scanner-switch.yml`. Do not recreate the alert topics: replacing their subscriptions requires email confirmation again.

The switch workflow updates only the dedicated WAF stack and verifies edge behavior with an exact change ID. Release and manual application deploys no longer accept scanner state. Cold bootstrap and missing configuration are fail-closed.

Hosted reports now return `X-Robots-Tag: noindex, nofollow, noarchive`; the landing and security documentation explicitly describe their seven-day lifecycle and bearer-link access. Hosted failures map to actionable public copy, while completed jobs and admission rejections add redacted operational events and CloudWatch metrics. An hourly external canary crosses the expected enabled or disabled public path.

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
