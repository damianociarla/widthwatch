import type { ScanOptions } from "./types.js";

export interface ParsedCliOptions {
  command: "scan" | "init";
  url?: string;
  config?: string;
  output?: string;
  json?: string;
  baseline?: string;
  minWidth?: number;
  maxWidth?: number;
  maxSamples?: number;
  maxCaptures?: number;
  fullPage: boolean;
  layoutOnly: boolean;
  reloadPerWidth?: true;
  failOnRegression: boolean;
  help: boolean;
  version: boolean;
}

const valueOptions: ReadonlyMap<string, "config" | "output" | "json" | "baseline" | "minWidth" | "maxWidth" | "maxSamples" | "maxCaptures"> = new Map([
  ["--config", "config"],
  ["--output", "output"],
  ["--json", "json"],
  ["--baseline", "baseline"],
  ["--min-width", "minWidth"],
  ["--max-width", "maxWidth"],
  ["--max-samples", "maxSamples"],
  ["--max-captures", "maxCaptures"],
] as const);

export function parseCliOptions(args: string[]): ParsedCliOptions {
  const parsed: ParsedCliOptions = {
    command: args[0] === "init" ? "init" : "scan",
    fullPage: false,
    layoutOnly: false,
    failOnRegression: false,
    help: false,
    version: false,
  };
  for (let index = parsed.command === "init" ? 1 : 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--full-page") { parsed.fullPage = true; continue; }
    if (argument === "--layout-only") { parsed.layoutOnly = true; continue; }
    if (argument === "--reload-per-width") { parsed.reloadPerWidth = true; continue; }
    if (argument === "--fail-on-regression") { parsed.failOnRegression = true; continue; }
    if (argument === "--help") { parsed.help = true; continue; }
    if (argument === "--version") { parsed.version = true; continue; }
    const key = valueOptions.get(argument);
    if (key) {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value.`);
      index += 1;
      if (key === "minWidth" || key === "maxWidth" || key === "maxSamples" || key === "maxCaptures") parsed[key] = Number(value);
      else parsed[key] = value;
      continue;
    }
    if (argument.startsWith("-")) throw new Error(`Unknown option: ${argument}`);
    if (parsed.command === "init") throw new Error(`Unknown init argument: ${argument}`);
    if (parsed.url) throw new Error("Only one URL can be scanned at a time.");
    parsed.url = argument;
  }
  return parsed;
}

export function applyCliScanOptions(configured: ScanOptions | undefined, parsed: ParsedCliOptions): ScanOptions {
  const scanOptions: ScanOptions = { ...configured };
  if (parsed.minWidth !== undefined) scanOptions.minWidth = parsed.minWidth;
  if (parsed.maxWidth !== undefined) scanOptions.maxWidth = parsed.maxWidth;
  if (parsed.maxSamples !== undefined) scanOptions.maxSamples = parsed.maxSamples;
  if (parsed.maxCaptures !== undefined) scanOptions.maxCaptureSamples = parsed.maxCaptures;
  if (parsed.layoutOnly) scanOptions.mode = "layout";
  if (parsed.reloadPerWidth) scanOptions.reloadPerWidth = true;
  else if (!parsed.layoutOnly && configured?.reloadPerWidth === undefined) scanOptions.reloadPerWidth = true;
  if (parsed.fullPage) scanOptions.screenshot = "full-page";
  return scanOptions;
}
