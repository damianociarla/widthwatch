import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { ElementRef, LayoutFrame, ResponsiveIssue, ScanOptions, WidthTransition, WidthWatchReport } from "./types.js";
import { CAPTURE_PROTOCOL_VERSION, PACKAGE_VERSION } from "./version.js";
import { groupIssuesByRange } from "./issue-ranges.js";

interface ProbeResult {
  document: { width: number; height: number };
  signature: string;
  issues: ResponsiveIssue[];
}

type FrameSignal = Pick<LayoutFrame, "width" | "height" | "document" | "layoutSignature" | "issues" | "durationMs">;

interface ResolvedScanOptions {
  mode: "layout" | "visual";
  exactWidths: number[] | undefined;
  minWidth: number;
  maxWidth: number;
  viewportHeight: number;
  initialStep: number;
  minStep: number;
  maxSamples: number;
  maxCaptureSamples: number;
  maxElements: number;
  maxDomNodes: number;
  timeoutMs: number;
  settleMs: number;
  scrollSweep: boolean;
  maxScrollSteps: number;
  reloadPerWidth: boolean;
  pageReady: ScanOptions["pageReady"] | undefined;
  readinessKey: string | undefined;
  pageReadyTimeoutMs: number;
  screenshot: "viewport" | "full-page";
  imageFormat: "png" | "jpeg";
  imageQuality: number;
  headless: boolean;
  blockResourceTypes: string[];
  hideSelectors: string[];
  maxRequestsPerNavigation: number;
  maxTotalRequests: number;
  proxyServer: string | undefined;
  allowedUrl: ScanOptions["allowedUrl"] | undefined;
}

const defaults: Omit<ResolvedScanOptions, "allowedUrl" | "exactWidths" | "pageReady" | "readinessKey"> = {
  mode: "visual",
  minWidth: 320,
  maxWidth: 1440,
  viewportHeight: 900,
  initialStep: 160,
  minStep: 8,
  maxSamples: 24,
  maxCaptureSamples: 8,
  maxElements: 500,
  maxDomNodes: 10_000,
  timeoutMs: 30_000,
  settleMs: 120,
  scrollSweep: true,
  maxScrollSteps: 20,
  reloadPerWidth: false,
  pageReadyTimeoutMs: 10_000,
  screenshot: "full-page" as const,
  imageFormat: "png" as const,
  imageQuality: 80,
  headless: true,
  blockResourceTypes: ["media"],
  hideSelectors: [] as string[],
  maxRequestsPerNavigation: 500,
  maxTotalRequests: 5_000,
  proxyServer: undefined,
};

