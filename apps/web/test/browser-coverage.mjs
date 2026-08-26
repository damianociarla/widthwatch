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
    const rawPathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (rawPathname === "/api/v1/scans" && request.method === "POST") {
      let body = "";
      for await (const chunk of request) body += chunk;
      if (body.includes("rate-limit.example")) {
        response.writeHead(429, { "content-type": "application/json" }).end('{"error":"rate_limited"}');
        return;
      }
      const failureCodes = {
        "too-large.example": "transfer_limit",
        "too-many.example": "request_limit",
        "timeout.example": "timeout",
        "network.example": "network_failure",
        "browser.example": "browser_failure",
      };
      const failureCode = Object.entries(failureCodes).find(([hostname]) => body.includes(hostname))?.[1];
      const id = body.includes("frames-only.example") ? "scan-frames" : "scan-ok";
      response
        .writeHead(202, { "content-type": "application/json" })
        .end(JSON.stringify(failureCode ? { id: "scan-failed", status: "failed", failureCode } : { id, status: "complete" }));
      return;
    }
    if (rawPathname === "/api/v1/scans/scan-ok" || rawPathname === "/api/v1/scans/scan-frames") {
      const framesOnly = rawPathname.endsWith("scan-frames");
      response.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          id: framesOnly ? "scan-frames" : "scan-ok",
          status: "complete",
          reportUrl: "/v1/reports/scan-ok",
          report: {
            ...(framesOnly
              ? {}
              : {
                  probes: [
                    { width: 320, severities: [] },
                    { width: 640, severities: ["error"] },
                  ],
                }),
            frames: [{ width: 320, issues: [] }],
            summary: { errors: framesOnly ? 0 : 1, warnings: 0, sampledWidths: framesOnly ? 1 : 2 },
          },
        }),
      );
      return;
    }
    const pathname = rawPathname.replace(/^\/widthwatch\/?/, "");
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
  await page.locator("[data-copy]").first().click();
  await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true }));
  await page.locator("[data-copy]").first().click();
  await page.getByLabel("Website URL").fill("https://example.com");
  await page.getByRole("button", { name: /Analyze/ }).click();
  await page.waitForFunction(() => document.querySelector("#scanState")?.textContent?.includes("complete"));
  await page.getByLabel("Website URL").fill("https://frames-only.example");
  await page.getByRole("button", { name: /Analyze/ }).click();
  await page.waitForFunction(() => document.querySelector("#scanMessage")?.textContent?.includes("1 probes"));
  for (const [url, expected] of [
    ["https://too-large.example", "75 MiB transfer limit"],
    ["https://too-many.example", "too many requests"],
    ["https://timeout.example", "did not become ready"],
    ["https://network.example", "not reachable"],
    ["https://browser.example", "job scan-fai"],
  ]) {
    await page.getByLabel("Website URL").fill(url);
    await page.getByRole("button", { name: /Analyze/ }).click();
    await page.waitForFunction(() => document.querySelector("#scanState")?.textContent?.includes("failed"));
    assert.match(await page.locator("#scanMessage").innerText(), new RegExp(expected));
  }
  await page.getByLabel("Website URL").fill("https://rate-limit.example");
  await page.getByRole("button", { name: /Analyze/ }).click();
  await page.waitForFunction(() => document.querySelector("#scanState")?.textContent?.includes("rejected"));
  assert.match(await page.locator("#scanMessage").innerText(), /public demo limit/);
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
