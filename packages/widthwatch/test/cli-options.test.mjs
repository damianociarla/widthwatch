import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { applyCliScanOptions, parseCliOptions } from "../dist/cli-options.js";

test("CLI accepts value options before the URL without treating their values as the URL", () => {
  const parsed = parseCliOptions([
    "--output",
    "report.html",
    "--max-samples",
    "8",
    "--max-captures",
    "4",
    "--layout-only",
    "--reload-per-width",
    "https://example.com",
  ]);
  assert.equal(parsed.url, "https://example.com");
  assert.equal(parsed.output, "report.html");
  assert.equal(parsed.maxSamples, 8);
  assert.equal(parsed.maxCaptures, 4);
  assert.equal(parsed.layoutOnly, true);
  assert.equal(parsed.reloadPerWidth, true);
});

test("CLI rejects missing values and unknown flags", () => {
  assert.throws(() => parseCliOptions(["--output"]), /requires a value/);
  assert.throws(() => parseCliOptions(["--wat"]), /Unknown option/);
});

test("CLI recognizes init and an explicit config path", () => {
  assert.deepEqual(parseCliOptions(["init"]).command, "init");
  const parsed = parseCliOptions(["--config", "checks/widthwatch.config.ts"]);
  assert.equal(parsed.command, "scan");
  assert.equal(parsed.config, "checks/widthwatch.config.ts");
});

test("built CLI exposes help and version successfully", () => {
  for (const argument of ["--help", "--version"]) {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("../dist/cli.js", import.meta.url)), argument], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.trim());
  }
});

test("widthwatch init creates a typed config and reusable workflow without overwriting", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "widthwatch-init-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  const first = spawnSync(process.execPath, [cli, "init"], { cwd: directory, encoding: "utf8" });
  assert.equal(first.status, 0, first.stderr);
  assert.match(await readFile(join(directory, "widthwatch.config.ts"), "utf8"), /defineConfig/);
  assert.match(await readFile(join(directory, ".github/workflows/widthwatch.yml"), "utf8"), /workflow_call/);
  const second = spawnSync(process.execPath, [cli, "init"], { cwd: directory, encoding: "utf8" });
  assert.equal(second.status, 1);
  assert.match(second.stderr, /Refusing to overwrite/);
});

test("visual CLI defaults to reloads but preserves an explicit config false", () => {
  assert.equal(applyCliScanOptions(undefined, parseCliOptions(["https://example.com"])).reloadPerWidth, true);
  assert.equal(applyCliScanOptions({ reloadPerWidth: false }, parseCliOptions(["https://example.com"])).reloadPerWidth, false);
  assert.equal(applyCliScanOptions({ reloadPerWidth: false }, parseCliOptions(["--reload-per-width", "https://example.com"])).reloadPerWidth, true);
});
