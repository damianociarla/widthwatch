# Migration notes

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
