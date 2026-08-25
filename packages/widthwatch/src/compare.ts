import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import type { CompareOptions, ComparisonError, ComparisonReport, LayoutProbe, ResponsiveIssue, VisualDiff, WidthWatchReport } from "./types.js";
import { groupIssuesByRange } from "./issue-ranges.js";
import { issueOccurrenceKey } from "./issue-identity.js";
import { getReportIssues } from "./report-issues.js";

export function compareReports(baseline: WidthWatchReport, candidate: WidthWatchReport, options: CompareOptions = {}): ComparisonReport {
  const threshold = options.threshold ?? 0.2;
  const maxDiffRatio = options.maxDiffRatio ?? 0.001;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error("threshold must be between 0 and 1.");
  if (!Number.isFinite(maxDiffRatio) || maxDiffRatio < 0 || maxDiffRatio > 1) throw new Error("maxDiffRatio must be between 0 and 1.");
  const baselineByWidth = new Map(baseline.frames.map((frame) => [frame.width, frame]));
  const candidateByWidth = new Map(candidate.frames.map((frame) => [frame.width, frame]));
  const baselineProbes = reportProbes(baseline);
  const candidateProbes = reportProbes(candidate);
  const diffs: VisualDiff[] = [];
  const regressions: ResponsiveIssue[] = [];
  const validationErrors = validateCompatibility(baseline, candidate, baselineByWidth, candidateByWidth, baselineProbes, candidateProbes);

  for (const expected of baseline.frames) {
    const frame = candidateByWidth.get(expected.width);
    if (!frame) continue;
    let actualPng: PNG;
    let expectedPng: PNG;
    try {
      actualPng = decodePng(frame.screenshot);
      expectedPng = decodePng(expected.screenshot);
    } catch {
      validationErrors.push({ code: "invalid-screenshot", width: frame.width, message: `Frame ${frame.width}px contains an invalid PNG screenshot.` });
      continue;
    }
    if (actualPng.width !== expectedPng.width || actualPng.height !== expectedPng.height) {
      validationErrors.push({
        code: "image-dimensions-mismatch",
        width: frame.width,
        message: `Frame ${frame.width}px image dimensions differ: baseline is ${expectedPng.width}×${expectedPng.height}, candidate is ${actualPng.width}×${actualPng.height}.`,
      });
      continue;
    }
    const output = new PNG({ width: actualPng.width, height: actualPng.height });
    const changedPixels = pixelmatch(expectedPng.data, actualPng.data, output.data, actualPng.width, actualPng.height, { threshold });
    const ratio = changedPixels / (actualPng.width * actualPng.height);
    diffs.push({
      width: frame.width,
      changedPixels,
      ratio,
      ...(options.includeDiffImages ? { diffScreenshot: `data:image/png;base64,${PNG.sync.write(output).toString("base64")}` } : {}),
    });
    if (ratio > maxDiffRatio) {
      regressions.push({
        id: `visual-diff-${frame.width}`,
        kind: "visual-diff",
        severity: "error",
        width: frame.width,
        message: `${(ratio * 100).toFixed(2)}% of pixels differ from the baseline.`,
        elements: [],
        metrics: { changedPixels, ratio },
      });
    }
  }

  const baselineFindings = getReportIssues(baseline);
  const candidateFindings = getReportIssues(candidate);
  const baselineIssues = new Map(baselineFindings.map((issue) => [issueKey(issue), issue]));
  const candidateIssues = new Map(candidateFindings.map((issue) => [issueKey(issue), issue]));
  const escalated: NonNullable<ComparisonReport["escalated"]> = [];
  const deescalated: NonNullable<ComparisonReport["deescalated"]> = [];
  for (const issue of candidateFindings) {
    const previous = baselineIssues.get(issueKey(issue));
    if (!previous) {
      regressions.push(issue);
    } else if (severityRank(issue.severity) > severityRank(previous.severity)) {
      escalated.push({ baseline: previous, candidate: issue });
      regressions.push(issue);
    } else if (severityRank(issue.severity) < severityRank(previous.severity)) {
      deescalated.push({ baseline: previous, candidate: issue });
    }
  }
  const resolved = baselineFindings.filter((issue) => !candidateIssues.has(issueKey(issue)));
  const valid = validationErrors.length === 0;
  return {
    version: 1,
    baseline,
    candidate,
    diffs,
    regressions,
    resolved,
    escalated,
    deescalated,
    regressionRanges: groupIssuesByRange(
      candidateProbes.map((probe) => probe.width),
      regressions,
    ),
    settings: { threshold, maxDiffRatio },
    valid,
    validationErrors,
    passed: valid && regressions.every((issue) => issue.severity !== "error"),
  };
}

