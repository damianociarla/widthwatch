import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  assert.match(scannerSwitch, /ResponseCode: 403/);
  assert.match(scannerSwitch, /Access-Control-Allow-Origin/);
  assert.match(scannerSwitch, /Cache-Control, Value: "no-store"/);
  assert.match(edge, /ResponseCode: 429/);
  assert.match(edge, /ScannerRateLimited/);
  assert.match(edge, /Access-Control-Allow-Origin/);
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
  const syntax = spawnSync("bash", ["-n", `${root}/infra/aws/deploy.sh`], {
    encoding: "utf8",
  });
  assert.equal(syntax.status, 0, syntax.stderr);
});

test("release only accepts an immutable semantic-version tag connected to main", async (t) => {
  const workflow = await source(".github/workflows/release.yml");
  const validator = `${root}/infra/github/validate-release-ref.sh`;
  assert.doesNotMatch(workflow, /workflow_dispatch/);
  assert.doesNotMatch(workflow, /inputs\.tag/);
  assert.doesNotMatch(workflow, /ref: "\$\{\{ env\.RELEASE_TAG \}\}"/);
  assert.match(workflow, /ref: "\$\{\{ github\.sha \}\}"/);
  assert.match(workflow, /validate-release-ref\.sh/);

  const directory = await mkdtemp(join(tmpdir(), "widthwatch-release-ref-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = (...args) => spawnSync("git", args, { cwd: directory, encoding: "utf8" });
  assert.equal(git("init", "--initial-branch=main").status, 0);
  assert.equal(git("config", "user.name", "WidthWatch test").status, 0);
  assert.equal(git("config", "user.email", "test@widthwatch.invalid").status, 0);
  await writeFile(join(directory, "fixture.txt"), "main\n");
  assert.equal(git("add", "fixture.txt").status, 0);
  assert.equal(git("commit", "-m", "main").status, 0);
  const mainSha = git("rev-parse", "HEAD").stdout.trim();
  assert.equal(git("update-ref", "refs/remotes/origin/main", mainSha).status, 0);
  assert.equal(git("tag", "-a", "v1.2.3", "-m", "valid").status, 0);

  const run = (tag, sha, extraEnvironment = {}) =>
    spawnSync(validator, [tag, sha], {
      cwd: directory,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_REF_TYPE: "tag",
        GITHUB_REF: `refs/tags/${tag}`,
        ...extraEnvironment,
      },
    });
  assert.equal(run("v1.2.3", mainSha).status, 0);
  assert.notEqual(run("main", mainSha).status, 0);
  assert.notEqual(run(mainSha, mainSha).status, 0);
  assert.notEqual(run("v9.9.9", mainSha).status, 0);

  assert.equal(git("switch", "-c", "feature").status, 0);
  await writeFile(join(directory, "fixture.txt"), "feature\n");
  assert.equal(git("commit", "-am", "feature").status, 0);
  const featureSha = git("rev-parse", "HEAD").stdout.trim();
  assert.equal(git("tag", "-a", "v1.2.4", "-m", "off main").status, 0);
  assert.notEqual(run("v1.2.4", featureSha).status, 0);
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
    const result = spawnSync("bash", ["-n", `${root}/${path}`], {
      encoding: "utf8",
    });
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
  const productionPolicies = JSON.parse(await source("infra/github/production-deployment-policies.json"));
  const monitoringPolicies = JSON.parse(await source("infra/github/monitoring-deployment-policies.json"));
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
  assert.deepEqual(actions, {
    enabled: true,
    allowed_actions: "selected",
    sha_pinning_required: true,
  });
  assert.equal(selected.github_owned_allowed, true);
  assert.deepEqual(selected.patterns_allowed, ["aws-actions/configure-aws-credentials@*"]);
  assert.deepEqual(productionPolicies, [
    { name: "main", type: "branch" },
    { name: "v*", type: "tag" },
  ]);
  assert.deepEqual(monitoringPolicies, [{ name: "main", type: "branch" }]);
  assert.match(configure, /--method DELETE/);
  assert.match(configure, /Deployment policy drift remains/);
});

test("GitHub deployment policy reconciliation deletes drift and restores the manifest", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "widthwatch-github-policy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = join(directory, "bin");
  const state = join(directory, "state.json");
  const fakeGh = join(bin, "gh");
  await writeFile(
    state,
    JSON.stringify({
      branch_policies: [
        { id: 1, name: "main", type: "branch" },
        { id: 2, name: "feature/*", type: "branch" },
      ],
    }),
  );
  spawnSync("mkdir", ["-p", bin]);
  await writeFile(
    fakeGh,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
let method = "GET";
for (let index = 0; index < args.length; index += 1) if (args[index] === "--method") method = args[index + 1];
const endpoint = args.find((value) => value.startsWith("repos/"));
const path = process.env.GH_POLICY_STATE;
const state = JSON.parse(fs.readFileSync(path, "utf8"));
if (method === "DELETE") {
  const id = Number(endpoint.split("/").at(-1));
  state.branch_policies = state.branch_policies.filter((policy) => policy.id !== id);
  fs.writeFileSync(path, JSON.stringify(state));
} else if (method === "POST") {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => (input += chunk));
  process.stdin.on("end", () => {
    const policy = JSON.parse(input);
    state.branch_policies.push({ id: Math.max(0, ...state.branch_policies.map((item) => item.id)) + 1, ...policy });
    fs.writeFileSync(path, JSON.stringify(state));
    process.stdout.write(JSON.stringify(policy));
  });
} else {
  process.stdout.write(JSON.stringify(args.includes("--slurp") ? [state] : state));
}
`,
  );
  await chmod(fakeGh, 0o755);
  const result = spawnSync(
    "bash",
    [
      "-c",
      'source "$1"; reconcile_deployment_policies production "$2"',
      "test",
      `${root}/infra/github/configure.sh`,
      `${root}/infra/github/production-deployment-policies.json`,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        GH_POLICY_STATE: state,
        PATH: `${bin}:${process.env.PATH}`,
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const reconciled = JSON.parse(await readFile(state, "utf8")).branch_policies.map(({ name, type }) => ({ name, type }));
  assert.deepEqual(reconciled, [
    { name: "main", type: "branch" },
    { name: "v*", type: "tag" },
  ]);
});
