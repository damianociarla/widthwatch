import { chromium, type BrowserContext, type Page } from "playwright";
import type { ElementRef, LayoutFrame, ResponsiveIssue, ScanOptions, WidthTransition, WidthWatchReport } from "./types.js";

const PACKAGE_VERSION = "0.1.0";

interface ProbeResult {
  document: { width: number; height: number };
  signature: string;
  issues: ResponsiveIssue[];
}

interface ResolvedScanOptions {
  minWidth: number;
  maxWidth: number;
  viewportHeight: number;
  initialStep: number;
  minStep: number;
  maxSamples: number;
  maxElements: number;
  timeoutMs: number;
  settleMs: number;
  screenshot: "viewport" | "full-page";
  headless: boolean;
  blockResourceTypes: string[];
  hideSelectors: string[];
  maxRequests: number;
  proxyServer: string | undefined;
  allowedUrl: ScanOptions["allowedUrl"] | undefined;
}

const defaults: Omit<ResolvedScanOptions, "allowedUrl"> = {
  minWidth: 320,
  maxWidth: 1440,
  viewportHeight: 900,
  initialStep: 160,
  minStep: 8,
  maxSamples: 24,
  maxElements: 500,
  timeoutMs: 30_000,
  settleMs: 120,
  screenshot: "viewport" as const,
  headless: true,
  blockResourceTypes: ["media"],
  hideSelectors: [] as string[],
  maxRequests: 500,
  proxyServer: undefined,
};

export async function scanResponsive(url: string, options: ScanOptions = {}): Promise<WidthWatchReport> {
  const config: ResolvedScanOptions = { ...defaults, ...options, allowedUrl: options.allowedUrl, proxyServer: options.proxyServer };
  validateOptions(config);
  const normalizedUrl = normalizeUrl(url);
  if (config.allowedUrl && !(await config.allowedUrl(normalizedUrl))) throw new Error("URL rejected by the configured network policy.");

  const started = Date.now();
  const browser = await chromium.launch({ headless: config.headless, ...(config.proxyServer ? { proxy: { server: config.proxyServer } } : {}) });
  let context: BrowserContext | undefined;
  try {
    context = await browser.newContext({
      viewport: { width: config.minWidth, height: config.viewportHeight },
      reducedMotion: "reduce",
      colorScheme: "light",
      serviceWorkers: "block",
    });
    await installNetworkPolicy(context, config);
    const page = await context.newPage();
    await page.goto(normalizedUrl, { waitUntil: "domcontentloaded", timeout: config.timeoutMs });
    await stabilizePage(page, config.hideSelectors, config.settleMs);

    const frames = new Map<number, LayoutFrame>();
    const initialWidths = seedWidths(config.minWidth, config.maxWidth, config.initialStep);
    for (const width of initialWidths) {
      if (frames.size >= config.maxSamples) break;
      frames.set(width, await captureFrame(page, width, config));
    }

    while (frames.size < config.maxSamples) {
      const widths = [...frames.keys()].sort((a, b) => a - b);
      const candidates: Array<{ width: number; priority: number }> = [];
      for (let index = 0; index < widths.length - 1; index += 1) {
        const leftWidth = widths[index];
        const rightWidth = widths[index + 1];
        if (leftWidth === undefined || rightWidth === undefined || rightWidth - leftWidth <= config.minStep) continue;
        const left = frames.get(leftWidth)!;
        const right = frames.get(rightWidth)!;
        const changed = left.layoutSignature !== right.layoutSignature || issueFingerprint(left) !== issueFingerprint(right);
        if (changed) candidates.push({ width: Math.floor((leftWidth + rightWidth) / 2), priority: transitionScore(left, right) });
      }
      const next = candidates.sort((a, b) => b.priority - a.priority)[0];
      if (!next || frames.has(next.width)) break;
      frames.set(next.width, await captureFrame(page, next.width, config));
    }

    const orderedFrames = [...frames.values()].sort((a, b) => a.width - b.width);
    const transitions = buildTransitions(orderedFrames);
    addLayoutJumpIssues(orderedFrames, transitions);
    const issues = orderedFrames.flatMap((frame) => frame.issues);
    return {
      version: 1,
      url: normalizedUrl,
      title: await page.title(),
      scannedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      range: { min: config.minWidth, max: config.maxWidth, height: config.viewportHeight },
      environment: { browser: `Chromium ${browser.version()}`, platform: process.platform, packageVersion: PACKAGE_VERSION },
      frames: orderedFrames,
      transitions,
      summary: {
        errors: issues.filter((issue) => issue.severity === "error").length,
        warnings: issues.filter((issue) => issue.severity === "warning").length,
        info: issues.filter((issue) => issue.severity === "info").length,
        sampledWidths: orderedFrames.length,
      },
    };
  } finally {
    await context?.close();
    await browser.close();
  }
}

