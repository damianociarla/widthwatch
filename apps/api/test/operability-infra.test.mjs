import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../..", import.meta.url));

async function source(path) {
  return readFile(new URL(`../../../${path}`, import.meta.url), "utf8");
}

test("incident-control infrastructure versions alarms, alert routing and the scanner switch", async () => {
  const app = await source("infra/aws/apprunner.yml");
  const edge = await source("infra/aws/cloudfront-waf.yml");
  const role = await source("infra/aws/github-deploy-role.yml");
  for (const value of ["AWS::SNS::Topic", "AWS::CloudWatch::Alarm", "AWS::Logs::MetricFilter", "hosted_scan_failed", "FailedScans", "TransferLimitFailures"]) {
    assert.match(app, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  for (const value of ["PublicScannerEnabled", "EmergencyScannerSwitch", "CloudFront5xxAlarm", "WafBlockedRequestsAlarm", "ScanRateBlockedAlarm"]) {
    assert.match(edge, new RegExp(value));
  }
  assert.match(edge, /PublicScannerStatus/);
  assert.match(role, /cloudwatch:PutMetricAlarm/);
  assert.match(role, /logs:PutMetricFilter/);
  assert.match(role, /sns:Subscribe/);
});

test("deploy automation requires alerting and preserves an explicit emergency state", async () => {
  const deploy = await source("infra/aws/deploy.sh");
  const release = await source(".github/workflows/release.yml");
  const manual = await source(".github/workflows/deploy-api.yml");
  assert.match(deploy, /WIDTHWATCH_BUDGET_ALERT_EMAIL:\?Set/);
  assert.match(deploy, /WIDTHWATCH_PUBLIC_SCANNER_ENABLED/);
  assert.match(deploy, /PublicScannerEnabled=\$public_scanner_enabled/);
  assert.match(release, /vars\.WIDTHWATCH_PUBLIC_SCANNER_ENABLED/);
  assert.match(manual, /vars\.WIDTHWATCH_PUBLIC_SCANNER_ENABLED/);
  const syntax = spawnSync("bash", ["-n", `${root}/infra/aws/deploy.sh`], { encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
});

test("the incident runbook covers disable, edge verification and explicit restore", async () => {
  const runbook = await source("docs/runbooks/public-scanner.md");
  assert.match(runbook, /--body false/);
  assert.match(runbook, /Expected results: health `200`; scan admission `403`/);
  assert.match(runbook, /PendingConfirmation/);
  assert.match(runbook, /--body true/);
});
