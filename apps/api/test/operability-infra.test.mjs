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
  const scannerSwitch = await source("infra/aws/scanner-switch.yml");
  const scannerSwitchIam = await source("infra/aws/scanner-switch-iam.yml");
  const role = await source("infra/aws/github-deploy-role.yml");
  for (const value of [
    "AWS::SNS::Topic",
    "AWS::CloudWatch::Alarm",
    "AWS::Logs::MetricFilter",
    "hosted_scan_failed",
    "hosted_scan_completed",
    "hosted_scan_rejected",
    "FailedScans",
    "CompletedScans",
    "RejectedScans",
    "TransferLimitFailures",
  ]) {
    assert.match(app, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  for (const value of ["ScannerSwitchRuleGroupArn", "RuleGroupReferenceStatement", "CloudFront5xxAlarm", "WafBlockedRequestsAlarm", "ScanRateBlockedAlarm"]) {
    assert.match(edge, new RegExp(value));
  }
  assert.doesNotMatch(edge, /PublicScannerEnabled/);
  assert.match(scannerSwitch, /Default: "false"/);
  assert.match(scannerSwitch, /AWS::WAFv2::RuleGroup/);
  assert.match(scannerSwitch, /DeletionPolicy: Retain/);
  assert.match(scannerSwitch, /PublicScannerStatus/);
  assert.match(scannerSwitchIam, /ScannerSwitchRole/);
  assert.match(scannerSwitchIam, /ScannerSwitchExecutionRole/);
  assert.match(scannerSwitchIam, /ExistingDeployRoleBootstrapPolicy/);
  assert.match(scannerSwitchIam, /widthwatch-scanner-switch\/\*/);
  assert.match(role, /cloudwatch:PutMetricAlarm/);
  assert.match(role, /logs:PutMetricFilter/);
  assert.match(role, /sns:Subscribe/);
});

test("application deploy bootstraps fail-closed and never mutates scanner state", async () => {
  const deploy = await source("infra/aws/deploy.sh");
  const release = await source(".github/workflows/release.yml");
  const manual = await source(".github/workflows/deploy-api.yml");
  assert.match(deploy, /WIDTHWATCH_BUDGET_ALERT_EMAIL:\?Set/);
  assert.match(deploy, /Bootstrapping the independent scanner switch/);
  assert.match(deploy, /ScannerSwitchRuleGroupArn=\$scanner_switch_arn/);
  assert.doesNotMatch(deploy, /PublicScannerEnabled=/);
  assert.doesNotMatch(release, /WIDTHWATCH_PUBLIC_SCANNER_ENABLED/);
  assert.doesNotMatch(manual, /WIDTHWATCH_PUBLIC_SCANNER_ENABLED/);
  const syntax = spawnSync("bash", ["-n", `${root}/infra/aws/deploy.sh`], { encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
});

test("the independent switch workflow gates enable and correlates exact runs", async () => {
  const workflow = await source(".github/workflows/scanner-switch.yml");
  const script = await source("infra/aws/scanner-switch.sh");
  const runbook = await source("docs/runbooks/public-scanner.md");
  assert.match(workflow, /AWS_SCANNER_SWITCH_ROLE_ARN/);
  assert.match(workflow, /change_id/);
  assert.match(script, /assert_confirmed_email/);
  assert.match(script, /WIDTHWATCH_SCANNER_STATE must be enable or disable/);
  assert.match(script, /stack-update-complete/);
  assert.match(script, /restoring the fail-closed disabled state/);
  assert.match(runbook, /state=disable/);
  assert.match(runbook, /displayTitle ==/);
  assert.match(runbook, /Expected results: health `200`; scan admission `403`/);
  assert.match(runbook, /PendingConfirmation/);
  assert.match(runbook, /state=enable/);
  for (const path of ["infra/aws/deploy.sh", "infra/aws/scanner-switch.sh"]) {
    const result = spawnSync("bash", ["-n", `${root}/${path}`], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
});

test("the scheduled canary crosses the expected public path", async () => {
  const canary = await source(".github/workflows/canary.yml");
  assert.match(canary, /schedule/);
  assert.match(canary, /PublicScannerEnabled/);
  assert.match(canary, /x-robots-tag: noindex, nofollow, noarchive/i);
  assert.match(canary, /status" = complete/);
});
