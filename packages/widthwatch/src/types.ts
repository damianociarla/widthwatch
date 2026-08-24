import type { Page } from "playwright";

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

export interface ResponsiveIssueRange {
  id: string;
  kind: IssueKind;
  severity: Severity;
  from: number;
  to: number;
  sampledWidths: number[];
  occurrences: number;
  cleanBefore?: number;
  cleanAfter?: number;
  message: string;
  elements: ElementRef[];
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
  capture: {
    protocolVersion: number;
    mode: "layout" | "visual";
    screenshot: "viewport" | "full-page";
    imageFormat?: "png" | "jpeg";
    imageQuality: number;
    scrollSweep: boolean;
    maxScrollSteps: number;
    settleMs: number;
    reloadPerWidth: boolean;
    hideSelectors: string[];
    deviceScaleFactor: number;
    colorScheme: "light" | "dark" | "no-preference";
    reducedMotion: "reduce" | "no-preference";
    locale: string;
    timezoneId: string;
    pageReady: boolean;
    readinessKey: string | null;
  };
  frames: LayoutFrame[];
  transitions: WidthTransition[];
  issueRanges?: ResponsiveIssueRange[];
  summary: { errors: number; warnings: number; info: number; sampledWidths: number };
}

export interface VisualDiff {
  width: number;
  changedPixels: number;
  ratio: number;
  diffScreenshot?: string;
}

export type ComparisonErrorCode =
  | "range-mismatch"
  | "environment-mismatch"
  | "capture-mismatch"
  | "duplicate-width"
  | "missing-candidate-frame"
  | "unexpected-candidate-frame"
  | "viewport-mismatch"
  | "image-dimensions-mismatch"
  | "invalid-screenshot";

export interface ComparisonError {
  code: ComparisonErrorCode;
  message: string;
  width?: number;
}

export interface ComparisonReport {
  version: 1;
  baseline: WidthWatchReport;
  candidate: WidthWatchReport;
  diffs: VisualDiff[];
  regressions: ResponsiveIssue[];
  resolved?: ResponsiveIssue[];
  regressionRanges?: ResponsiveIssueRange[];
  settings?: { threshold: number; maxDiffRatio: number };
  valid: boolean;
  validationErrors: ComparisonError[];
  passed: boolean;
}

export interface ScanOptions {
  mode?: "layout" | "visual";
  exactWidths?: number[];
  minWidth?: number;
  maxWidth?: number;
  viewportHeight?: number;
  initialStep?: number;
  minStep?: number;
  maxSamples?: number;
  maxElements?: number;
  maxDomNodes?: number;
  timeoutMs?: number;
  settleMs?: number;
  scrollSweep?: boolean;
  maxScrollSteps?: number;
  reloadPerWidth?: boolean;
  pageReady?: (page: Page, context: { url: string; width: number }) => void | Promise<void>;
  readinessKey?: string;
  pageReadyTimeoutMs?: number;
  screenshot?: "viewport" | "full-page";
  imageFormat?: "png" | "jpeg";
  imageQuality?: number;
  headless?: boolean;
  blockResourceTypes?: string[];
  hideSelectors?: string[];
  /** @deprecated Use maxRequestsPerNavigation and maxTotalRequests. */
  maxRequests?: number;
  maxRequestsPerNavigation?: number;
  maxTotalRequests?: number;
  proxyServer?: string;
  allowedUrl?: (url: string) => boolean | Promise<boolean>;
}

export interface CompareOptions {
  threshold?: number;
  maxDiffRatio?: number;
  includeDiffImages?: boolean;
}

export interface WidthWatchConfig {
  version: 1;
  url?: string;
  output?: string;
  json?: string;
  baseline?: string;
  failOnRegression?: boolean;
  scan?: ScanOptions;
  compare?: CompareOptions;
}
