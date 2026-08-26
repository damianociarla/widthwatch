#!/usr/bin/env bash
set -euo pipefail

expected_state="${1:-}"
api_url="${2:-}"
landing_origin="${WIDTHWATCH_LANDING_ORIGIN:-https://damianociarla.github.io}"
attempts="${WIDTHWATCH_VERIFY_ATTEMPTS:-24}"
delay_seconds="${WIDTHWATCH_VERIFY_DELAY_SECONDS:-5}"

case "$expected_state" in
  enabled | disabled) ;;
  *) echo "Expected scanner state must be enabled or disabled." >&2; exit 2 ;;
esac
[[ -n "$api_url" ]] || { echo "Set the public API URL." >&2; exit 2; }

verification_directory="$(mktemp -d)"
trap 'rm -r -- "$verification_directory"' EXIT

verify_once() {
  local health scan headers body
  health="$(curl --max-time 15 --output /dev/null --silent --show-error --write-out '%{http_code}' "$api_url/health" || true)"
  [[ "$health" == "200" ]] || return 1

  headers="$verification_directory/headers"
  body="$verification_directory/body"
  scan="$(curl --max-time 15 --silent --show-error --dump-header "$headers" --output "$body" --write-out '%{http_code}' \
    --header "Origin: $landing_origin" --header 'content-type: application/json' --data '{"url":123}' \
    "$api_url/v1/scans" || true)"

  if [[ "$expected_state" == "enabled" ]]; then
    [[ "$scan" == "400" ]] && jq -e '.error == "invalid_url"' "$body" >/dev/null
    return
  fi

  [[ "$scan" == "403" ]] || return 1
  tr -d '\r' <"$headers" >"$headers.normalized"
  grep -Eiq '^content-type:[[:space:]]*application/json([;[:space:]]|$)' "$headers.normalized" || return 1
  grep -Fxiq "access-control-allow-origin: $landing_origin" "$headers.normalized" || return 1
  grep -Fxiq 'cache-control: no-store' "$headers.normalized" || return 1
  jq -e '.error == "scanner_paused"' "$body" >/dev/null
}

for ((attempt = 1; attempt <= attempts; attempt += 1)); do
  if verify_once; then
    if [[ "$expected_state" == "disabled" ]]; then
      echo "Scanner disabled contract verified: health=200, scan=403, JSON/CORS/no-store present."
    else
      echo "Scanner enabled contract verified: health=200, invalid scan reaches admission as 400."
    fi
    exit 0
  fi
  [[ "$attempt" == "$attempts" ]] || sleep "$delay_seconds"
done

echo "Scanner $expected_state contract could not be verified at the edge." >&2
exit 1
