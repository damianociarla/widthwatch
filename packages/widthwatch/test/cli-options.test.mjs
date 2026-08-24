import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { parseCliOptions } from "../dist/cli-options.js";

test("CLI accepts value options before the URL without treating their values as the URL", () => {
  const parsed = parseCliOptions(["--output", "report.html", "--max-samples", "8", "--layout-only", "--reload-per-width", "https://example.com"]);
  assert.equal(parsed.url, "https://example.com");
  assert.equal(parsed.output, "report.html");
  assert.equal(parsed.maxSamples, 8);
  assert.equal(parsed.layoutOnly, true);
  assert.equal(parsed.reloadPerWidth, true);
});

test("CLI rejects missing values and unknown flags", () => {
  assert.throws(() => parseCliOptions(["--output"]), /requires a value/);
  assert.throws(() => parseCliOptions(["--wat"]), /Unknown option/);
});

test("built CLI exposes help and version successfully", () => {
  for (const argument of ["--help", "--version"]) {
    const result = spawnSync(process.execPath, [new URL("../dist/cli.js", import.meta.url).pathname, argument], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.trim());
  }
});
