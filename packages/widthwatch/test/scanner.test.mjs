import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { scanAtWidths, scanResponsive } from "../dist/scanner.js";

test("invalid numeric options fail before launching a browser", async () => {
  await assert.rejects(scanResponsive("https://example.com", { initialStep: 0 }), /initialStep/);
  await assert.rejects(scanResponsive("https://example.com", { minStep: Number.NaN }), /minStep/);
  await assert.rejects(scanResponsive("https://example.com", { viewportHeight: 0 }), /viewportHeight/);
  await assert.rejects(scanResponsive("https://example.com", { exactWidths: [320, 320] }), /duplicates/);
});

test("scanAtWidths captures exactly the requested deterministic schedule", async (context) => {
  const server = createServer((_request, response) => response.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><title>Fixture</title><main>stable</main>"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const result = await scanAtWidths(`http://127.0.0.1:${address.port}`, [777, 321], { viewportHeight: 480, settleMs: 0 });
  assert.deepEqual(result.frames.map((frame) => frame.width), [321, 777]);
  assert.deepEqual(result.range, { min: 321, max: 777, height: 480 });
});
