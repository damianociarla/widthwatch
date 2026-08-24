export interface ParsedCliOptions {
  url?: string;
  output?: string;
  json?: string;
  baseline?: string;
  minWidth?: number;
  maxWidth?: number;
  maxSamples?: number;
  fullPage: boolean;
  failOnRegression: boolean;
  help: boolean;
  version: boolean;
}

const valueOptions: ReadonlyMap<string, "output" | "json" | "baseline" | "minWidth" | "maxWidth" | "maxSamples"> = new Map([
  ["--output", "output"],
  ["--json", "json"],
  ["--baseline", "baseline"],
  ["--min-width", "minWidth"],
  ["--max-width", "maxWidth"],
  ["--max-samples", "maxSamples"],
] as const);

export function parseCliOptions(args: string[]): ParsedCliOptions {
  const parsed: ParsedCliOptions = {
    fullPage: false,
    failOnRegression: false,
    help: false,
    version: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--full-page") { parsed.fullPage = true; continue; }
    if (argument === "--fail-on-regression") { parsed.failOnRegression = true; continue; }
    if (argument === "--help") { parsed.help = true; continue; }
    if (argument === "--version") { parsed.version = true; continue; }
    const key = valueOptions.get(argument);
    if (key) {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value.`);
      index += 1;
      if (key === "minWidth" || key === "maxWidth" || key === "maxSamples") parsed[key] = Number(value);
      else parsed[key] = value;
      continue;
    }
    if (argument.startsWith("-")) throw new Error(`Unknown option: ${argument}`);
    if (parsed.url) throw new Error("Only one URL can be scanned at a time.");
    parsed.url = argument;
  }
  return parsed;
}
