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
  const {
    candidateState = "true",
    candidateEdgeStatus = 400,
    rollbackEdgeStatus = 400,
    candidateUpdateFails = false,
    rollbackUpdateFails = false,
    candidateEvents = "UPDATE_COMPLETE",
    rollbackEvents = "UPDATE_COMPLETE",
  } = options;
  const directory = await mkdtemp(join(tmpdir(), "widthwatch-switch-upgrade-"));
  const log = join(directory, "aws.log");
  const phase = join(directory, "phase");
  const eventCount = join(directory, "event-count");
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
  *"cloudformation describe-stack-events"*)
    current_count=0
    [[ -f "${eventCount}" ]] && current_count="$(cat "${eventCount}")"
    current_count=$((current_count + 1))
    printf '%s' "$current_count" >"${eventCount}"
    sequence='${candidateEvents}'
    [[ "$current_phase" == rollback-updating ]] && sequence='${rollbackEvents}'
    IFS=',' read -r -a statuses <<< "$sequence"
    index=$((current_count - 1))
    statuses_length="\${#statuses[@]}"
    ((index >= statuses_length)) && index=$((statuses_length - 1))
    event_status="\${statuses[$index]}"
    if [[ "$event_status" == ERROR ]]; then
      printf '%s\n' 'transient observation error' >&2
      exit 1
    fi
    case "$event_status" in
      UPDATE_COMPLETE)
        [[ "$current_phase" == candidate-updating ]] && printf '%s' candidate >"${phase}"
        [[ "$current_phase" == rollback-updating ]] && printf '%s' rollback >"${phase}"
        ;;
      UPDATE_ROLLBACK_COMPLETE) printf '%s' automatic-rollback >"${phase}" ;;
      UPDATE_ROLLBACK_FAILED) printf '%s' rollback-failed >"${phase}" ;;
    esac
    printf '%s\n' "$event_status"
    ;;
  *"Stacks[0].StackStatus"*)
    current_phase=initial
    [[ -f "${phase}" ]] && current_phase="$(cat "${phase}")"
    case "$current_phase" in
      candidate-updating|rollback-updating) printf '%s\n' 'UPDATE_IN_PROGRESS' ;;
      automatic-rollback) printf '%s\n' 'UPDATE_ROLLBACK_COMPLETE' ;;
      rollback-failed) printf '%s\n' 'UPDATE_ROLLBACK_FAILED' ;;
      *) printf '%s\n' 'UPDATE_COMPLETE' ;;
    esac
    ;;
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
      ${candidateUpdateFails ? 'printf "%s\\n" "candidate denied" >&2; exit 1' : `printf '%s' candidate-updating >"${phase}"; printf '%s' 0 >"${eventCount}"`}
    else
      ${rollbackUpdateFails ? 'printf "%s\\n" "rollback denied" >&2; exit 1' : `printf '%s' rollback-updating >"${phase}"; printf '%s' 0 >"${eventCount}"`}
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
      WIDTHWATCH_STACK_STATUS_ATTEMPTS: "4",
      WIDTHWATCH_STACK_STATUS_DELAY_SECONDS: "0",
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
  assert.match(calls, /--client-request-token widthwatch-candidate-/);
  assert.match(calls, /cloudformation describe-stack-events/);
  assert.doesNotMatch(calls, /cloudformation wait/);
  assert.equal(calls.match(/cloudformation update-stack/g)?.length, 1);
});

test("an accepted update survives a transient observation failure before semantic rollback", async (t) => {
  const setup = await fixture(t, { candidateEdgeStatus: 500, candidateEvents: "ERROR,UPDATE_IN_PROGRESS,UPDATE_COMPLETE" });
  const result = run(setup.directory);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /observation failed transiently/);
  assert.match(result.stderr, new RegExp(`restoring scanner control plane revision ${previousRevision}`));
  assert.match(result.stderr, new RegExp(`Previous scanner control plane restored and verified: revision=${previousRevision} state=enabled`));
  const calls = await readFile(setup.log, "utf8");
  const updates = calls.split("\n").filter((line) => line.includes("cloudformation update-stack"));
  assert.equal(updates.length, 2);
  assert.match(updates[0], new RegExp(`file://${template.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(updates[1], /file:\/\/.*\/previous-template/);
  assert.match(updates[1], new RegExp(`ControlPlaneRevision,ParameterValue=${previousRevision}`));
});

test("an automatic CloudFormation rollback is resolved before the previous revision is verified", async (t) => {
  const setup = await fixture(t, { candidateEvents: "UPDATE_IN_PROGRESS,UPDATE_ROLLBACK_COMPLETE" });
  const result = run(setup.directory);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /completed an automatic rollback/);
  assert.match(result.stderr, /Previous scanner control plane was restored and verified by CloudFormation/);
  const calls = await readFile(setup.log, "utf8");
  assert.equal(calls.match(/cloudformation update-stack/g)?.length, 1);
});

test("an accepted operation without a terminal state is critical and never starts an overlapping rollback", async (t) => {
  const setup = await fixture(t, { candidateEvents: "UPDATE_IN_PROGRESS" });
  const result = run(setup.directory);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /terminal state is still unknown/);
  assert.match(result.stderr, /no overlapping rollback was attempted/);
  assert.doesNotMatch(result.stderr, /Previous scanner control plane remains installed/);
  const calls = await readFile(setup.log, "utf8");
  assert.equal(calls.match(/cloudformation update-stack/g)?.length, 1);
});

test("UPDATE_ROLLBACK_FAILED is a critical terminal state without a competing mutation", async (t) => {
  const setup = await fixture(t, { candidateEvents: "UPDATE_IN_PROGRESS,UPDATE_ROLLBACK_FAILED" });
  const result = run(setup.directory);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /failed terminal state/);
  assert.match(result.stderr, /no overlapping rollback was attempted/);
  const calls = await readFile(setup.log, "utf8");
  assert.equal(calls.match(/cloudformation update-stack/g)?.length, 1);
});

test("a candidate rejected before mutation verifies the unchanged previous revision", async (t) => {
  const setup = await fixture(t, { candidateUpdateFails: true });
  const result = run(setup.directory);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /rejected before mutation/);
  assert.match(result.stderr, /Previous scanner control plane remains installed and verified after the rejected update/);
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
