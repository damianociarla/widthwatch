# Public scanner incident runbook

The public scanner kill switch is the `WIDTHWATCH_PUBLIC_SCANNER_ENABLED` variable in the protected GitHub `production` environment. Release and manual deploy workflows both read it, so an emergency stop survives normal releases until it is explicitly restored.

The switch changes only the highest-priority WAF rule for exact `POST /v1/scans` requests. Health checks, scan status and existing report reads remain available.

## Check current state

```bash
gh variable get WIDTHWATCH_PUBLIC_SCANNER_ENABLED --env production
aws cloudformation describe-stacks \
  --region us-east-1 \
  --stack-name widthwatch-edge \
  --query "Stacks[0].Outputs[?OutputKey=='PublicScannerStatus']"
```

An absent GitHub variable defaults to `true`. Set it explicitly before relying on the runbook.

## Disable new scans

```bash
gh variable set WIDTHWATCH_PUBLIC_SCANNER_ENABLED --env production --body false
gh workflow run deploy-api.yml --ref main
run_id="$(gh run list --workflow deploy-api.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
gh run watch "$run_id" --exit-status
```

Verify that health remains available while scan admission is blocked at the edge:

```bash
curl --fail https://d35vhnded4ly3z.cloudfront.net/health
curl --output /dev/null --silent --write-out '%{http_code}\n' \
  --header 'content-type: application/json' \
  --data '{"url":"https://example.com"}' \
  https://d35vhnded4ly3z.cloudfront.net/v1/scans
```

Expected results: health `200`; scan admission `403`.

## Inspect alerts

The two CloudFormation stacks output their regional SNS topic and subscription ARNs. A subscription value of `PendingConfirmation` is not active alerting; confirm both email subscriptions before treating the deployment as ready.

```bash
aws cloudwatch describe-alarms --region eu-west-1 --alarm-name-prefix widthwatch
aws cloudwatch describe-alarms --region us-east-1 --alarm-name-prefix widthwatch
aws budgets describe-budget --account-id "$AWS_ACCOUNT_ID" --budget-name widthwatch-monthly-cost
```

Application failure logs contain the fixed event name `hosted_scan_failed`. They include job ID, failure code, phase, duration and optional numeric transfer metadata. They never include target URLs, hostnames, query strings, page content, raw messages or stack traces.

## Restore new scans

Restoration is always explicit:

```bash
gh variable set WIDTHWATCH_PUBLIC_SCANNER_ENABLED --env production --body true
gh workflow run deploy-api.yml --ref main
run_id="$(gh run list --workflow deploy-api.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
gh run watch "$run_id" --exit-status
```

Re-run the health and scan requests. Expected results: health `200`; scan admission `202` unless an ordinary application or WAF quota is currently exhausted.
