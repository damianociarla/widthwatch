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
  assert.match(scannerSwitchIam, /CanaryRole/);
  assert.match(scannerSwitchIam, /WidthWatchCanaryReadOnly/);
  assert.match(scannerSwitchIam, /environment:\$\{CanaryEnvironmentName\}/);
  assert.match(scannerSwitchIam, /ExistingDeployRoleReadPolicy/);
  assert.match(scannerSwitchIam, /WidthWatchScannerSwitchReadOnly/);
  assert.match(scannerSwitchIam, /widthwatch-scanner-switch\/\*/);
  assert.match(role, /cloudwatch:PutMetricAlarm/);
  assert.match(role, /logs:PutMetricFilter/);
  assert.match(role, /sns:Subscribe/);
});

test("application deploy requires a fail-closed bootstrap and cannot mutate scanner state", async () => {
  const deploy = await source("infra/aws/deploy.sh");
  const release = await source(".github/workflows/release.yml");
  const manual = await source(".github/workflows/deploy-api.yml");
  assert.match(deploy, /WIDTHWATCH_BUDGET_ALERT_EMAIL:\?Set/);
  assert.match(deploy, /Bootstrap it disabled before deploying the application/);
  assert.match(deploy, /ScannerSwitchRuleGroupArn=\$scanner_switch_arn/);
  assert.doesNotMatch(deploy, /cloudformation deploy .*widthwatch-scanner-switch/);
  assert.doesNotMatch(deploy, /PublicScannerEnabled=/);
  assert.doesNotMatch(release, /WIDTHWATCH_PUBLIC_SCANNER_ENABLED/);
  assert.doesNotMatch(manual, /WIDTHWATCH_PUBLIC_SCANNER_ENABLED/);
  assert.doesNotMatch(release, /AWS_SCANNER_SWITCH_EXECUTION_ROLE_ARN/);
  assert.doesNotMatch(manual, /AWS_SCANNER_SWITCH_EXECUTION_ROLE_ARN/);
  const readPolicy = (await source("infra/aws/scanner-switch-iam.yml")).match(/ExistingDeployRoleReadPolicy:[\s\S]*?Outputs:/)?.[0] ?? "";
  assert.match(readPolicy, /Action: cloudformation:DescribeStacks/);
  assert.doesNotMatch(readPolicy, /CreateChangeSet|ExecuteChangeSet|UpdateStack|iam:PassRole/);
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
  assert.match(canary, /AWS_CANARY_ROLE_ARN/);
  assert.doesNotMatch(canary, /AWS_SCANNER_SWITCH_ROLE_ARN/);
  assert.match(canary, /x-robots-tag: noindex, nofollow, noarchive/i);
  assert.match(canary, /status" = complete/);
  assert.match(canary, /gh issue create/);
  assert.match(canary, /gh issue close/);
});

test("third-party actions are pinned and Dependabot maintains their SHAs", async () => {
  const workflows = ["canary.yml", "ci.yml", "deploy-api.yml", "pages.yml", "release.yml", "scanner-switch.yml"];
  for (const workflow of workflows) {
    const sourceText = await source(`.github/workflows/${workflow}`);
    for (const use of sourceText.matchAll(/uses:\s*([^\s#]+)/g)) {
      assert.match(use[1], /@[a-f0-9]{40}$/, `${workflow} contains a mobile action reference: ${use[1]}`);
    }
  }
  const dependabot = await source(".github/dependabot.yml");
  assert.match(dependabot, /package-ecosystem: github-actions/);
});

test("versioned GitHub policy protects main, release tags and deployment refs", async () => {
  const main = JSON.parse(await source("infra/github/main-ruleset.json"));
  const tagCreation = JSON.parse(await source("infra/github/release-tag-creation-ruleset.json"));
  const tagImmutability = JSON.parse(await source("infra/github/release-tags-ruleset.json"));
  const actions = JSON.parse(await source("infra/github/actions-permissions.json"));
  const selected = JSON.parse(await source("infra/github/selected-actions.json"));
  const configure = await source("infra/github/configure.sh");
  assert.equal(main.enforcement, "active");
  assert.deepEqual(
    main.rules.find((rule) => rule.type === "required_status_checks").parameters.required_status_checks.map((check) => check.context),
    ["verify (22)", "verify (24)"],
  );
  assert.ok(main.rules.some((rule) => rule.type === "pull_request"));
  assert.deepEqual(tagCreation.bypass_actors, [{ actor_id: 2201712, actor_type: "User", bypass_mode: "always" }]);
  assert.deepEqual(tagCreation.rules, [{ type: "creation" }]);
  assert.deepEqual(
    tagImmutability.rules.map((rule) => rule.type),
    ["deletion", "update"],
  );
  assert.deepEqual(actions, { enabled: true, allowed_actions: "selected", sha_pinning_required: true });
  assert.equal(selected.github_owned_allowed, true);
  assert.deepEqual(selected.patterns_allowed, ["aws-actions/configure-aws-credentials@*"]);
  assert.match(configure, /production tag 'v\*'/);
  assert.match(configure, /monitoring branch main/);
});
