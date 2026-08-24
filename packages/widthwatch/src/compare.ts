import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import type { CompareOptions, ComparisonReport, ResponsiveIssue, VisualDiff, WidthWatchReport } from "./types.js";

export function compareReports(baseline: WidthWatchReport, candidate: WidthWatchReport, options: CompareOptions = {}): ComparisonReport {
  const threshold = options.threshold ?? 0.2;
  const maxDiffRatio = options.maxDiffRatio ?? 0.001;
  const baselineByWidth = new Map(baseline.frames.map((frame) => [frame.width, frame]));
  const diffs: VisualDiff[] = [];
  const regressions: ResponsiveIssue[] = [];

  for (const frame of candidate.frames) {
    const expected = baselineByWidth.get(frame.width);
    if (!expected) continue;
    const actualPng = decodePng(frame.screenshot);
    const expectedPng = decodePng(expected.screenshot);
    if (actualPng.width !== expectedPng.width || actualPng.height !== expectedPng.height) continue;
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
  for (const issue of candidate.frames.flatMap((frame) => frame.issues)) {
    if (!baselineIssues.has(issueKey(issue))) regressions.push(issue);
  }
  return { version: 1, baseline, candidate, diffs, regressions, passed: regressions.every((issue) => issue.severity !== "error") };
}

function decodePng(dataUrl: string): PNG {
  const encoded = dataUrl.slice(dataUrl.indexOf(",") + 1);
  return PNG.sync.read(Buffer.from(encoded, "base64"));
}

function issueKey(issue: ResponsiveIssue): string {
  return `${issue.width}:${issue.kind}:${issue.elements.map((element) => element.selector).join(",")}`;
}

