# Public scanner incident runbook

The public scanner switch is an independent, fail-closed WAF rule group. `scanner-switch.yml` updates only its dedicated CloudFormation stack; it never builds an image, publishes to ECR, updates App Runner, deploys the ordinary edge stack or reads an unreleased application artifact.

The rule blocks exact `POST /v1/scans`. Health, status and existing public report links remain available. Disable does not depend on SNS. Enable requires the expected email to have a confirmed subscription on both regional alert topics.

## Check current state

```bash
aws cloudformation describe-stacks \
  --region us-east-1 \
  --stack-name widthwatch-scanner-switch \
  --query "Stacks[0].[StackStatus,Parameters[?ParameterKey=='PublicScannerEnabled'].ParameterValue|[0],Outputs[?OutputKey=='PublicScannerStatus'].OutputValue|[0]]"
```

`false` / `DISABLED` is the cold-bootstrap default. An absent stack is not an enabled state; run the ordinary API bootstrap, which creates the switch disabled before building the application.

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

Expected results: health `200`; scan admission `403`. Do not run an application deploy to operate the switch. A normal release reads the dedicated rule-group ARN but cannot change its enabled parameter.

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
2. Run the first API deploy. It creates `widthwatch-scanner-switch` with `PublicScannerEnabled=false`, then creates the API/alerts and the edge reference.
3. Confirm both SNS email subscriptions.
4. Dispatch `state=enable` explicitly.
5. Verify the hourly canary and alarms before treating the public scanner as operational.