function validateCompatibility(
  baseline: WidthWatchReport,
  candidate: WidthWatchReport,
  baselineByWidth: Map<number, WidthWatchReport["frames"][number]>,
  candidateByWidth: Map<number, WidthWatchReport["frames"][number]>,
  baselineProbes: LayoutProbe[],
  candidateProbes: LayoutProbe[],
): ComparisonError[] {
  const errors: ComparisonError[] = [];
  if (baseline.range.min !== candidate.range.min || baseline.range.max !== candidate.range.max || baseline.range.height !== candidate.range.height) {
    errors.push({
      code: "range-mismatch",
      message: `Scan ranges differ: baseline is ${baseline.range.min}–${baseline.range.max}×${baseline.range.height}, candidate is ${candidate.range.min}–${candidate.range.max}×${candidate.range.height}.`,
    });
  }
  const environmentKeys = ["browser", "platform"] as const;
  const changedEnvironment = environmentKeys.filter((key) => baseline.environment[key] !== candidate.environment[key]);
  if (changedEnvironment.length) {
    errors.push({ code: "environment-mismatch", message: `Rendering environments differ in: ${changedEnvironment.join(", ")}.` });
  }
  const captureKeys = [
    "protocolVersion",
    "mode",
    "screenshot",
    "imageFormat",
    "imageQuality",
    "scrollSweep",
    "maxScrollSteps",
    "settleMs",
    "reloadPerWidth",
    "hideSelectors",
    "deviceScaleFactor",
    "colorScheme",
    "reducedMotion",
    "locale",
    "timezoneId",
    "pageReady",
    "readinessKey",
  ] as const;
  const changedCapture =
    !baseline.capture || !candidate.capture
      ? captureKeys
      : captureKeys.filter((key) => JSON.stringify(baseline.capture[key]) !== JSON.stringify(candidate.capture[key]));
  if (changedCapture.length) {
    errors.push({ code: "capture-mismatch", message: `Capture settings differ or are missing in: ${changedCapture.join(", ")}.` });
  }
  const baselineProbeWidths = baselineProbes.map((probe) => probe.width);
  const candidateProbeWidths = candidateProbes.map((probe) => probe.width);
  if (new Set(baselineProbeWidths).size !== baselineProbeWidths.length || new Set(candidateProbeWidths).size !== candidateProbeWidths.length) {
    errors.push({ code: "duplicate-width", message: "A report contains duplicate probe widths." });
  } else if (JSON.stringify(baselineProbeWidths) !== JSON.stringify(candidateProbeWidths)) {
    errors.push({
      code: "probe-schedule-mismatch",
      message: "Discovery probe schedules differ; reproduce the baseline probe schedule before comparing geometry findings.",
    });
  }
  if (baselineByWidth.size !== baseline.frames.length) errors.push({ code: "duplicate-width", message: "Baseline contains duplicate frame widths." });
  if (candidateByWidth.size !== candidate.frames.length) errors.push({ code: "duplicate-width", message: "Candidate contains duplicate frame widths." });
  for (const frame of baseline.frames) {
    const actual = candidateByWidth.get(frame.width);
    if (!actual) {
      errors.push({ code: "missing-candidate-frame", width: frame.width, message: `Candidate is missing the required ${frame.width}px frame.` });
      continue;
    }
    if (frame.height !== actual.height)
      errors.push({
        code: "viewport-mismatch",
        width: frame.width,
        message: `Frame ${frame.width}px viewport heights differ: baseline is ${frame.height}px, candidate is ${actual.height}px.`,
      });
  }
  for (const frame of candidate.frames) {
    if (!baselineByWidth.has(frame.width))
      errors.push({ code: "unexpected-candidate-frame", width: frame.width, message: `Candidate contains an unexpected ${frame.width}px frame.` });
  }
  return errors;
}

function reportProbes(report: WidthWatchReport): LayoutProbe[] {
  return report.probes?.length ? report.probes : report.frames;
}

function decodePng(dataUrl: string): PNG {
  const encoded = dataUrl.slice(dataUrl.indexOf(",") + 1);
  return PNG.sync.read(Buffer.from(encoded, "base64"));
}

function issueKey(issue: ResponsiveIssue): string {
  return issueOccurrenceKey(issue);
}

function severityRank(severity: ResponsiveIssue["severity"]): number {
  return severity === "error" ? 2 : severity === "warning" ? 1 : 0;
}