export async function scanResponsive(url: string, options: ScanOptions = {}): Promise<WidthWatchReport> {
  const requestedWidths = options.exactWidths ? [...options.exactWidths] : undefined;
  const derivableWidths = requestedWidths?.length && requestedWidths.every(Number.isFinite) ? requestedWidths : undefined;
  const mode = options.mode ?? defaults.mode;
  const config: ResolvedScanOptions = {
    ...defaults,
    ...options,
    mode,
    screenshot: options.screenshot ?? (mode === "visual" ? "full-page" : "viewport"),
    scrollSweep: options.scrollSweep ?? mode === "visual",
    ...(derivableWidths ? {
      minWidth: options.minWidth ?? Math.min(...derivableWidths),
      maxWidth: options.maxWidth ?? Math.max(...derivableWidths),
    } : {}),
    exactWidths: requestedWidths,
    pageReady: options.pageReady,
    readinessKey: options.readinessKey,
    allowedUrl: options.allowedUrl,
    proxyServer: options.proxyServer,
    maxRequestsPerNavigation: options.maxRequestsPerNavigation ?? options.maxRequests ?? defaults.maxRequestsPerNavigation,
    maxTotalRequests: options.maxTotalRequests ?? options.maxRequests ?? defaults.maxTotalRequests,
    maxCaptureSamples: Math.min(
      options.maxCaptureSamples ?? defaults.maxCaptureSamples,
      options.maxSamples ?? defaults.maxSamples,
    ),
  };
  validateOptions(config);
  const normalizedUrl = normalizeUrl(url);
  if (config.allowedUrl && !(await config.allowedUrl(normalizedUrl))) throw new Error("URL rejected by the configured network policy.");

  const started = Date.now();
  const browser = await chromium.launch({ headless: config.headless, ...(config.proxyServer ? { proxy: { server: config.proxyServer } } : {}) });
  let context: BrowserContext | undefined;
  try {
    const requestBudget: RequestBudget = { perNavigation: 0, total: 0 };
    context = await createScanContext(browser, config, requestBudget);
    let page = await context.newPage();
    if (!config.reloadPerWidth) await navigate(page, normalizedUrl, config, requestBudget);

    let frames: Map<number, LayoutFrame>;
    let discoveryWidths: number[];
    let samplingStrategy: NonNullable<WidthWatchReport["sampling"]>["strategy"];
    if (config.exactWidths) {
      frames = new Map();
      for (const width of config.exactWidths) frames.set(width, await captureFrame(page, normalizedUrl, width, config, requestBudget));
      discoveryWidths = [];
      samplingStrategy = "exact";
    } else if (config.mode === "visual") {
      const discovered = await sampleAdaptiveFrames(
        (width) => probeDiscoveryFrame(page, normalizedUrl, width, config, requestBudget),
        config,
      );
      discoveryWidths = [...discovered.keys()].sort((a, b) => a - b);
      const captureWidths = selectVisualCaptureWidths(discovered, config.maxCaptureSamples);
      await context.close();
      context = await createScanContext(browser, config, requestBudget);
      page = await context.newPage();
      if (!config.reloadPerWidth) await navigate(page, normalizedUrl, config, requestBudget);
      frames = new Map();
      for (const width of captureWidths) frames.set(width, await captureFrame(page, normalizedUrl, width, config, requestBudget));
      samplingStrategy = "adaptive-two-pass";
    } else {
      frames = await sampleAdaptiveFrames(
        (width) => captureFrame(page, normalizedUrl, width, config, requestBudget),
        config,
      );
      discoveryWidths = [...frames.keys()].sort((a, b) => a - b);
      samplingStrategy = "adaptive-single-pass";
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
      capture: {
        protocolVersion: CAPTURE_PROTOCOL_VERSION,
        mode: config.mode,
        screenshot: config.screenshot,
        imageFormat: config.imageFormat,
        imageQuality: config.imageQuality,
        scrollSweep: config.scrollSweep,
        maxScrollSteps: config.maxScrollSteps,
        settleMs: config.settleMs,
        reloadPerWidth: config.reloadPerWidth,
        hideSelectors: [...config.hideSelectors].sort(),
        deviceScaleFactor: 1,
        colorScheme: "light",
        reducedMotion: "reduce",
        locale: "en-US",
        timezoneId: "UTC",
        pageReady: Boolean(config.pageReady),
        readinessKey: config.readinessKey ?? null,
      },
      sampling: {
        protocolVersion: 1,
        strategy: samplingStrategy,
        discoveryWidths,
        capturedWidths: orderedFrames.map((frame) => frame.width),
      },
      frames: orderedFrames,
      transitions,
      issueRanges: groupIssuesByRange(orderedFrames.map((frame) => frame.width), issues),
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

export function scanAtWidths(url: string, widths: number[], options: Omit<ScanOptions, "exactWidths"> = {}): Promise<WidthWatchReport> {
  return scanResponsive(url, { ...options, exactWidths: widths });
}

async function sampleAdaptiveFrames<T extends FrameSignal>(
  sample: (width: number) => Promise<T>,
  config: ResolvedScanOptions,
): Promise<Map<number, T>> {
  const frames = new Map<number, T>();
  const refinementsByBand = new Map<number, number>();
  const seeds = seedWidths(config.minWidth, config.maxWidth, config.initialStep);
  const initialWidths = seeds.length <= config.maxSamples
    ? seeds
    : Array.from({ length: config.maxSamples }, (_, index) => seeds[Math.round(index * (seeds.length - 1) / (config.maxSamples - 1))]!);
  for (const width of new Set(initialWidths)) frames.set(width, await sample(width));

  while (frames.size < config.maxSamples) {
    const widths = [...frames.keys()].sort((a, b) => a - b);
    const candidates: Array<{ width: number; priority: number; band: number; span: number }> = [];
    for (let index = 0; index < widths.length - 1; index += 1) {
      const leftWidth = widths[index];
      const rightWidth = widths[index + 1];
      if (leftWidth === undefined || rightWidth === undefined || rightWidth - leftWidth <= config.minStep) continue;
      const left = frames.get(leftWidth)!;
      const right = frames.get(rightWidth)!;
      const changed = left.layoutSignature !== right.layoutSignature || issueFingerprint(left) !== issueFingerprint(right);
      if (!changed) continue;
      const width = Math.floor((leftWidth + rightWidth) / 2);
      const band = Math.min(Math.floor((width - config.minWidth) / config.initialStep), Math.floor((config.maxWidth - config.minWidth) / config.initialStep));
      const refinements = refinementsByBand.get(band) ?? 0;
      const span = rightWidth - leftWidth;
      const priority = transitionScore(left, right) / (1 + refinements) + Math.min(6, span / config.initialStep * 3);
      candidates.push({ width, priority, band, span });
    }
    const next = candidates.sort((a, b) => b.priority - a.priority || b.span - a.span || a.width - b.width)[0];
    if (!next || frames.has(next.width)) break;
    frames.set(next.width, await sample(next.width));
    refinementsByBand.set(next.band, (refinementsByBand.get(next.band) ?? 0) + 1);
  }
  return frames;
}

function selectVisualCaptureWidths(discovered: Map<number, FrameSignal>, target: number): number[] {
  const frames = [...discovered.values()].sort((a, b) => a.width - b.width);
  if (frames.length <= target) return frames.map((frame) => frame.width);
  const selected = new Set<number>([frames[0]!.width, frames.at(-1)!.width]);
  const transitionScores = new Map<number, number>();
  for (let index = 0; index < frames.length - 1; index += 1) {
    const left = frames[index]!;
    const right = frames[index + 1]!;
    if (left.layoutSignature === right.layoutSignature && issueFingerprint(left) === issueFingerprint(right)) continue;
    const score = transitionScore(left, right);
    transitionScores.set(left.width, Math.max(transitionScores.get(left.width) ?? 0, score));
    transitionScores.set(right.width, Math.max(transitionScores.get(right.width) ?? 0, score));
  }
  while (selected.size < target) {
    const candidate = frames
      .filter((frame) => !selected.has(frame.width))
      .map((frame) => {
        const nearest = Math.min(...[...selected].map((width) => Math.abs(width - frame.width)));
        const coverage = nearest / Math.max(1, frames.at(-1)!.width - frames[0]!.width) * 100;
        const issue = frame.issues.reduce((score, finding) => Math.max(score, finding.severity === "error" ? 300 : finding.severity === "warning" ? 180 : 60), 0);
        return { width: frame.width, priority: issue + (transitionScores.get(frame.width) ?? 0) * 4 + coverage };
      })
      .sort((a, b) => b.priority - a.priority || a.width - b.width)[0];
    if (!candidate) break;
    selected.add(candidate.width);
  }
  return [...selected].sort((a, b) => a - b);
}

async function probeDiscoveryFrame(page: Page, url: string, width: number, config: ResolvedScanOptions, budget: RequestBudget): Promise<FrameSignal> {
  const started = Date.now();
  await page.setViewportSize({ width, height: config.viewportHeight });
  if (config.reloadPerWidth) await navigate(page, url, config, budget);
  await preparePage(page, url, width, config, "discovery");
  assertRequestBudget(budget);
  const probe = await page.evaluate(probePage, { width, maxElements: config.maxElements, maxDomNodes: config.maxDomNodes });
  return {
    width,
    height: config.viewportHeight,
    document: probe.document,
    layoutSignature: probe.signature,
    issues: probe.issues,
    durationMs: Date.now() - started,
  };
}

interface RequestBudget {
  perNavigation: number;
  total: number;
  error?: Error;
}

async function createScanContext(browser: Browser, config: ResolvedScanOptions, budget: RequestBudget): Promise<BrowserContext> {
  const context = await browser.newContext({
    viewport: { width: config.minWidth, height: config.viewportHeight },
    reducedMotion: "reduce",
    colorScheme: "light",
    deviceScaleFactor: 1,
    locale: "en-US",
    timezoneId: "UTC",
    serviceWorkers: "block",
  });
  await installNetworkPolicy(context, config, budget);
  return context;
}

async function installNetworkPolicy(context: BrowserContext, config: ResolvedScanOptions, budget: RequestBudget): Promise<void> {
  await context.route("**/*", async (route) => {
    const request = route.request();
    if (config.blockResourceTypes.includes(request.resourceType())) return route.abort("blockedbyclient");
    if (config.allowedUrl && !(await config.allowedUrl(request.url()))) return route.abort("blockedbyclient");
    if (request.isNavigationRequest() && request.resourceType() === "document" && request.frame() === request.frame().page().mainFrame()) budget.perNavigation = 0;
    budget.perNavigation += 1;
    budget.total += 1;
    if (budget.perNavigation > config.maxRequestsPerNavigation) {
      budget.error = new Error(`request budget exceeded for one navigation (${config.maxRequestsPerNavigation} allowed requests). Increase maxRequestsPerNavigation.`);
      return route.abort("blockedbyclient");
    }
    if (budget.total > config.maxTotalRequests) {
      budget.error = new Error(`total request budget exceeded (${config.maxTotalRequests} allowed requests). Increase maxTotalRequests.`);
      return route.abort("blockedbyclient");
    }
    return route.continue();
  });
}

async function navigate(page: Page, url: string, config: ResolvedScanOptions, budget: RequestBudget): Promise<void> {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: config.timeoutMs });
  } catch (error) {
    if (budget.error) throw new Error(`WidthWatch ${budget.error.message}`, { cause: error });
    throw error;
  }
  assertRequestBudget(budget);
}

