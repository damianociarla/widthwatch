# Public scanner incident runbook

The public scanner switch is an independent, fail-closed WAF rule group. The operational `scanner-switch.yml` workflow changes only scanner state using the previously installed template; it never builds an image, publishes to ECR, updates App Runner or deploys the ordinary edge stack. The release-called `upgrade-scanner-switch.yml` workflow is the only normal path that installs the complete versioned control-plane template.

The rule blocks exact `POST /v1/scans`. Health, status and existing public report links remain available. Disable does not depend on SNS. Enable requires the expected email to have a confirmed subscription on both regional alert topics.

## Check current state

```bash
aws cloudformation describe-stacks \
  --region us-east-1 \
  --stack-name widthwatch-scanner-switch \
  --query "Stacks[0].[StackStatus,Parameters[?ParameterKey=='PublicScannerEnabled'].ParameterValue|[0],Outputs[?OutputKey=='PublicScannerStatus'].OutputValue|[0],Outputs[?OutputKey=='ControlPlaneRevision'].OutputValue|[0]]"
```

`false` / `DISABLED` is the cold-bootstrap default. An absent stack is not an enabled state; bootstrap the dedicated stack before the first application deploy. The application role has read-only access and refuses to deploy while the stack is absent.

`ControlPlaneRevision` is `bootstrap` until the first protected release upgrade, then becomes the SHA-256 digest of the installed template. A successful release summary records the same digest and preserved state. Before mutation, the upgrade stores the live template, state and revision in runner-temporary storage. Each accepted mutation is followed by its client request token until the root event and stack status reach a coherent terminal outcome. Transient CLI or AWS observation failures are retried and never imply that the previous revision is still installed. If candidate state, revision or edge verification fails after a confirmed install, the workflow restores that snapshot, verifies the restored edge behavior and still leaves the workflow red. Do not update the full template with the operational toggle workflow or an ordinary application deploy.

## Dispatch an exact switch run

Use a unique change ID and the latest released tag. The ID is embedded in `run-name`, so the lookup cannot attach to a previous dispatch.

```bash
state=disable
change_id="scanner-${state}-$(date -u +%Y%m%dT%H%M%SZ)"
release_tag="$(gh release view --json tagName --jq .tagName)"
started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

gh workflow run scanner-switch.yml \
  --ref "$release_tag" \
  -f state="$state" \
  -f change_id="$change_id"

for _ in {1..30}; do
  run_id="$(gh run list --workflow scanner-switch.yml --event workflow_dispatch --limit 30 \
    --json databaseId,displayTitle,createdAt \
    --jq ".[] | select(.displayTitle == \"Scanner $state · $change_id\" and .createdAt >= \"$started_at\") | .databaseId" | head -n 1)"
  [[ -n "$run_id" ]] && break
  sleep 2
done
test -n "$run_id"
gh run watch "$run_id" --exit-status
```

The workflow waits for WAF propagation. Disable succeeds only when health is `200` and scan admission is `403`. Enable succeeds only when health is `200` and a deliberately invalid scan reaches HTTP admission as `400`. A failed enable verification restores disabled state best effort and leaves the workflow red.

## Disable new scans

Run the dispatch block with `state=disable`. Then independently verify:

```bash
curl --fail https://d35vhnded4ly3z.cloudfront.net/health
curl --output /dev/null --silent --write-out '%{http_code}\n' \
  --header 'content-type: application/json' \
  --data '{"url":123}' \
  https://d35vhnded4ly3z.cloudfront.net/v1/scans
```

Expected results: health `200`; scan admission `403` with JSON error `scanner_paused`, `Access-Control-Allow-Origin: https://damianociarla.github.io` and `Cache-Control: no-store`. Do not run an application deploy to operate the switch. A normal application deploy reads the dedicated rule-group ARN but cannot change its enabled parameter.

## Upgrade the versioned template

Do not dispatch a separate mutable ref. A `vX.Y.Z` release calls `upgrade-scanner-switch.yml` as a reusable workflow after tag/version validation and before application deployment. It preserves the current scanner state, installs `infra/aws/scanner-switch.yml`, verifies `ControlPlaneRevision` and exercises the expected edge state. A failure blocks the application deploy and GitHub Release.

v0.4.11 requires the v0.4.10 control-plane revision to be installed. For an environment on v0.4.9 or earlier, install v0.4.10 first; do not bypass the missing-revision refusal.

To resume a failed control-plane migration after correcting an external AWS condition, first confirm the job reports either `Previous scanner control plane restored and verified`, `Previous scanner control plane was restored and verified by CloudFormation`, or a rejection-before-mutation followed by verification of the unchanged revision. If it reports any `CRITICAL` outcome—especially an unknown terminal state—inspect `describe-stacks` and the token-correlated `describe-stack-events` output until CloudFormation is terminal before running any switch or upgrade workflow. Then use **Re-run failed jobs** on the same immutable release run. If GitHub lost the run before creating any job and native rerun is unavailable, dispatch `release.yml` from `main` with that existing tag. The recovery path refuses historical versions, revalidates the latest stable tag reachable from `origin/main` and checks it out in every job. The workflow graph is still supplied by protected `main`. Never use recovery as rollback, and never move or recreate the tag.

Every release also parses the complete template and asserts both WAF branches: enabled must count exact scan admission so application validation remains reachable; disabled must block exact `POST /v1/scans` with the versioned JSON/CORS/no-store contract. Live upgrade verification exercises only the preserved operational state so an emergency-disabled scanner is never enabled automatically.

## Inspect alert readiness

```bash
aws sns list-subscriptions-by-topic --region eu-west-1 \
  --topic-arn "$(aws cloudformation describe-stacks --region eu-west-1 --stack-name widthwatch-api --query "Stacks[0].Outputs[?OutputKey=='OperationalAlertTopicArn'].OutputValue|[0]" --output text)"
aws sns list-subscriptions-by-topic --region us-east-1 \
  --topic-arn "$(aws cloudformation describe-stacks --region us-east-1 --stack-name widthwatch-edge --query "Stacks[0].Outputs[?OutputKey=='EdgeAlertTopicArn'].OutputValue|[0]" --output text)"
```

`PendingConfirmation` is not active alerting. The enable workflow checks for a confirmed email subscription matching the protected `WIDTHWATCH_BUDGET_ALERT_EMAIL` secret on both topics and refuses activation otherwise.

Application logs use three stable redacted events: `hosted_scan_completed`, `hosted_scan_failed` and `hosted_scan_rejected`. They contain bounded timing/count data or stable failure/rejection codes. They never contain client addresses, target URLs, hostnames, query strings, page content, raw messages or stack traces.

## Restore new scans

Run the dispatch block with `state=enable`. Re-run the independent requests with the invalid body shown above. Expected results: health `200`; scan admission `400`. A normal valid scan should then return `202` unless an ordinary application quota is exhausted.

## Cold bootstrap order

1. Deploy the additive `scanner-switch-iam.yml` stack containing the dedicated scanner switch and execution roles; existing application roles are not replaced.
2. Using bootstrap administrator credentials, deploy `infra/aws/scanner-switch.yml` in us-east-1 with the dedicated switch execution role and its default `PublicScannerEnabled=false` parameter.
3. Run the first API deploy. It verifies the disabled switch exists, then creates the API/alerts and the edge reference without receiving switch mutation permissions.
4. Confirm both SNS email subscriptions.
5. Dispatch `state=enable` explicitly.
6. Verify the hourly canary and alarms before treating the public scanner as operational.
