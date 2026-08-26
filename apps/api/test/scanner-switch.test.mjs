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
  *) : ;;
esac
`,
  );
  await writeFile(
    join(directory, "curl"),
    `#!/usr/bin/env bash
set -euo pipefail
[[ "$*" == *'/health'* ]] && printf 200 || printf 403
`,
  );
  await Promise.all([chmod(join(directory, "aws"), 0o755), chmod(join(directory, "curl"), 0o755)]);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, log };
}

function run(directory, state) {
  return spawnSync("bash", [script], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      WIDTHWATCH_SCANNER_STATE: state,
      WIDTHWATCH_SCANNER_SWITCH_EXECUTION_ROLE_ARN: "arn:aws:iam::123:role/switch-execution",
      WIDTHWATCH_ALERT_EMAIL: "alerts@example.com",
    },
  });
}

test("scanner disable bypasses alert readiness and updates only its dedicated stack", async (t) => {
  const fixture = await fakeTools(t, "PendingConfirmation");
  const result = run(fixture.directory, "disable");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /health=200, POST \/v1\/scans=403/);
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
