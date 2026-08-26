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
observation_error="$transaction_directory/observation-error"
trap 'rm -r -- "$transaction_directory"' EXIT

status_attempts="${WIDTHWATCH_STACK_STATUS_ATTEMPTS:-120}"
status_delay_seconds="${WIDTHWATCH_STACK_STATUS_DELAY_SECONDS:-5}"
[[ "$status_attempts" =~ ^[1-9][0-9]*$ ]] || {
  echo "WIDTHWATCH_STACK_STATUS_ATTEMPTS must be a positive integer." >&2
  exit 1
}
[[ "$status_delay_seconds" =~ ^[0-9]+$ ]] || {
  echo "WIDTHWATCH_STACK_STATUS_DELAY_SECONDS must be a non-negative integer." >&2
  exit 1
}

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

request_token() {
  local phase="$1"
  printf 'widthwatch-%s-%s-%s' "$phase" "$(date +%s)" "$RANDOM"
}

resolve_stack_update() {
  local token="$1" phase="$2" attempt event_status stack_status observation_failed=false
  for ((attempt = 1; attempt <= status_attempts; attempt++)); do
    : >"$observation_error"
    if ! event_status="$(aws cloudformation describe-stack-events \
      --region "$region" \
      --stack-name "$stack" \
      --query "StackEvents[?ClientRequestToken=='$token' && LogicalResourceId=='$stack']|[0].ResourceStatus" \
      --output text 2>"$observation_error")"; then
      if [[ "$observation_failed" == false ]]; then
        echo "CloudFormation $phase observation failed transiently; resolving the accepted operation from stack events." >&2
        observation_failed=true
      fi
      [[ "$attempt" -lt "$status_attempts" ]] && sleep "$status_delay_seconds"
      continue
    fi
    if ! stack_status="$(aws cloudformation describe-stacks \
      --region "$region" \
      --stack-name "$stack" \
      --query 'Stacks[0].StackStatus' \
      --output text 2>"$observation_error")"; then
      if [[ "$observation_failed" == false ]]; then
        echo "CloudFormation $phase observation failed transiently; resolving the accepted operation from stack events." >&2
        observation_failed=true
      fi
      [[ "$attempt" -lt "$status_attempts" ]] && sleep "$status_delay_seconds"
      continue
    fi

    case "$event_status:$stack_status" in
      UPDATE_COMPLETE:UPDATE_COMPLETE) return 0 ;;
      UPDATE_ROLLBACK_COMPLETE:UPDATE_ROLLBACK_COMPLETE) return 2 ;;
      UPDATE_ROLLBACK_FAILED:*|*:UPDATE_ROLLBACK_FAILED) return 3 ;;
    esac
    [[ "$attempt" -lt "$status_attempts" ]] && sleep "$status_delay_seconds"
  done
  return 4
}

apply_template() {
  local template_path="$1" state="$2" control_plane_revision="$3" phase="$4" token outcome
  token="$(request_token "$phase")"
  : >"$update_error"
  if aws cloudformation update-stack \
    --region "$region" \
    --stack-name "$stack" \
    --role-arn "$WIDTHWATCH_SCANNER_SWITCH_EXECUTION_ROLE_ARN" \
    --client-request-token "$token" \
    --template-body "file://$template_path" \
    --parameters \
      "ParameterKey=PublicScannerEnabled,ParameterValue=$state" \
      "ParameterKey=ControlPlaneRevision,ParameterValue=$control_plane_revision" >/dev/null 2>"$update_error"; then
    if resolve_stack_update "$token" "$phase"; then
      return 0
    else
      outcome=$?
    fi
    case "$outcome" in
      2)
        echo "CloudFormation completed an automatic rollback of the $phase operation." >&2
        return 21
        ;;
      3)
        echo "CRITICAL: CloudFormation reached a failed terminal state for the $phase operation." >&2
        return 22
        ;;
      *)
        echo "CRITICAL: CloudFormation accepted the $phase operation, but its terminal state is still unknown." >&2
        return 23
        ;;
    esac
  elif grep -Fq 'No updates are to be performed' "$update_error"; then
    return 0
  else
    cat "$update_error" >&2
    echo "CloudFormation rejected the $phase operation before it started." >&2
    return 20
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
  if ! apply_template "$previous_template" "$current_state" "$previous_revision" rollback; then
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

if apply_template "$template" "$current_state" "$revision" candidate; then
  candidate_result=0
else
  candidate_result=$?
fi

case "$candidate_result" in
  0) ;;
  20)
    echo "Scanner control-plane candidate was rejected before mutation; verifying the previous revision." >&2
    if verify_control_plane "$previous_revision" unchanged; then
      echo "Previous scanner control plane remains installed and verified after the rejected update." >&2
    else
      echo "CRITICAL: the previous scanner control plane could not be verified after the rejected update." >&2
    fi
    exit 1
    ;;
  21)
    echo "Scanner control-plane candidate rolled back automatically; verifying the previous revision." >&2
    if verify_control_plane "$previous_revision" automatic-rollback; then
      echo "Previous scanner control plane was restored and verified by CloudFormation." >&2
    else
      echo "CRITICAL: the previous scanner control plane could not be verified after automatic rollback." >&2
    fi
    exit 1
    ;;
  *)
    echo "CRITICAL: scanner control-plane state requires operator inspection; no overlapping rollback was attempted." >&2
    exit 1
    ;;
esac

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
