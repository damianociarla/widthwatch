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
const previousRevision = "a".repeat(64);

async function fixture(t, options = {}) {
  const { candidateState = "true", candidateEdgeStatus = 400, rollbackEdgeStatus = 400, rollbackUpdateFails = false } = options;
  const directory = await mkdtemp(join(tmpdir(), "widthwatch-switch-upgrade-"));
  const log = join(directory, "aws.log");
  const phase = join(directory, "phase");
  const revision = createHash("sha256")
    .update(await readFile(template))
    .digest("hex");
  const previousTemplate = JSON.stringify({
    TemplateBody:
      'AWSTemplateFormatVersion: "2010-09-09"\nParameters:\n  PublicScannerEnabled: { Type: String }\n  ControlPlaneRevision: { Type: String }\nResources: {}\n',
  });
  await writeFile(
    join(directory, "aws"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${log}"
current_phase=initial
[[ -f "${phase}" ]] && current_phase="$(cat "${phase}")"
case "$*" in
  *"cloudformation get-template"*) printf '%s\n' '${previousTemplate}' ;;
  *"Parameters[?ParameterKey=='PublicScannerEnabled']"*)
    case "$current_phase" in
      candidate) printf '%s\n' '${candidateState}' ;;
      *) printf '%s\n' 'true' ;;
    esac
    ;;
  *"Outputs[?OutputKey=='ControlPlaneRevision']"*)
    case "$current_phase" in
      candidate) printf '%s\n' '${revision}' ;;
      *) printf '%s\n' '${previousRevision}' ;;
    esac
    ;;
  *"Outputs[?OutputKey=='ApiUrl']"*) printf '%s\n' 'https://api.example' ;;
  *"cloudformation update-stack"*)
    if [[ "$*" == *"file://${template}"* ]]; then
      printf '%s' candidate >"${phase}"
    else
      ${rollbackUpdateFails ? 'printf "%s\\n" "rollback denied" >&2; exit 1' : `printf '%s' rollback >"${phase}"`}
    fi
    ;;
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
  exit 0
fi
current_phase=initial
[[ -f "${phase}" ]] && current_phase="$(cat "${phase}")"
scan_status=${rollbackEdgeStatus}
[[ "$current_phase" == candidate ]] && scan_status=${candidateEdgeStatus}
if [[ "$scan_status" == 400 ]]; then
  printf '%s\n' '{"error":"invalid_url"}' >"$output"
else
  printf '%s\n' '{"error":"unexpected"}' >"$output"
fi
printf '%s' "$scan_status"
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

test("control-plane upgrade snapshots and installs the full template while preserving state", async (t) => {
  const setup = await fixture(t);
  const result = run(setup.directory);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`revision=${setup.revision} state=enabled`));
  const calls = await readFile(setup.log, "utf8");
  assert.match(calls, /cloudformation get-template .*--template-stage Original/);
  assert.match(calls, new RegExp(`--template-body file://${template.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(calls, /ParameterKey=PublicScannerEnabled,ParameterValue=true/);
  assert.match(calls, new RegExp(`ParameterKey=ControlPlaneRevision,ParameterValue=${setup.revision}`));
  assert.equal(calls.match(/cloudformation update-stack/g)?.length, 1);
});

test("semantic edge failure restores and verifies the previous template, then leaves release red", async (t) => {
  const setup = await fixture(t, { candidateEdgeStatus: 500 });
  const result = run(setup.directory);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, new RegExp(`restoring scanner control plane revision ${previousRevision}`));
  assert.match(result.stderr, new RegExp(`Previous scanner control plane restored and verified: revision=${previousRevision} state=enabled`));
  const calls = await readFile(setup.log, "utf8");
  const updates = calls.split("\n").filter((line) => line.includes("cloudformation update-stack"));
  assert.equal(updates.length, 2);
  assert.match(updates[0], new RegExp(`file://${template.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(updates[1], /file:\/\/.*\/previous-template/);
  assert.match(updates[1], new RegExp(`ControlPlaneRevision,ParameterValue=${previousRevision}`));
});

test("state mismatch also rolls back instead of leaving the candidate installed", async (t) => {
  const setup = await fixture(t, { candidateState: "false" });
  const result = run(setup.directory);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /candidate changed state from true to false/);
  assert.match(result.stderr, /Previous scanner control plane restored and verified/);
});

test("rollback failure is explicit and never turns a failed candidate green", async (t) => {
  const setup = await fixture(t, { candidateEdgeStatus: 500, rollbackUpdateFails: true });
  const result = run(setup.directory);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /CRITICAL: previous scanner control-plane template could not be restored/);
  assert.doesNotMatch(result.stdout, /control plane upgraded/);
});

test("rollback verification failure is explicit after the previous template is reapplied", async (t) => {
  const setup = await fixture(t, { candidateEdgeStatus: 500, rollbackEdgeStatus: 500 });
  const result = run(setup.directory);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /CRITICAL: scanner control-plane rollback could not be verified/);
  const calls = await readFile(setup.log, "utf8");
  assert.equal(calls.match(/cloudformation update-stack/g)?.length, 2);
});
