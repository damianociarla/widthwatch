#!/usr/bin/env node
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { compareReports } from "./compare.js";
import { generateHtmlReport } from "./reporter.js";
import { scanResponsive } from "./scanner.js";
import type { WidthWatchReport } from "./types.js";

const args = process.argv.slice(2);
if (args.includes("--help") || args.length === 0) {
  console.log(`widthwatch <url> [options]\n\nOptions:\n  --output <file>       HTML report path (default: widthwatch-report.html)\n  --json <file>         Write the typed JSON report\n  --baseline <file>     Compare against a previous JSON report\n  --min-width <px>      Minimum width (default: 320)\n  --max-width <px>      Maximum width (default: 1440)\n  --max-samples <n>     Adaptive sample budget (default: 24)\n  --full-page           Capture full document screenshots\n  --fail-on-regression  Exit with status 1 when errors regress\n  --version             Print package version`);
  process.exit(0);
}
if (args.includes("--version")) {
  console.log("0.1.0");
  process.exit(0);
}

const url = args.find((arg) => !arg.startsWith("-"));
if (!url) throw new Error("A URL is required.");
const value = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const numberValue = (name: string): number | undefined => {
  const raw = value(name);
  return raw === undefined ? undefined : Number(raw);
};
const outputPath = resolve(value("--output") ?? "widthwatch-report.html");
const jsonPath = value("--json");

console.log(`WidthWatch · scanning ${url}`);
const scanOptions: import("./types.js").ScanOptions = {};
const minWidth = numberValue("--min-width");
const maxWidth = numberValue("--max-width");
const maxSamples = numberValue("--max-samples");
if (minWidth !== undefined) scanOptions.minWidth = minWidth;
if (maxWidth !== undefined) scanOptions.maxWidth = maxWidth;
if (maxSamples !== undefined) scanOptions.maxSamples = maxSamples;
if (args.includes("--full-page")) scanOptions.screenshot = "full-page";
const report = await scanResponsive(url, scanOptions);

let rendered: WidthWatchReport | ReturnType<typeof compareReports> = report;
const baselinePath = value("--baseline");
if (baselinePath) {
  const baseline = JSON.parse(await readFile(resolve(baselinePath), "utf8")) as WidthWatchReport;
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
if ("passed" in rendered && !rendered.passed && args.includes("--fail-on-regression")) process.exitCode = 1;
