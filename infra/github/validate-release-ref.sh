#!/usr/bin/env bash
set -euo pipefail

release_tag="${1:-}"
event_sha="${2:-}"

if [[ ! "$release_tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Release refs must be stable semantic-version tags such as v1.2.3." >&2
  exit 1
fi

if [[ "${GITHUB_REF_TYPE:-tag}" != "tag" || "${GITHUB_REF:-refs/tags/$release_tag}" != "refs/tags/$release_tag" ]]; then
  echo "Release workflows may run only for an exact tag ref." >&2
  exit 1
fi

if ! git show-ref --verify --quiet "refs/tags/$release_tag"; then
  echo "Release tag $release_tag does not exist in the checkout." >&2
  exit 1
fi

resolved_sha="$(git rev-parse "refs/tags/$release_tag^{commit}")"
if [[ -z "$event_sha" || "$resolved_sha" != "$event_sha" ]]; then
  echo "Release tag $release_tag resolves to $resolved_sha instead of the event commit $event_sha." >&2
  exit 1
fi

if ! git show-ref --verify --quiet refs/remotes/origin/main || ! git merge-base --is-ancestor "$resolved_sha" refs/remotes/origin/main; then
  echo "Release tag $release_tag is not connected to origin/main." >&2
  exit 1
fi

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
node "$script_directory/validate-release-version.mjs" "$release_tag"

echo "Release ref verified: $release_tag -> $resolved_sha"
