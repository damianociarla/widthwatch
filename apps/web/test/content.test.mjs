import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("landing exposes the scanner, docs and package command", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /Trace a public page/);
  assert.match(html, /npx widthwatch/);
  assert.match(html, /docs\.html/);
});

test("production build uses the GitHub Pages repository base path", async () => {
  const config = await readFile(new URL("../vite.config.ts", import.meta.url), "utf8");
  assert.match(config, /base:\s*["']\/widthwatch\/["']/);
});