async function installNetworkPolicy(context: BrowserContext, config: ResolvedScanOptions): Promise<void> {
  let requestCount = 0;
  await context.route("**/*", async (route) => {
    const request = route.request();
    requestCount += 1;
    if (requestCount > config.maxRequests) return route.abort("blockedbyclient");
    if (config.blockResourceTypes.includes(request.resourceType())) return route.abort("blockedbyclient");
    if (config.allowedUrl && !(await config.allowedUrl(request.url()))) return route.abort("blockedbyclient");
    return route.continue();
  });
}

async function stabilizePage(page: Page, hideSelectors: string[], settleMs: number): Promise<void> {
  await page.addStyleTag({
    content: `*,*::before,*::after{animation-delay:0s!important;animation-duration:0s!important;transition:none!important;caret-color:transparent!important}${hideSelectors.map((selector) => `${selector}{visibility:hidden!important}`).join("")}`,
  });
  await page.evaluate(async () => {
    await document.fonts.ready;
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(settleMs);
}

async function captureFrame(page: Page, width: number, config: ResolvedScanOptions): Promise<LayoutFrame> {
  const started = Date.now();
  await page.setViewportSize({ width, height: config.viewportHeight });
  await page.waitForTimeout(config.settleMs);
  const probe = await page.evaluate(probePage, { width, maxElements: config.maxElements });
  const screenshot = await page.screenshot({ fullPage: config.screenshot === "full-page", type: "png", animations: "disabled" });
  return {
    width,
    height: config.viewportHeight,
    document: probe.document,
    layoutSignature: probe.signature,
    issues: probe.issues,
    screenshot: `data:image/png;base64,${screenshot.toString("base64")}`,
    durationMs: Date.now() - started,
  };
}

function probePage(input: { width: number; maxElements: number }): ProbeResult {
  type Snap = ElementRef & { element: Element; clientWidth: number; clientHeight: number; scrollWidth: number; scrollHeight: number; overflowX: string; overflowY: string };
  const round = (value: number) => Math.round(value * 10) / 10;
  const visible = (element: Element, rect: DOMRect, style: CSSStyleDeclaration) =>
    rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0;
  const selectorFor = (element: Element): string => {
    if (element.id) return `#${CSS.escape(element.id)}`;
    const testId = element.getAttribute("data-testid");
    if (testId) return `[data-testid="${CSS.escape(testId)}"]`;
    const parts: string[] = [];
    let current: Element | null = element;
    while (current && parts.length < 4) {
      let part = current.tagName.toLowerCase();
      const parent: Element | null = current.parentElement;
      if (parent) {
        const siblings = [...parent.children].filter((child) => child.tagName === current!.tagName);
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      }
      parts.unshift(part);
      current = parent;
    }
    return parts.join(" > ");
  };
  const ref = (snap: Snap): ElementRef => ({
    selector: snap.selector,
    tagName: snap.tagName,
    ...(snap.text ? { text: snap.text } : {}),
    rect: snap.rect,
  });
  const issue = (kind: ResponsiveIssue["kind"], severity: ResponsiveIssue["severity"], message: string, elements: ElementRef[], suffix: string, metrics?: Record<string, number>): ResponsiveIssue => ({
    id: `${kind}-${input.width}-${suffix}`,
    kind,
    severity,
    width: input.width,
    message,
    elements,
    ...(metrics ? { metrics } : {}),
  });

  const all = [...document.querySelectorAll("body *")].slice(0, input.maxElements);
  const snaps: Snap[] = [];
  for (const element of all) {
    if (element.closest("[data-widthwatch-ignore]")) continue;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    if (!visible(element, rect, style)) continue;
    const text = (element.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 90);
    snaps.push({
      element,
      selector: selectorFor(element),
      tagName: element.tagName.toLowerCase(),
      ...(text ? { text } : {}),
      rect: { x: round(rect.x), y: round(rect.y), width: round(rect.width), height: round(rect.height) },
      clientWidth: (element as HTMLElement).clientWidth,
      clientHeight: (element as HTMLElement).clientHeight,
      scrollWidth: (element as HTMLElement).scrollWidth,
      scrollHeight: (element as HTMLElement).scrollHeight,
      overflowX: style.overflowX,
      overflowY: style.overflowY,
    });
  }

  const issues: ResponsiveIssue[] = [];
  const documentWidth = Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0);
  const documentHeight = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0);
  if (documentWidth > input.width + 1) {
    issues.push(issue("document-overflow", "error", `The document is ${documentWidth - input.width}px wider than the viewport.`, [], "document", { overflowPx: documentWidth - input.width }));
  }

  for (const snap of snaps) {
    const right = snap.rect.x + snap.rect.width;
    const meaningfulLeaf = snap.element.matches("h1,h2,h3,h4,h5,h6,p,li,a,button,input,select,textarea,img") && !snap.element.closest("[aria-hidden=true]");
    if (meaningfulLeaf && right > input.width + 2 && snap.rect.x < input.width) {
      issues.push(issue("element-overflow", "warning", "Element crosses the right viewport edge.", [ref(snap)], snap.selector, { overflowPx: round(right - input.width) }));
    }
    const hasText = Boolean(snap.text) && snap.element.children.length === 0;
    const clippedX = snap.scrollWidth > snap.clientWidth + 1 && ["hidden", "clip"].includes(snap.overflowX);
    const clippedY = snap.scrollHeight > snap.clientHeight + 1 && ["hidden", "clip"].includes(snap.overflowY);
    if (hasText && (clippedX || clippedY)) {
      issues.push(issue("clipped-text", "error", "Rendered text is clipped by its box.", [ref(snap)], snap.selector, { hiddenWidth: Math.max(0, snap.scrollWidth - snap.clientWidth), hiddenHeight: Math.max(0, snap.scrollHeight - snap.clientHeight) }));
    }
  }

  const overlapCandidates = snaps.filter((snap) => snap.element.children.length === 0 && (snap.text || snap.element.matches("img,svg,button,input,select,textarea,a"))).slice(0, 180);
  let overlapCount = 0;
  for (let a = 0; a < overlapCandidates.length && overlapCount < 25; a += 1) {
    for (let b = a + 1; b < overlapCandidates.length && overlapCount < 25; b += 1) {
      const first = overlapCandidates[a];
      const second = overlapCandidates[b];
      if (!first || !second || first.element.contains(second.element) || second.element.contains(first.element)) continue;
      const width = Math.min(first.rect.x + first.rect.width, second.rect.x + second.rect.width) - Math.max(first.rect.x, second.rect.x);
      const height = Math.min(first.rect.y + first.rect.height, second.rect.y + second.rect.height) - Math.max(first.rect.y, second.rect.y);
      if (width <= 2 || height <= 2) continue;
      const intersection = width * height;
      const smaller = Math.min(first.rect.width * first.rect.height, second.rect.width * second.rect.height);
      const ratio = smaller ? intersection / smaller : 0;
      if (ratio < 0.18) continue;
      issues.push(issue("overlap", ratio > 0.55 ? "error" : "warning", "Visible leaf elements overlap.", [ref(first), ref(second)], `${a}-${b}`, { overlapRatio: round(ratio) }));
      overlapCount += 1;
    }
  }

  const signatureSource = snaps.slice(0, 120).map((snap) => `${snap.selector}:${Math.round(snap.rect.x / 4)},${Math.round(snap.rect.y / 4)},${Math.round(snap.rect.width / 4)},${Math.round(snap.rect.height / 4)}`).join("|");
  let hash = 2166136261;
  for (let index = 0; index < signatureSource.length; index += 1) hash = Math.imul(hash ^ signatureSource.charCodeAt(index), 16777619);
  return { document: { width: documentWidth, height: documentHeight }, signature: (hash >>> 0).toString(36), issues };
}

