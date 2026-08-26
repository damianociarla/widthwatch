#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const releaseTag = process.argv[2] ?? "";
const expected = releaseTag.startsWith("v") ? releaseTag.slice(1) : "";
const root = fileURLToPath(new URL("../..", import.meta.url));
const rootUrl = pathToFileURL(`${root}/`);
const mismatches = [];

async function readJson(path) {
  return JSON.parse(await readFile(new URL(path, rootUrl), "utf8"));
}

async function requireJsonVersion(path, label) {
  const value = (await readJson(path)).version;
  if (value !== expected) mismatches.push(`${label}=${String(value)}`);
}

await Promise.all([
  requireJsonVersion("package.json", "root package"),
  requireJsonVersion("apps/api/package.json", "API package"),
  requireJsonVersion("apps/web/package.json", "web package"),
  requireJsonVersion("packages/widthwatch/package.json", "npm package"),
]);

const lock = await readJson("package-lock.json");
for (const [path, label] of [
  ["", "lock root"],
  ["apps/api", "lock API"],
  ["apps/web", "lock web"],
  ["packages/widthwatch", "lock npm"],
]) {
  const value = lock.packages?.[path]?.version;
  if (value !== expected) mismatches.push(`${label}=${String(value)}`);
}

const openApi = await readFile(new URL("docs/openapi.yml", rootUrl), "utf8");
const openApiVersion = openApi.match(/^info:.*\bversion:\s*([0-9]+\.[0-9]+\.[0-9]+)/m)?.[1];
if (openApiVersion !== expected) mismatches.push(`OpenAPI=${String(openApiVersion)}`);

const landing = await readFile(new URL("apps/web/index.html", rootUrl), "utf8");
const landingVersion = landing.match(/"softwareVersion":"([^"]+)"/)?.[1];
if (landingVersion !== expected) mismatches.push(`JSON-LD=${String(landingVersion)}`);

if (mismatches.length > 0) {
  console.error(`Release version mismatch for ${releaseTag}: expected ${expected}; ${mismatches.join(", ")}.`);
  process.exit(1);
}

console.log(`Release version contract verified: ${releaseTag} matches every package and public metadata surface.`);
