import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { WidthWatchConfig } from "./types.js";

const configNames = ["widthwatch.config.ts", "widthwatch.config.mts", "widthwatch.config.js", "widthwatch.config.mjs"] as const;

export function defineConfig(config: WidthWatchConfig): WidthWatchConfig {
  return config;
}

export async function loadWidthWatchConfig(
  explicitPath?: string,
  cwd = process.cwd(),
): Promise<{ config: WidthWatchConfig; path: string; directory: string } | undefined> {
  const path = explicitPath ? resolve(cwd, explicitPath) : await findConfig(cwd);
  if (!path) return undefined;
  try {
    await access(path);
  } catch {
    throw new Error(`WidthWatch config not found: ${path}`);
  }
  const imported = (await import(`${pathToFileURL(path).href}?widthwatch=${Date.now()}`)) as { default?: unknown };
  const config = imported.default;
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("WidthWatch config must default-export an object.");
  const typed = config as Partial<WidthWatchConfig>;
  if (typed.version !== 1) throw new Error("WidthWatch config version must be 1.");
  if (typed.url !== undefined && typeof typed.url !== "string") throw new Error("WidthWatch config url must be a string.");
  for (const key of ["output", "json", "baseline"] as const) {
    if (typed[key] !== undefined && typeof typed[key] !== "string") throw new Error(`WidthWatch config ${key} must be a string.`);
  }
  if (typed.failOnRegression !== undefined && typeof typed.failOnRegression !== "boolean")
    throw new Error("WidthWatch config failOnRegression must be a boolean.");
  if (typed.scan !== undefined && (!typed.scan || typeof typed.scan !== "object" || Array.isArray(typed.scan)))
    throw new Error("WidthWatch config scan must be an object.");
  if (typed.compare !== undefined && (!typed.compare || typeof typed.compare !== "object" || Array.isArray(typed.compare)))
    throw new Error("WidthWatch config compare must be an object.");
  return { config: typed as WidthWatchConfig, path, directory: dirname(path) };
}

async function findConfig(cwd: string): Promise<string | undefined> {
  for (const name of configNames) {
    const path = resolve(cwd, name);
    try {
      await access(path);
      return path;
    } catch {
      // Try the next supported filename.
    }
  }
  return undefined;
}
