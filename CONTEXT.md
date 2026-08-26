# WidthWatch domain language

## Probe

A geometry observation at one viewport width. A probe contains layout signature, document dimensions and findings, but no screenshot requirement.

## Evidence

A captured frame at one viewport width. Evidence contains the probe geometry plus a screenshot and may reveal additional findings after visual readiness and scroll sweep.

## Finding

A deterministic responsive issue identified by kind and sorted element selectors. One finding can be observed at several widths.

## Canonical issues

The report-level union of findings from probes and evidence. Occurrences are deduplicated by width and finding identity; evidence wins when both phases reproduce the same occurrence.

## Severity change

A comparison of the same finding occurrence across baseline and candidate. Higher candidate severity is an escalation and therefore a regression; lower candidate severity is a de-escalation, not a resolved finding.

## Report schedule

The pair of ordered width schedules used by a report: all probe widths and the evidence subset. CI reproduces both schedules and fails closed when either differs.

## HTTP admission

The request lifecycle that accepts a hosted public scan. HTTP admission owns JSON limits, origin verification, CORS, public-target policy, capacity, rate limits, queue state and status semantics; it delegates responsive scanning and report persistence to adapters.

## Bounded egress session

The job-scoped execution lifecycle for one hosted scan. A bounded egress session owns its pinned proxy, byte allowance, browser cancellation and transport cleanup. Plain HTTP responses have individual body limits; opaque HTTPS connections have tunnel limits; both protocols share one hard transferred-byte limit for the job.

## Job outcome

The sanitized terminal result of an accepted hosted scan. A completed job outcome contains bounded timing, probe and capture counts. A failed job outcome contains a stable failure code, phase and timing, plus bounded transfer metadata only when applicable. It never contains a target URL, hostname, query string, page content, raw error message or stack trace. HTTP admission exposes the safe failure code and sends every outcome to one operational adapter.

## Admission rejection

A sanitized refusal before a hosted job exists. It records only a stable capacity or rate-limit code; it never records the client address, target, body or raw error. Admission rejection and job outcome share the operational event adapter but remain different domain events.

## Scanner control plane

The fail-closed emergency boundary for public scan admission. A dedicated WAF rule group owns only exact `POST /v1/scans`; its switch-only stack and least-privilege workflow are independent of image publication, App Runner and ordinary edge deployments. Disable never depends on alerting. Enable requires confirmed regional alert subscriptions. Edge refusals preserve the public HTTP contract with explicit JSON status, landing-origin CORS and no-store semantics.

## Control-plane revision

The SHA-256 identity of the versioned scanner-control template installed by a protected release. A control-plane upgrade is transactional: it snapshots the installed template, state and revision before mutation; identifies every accepted mutation with a client request token; resolves its root stack event and `StackStatus` to a terminal outcome; installs and verifies the candidate; and restores and verifies the snapshot after any semantic verification failure while leaving the release red. An accepted operation whose outcome cannot be resolved is critical and must not trigger an overlapping mutation. The operational switch changes only admission state with the previously installed template and revision.

## Operational canary

The scheduled external observer of the hosted public path. It may read the expected scanner-control state and exercise public HTTP endpoints, but it cannot mutate AWS resources. One open GitHub incident represents a continuing failure and is closed only after a successful recovery run.

## Public report link

The bearer URL for one hosted standalone report. S3 storage remains private, but anyone who has the unguessable application URL can open the report until it expires. The report can reproduce page title, URL, screenshots and visible content, so no secrecy is promised and indexing is explicitly discouraged at the HTTP boundary.
