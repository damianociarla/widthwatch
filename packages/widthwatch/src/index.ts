export { scanAtWidths, scanResponsive } from "./scanner.js";
export { compareReports } from "./compare.js";
export { generateHtmlReport } from "./reporter.js";
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
  ScanOptions,
  Severity,
  VisualDiff,
  WidthTransition,
  WidthWatchReport,
} from "./types.js";
