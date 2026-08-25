# Migration notes

## v0.4.0

WidthWatch now treats finding severity changes as first-class comparison results. Escalations are regressions; de-escalations are exposed separately from resolved findings. Schema-v1 reports that omit the optional canonical `issues` field are reconstructed from both probes and evidence frames.

The reporter timeline is now one accessible interactive graph. Use Arrow keys to move between adjacent probes, Page Up or Page Down to move five samples, and Home or End to reach a range endpoint.

Baselines created by v0.3.0 or earlier use capture protocol 2 and must be recaptured. Baselines created by v0.3.1 already use capture protocol 3 and remain compatible with v0.4.0 when their environment and report schedules match.
