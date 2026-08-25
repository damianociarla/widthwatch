import type { ResponsiveIssue } from "./types.js";

export function issueIdentity(issue: ResponsiveIssue): string {
  return `${issue.kind}:${issue.elements.map((element) => element.selector).sort().join("|")}`;
}

export function issueOccurrenceKey(issue: ResponsiveIssue): string {
  return `${issue.width}:${issueIdentity(issue)}`;
}