function assertRequestBudget(budget: RequestBudget): void {
  if (budget.error) throw new Error(`WidthWatch ${budget.error.message}`);
}

async function preparePage(page: Page, url: string, width: number, config: ResolvedScanOptions, phase: "discovery" | "capture"): Promise<void> {
  const stabilizingCss = `*,*::before,*::after{animation-delay:0s!important;animation-duration:0s!important;transition:none!important;caret-color:transparent!important}${config.hideSelectors.map((selector) => `${selector}{visibility:hidden!important}`).join("")}`;
  await page.evaluate((css) => {
    let style = document.querySelector<HTMLStyleElement>("style[data-widthwatch-stability]");
    if (!style) {
      style = document.createElement("style");
      style.dataset.widthwatchStability = "";
      document.head.append(style);
    }
    style.textContent = css;
  }, stabilizingCss);
  if (config.pageReady) await withTimeout(Promise.resolve(config.pageReady(page, { url, width, phase })), config.pageReadyTimeoutMs, "pageReady hook");
  await page.evaluate(async () => { await document.fonts.ready; });
  if (phase === "capture") {
    if (config.scrollSweep) await scrollSweep(page, config.maxScrollSteps, config.settleMs);
    await page.evaluate(async ({ timeoutMs, waitForFullPage }) => {
      const pending = [...document.images].filter((image) => {
        if (image.complete) return false;
        if (waitForFullPage) return true;
        const rect = image.getBoundingClientRect();
        return rect.bottom >= 0 && rect.top <= window.innerHeight && rect.right >= 0 && rect.left <= window.innerWidth;
      });
      if (pending.length) await Promise.race([
        Promise.all(pending.map((image) => new Promise<void>((resolve) => {
          image.addEventListener("load", () => resolve(), { once: true });
          image.addEventListener("error", () => resolve(), { once: true });
        }))),
        new Promise<void>((resolve) => window.setTimeout(resolve, timeoutMs)),
      ]);
      window.scrollTo(0, 0);
    }, { timeoutMs: Math.min(config.timeoutMs, 5_000), waitForFullPage: config.screenshot === "full-page" });
  }
  await page.waitForTimeout(config.settleMs);
}

