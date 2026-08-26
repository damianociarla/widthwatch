#!/usr/bin/env bash
set -euo pipefail

repository="${GH_REPOSITORY:-damianociarla/widthwatch}"
script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

upsert_ruleset() {
  local name="$1" payload="$2" id
  id="$(gh api "repos/$repository/rulesets" --jq ".[] | select(.name == \"$name\") | .id" | head -n 1)"
  if [[ -n "$id" ]]; then
    gh api --method PUT "repos/$repository/rulesets/$id" --input "$payload" >/dev/null
  else
    gh api --method POST "repos/$repository/rulesets" --input "$payload" >/dev/null
  fi
}

ensure_deployment_policy() {
  local environment="$1" type="$2" name="$3" existing
  existing="$(gh api "repos/$repository/environments/$environment/deployment-branch-policies" \
    --jq ".branch_policies[] | select(.type == \"$type\" and .name == \"$name\") | .id" | head -n 1)"
  if [[ -z "$existing" ]]; then
    jq -n --arg name "$name" --arg type "$type" '{name: $name, type: $type}' |
      gh api --method POST "repos/$repository/environments/$environment/deployment-branch-policies" --input - >/dev/null
  fi
}

gh api --method PUT "repos/$repository/actions/permissions" --input "$script_directory/actions-permissions.json" >/dev/null
gh api --method PUT "repos/$repository/actions/permissions/selected-actions" --input "$script_directory/selected-actions.json" >/dev/null

gh api --method PUT "repos/$repository/environments/production" --input "$script_directory/production-environment.json" >/dev/null
ensure_deployment_policy production branch main
ensure_deployment_policy production tag 'v*'

gh api --method PUT "repos/$repository/environments/monitoring" --input "$script_directory/monitoring-environment.json" >/dev/null
ensure_deployment_policy monitoring branch main

upsert_ruleset "Protect main" "$script_directory/main-ruleset.json"
upsert_ruleset "Authorize release tag creation" "$script_directory/release-tag-creation-ruleset.json"
upsert_ruleset "Keep release tags immutable" "$script_directory/release-tags-ruleset.json"

echo "GitHub supply-chain policy applied to $repository."
