#!/usr/bin/env bash
set -euo pipefail

: "${WIDTHWATCH_SCANNER_SWITCH_EXECUTION_ROLE_ARN:?Set WIDTHWATCH_SCANNER_SWITCH_EXECUTION_ROLE_ARN}"

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
template="${WIDTHWATCH_SCANNER_SWITCH_TEMPLATE:-$script_directory/scanner-switch.yml}"
stack="widthwatch-scanner-switch"
region="us-east-1"
transaction_directory="$(mktemp -d)"
previous_template="$transaction_directory/previous-template"
template_response="$transaction_directory/template-response.json"
update_error="$transaction_directory/update-error"
trap 'rm -r -- "$transaction_directory"' EXIT

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
previous_revision="$(stack_output "$stack" ControlPlaneRevision)"
[[ -n "$previous_revision" && "$previous_revision" != "None" ]] || {
  echo "Scanner control-plane upgrade refused: current revision is unavailable." >&2
  exit 1
}

if ! aws cloudformation get-template --region "$region" --stack-name "$stack" \
  --template-stage Original --output json >"$template_response"; then
  echo "Scanner control-plane upgrade refused: previous template could not be captured." >&2
  exit 1
fi
if ! jq -er '.TemplateBody | if type == "string" then . else tojson end' \
  "$template_response" >"$previous_template" || [[ ! -s "$previous_template" ]]; then
  echo "Scanner control-plane upgrade refused: previous template snapshot is invalid." >&2
  exit 1
fi

apply_template() {
  local template_path="$1" state="$2" control_plane_revision="$3"
  : >"$update_error"
  if aws cloudformation update-stack \
    --region "$region" \
    --stack-name "$stack" \
    --role-arn "$WIDTHWATCH_SCANNER_SWITCH_EXECUTION_ROLE_ARN" \
    --template-body "file://$template_path" \
    --parameters \
      "ParameterKey=PublicScannerEnabled,ParameterValue=$state" \
      "ParameterKey=ControlPlaneRevision,ParameterValue=$control_plane_revision" >/dev/null 2>"$update_error"; then
    if ! aws cloudformation wait stack-update-complete --region "$region" --stack-name "$stack"; then
      echo "CloudFormation did not complete the scanner control-plane update." >&2
      return 1
    fi
  elif ! grep -Fq 'No updates are to be performed' "$update_error"; then
    cat "$update_error" >&2
    return 1
  fi
}

expected_state="disabled"
[[ "$current_state" == "true" ]] && expected_state="enabled"
api_url="$(stack_output widthwatch-edge ApiUrl)"
api_url="${api_url%/}"

verify_control_plane() {
  local expected_revision="$1" phase="$2" installed_state installed_revision
  installed_state="$(stack_parameter PublicScannerEnabled)"
  installed_revision="$(stack_output "$stack" ControlPlaneRevision)"
  if [[ "$installed_state" != "$current_state" ]]; then
    echo "Scanner control-plane $phase changed state from $current_state to $installed_state." >&2
    return 1
  fi
  if [[ "$installed_revision" != "$expected_revision" ]]; then
    echo "Scanner control-plane $phase revision mismatch: expected $expected_revision, got $installed_revision." >&2
    return 1
  fi
  "$script_directory/verify-scanner-edge.sh" "$expected_state" "$api_url"
}

rollback_control_plane() {
  echo "Candidate verification failed; restoring scanner control plane revision $previous_revision." >&2
  if ! apply_template "$previous_template" "$current_state" "$previous_revision"; then
    echo "CRITICAL: previous scanner control-plane template could not be restored." >&2
    return 1
  fi
  if ! verify_control_plane "$previous_revision" rollback; then
    echo "CRITICAL: scanner control-plane rollback could not be verified." >&2
    return 1
  fi
  echo "Previous scanner control plane restored and verified: revision=$previous_revision state=$expected_state." >&2
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    {
      echo "### Infrastructure migration"
      echo
      echo "- Candidate control plane revision: \`$revision\`"
      echo "- Result: verification failed"
      echo "- Restored revision: \`$previous_revision\`"
      echo "- Restored state and edge contract: verified"
    } >>"$GITHUB_STEP_SUMMARY"
  fi
  return 0
}

if ! apply_template "$template" "$current_state" "$revision"; then
  echo "Scanner control-plane candidate could not be installed; verifying the previous revision." >&2
  if verify_control_plane "$previous_revision" automatic-rollback; then
    echo "Previous scanner control plane remains installed and verified after the failed update." >&2
  else
    echo "CRITICAL: the previous scanner control plane could not be verified after the failed update." >&2
  fi
  exit 1
fi

if ! verify_control_plane "$revision" candidate; then
  rollback_control_plane || true
  exit 1
fi

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
