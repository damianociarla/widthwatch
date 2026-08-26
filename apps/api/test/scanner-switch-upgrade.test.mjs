import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const script = fileURLToPath(new URL("../../../infra/aws/upgrade-scanner-switch.sh", import.meta.url));
const template = fileURLToPath(new URL("../../../infra/aws/scanner-switch.yml", import.meta.url));

async function fixture(t, installedState = "true") {
  const directory = await mkdtemp(join(tmpdir(), "widthwatch-switch-upgrade-"));
  const log = join(directory, "aws.log");
  const revision = createHash("sha256")
    .update(await readFile(template))
    .digest("hex");
  await writeFile(
    join(directory, "aws"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${log}"
case "$*" in
  *"Parameters[?ParameterKey=='PublicScannerEnabled']"*)
    count_file="${directory}/state-count"
    count=0
    [[ -f "$count_file" ]] && count="$(cat "$count_file")"
    count=$((count + 1))
    printf '%s' "$count" >"$count_file"
    [[ "$count" == 1 ]] && printf '%s\n' 'true' || printf '%s\n' '${installedState}'
    ;;
  *"Outputs[?OutputKey=='ControlPlaneRevision']"*) printf '%s\n' '${revision}' ;;
  *"Outputs[?OutputKey=='ApiUrl']"*) printf '%s\n' 'https://api.example' ;;
  *) : ;;
esac
`,
  );
  await writeFile(
    join(directory, "curl"),
    `#!/usr/bin/env bash
set -euo pipefail
arguments="$*"
output=/dev/null
while (($#)); do
  case "$1" in
    --output) output="$2"; shift 2 ;;
    --dump-header) shift 2 ;;
    *) shift ;;
  esac
done
if [[ "$arguments" == *'/health'* ]]; then
  printf 200
else
  printf '%s\n' '{"error":"invalid_url"}' >"$output"
  printf 400
fi
`,
  );
  await Promise.all([chmod(join(directory, "aws"), 0o755), chmod(join(directory, "curl"), 0o755)]);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, log, revision };
}

function run(directory) {
  return spawnSync("bash", [script], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      WIDTHWATCH_SCANNER_SWITCH_EXECUTION_ROLE_ARN: "arn:aws:iam::123:role/switch-execution",
      WIDTHWATCH_VERIFY_ATTEMPTS: "1",
      WIDTHWATCH_VERIFY_DELAY_SECONDS: "0",
    },
  });
}

test("control-plane upgrade installs the full template and preserves enabled state", async (t) => {
  const setup = await fixture(t);
  const result = run(setup.directory);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`revision=${setup.revision} state=enabled`));
  const calls = await readFile(setup.log, "utf8");
  assert.match(calls, new RegExp(`--template-body file://${template.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(calls, /ParameterKey=PublicScannerEnabled,ParameterValue=true/);
  assert.match(calls, new RegExp(`ParameterKey=ControlPlaneRevision,ParameterValue=${setup.revision}`));
  assert.doesNotMatch(calls, /--use-previous-template/);
});

test("control-plane upgrade fails when CloudFormation does not preserve scanner state", async (t) => {
  const setup = await fixture(t, "false");
  const result = run(setup.directory);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /changed state from true to false/);
});
