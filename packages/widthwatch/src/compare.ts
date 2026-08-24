import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import type { CompareOptions, ComparisonError, ComparisonReport, ResponsiveIssue, VisualDiff, WidthWatchReport } from "./types.js";
import { groupIssuesByRange } from "./issue-ranges.js";

export function compareReports(baseline: WidthWatchReport, candidate: WidthWatchReport, options: CompareOptions = {}): ComparisonReport {
  const threshold = options.threshold ?? 0.2;
  const maxDiffRatio = options.maxDiffRatio ?? 0.001;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error("threshold must be between 0 and 1.");
  if (!Number.isFinite(maxDiffRatio) || maxDiffRatio < 0 || maxDiffRatio > 1) throw new Error("maxDiffRatio must be between 0 and 1.");
  const baselineByWidth = new Map(baseline.frames.map((frame) => [frame.width, frame]));
  const candidateByWidth = new Map(candidate.frames.map((frame) => [frame.width, frame]));
  const diffs: VisualDiff[] = [];
  const regressions: ResponsiveIssue[] = [];
  const validationErrors = validateCompatibility(baseline, candidate, baselineByWidth, candidateByWidth);

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

  const baselineIssues = new Set(baseline.frames.flatMap((frame) => frame.issues.map(issueKey)));
  const candidateIssues = new Set(candidate.frames.flatMap((frame) => frame.issues.map(issueKey)));
  for (const issue of candidate.frames.flatMap((frame) => frame.issues)) {
    if (!baselineIssues.has(issueKey(issue))) regressions.push(issue);
  }
  const resolved = baseline.frames.flatMap((frame) => frame.issues).filter((issue) => !candidateIssues.has(issueKey(issue)));
  const valid = validationErrors.length === 0;
  return {
    version: 1,
    baseline,
    candidate,
    diffs,
    regressions,
    resolved,
    regressionRanges: groupIssuesByRange(candidate.frames.map((frame) => frame.width), regressions),
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
): ComparisonError[] {
  const errors: ComparisonError[] = [];
  if (baseline.range.min !== candidate.range.min || baseline.range.max !== candidate.range.max || baseline.range.height !== candidate.range.height) {
    errors.push({ code: "range-mismatch", message: `Scan ranges differ: baseline is ${baseline.range.min}–${baseline.range.max}×${baseline.range.height}, candidate is ${candidate.range.min}–${candidate.range.max}×${candidate.range.height}.` });
  }
  const environmentKeys = ["browser", "platform", "packageVersion"] as const;
  const changedEnvironment = environmentKeys.filter((key) => baseline.environment[key] !== candidate.environment[key]);
  if (changedEnvironment.length) {
    errors.push({ code: "environment-mismatch", message: `Rendering environments differ in: ${changedEnvironment.join(", ")}.` });
  }
  const captureKeys = ["mode", "screenshot", "imageFormat", "scrollSweep", "reloadPerWidth", "pageReady", "readinessKey"] as const;
  const changedCapture = !baseline.capture || !candidate.capture ? captureKeys : captureKeys.filter((key) => baseline.capture[key] !== candidate.capture[key]);
  if (changedCapture.length) {
    errors.push({ code: "capture-mismatch", message: `Capture settings differ or are missing in: ${changedCapture.join(", ")}.` });
  }
  if (baselineByWidth.size !== baseline.frames.length) errors.push({ code: "duplicate-width", message: "Baseline contains duplicate frame widths." });
  if (candidateByWidth.size !== candidate.frames.length) errors.push({ code: "duplicate-width", message: "Candidate contains duplicate frame widths." });
  for (const frame of baseline.frames) {
    const actual = candidateByWidth.get(frame.width);
    if (!actual) {
      errors.push({ code: "missing-candidate-frame", width: frame.width, message: `Candidate is missing the required ${frame.width}px frame.` });
      continue;
    }
    if (frame.height !== actual.height) errors.push({ code: "viewport-mismatch", width: frame.width, message: `Frame ${frame.width}px viewport heights differ: baseline is ${frame.height}px, candidate is ${actual.height}px.` });
  }
  for (const frame of candidate.frames) {
    if (!baselineByWidth.has(frame.width)) errors.push({ code: "unexpected-candidate-frame", width: frame.width, message: `Candidate contains an unexpected ${frame.width}px frame.` });
  }
  return errors;
}

function decodePng(dataUrl: string): PNG {
  const encoded = dataUrl.slice(dataUrl.indexOf(",") + 1);
  return PNG.sync.read(Buffer.from(encoded, "base64"));
}

function issueKey(issue: ResponsiveIssue): string {
  return `${issue.width}:${issue.kind}:${issue.elements.map((element) => element.selector).join(",")}`;
}
