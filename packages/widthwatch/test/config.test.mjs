import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defineConfig, loadWidthWatchConfig } from "../dist/config.js";

async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), "widthwatch-config-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test("defineConfig preserves the typed config object", () => {
  const config = { version: 1, url: "https://example.com" };
  assert.equal(defineConfig(config), config);
});

test("config loader returns undefined when auto-detection finds nothing", async (t) => {
  assert.equal(await loadWidthWatchConfig(undefined, await directory(t)), undefined);
});

test("config loader resolves explicit and auto-detected module paths", async (t) => {
  const cwd = await directory(t);
  const path = join(cwd, "widthwatch.config.mjs");
  await writeFile(
    path,
    'export default { version: 1, url: "https://example.com", output: "reports/site.html", failOnRegression: true, scan: {}, compare: {} };',
  );
  const loaded = await loadWidthWatchConfig(undefined, cwd);
  assert.equal(loaded.path, path);
  assert.equal(loaded.directory, cwd);
  assert.equal(loaded.config.url, "https://example.com");
  assert.equal((await loadWidthWatchConfig("widthwatch.config.mjs", cwd)).path, path);
});

test("config loader reports a missing explicit module", async (t) => {
  const cwd = await directory(t);
  await assert.rejects(() => loadWidthWatchConfig("missing.mjs", cwd), /config not found/);
});

test("config loader rejects every invalid top-level contract", async (t) => {
  const cwd = await directory(t);
  const cases = [
    [null, /default-export an object/],
    [{ version: 2 }, /version must be 1/],
    [{ version: 1, url: 1 }, /url must be a string/],
    [{ version: 1, output: 1 }, /output must be a string/],
    [{ version: 1, json: 1 }, /json must be a string/],
    [{ version: 1, baseline: 1 }, /baseline must be a string/],
    [{ version: 1, failOnRegression: "yes" }, /failOnRegression must be a boolean/],
    [{ version: 1, scan: [] }, /scan must be an object/],
    [{ version: 1, compare: null }, /compare must be an object/],
  ];
  for (const [index, [value, pattern]] of cases.entries()) {
    const path = join(cwd, `invalid-${index}.mjs`);
    await writeFile(path, `export default ${JSON.stringify(value)};`);
    await assert.rejects(() => loadWidthWatchConfig(path, cwd), pattern);
  }
});