async function scrollSweep(page: Page, maxSteps: number, settleMs: number): Promise<void> {
  await page.evaluate(async ({ maxSteps, stepDelay }) => {
    const wait = () => new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => window.setTimeout(resolve, stepDelay)));
    });
    const maxY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    const step = maxY ? Math.max(1, Math.ceil(maxY / maxSteps)) : 1;
    for (let y = 0; y < maxY; y += step) {
      window.scrollTo(0, y);
      await wait();
    }
    window.scrollTo(0, maxY);
    await wait();
    window.scrollTo(0, 0);
    await wait();
  }, { maxSteps, stepDelay: Math.min(50, Math.max(0, settleMs)) });
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms.`)), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function captureFrame(page: Page, url: string, width: number, config: ResolvedScanOptions, budget: RequestBudget): Promise<LayoutFrame> {
  const started = Date.now();
  await page.setViewportSize({ width, height: config.viewportHeight });
  if (config.reloadPerWidth) await navigate(page, url, config, budget);
  await preparePage(page, url, width, config, "capture");
  assertRequestBudget(budget);
  const probe = await page.evaluate(probePage, { width, maxElements: config.maxElements, maxDomNodes: config.maxDomNodes });
  const screenshot = config.imageFormat === "jpeg"
    ? await page.screenshot({ fullPage: config.screenshot === "full-page", type: "jpeg", quality: config.imageQuality, animations: "disabled" })
    : await page.screenshot({ fullPage: config.screenshot === "full-page", type: "png", animations: "disabled" });
  return {
    width,
    height: config.viewportHeight,
    document: probe.document,
    layoutSignature: probe.signature,
    issues: probe.issues,
    screenshot: `data:image/${config.imageFormat};base64,${screenshot.toString("base64")}`,
    durationMs: Date.now() - started,
  };
}

function probePage(input: { width: number; maxElements: number; maxDomNodes: number }): ProbeResult {
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

  const all = [...document.querySelectorAll("body *")].slice(0, input.maxDomNodes);
  const snaps: Snap[] = [];
  for (const element of all) {
    if (snaps.length >= input.maxElements) break;
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

  const signatureSource = snaps.slice(0, 120).map((snap) => `${snap.selector}:${Math.round(snap.rect.x / input.width * 20)},${Math.round(snap.rect.y / 8)},${Math.round(snap.rect.width / input.width * 20)},${Math.round(snap.rect.height / 8)}`).join("|");
  let hash = 2166136261;
  for (let index = 0; index < signatureSource.length; index += 1) hash = Math.imul(hash ^ signatureSource.charCodeAt(index), 16777619);
  return { document: { width: documentWidth, height: documentHeight }, signature: (hash >>> 0).toString(36), issues };
}

function seedWidths(min: number, max: number, step: number): number[] {
  const values = new Set<number>([min, max]);
  for (let width = min; width <= max; width += step) values.add(width);
  return [...values].sort((a, b) => a - b);
}

function issueFingerprint(frame: FrameSignal): string {
  return frame.issues.map((issue) => `${issue.kind}:${issue.elements.map((element) => element.selector).join(",")}`).sort().join("|");
}

function transitionScore(left: FrameSignal, right: FrameSignal): number {
  const issueDelta = Math.abs(left.issues.length - right.issues.length) * 10;
  const documentDelta = Math.abs(left.document.height - right.document.height) / 20;
  return (left.layoutSignature === right.layoutSignature ? 0 : 20) + issueDelta + documentDelta;
}

function buildTransitions(frames: LayoutFrame[]): WidthTransition[] {
  return frames.slice(0, -1).map((frame, index) => {
    const next = frames[index + 1]!;
    const score = transitionScore(frame, next);
    return { from: frame.width, to: next.width, changed: frame.layoutSignature !== next.layoutSignature || issueFingerprint(frame) !== issueFingerprint(next), score: Math.round(score * 10) / 10 };
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
  const finiteInteger = (value: number) => Number.isFinite(value) && Number.isInteger(value);
  if (!(["layout", "visual"] as const).includes(config.mode)) throw new Error("mode must be layout or visual.");
  if (!(["viewport", "full-page"] as const).includes(config.screenshot)) throw new Error("screenshot must be viewport or full-page.");
  if (!(["png", "jpeg"] as const).includes(config.imageFormat)) throw new Error("imageFormat must be png or jpeg.");
  if (!finiteInteger(config.imageQuality) || config.imageQuality < 1 || config.imageQuality > 100) throw new Error("imageQuality must be a whole number between 1 and 100.");
  if (typeof config.scrollSweep !== "boolean" || typeof config.reloadPerWidth !== "boolean" || typeof config.headless !== "boolean") throw new Error("scrollSweep, reloadPerWidth and headless must be booleans.");
  if (config.pageReady !== undefined && typeof config.pageReady !== "function") throw new Error("pageReady must be a function.");
  if (config.pageReady && (typeof config.readinessKey !== "string" || !config.readinessKey.trim())) throw new Error("readinessKey is required when pageReady is configured.");
  if (!config.pageReady && config.readinessKey !== undefined) throw new Error("readinessKey requires pageReady.");
  if (!Array.isArray(config.hideSelectors) || config.hideSelectors.some((selector) => typeof selector !== "string")) throw new Error("hideSelectors must be an array of strings.");
  if (!Array.isArray(config.blockResourceTypes) || config.blockResourceTypes.some((type) => typeof type !== "string")) throw new Error("blockResourceTypes must be an array of strings.");
  if (!finiteInteger(config.minWidth) || !finiteInteger(config.maxWidth) || config.minWidth < 240 || config.maxWidth > 3840 || (config.exactWidths ? config.minWidth > config.maxWidth : config.minWidth >= config.maxWidth)) throw new Error("Width range must use whole pixels between 240px and 3840px.");
  if (!finiteInteger(config.viewportHeight) || config.viewportHeight < 240 || config.viewportHeight > 4320) throw new Error("viewportHeight must be a whole number between 240 and 4320.");
  if (!finiteInteger(config.initialStep) || config.initialStep < 1 || config.initialStep > 3840) throw new Error("initialStep must be a whole number between 1 and 3840.");
  if (!finiteInteger(config.minStep) || config.minStep < 1 || config.minStep > 3840) throw new Error("minStep must be a whole number between 1 and 3840.");
  if (!finiteInteger(config.maxSamples) || config.maxSamples < 2 || config.maxSamples > 100) throw new Error("maxSamples must be a whole number between 2 and 100.");
  if (!finiteInteger(config.maxCaptureSamples) || config.maxCaptureSamples < 2 || config.maxCaptureSamples > 100) throw new Error("maxCaptureSamples must be a whole number between 2 and 100.");
  if (!finiteInteger(config.maxElements) || config.maxElements < 1 || config.maxElements > 10_000) throw new Error("maxElements must be a whole number between 1 and 10000.");
  if (!finiteInteger(config.maxDomNodes) || config.maxDomNodes < config.maxElements || config.maxDomNodes > 100_000) throw new Error("maxDomNodes must be a whole number between maxElements and 100000.");
  if (!finiteInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 300_000) throw new Error("timeoutMs must be a whole number between 1 and 300000.");
  if (!finiteInteger(config.settleMs) || config.settleMs < 0 || config.settleMs > 30_000) throw new Error("settleMs must be a whole number between 0 and 30000.");
  if (!finiteInteger(config.maxScrollSteps) || config.maxScrollSteps < 1 || config.maxScrollSteps > 100) throw new Error("maxScrollSteps must be a whole number between 1 and 100.");
  if (!finiteInteger(config.pageReadyTimeoutMs) || config.pageReadyTimeoutMs < 1 || config.pageReadyTimeoutMs > 300_000) throw new Error("pageReadyTimeoutMs must be a whole number between 1 and 300000.");
  if (!finiteInteger(config.maxRequestsPerNavigation) || config.maxRequestsPerNavigation < 1 || config.maxRequestsPerNavigation > 10_000) throw new Error("maxRequestsPerNavigation must be a whole number between 1 and 10000.");
  if (!finiteInteger(config.maxTotalRequests) || config.maxTotalRequests < 1 || config.maxTotalRequests > 100_000) throw new Error("maxTotalRequests must be a whole number between 1 and 100000.");
  if (config.exactWidths) {
    if (config.exactWidths.length < 1 || config.exactWidths.length > 100) throw new Error("exactWidths must contain between 1 and 100 widths.");
    if (config.exactWidths.some((width) => !finiteInteger(width) || width < 240 || width > 3840)) throw new Error("exactWidths must contain whole pixels between 240 and 3840.");
    if (new Set(config.exactWidths).size !== config.exactWidths.length) throw new Error("exactWidths must not contain duplicates.");
    if (config.exactWidths.some((width) => width < config.minWidth || width > config.maxWidth)) throw new Error("exactWidths must stay inside the configured width range.");
    config.exactWidths.sort((a, b) => a - b);
  }
}
