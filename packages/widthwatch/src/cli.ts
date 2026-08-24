#!/usr/bin/env node
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseCliOptions } from "./cli-options.js";
import { compareReports } from "./compare.js";
import { generateHtmlReport } from "./reporter.js";
import { scanResponsive } from "./scanner.js";
import type { WidthWatchReport } from "./types.js";
import { PACKAGE_VERSION } from "./version.js";

const args = process.argv.slice(2);
const parsed = parseCliOptions(args);
if (parsed.help || args.length === 0) {
  console.log(`widthwatch <url> [options]\n\nOptions:\n  --output <file>       HTML report path (default: widthwatch-report.html)\n  --json <file>         Write the typed JSON report\n  --baseline <file>     Compare against a previous JSON report\n  --min-width <px>      Minimum width (default: 320)\n  --max-width <px>      Maximum width (default: 1440)\n  --max-samples <n>     Adaptive sample budget (default: 24)\n  --layout-only         Fast viewport probe without scroll sweep\n  --reload-per-width    Reload the page at every captured width\n  --fail-on-regression  Exit with status 1 when errors regress\n  --version             Print package version`);
  process.exit(0);
}
if (parsed.version) {
  console.log(PACKAGE_VERSION);
  process.exit(0);
}

const url = parsed.url;
if (!url) throw new Error("A URL is required.");
const outputPath = resolve(parsed.output ?? "widthwatch-report.html");
const jsonPath = parsed.json;
const baseline = parsed.baseline ? JSON.parse(await readFile(resolve(parsed.baseline), "utf8")) as WidthWatchReport : undefined;
if (baseline && (parsed.minWidth !== undefined || parsed.maxWidth !== undefined || parsed.maxSamples !== undefined || parsed.layoutOnly || parsed.reloadPerWidth || parsed.fullPage)) {
  throw new Error("A baseline controls the exact width and capture schedule; remove width, sample and capture mode flags.");
}
if (baseline?.capture?.pageReady) throw new Error("This baseline requires a pageReady hook; compare it through the TypeScript API with the matching readinessKey.");

console.log(`WidthWatch · scanning ${url}`);
const scanOptions: import("./types.js").ScanOptions = {};
if (parsed.minWidth !== undefined) scanOptions.minWidth = parsed.minWidth;
if (parsed.maxWidth !== undefined) scanOptions.maxWidth = parsed.maxWidth;
if (parsed.maxSamples !== undefined) scanOptions.maxSamples = parsed.maxSamples;
if (parsed.layoutOnly) scanOptions.mode = "layout";
if (!parsed.layoutOnly || parsed.reloadPerWidth) scanOptions.reloadPerWidth = true;
if (parsed.fullPage) scanOptions.screenshot = "full-page";
if (baseline) {
  scanOptions.exactWidths = baseline.frames.map((frame) => frame.width);
  scanOptions.viewportHeight = baseline.range.height;
  if (baseline.capture) {
    scanOptions.mode = baseline.capture.mode;
    scanOptions.screenshot = baseline.capture.screenshot;
    scanOptions.scrollSweep = baseline.capture.scrollSweep;
    scanOptions.reloadPerWidth = baseline.capture.reloadPerWidth;
  }
}
const report = await scanResponsive(url, scanOptions);

let rendered: WidthWatchReport | ReturnType<typeof compareReports> = report;
if (baseline) {
  rendered = compareReports(baseline, report, { includeDiffImages: true });
}
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, generateHtmlReport(rendered), "utf8");
if (jsonPath) {
  const resolvedJson = resolve(jsonPath);
  await mkdir(dirname(resolvedJson), { recursive: true });
  await writeFile(resolvedJson, JSON.stringify(report, null, 2), "utf8");
}
console.log(`Report: ${outputPath}`);
console.log(`${report.summary.errors} errors · ${report.summary.warnings} warnings · ${report.frames.length} sampled widths`);
if ("passed" in rendered && !rendered.passed && parsed.failOnRegression) process.exitCode = 1;
