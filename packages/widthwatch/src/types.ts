export type Severity = "info" | "warning" | "error";

export type IssueKind =
  | "document-overflow"
  | "element-overflow"
  | "clipped-text"
  | "overlap"
  | "layout-jump"
  | "visual-diff";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ElementRef {
  selector: string;
  tagName: string;
  text?: string;
  rect: Rect;
}

export interface ResponsiveIssue {
  id: string;
  kind: IssueKind;
  severity: Severity;
  width: number;
  message: string;
  elements: ElementRef[];
  metrics?: Record<string, number>;
}

export interface LayoutFrame {
  width: number;
  height: number;
  document: { width: number; height: number };
  layoutSignature: string;
  issues: ResponsiveIssue[];
  screenshot: string;
  durationMs: number;
}

export interface WidthTransition {
  from: number;
  to: number;
  changed: boolean;
  score: number;
}

export interface WidthWatchReport {
  version: 1;
  url: string;
  title: string;
  scannedAt: string;
  durationMs: number;
  range: { min: number; max: number; height: number };
  environment: { browser: string; platform: string; packageVersion: string };
  frames: LayoutFrame[];
  transitions: WidthTransition[];
  summary: { errors: number; warnings: number; info: number; sampledWidths: number };
}

export interface VisualDiff {
  width: number;
  changedPixels: number;
  ratio: number;
  diffScreenshot?: string;
}

export interface ComparisonReport {
  version: 1;
  baseline: WidthWatchReport;
  candidate: WidthWatchReport;
  diffs: VisualDiff[];
  regressions: ResponsiveIssue[];
  passed: boolean;
}

export interface ScanOptions {
  minWidth?: number;
  maxWidth?: number;
  viewportHeight?: number;
  initialStep?: number;
  minStep?: number;
  maxSamples?: number;
  maxElements?: number;
  timeoutMs?: number;
  settleMs?: number;
  screenshot?: "viewport" | "full-page";
  headless?: boolean;
  blockResourceTypes?: string[];
  hideSelectors?: string[];
  maxRequests?: number;
  proxyServer?: string;
  allowedUrl?: (url: string) => boolean | Promise<boolean>;
}

export interface CompareOptions {
  threshold?: number;
  maxDiffRatio?: number;
  includeDiffImages?: boolean;
}
