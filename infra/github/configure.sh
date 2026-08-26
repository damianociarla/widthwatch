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

reconcile_deployment_policies() {
  local environment="$1" manifest="$2" endpoint current actual desired id type name
  endpoint="repos/$repository/environments/$environment/deployment-branch-policies"
  current="$(
    gh api --paginate --slurp "$endpoint?per_page=100" |
      jq -c '{branch_policies: [.[].branch_policies[]]}'
  )"

  while IFS=$'\t' read -r id type name; do
    if ! jq -e --arg type "$type" --arg name "$name" '.[] | select(.type == $type and .name == $name)' "$manifest" >/dev/null; then
      gh api --method DELETE "$endpoint/$id" >/dev/null
    fi
  done < <(jq -r '.branch_policies[] | [.id, .type, .name] | @tsv' <<<"$current")

  current="$(
    gh api --paginate --slurp "$endpoint?per_page=100" |
      jq -c '{branch_policies: [.[].branch_policies[]]}'
  )"
  while IFS=$'\t' read -r type name; do
    if ! jq -e --arg type "$type" --arg name "$name" '.branch_policies[] | select(.type == $type and .name == $name)' <<<"$current" >/dev/null; then
      jq -n --arg name "$name" --arg type "$type" '{name: $name, type: $type}' |
        gh api --method POST "$endpoint" --input - >/dev/null
    fi
  done < <(jq -r '.[] | [.type, .name] | @tsv' "$manifest")

  actual="$(
    gh api --paginate --slurp "$endpoint?per_page=100" |
      jq -c '[.[].branch_policies[] | {name, type}] | sort_by(.type, .name)'
  )"
  desired="$(jq -c '[.[] | {name, type}] | sort_by(.type, .name)' "$manifest")"
  if [[ "$actual" != "$desired" ]]; then
    echo "Deployment policy drift remains for $environment: expected $desired, got $actual" >&2
    return 1
  fi
}

main() {
  gh api --method PUT "repos/$repository/actions/permissions" --input "$script_directory/actions-permissions.json" >/dev/null
  gh api --method PUT "repos/$repository/actions/permissions/selected-actions" --input "$script_directory/selected-actions.json" >/dev/null

  gh api --method PUT "repos/$repository/environments/production" --input "$script_directory/production-environment.json" >/dev/null
  reconcile_deployment_policies production "$script_directory/production-deployment-policies.json"

  gh api --method PUT "repos/$repository/environments/monitoring" --input "$script_directory/monitoring-environment.json" >/dev/null
  reconcile_deployment_policies monitoring "$script_directory/monitoring-deployment-policies.json"

  gh api --method PUT "repos/$repository/environments/github-pages" --input "$script_directory/pages-environment.json" >/dev/null
  reconcile_deployment_policies github-pages "$script_directory/pages-deployment-policies.json"

  upsert_ruleset "Protect main" "$script_directory/main-ruleset.json"
  upsert_ruleset "Authorize release tag creation" "$script_directory/release-tag-creation-ruleset.json"
  upsert_ruleset "Keep release tags immutable" "$script_directory/release-tags-ruleset.json"

  echo "GitHub supply-chain policy applied to $repository."
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