function seedWidths(min: number, max: number, step: number): number[] {
  const values = new Set<number>([min, max]);
  for (let width = min; width <= max; width += step) values.add(width);
  return [...values].sort((a, b) => a - b);
}

function issueFingerprint(frame: LayoutFrame): string {
  return frame.issues.map((issue) => `${issue.kind}:${issue.elements.map((element) => element.selector).join(",")}`).sort().join("|");
}

function transitionScore(left: LayoutFrame, right: LayoutFrame): number {
  const issueDelta = Math.abs(left.issues.length - right.issues.length) * 10;
  const documentDelta = Math.abs(left.document.height - right.document.height) / 20;
  return (left.layoutSignature === right.layoutSignature ? 0 : 20) + issueDelta + documentDelta;
}

function buildTransitions(frames: LayoutFrame[]): WidthTransition[] {
  return frames.slice(0, -1).map((frame, index) => {
    const next = frames[index + 1]!;
    const score = transitionScore(frame, next);
    return { from: frame.width, to: next.width, changed: frame.layoutSignature !== next.layoutSignature, score: Math.round(score * 10) / 10 };
  });
}

function addLayoutJumpIssues(frames: LayoutFrame[], transitions: WidthTransition[]): void {
  for (const transition of transitions) {
    if (!transition.changed || transition.to - transition.from > 24 || transition.score < 45) continue;
    const frame = frames.find((candidate) => candidate.width === transition.to);
    if (!frame) continue;
    frame.issues.push({
      id: `layout-jump-${transition.from}-${transition.to}`,
      kind: "layout-jump",
      severity: "info",
      width: transition.to,
      message: `A strong layout discontinuity occurs between ${transition.from}px and ${transition.to}px.`,
      elements: [],
      metrics: { score: transition.score },
    });
  }
}

function normalizeUrl(value: string): string {
  const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Only credential-free HTTP(S) URLs are supported.");
  return url.toString();
}

function validateOptions(config: ResolvedScanOptions): void {
  if (config.minWidth < 240 || config.maxWidth > 3840 || config.minWidth >= config.maxWidth) throw new Error("Width range must be between 240px and 3840px.");
  if (config.maxSamples < 2 || config.maxSamples > 100) throw new Error("maxSamples must be between 2 and 100.");
}
