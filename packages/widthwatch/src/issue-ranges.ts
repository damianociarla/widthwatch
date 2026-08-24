import type { ResponsiveIssue, ResponsiveIssueRange, Severity } from "./types.js";

export function groupIssuesByRange(widths: number[], issues: ResponsiveIssue[]): ResponsiveIssueRange[] {
  const orderedWidths = [...new Set(widths)].sort((a, b) => a - b);
  const widthIndex = new Map(orderedWidths.map((width, index) => [width, index]));
  const grouped = new Map<string, ResponsiveIssue[]>();
  for (const issue of issues) {
    const key = issueIdentity(issue);
    const values = grouped.get(key) ?? [];
    values.push(issue);
    grouped.set(key, values);
  }

  const ranges: ResponsiveIssueRange[] = [];
  for (const [identity, values] of grouped) {
    const ordered = values
      .filter((issue) => widthIndex.has(issue.width))
      .sort((a, b) => (widthIndex.get(a.width) ?? 0) - (widthIndex.get(b.width) ?? 0));
    let current: ResponsiveIssue[] = [];
    for (const issue of ordered) {
      const previous = current.at(-1);
      if (previous && (widthIndex.get(issue.width) ?? 0) !== (widthIndex.get(previous.width) ?? 0) + 1) {
        ranges.push(toRange(identity, current, ranges.length, orderedWidths, widthIndex));
        current = [];
      }
      current.push(issue);
    }
    if (current.length) ranges.push(toRange(identity, current, ranges.length, orderedWidths, widthIndex));
  }
  return ranges.sort((a, b) => a.from - b.from || severityRank(b.severity) - severityRank(a.severity) || a.kind.localeCompare(b.kind));
}

function issueIdentity(issue: ResponsiveIssue): string {
  return `${issue.kind}:${issue.elements.map((element) => element.selector).sort().join("|")}`;
}

function toRange(identity: string, issues: ResponsiveIssue[], index: number, orderedWidths: number[], widthIndex: Map<number, number>): ResponsiveIssueRange {
  const first = issues[0]!;
  const sampledWidths = issues.map((issue) => issue.width);
  const firstIndex = widthIndex.get(Math.min(...sampledWidths));
  const lastIndex = widthIndex.get(Math.max(...sampledWidths));
  return {
    id: `${first.kind}-${hash(identity)}-${index}`,
    kind: first.kind,
    severity: issues.reduce<Severity>((severity, issue) => severityRank(issue.severity) > severityRank(severity) ? issue.severity : severity, first.severity),
    from: Math.min(...sampledWidths),
    to: Math.max(...sampledWidths),
    sampledWidths,
    occurrences: issues.length,
    ...(firstIndex !== undefined && firstIndex > 0 ? { cleanBefore: orderedWidths[firstIndex - 1] } : {}),
    ...(lastIndex !== undefined && lastIndex < orderedWidths.length - 1 ? { cleanAfter: orderedWidths[lastIndex + 1] } : {}),
    message: first.message,
    elements: first.elements,
  };
}

function severityRank(severity: Severity): number {
  return severity === "error" ? 2 : severity === "warning" ? 1 : 0;
}

function hash(value: string): string {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) result = Math.imul(result ^ value.charCodeAt(index), 16777619);
  return (result >>> 0).toString(36);
}
