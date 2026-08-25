import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("landing exposes the scanner, docs and published package command", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /Trace a public page/);
  assert.match(html, /npx widthwatch https:\/\/your-site\.com/);
  assert.match(html, /data-copy=/);
  assert.match(html, /docs\.html/);
  assert.match(html, /id="reportLink"/);
  assert.match(html, /Open interactive report/);
  assert.doesNotMatch(html, /Watch every width/);
  assert.match(html, /rel="canonical"/);
  assert.match(html, /application\/ld\+json/);
  assert.match(html, /og-widthwatch\.png/);
  assert.match(html, /summary_large_image/);
  assert.match(html, /softwareVersion":"0\.4\.0/);
  assert.match(html, /id="navToggle"/);
  assert.match(html, /Reproducible evidence/);
  assert.match(html, /href="\.\/proof\.html"/);
  assert.match(html, /href="\.\/proof-two-pass\.html"/);
  assert.match(html, /Twelve geometry probes/);
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

test("production artifact includes real proof fixtures and comparison report", async () => {
  const proof = await readFile(new URL("../dist/proof.html", import.meta.url), "utf8");
  const candidate = await readFile(new URL("../dist/proof-candidate.html", import.meta.url), "utf8");
  const twoPassProof = await readFile(new URL("../dist/proof-two-pass.html", import.meta.url), "utf8");
  assert.match(proof, /First regression/);
  assert.match(proof, /Observed at 742—811px/);
  assert.match(proof, /clipped-text/);
  assert.match(candidate, /min-width:742px/);
  assert.match(twoPassProof, /captures <strong>4<\/strong>/);
  assert.match(twoPassProof, /probes <strong>12<\/strong>/);
  assert.match(twoPassProof, /discovery only/);
});

test("public scanner serializes runs and the landing exposes visible keyboard focus", async () => {
  const source = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(source, /new AbortController/);
  assert.match(source, /submitButton\.disabled = true/);
  assert.match(source, /run !== scanRun/);
  assert.match(styles, /:focus-visible/);
  assert.match(styles, /outline-offset/);
});
