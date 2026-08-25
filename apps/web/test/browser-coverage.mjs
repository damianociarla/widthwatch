import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import v8toIstanbul from "v8-to-istanbul";

const root = fileURLToPath(new URL("../dist", import.meta.url));
const contentTypes = { ".css": "text/css", ".html": "text/html", ".js": "text/javascript", ".png": "image/png" };
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname.replace(/^\/widthwatch\/?/, "");
    const path = resolve(root, pathname || "index.html");
    if (!path.startsWith(root)) throw new Error("Invalid path");
    response.writeHead(200, { "content-type": contentTypes[extname(path)] ?? "application/octet-stream" }).end(await readFile(path));
  } catch {
    response.writeHead(404).end();
  }
});

await new Promise((resolveListen, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolveListen);
});
const address = server.address();
assert.ok(address && typeof address !== "string");
const browser = await chromium.launch();

try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.addInitScript(() => {
    const supports = DOMTokenList.prototype.supports;
    DOMTokenList.prototype.supports = function (token) {
      return token === "modulepreload" ? false : supports.call(this, token);
    };
  });
  await page.coverage.startJSCoverage({ resetOnNavigation: false });
  await page.goto(`http://127.0.0.1:${address.port}/widthwatch/`);
  await page.evaluate(() => {
    const preload = document.createElement("link");
    preload.rel = "modulepreload";
    preload.href = "data:text/javascript,export default true";
    preload.crossOrigin = "anonymous";
    document.head.append(preload);
  });
  await page.waitForTimeout(50);
  const menu = page.getByRole("button", { name: "Menu" });
  await menu.click();
  await page.locator("#primaryNav a").first().click();
  await menu.click();
  await page.locator("main").dispatchEvent("pointerdown");
  await menu.click();
  await page.keyboard.press("Escape");
  await page.locator("[data-copy]").click();
  await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true }));
  await page.locator("[data-copy]").click();
  await page.getByLabel("Website URL").fill("https://example.com");
  await page.getByRole("button", { name: /Analyze/ }).click();
  await page.waitForFunction(() => document.querySelector("#scanState")?.textContent?.includes("complete"));
  await page.setViewportSize({ width: 1200, height: 800 });
  const entries = (await page.coverage.stopJSCoverage()).filter((entry) => /\/assets\/main-[^/]+\.js$/.test(entry.url));
  assert.equal(entries.length, 1, "Expected one production JavaScript bundle in browser coverage.");
  const metrics = await coverageMetrics(entries[0]);
  console.log(
    `Web browser coverage: ${metrics.lines.toFixed(2)}% lines · ${metrics.branches.toFixed(2)}% branches · ${metrics.functions.toFixed(2)}% functions`,
  );
  assert.ok(metrics.lines >= 70, `Web line coverage ${metrics.lines.toFixed(2)}% is below 70%.`);
  assert.ok(metrics.branches >= 60, `Web branch coverage ${metrics.branches.toFixed(2)}% is below 60%.`);
  assert.ok(metrics.functions >= 65, `Web function coverage ${metrics.functions.toFixed(2)}% is below 65%.`);
} finally {
  await browser.close();
  await new Promise((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
    server.closeAllConnections();
  });
}

async function coverageMetrics(entry) {
  const asset = new URL(entry.url).pathname.replace(/^\/widthwatch\/?/, "");
  const bundlePath = resolve(root, asset);
  const sourceMap = JSON.parse(await readFile(`${bundlePath}.map`, "utf8"));
  assert.equal(sourceMap.sources.length, 1, "Expected the web bundle to map to one TypeScript entry.");
  const converter = v8toIstanbul(bundlePath, 0, {
    source: entry.source,
    originalSource: sourceMap.sourcesContent[0],
    sourceMap: { sourcemap: sourceMap },
  });
  await converter.load();
  converter.applyCoverage(entry.functions);
  const files = Object.values(converter.toIstanbul());
  const lineHits = new Map();
  const branchHits = [];
  const functionHits = [];
  const functionDetails = [];
  for (const file of files) {
    for (const [id, location] of Object.entries(file.statementMap)) {
      const line = location.start.line;
      lineHits.set(line, Math.max(lineHits.get(line) ?? 0, file.s[id] ?? 0));
    }
    for (const hits of Object.values(file.b)) branchHits.push(...hits);
    for (const [id, hits] of Object.entries(file.f)) {
      functionHits.push(hits);
      functionDetails.push({ name: file.fnMap[id]?.name, line: file.fnMap[id]?.loc?.start?.line, hits });
    }
  }
  if (process.env.DEBUG_COVERAGE === "true") console.log(functionDetails);
  return {
    lines: percentage([...lineHits.values()].filter((hits) => hits > 0).length, lineHits.size),
    branches: percentage(branchHits.filter((hits) => hits > 0).length, branchHits.length),
    functions: percentage(functionHits.filter((hits) => hits > 0).length, functionHits.length),
  };
}

function percentage(covered, total) {
  return total ? (covered / total) * 100 : 100;
}
