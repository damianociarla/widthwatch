# WidthWatch domain language

## Probe

A geometry observation at one viewport width. A probe contains layout signature, document dimensions and findings, but no screenshot requirement.

## Evidence

A captured frame at one viewport width. Evidence contains the probe geometry plus a screenshot and may reveal additional findings after visual readiness and scroll sweep.

## Finding

A deterministic responsive issue identified by kind and sorted element selectors. One finding can be observed at several widths.

## Canonical issues

The report-level union of findings from probes and evidence. Occurrences are deduplicated by width and finding identity; evidence wins when both phases reproduce the same occurrence.

## Report schedule

The pair of ordered width schedules used by a report: all probe widths and the evidence subset. CI reproduces both schedules and fails closed when either differs.
