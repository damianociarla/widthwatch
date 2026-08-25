import type { LayoutFrame, LayoutProbe, ResponsiveIssue, WidthWatchReport } from "./types.js";
import { issueIdentity, issueOccurrenceKey } from "./issue-identity.js";

export function mergeReportIssues(probes: LayoutProbe[], frames: LayoutFrame[]): ResponsiveIssue[] {
  const issues = new Map<string, ResponsiveIssue>();
  for (const issue of probes.flatMap((probe) => probe.issues)) {
    issues.set(issueOccurrenceKey(issue), { ...issue, evidence: "discovery" });
  }
  for (const issue of frames.flatMap((frame) => frame.issues)) {
    issues.set(issueOccurrenceKey(issue), { ...issue, evidence: "capture" });
  }
  return [...issues.values()].sort((a, b) => a.width - b.width || a.kind.localeCompare(b.kind) || issueIdentity(a).localeCompare(issueIdentity(b)));
}

export function getReportIssues(report: WidthWatchReport): ResponsiveIssue[] {
  if (report.issues) return [...new Map(report.issues.map((issue) => [issueOccurrenceKey(issue), issue])).values()];
  return mergeReportIssues(report.probes?.length ? report.probes : report.frames, report.frames);
}
