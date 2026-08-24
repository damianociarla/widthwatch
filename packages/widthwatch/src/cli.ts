#!/usr/bin/env node
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseCliOptions } from "./cli-options.js";
import { compareReports } from "./compare.js";
import { loadWidthWatchConfig } from "./config.js";
import { initializeProject } from "./init.js";
import { generateHtmlReport } from "./reporter.js";
import { scanResponsive } from "./scanner.js";
import type { ScanOptions, WidthWatchReport } from "./types.js";
import { PACKAGE_VERSION } from "./version.js";

const help = `widthwatch [url] [options]
widthwatch init

Commands:
  init                  Create widthwatch.config.ts and a reusable GitHub workflow

Options:
  --config <file>       Config path (auto-detects widthwatch.config.ts)
  --output <file>       HTML report path (default: widthwatch-report.html)
  --json <file>         Write the typed JSON report
  --baseline <file>     Compare against a previous JSON report
  --min-width <px>      Minimum width (default: 320)
  --max-width <px>      Maximum width (default: 1440)
  --max-samples <n>     Adaptive sample budget (default: 24)
  --layout-only         Fast viewport probe without scroll sweep
  --reload-per-width    Reload the page at every captured width
  --fail-on-regression  Exit with status 1 when errors regress
  --version             Print package version`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const parsed = parseCliOptions(args);
  if (parsed.help) {
    console.log(help);
    return;
  }
  if (parsed.version) {
    console.log(PACKAGE_VERSION);
    return;
  }
  if (parsed.command === "init") {
    const created = await initializeProject();
    console.log(`WidthWatch initialized:\n${created.map((path) => `  ${path}`).join("\n")}\nCommit a trusted .widthwatch/baseline.json before enabling regression failures.`);
    return;
  }

  const loaded = await loadWidthWatchConfig(parsed.config);
  if (!args.length && !loaded) {
    console.log(help);
    return;
  }
  const configured = loaded?.config;
  const url = parsed.url ?? configured?.url;
  if (!url) throw new Error("A URL is required as an argument, in widthwatch.config.ts, or through WIDTHWATCH_URL.");

  const outputPath = resolve(parsed.output ?? configured?.output ?? "widthwatch-report.html");
  const jsonPath = parsed.json ?? configured?.json;
  const baselinePath = parsed.baseline ?? configured?.baseline;
  const baseline = baselinePath ? JSON.parse(await readFile(resolve(baselinePath), "utf8")) as WidthWatchReport : undefined;
  if (baseline && (parsed.minWidth !== undefined || parsed.maxWidth !== undefined || parsed.maxSamples !== undefined || parsed.layoutOnly || parsed.reloadPerWidth || parsed.fullPage)) {
    throw new Error("A baseline controls the exact width and capture schedule; remove width, sample and capture mode flags.");
  }

  console.log(`WidthWatch · scanning ${url}`);
  const scanOptions: ScanOptions = { ...configured?.scan };
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
      if (baseline.capture.pageReady && (!scanOptions.pageReady || scanOptions.readinessKey !== baseline.capture.readinessKey)) {
        throw new Error("This baseline requires the matching pageReady hook and readinessKey in widthwatch.config.ts.");
      }
    }
  }
  const report = await scanResponsive(url, scanOptions);

  let rendered: WidthWatchReport | ReturnType<typeof compareReports> = report;
  if (baseline) rendered = compareReports(baseline, report, configured?.compare);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, generateHtmlReport(rendered), "utf8");
  if (jsonPath) {
    const resolvedJson = resolve(jsonPath);
    await mkdir(dirname(resolvedJson), { recursive: true });
    await writeFile(resolvedJson, JSON.stringify(report, null, 2), "utf8");
  }
  console.log(`Report: ${outputPath}`);
  console.log(`${report.summary.errors} errors · ${report.summary.warnings} warnings · ${report.frames.length} sampled widths`);
  const failOnRegression = parsed.failOnRegression || configured?.failOnRegression;
  if ("passed" in rendered && !rendered.passed && failOnRegression) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(`WidthWatch: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
