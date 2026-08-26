#!/usr/bin/env bash
set -euo pipefail

: "${WIDTHWATCH_SCANNER_STATE:?Set WIDTHWATCH_SCANNER_STATE to enable or disable}"
: "${WIDTHWATCH_SCANNER_SWITCH_EXECUTION_ROLE_ARN:?Set WIDTHWATCH_SCANNER_SWITCH_EXECUTION_ROLE_ARN}"

case "$WIDTHWATCH_SCANNER_STATE" in
  enable)
    desired="true"
    : "${WIDTHWATCH_ALERT_EMAIL:?Set WIDTHWATCH_ALERT_EMAIL}"
    ;;
  disable) desired="false" ;;
  *) echo "WIDTHWATCH_SCANNER_STATE must be enable or disable." >&2; exit 2 ;;
esac

stack_output() {
  local region="$1" stack="$2" key="$3"
  aws cloudformation describe-stacks --region "$region" --stack-name "$stack" \
    --query "Stacks[0].Outputs[?OutputKey=='$key'].OutputValue|[0]" --output text
}

assert_confirmed_email() {
  local region="$1" topic="$2"
  local subscriptions
  subscriptions="$(aws sns list-subscriptions-by-topic --region "$region" --topic-arn "$topic" --output json)"
  if ! jq -e --arg endpoint "$WIDTHWATCH_ALERT_EMAIL" \
    'any(.Subscriptions[]; .Protocol == "email" and .Endpoint == $endpoint and .SubscriptionArn != "PendingConfirmation")' \
    <<<"$subscriptions" >/dev/null; then
    echo "Scanner enable refused: $topic has no confirmed subscription for the operational email." >&2
    exit 1
  fi
}

if [[ "$desired" == "true" ]]; then
  assert_confirmed_email eu-west-1 "$(stack_output eu-west-1 widthwatch-api OperationalAlertTopicArn)"
  assert_confirmed_email us-east-1 "$(stack_output us-east-1 widthwatch-edge EdgeAlertTopicArn)"
fi

current="$(aws cloudformation describe-stacks --region us-east-1 --stack-name widthwatch-scanner-switch \
  --query "Stacks[0].Parameters[?ParameterKey=='PublicScannerEnabled'].ParameterValue|[0]" --output text)"
control_plane_revision="$(aws cloudformation describe-stacks --region us-east-1 --stack-name widthwatch-scanner-switch \
  --query "Stacks[0].Parameters[?ParameterKey=='ControlPlaneRevision'].ParameterValue|[0]" --output text)"

update_switch() {
  local value="$1"
  local parameters=("ParameterKey=PublicScannerEnabled,ParameterValue=$value")
  if [[ "$control_plane_revision" != "None" && -n "$control_plane_revision" ]]; then
    parameters+=("ParameterKey=ControlPlaneRevision,UsePreviousValue=true")
  fi
  aws cloudformation update-stack \
    --region us-east-1 \
    --stack-name widthwatch-scanner-switch \
    --use-previous-template \
    --role-arn "$WIDTHWATCH_SCANNER_SWITCH_EXECUTION_ROLE_ARN" \
    --parameters "${parameters[@]}" >/dev/null
  aws cloudformation wait stack-update-complete --region us-east-1 --stack-name widthwatch-scanner-switch
}

if [[ "$current" != "$desired" ]]; then
  update_switch "$desired"
fi

api_url="$(stack_output us-east-1 widthwatch-edge ApiUrl)"
api_url="${api_url%/}"

expected_state="disabled"
[[ "$desired" == "true" ]] && expected_state="enabled"
script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if "$script_directory/verify-scanner-edge.sh" "$expected_state" "$api_url"; then
  exit 0
fi

if [[ "$desired" == "true" ]]; then
  echo "Enable verification failed; restoring the fail-closed disabled state." >&2
  update_switch false || true
fi
echo "Scanner $WIDTHWATCH_SCANNER_STATE could not be verified at the edge." >&2
exit 1
