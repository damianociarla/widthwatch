import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("landing exposes the scanner, docs and package command", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /Trace a public page/);
  assert.match(html, /Run the bounded hosted beta/);
  assert.match(html, /docs\.html/);
  assert.match(html, /id="reportLink"/);
  assert.match(html, /Open interactive report/);
  assert.doesNotMatch(html, /Watch every width/);
  assert.match(html, /rel="canonical"/);
});

test("production build uses the GitHub Pages repository base path", async () => {
  const config = await readFile(new URL("../vite.config.ts", import.meta.url), "utf8");
  assert.match(config, /base:\s*["']\/widthwatch\/["']/);
});

test("production artifact includes the documentation entry", async () => {
  const html = await readFile(new URL("../dist/docs.html", import.meta.url), "utf8");
  assert.match(html, /WidthWatch documentation/);
  assert.match(html, /What it detects/);
});
