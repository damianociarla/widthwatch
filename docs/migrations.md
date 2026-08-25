# Migration notes

## v0.4.1

This patch improves the standalone reporter without changing report schema, sampling protocol or capture protocol. Existing baselines compatible with v0.4.0 remain compatible with v0.4.1.

Discovery-only findings now precede a compact evidence placeholder on narrow viewports. Visual evidence controls use semantic tabs with Left/Right and Home/End navigation, and the summary metric previously labelled “regression types” is now correctly labelled “regression ranges”. The repository and every workspace now declare the same Node.js `>=22` runtime contract verified by CI on Node.js 22 and 24.

## v0.4.0

WidthWatch now treats finding severity changes as first-class comparison results. Escalations are regressions; de-escalations are exposed separately from resolved findings. Schema-v1 reports that omit the optional canonical `issues` field are reconstructed from both probes and evidence frames.

The reporter timeline is now one accessible interactive graph. Use Arrow keys to move between adjacent probes, Page Up or Page Down to move five samples, and Home or End to reach a range endpoint.

Baselines created by v0.3.0 or earlier use capture protocol 2 and must be recaptured. Baselines created by v0.3.1 already use capture protocol 3 and remain compatible with v0.4.0 when their environment and report schedules match.
