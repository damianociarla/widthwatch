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
