#!/usr/bin/env bash
set -euo pipefail

: "${WIDTHWATCH_SCANNER_SWITCH_EXECUTION_ROLE_ARN:?Set WIDTHWATCH_SCANNER_SWITCH_EXECUTION_ROLE_ARN}"

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
template="${WIDTHWATCH_SCANNER_SWITCH_TEMPLATE:-$script_directory/scanner-switch.yml}"
stack="widthwatch-scanner-switch"
region="us-east-1"

if command -v sha256sum >/dev/null 2>&1; then
  revision="$(sha256sum "$template" | awk '{print $1}')"
else
  revision="$(shasum -a 256 "$template" | awk '{print $1}')"
fi

stack_parameter() {
  local key="$1"
  aws cloudformation describe-stacks --region "$region" --stack-name "$stack" \
    --query "Stacks[0].Parameters[?ParameterKey=='$key'].ParameterValue|[0]" --output text
}

stack_output() {
  local stack_name="$1" key="$2"
  aws cloudformation describe-stacks --region "$region" --stack-name "$stack_name" \
    --query "Stacks[0].Outputs[?OutputKey=='$key'].OutputValue|[0]" --output text
}

current_state="$(stack_parameter PublicScannerEnabled)"
[[ "$current_state" == "true" || "$current_state" == "false" ]] || {
  echo "Scanner control-plane upgrade refused: current state is unavailable." >&2
  exit 1
}

update_error="$(mktemp)"
trap 'rm -f -- "$update_error"' EXIT
if aws cloudformation update-stack \
  --region "$region" \
  --stack-name "$stack" \
  --role-arn "$WIDTHWATCH_SCANNER_SWITCH_EXECUTION_ROLE_ARN" \
  --template-body "file://$template" \
  --parameters \
    "ParameterKey=PublicScannerEnabled,ParameterValue=$current_state" \
    "ParameterKey=ControlPlaneRevision,ParameterValue=$revision" >/dev/null 2>"$update_error"; then
  aws cloudformation wait stack-update-complete --region "$region" --stack-name "$stack"
elif ! grep -Fq 'No updates are to be performed' "$update_error"; then
  cat "$update_error" >&2
  exit 1
fi

installed_state="$(stack_parameter PublicScannerEnabled)"
installed_revision="$(stack_output "$stack" ControlPlaneRevision)"
[[ "$installed_state" == "$current_state" ]] || {
  echo "Scanner control-plane upgrade changed state from $current_state to $installed_state." >&2
  exit 1
}
[[ "$installed_revision" == "$revision" ]] || {
  echo "Scanner control-plane revision mismatch: expected $revision, got $installed_revision." >&2
  exit 1
}

api_url="$(stack_output widthwatch-edge ApiUrl)"
api_url="${api_url%/}"
expected_state="disabled"
[[ "$current_state" == "true" ]] && expected_state="enabled"
"$script_directory/verify-scanner-edge.sh" "$expected_state" "$api_url"

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  {
    echo "### Infrastructure migration"
    echo
    echo "- Scanner control plane revision: \`$revision\`"
    echo "- Preserved scanner state: \`$expected_state\`"
    echo "- Installed template and edge contract: verified"
  } >>"$GITHUB_STEP_SUMMARY"
fi

echo "Scanner control plane upgraded: revision=$revision state=$expected_state."
