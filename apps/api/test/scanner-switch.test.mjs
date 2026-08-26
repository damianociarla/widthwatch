import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const script = fileURLToPath(new URL("../../../infra/aws/scanner-switch.sh", import.meta.url));

async function fakeTools(t, subscriptionArn) {
  const directory = await mkdtemp(join(tmpdir(), "widthwatch-switch-"));
  const log = join(directory, "aws.log");
  await writeFile(
    join(directory, "aws"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${log}"
case "$*" in
  *list-subscriptions-by-topic*) printf '%s\n' '{"Subscriptions":[{"Protocol":"email","Endpoint":"alerts@example.com","SubscriptionArn":"${subscriptionArn}"}]}' ;;
  *OperationalAlertTopicArn*) printf '%s\n' 'arn:aws:sns:eu-west-1:123:widthwatch-operational-alerts' ;;
  *EdgeAlertTopicArn*) printf '%s\n' 'arn:aws:sns:us-east-1:123:widthwatch-edge-operational-alerts' ;;
  *ApiUrl*) printf '%s\n' 'https://api.example' ;;
  *PublicScannerEnabled*) printf '%s\n' 'true' ;;
  *ControlPlaneRevision*) printf '%s\n' 'fixture-revision' ;;
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
headers=/dev/null
while (($#)); do
  case "$1" in
    --output) output="$2"; shift 2 ;;
    --dump-header) headers="$2"; shift 2 ;;
    *) shift ;;
  esac
done
if [[ "$arguments" == *'/health'* ]]; then
  printf 200
else
  printf '%s\n' 'HTTP/2 403' 'content-type: application/json' 'access-control-allow-origin: https://damianociarla.github.io' 'cache-control: no-store' >"$headers"
  printf '%s\n' '{"error":"scanner_paused"}' >"$output"
  printf 403
fi
`,
  );
  await Promise.all([chmod(join(directory, "aws"), 0o755), chmod(join(directory, "curl"), 0o755)]);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, log };
}

function run(directory, state, alertEmail = "alerts@example.com") {
  return spawnSync("bash", [script], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      WIDTHWATCH_SCANNER_STATE: state,
      WIDTHWATCH_SCANNER_SWITCH_EXECUTION_ROLE_ARN: "arn:aws:iam::123:role/switch-execution",
      ...(alertEmail ? { WIDTHWATCH_ALERT_EMAIL: alertEmail } : {}),
    },
  });
}

test("scanner disable bypasses alert readiness and updates only its dedicated stack", async (t) => {
  const fixture = await fakeTools(t, "PendingConfirmation");
  const result = run(fixture.directory, "disable", "");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /scan=403, JSON\/CORS\/no-store present/);
  const calls = await readFile(fixture.log, "utf8");
  assert.match(calls, /update-stack .*widthwatch-scanner-switch/);
  assert.doesNotMatch(calls, /apprunner|ecr|widthwatch-api.*update-stack/);
  assert.doesNotMatch(calls, /list-subscriptions-by-topic/);
});

test("scanner enable fails closed before mutation when alert email is pending", async (t) => {
  const fixture = await fakeTools(t, "PendingConfirmation");
  const result = run(fixture.directory, "enable");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /no confirmed subscription/);
  const calls = await readFile(fixture.log, "utf8");
  assert.match(calls, /list-subscriptions-by-topic/);
  assert.doesNotMatch(calls, /update-stack/);
});
