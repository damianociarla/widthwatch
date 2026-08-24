export { scanAtWidths, scanResponsive } from "./scanner.js";
export { compareReports } from "./compare.js";
export { generateHtmlReport } from "./reporter.js";
export { defineConfig, loadWidthWatchConfig } from "./config.js";
export { groupIssuesByRange } from "./issue-ranges.js";
export type {
  CompareOptions,
  ComparisonError,
  ComparisonErrorCode,
  ComparisonReport,
  ElementRef,
  IssueKind,
  LayoutFrame,
  Rect,
  ResponsiveIssue,
  ResponsiveIssueRange,
  ScanOptions,
  Severity,
  VisualDiff,
  WidthTransition,
  WidthWatchReport,
  WidthWatchConfig,
} from "./types.js";
