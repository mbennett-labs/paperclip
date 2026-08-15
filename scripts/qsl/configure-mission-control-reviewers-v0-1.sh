#!/usr/bin/env bash
set -euo pipefail

# QSL Mission Control V0.1 reviewer/recorder coordination configuration.
# Run only AFTER upgrade-mission-control-v0-1.sh has deployed the loopback-only
# Hermes Paperclip API containment gate. Staging only; no production mutation.

API_BASE="${PAPERCLIP_STAGING_API_BASE:-http://127.0.0.1:3101/api}"
REPO="${QSL_STAGING_REPO:-/opt/paperclip-deployments/thebinmap-email-ops-staging}"
COMPANY_ID="${QSL_MISSION_CONTROL_COMPANY_ID:-f32509d2-8cad-4754-baab-c87148c4c69a}"
SENTINEL_ID="${QSL_SENTINEL_GOVERNOR_ID:-413d0fce-52af-4764-bef5-6038ff1cd864}"
RECORDER_ID="${QSL_SELARIX_RECORDER_ID:-038946e0-f4bb-47e1-82b7-8818f7ab5f9f}"
PROD_SERVICE="paperclip-thebinmap-prod.service"
STAGING_SERVICE="paperclip-thebinmap-staging.service"

fail() { echo "BLOCKED: $*" >&2; exit 1; }
for cmd in curl jq systemctl; do command -v "$cmd" >/dev/null 2>&1 || fail "missing command: $cmd"; done
[[ "$API_BASE" == "http://127.0.0.1:3101/api" || "$API_BASE" == "http://localhost:3101/api" ]] \
  || fail "refusing non-staging API base: $API_BASE"

prod_pid() { systemctl show "$PROD_SERVICE" --property=MainPID --value; }
health() {
  [[ "$(systemctl is-active "$PROD_SERVICE")" == "active" ]] || fail "production inactive"
  [[ "$(systemctl is-active "$STAGING_SERVICE")" == "active" ]] || fail "staging inactive"
  curl -fsS http://127.0.0.1:3100/api/health >/dev/null || fail "production health failed"
  curl -fsS http://127.0.0.1:3101/api/health >/dev/null || fail "staging health failed"
}
api_get() { curl -fsS "$API_BASE$1"; }
api_patch() {
  local path="$1" payload="$2" label="$3" body status
  body="$(mktemp)"
  status="$(curl -sS -o "$body" -w '%{http_code}' -X PATCH "$API_BASE$path" -H 'Content-Type: application/json' --data-binary "$payload")" \
    || { rm -f "$body"; fail "$label transport failure"; }
  if [[ "$status" != "200" ]]; then
    echo "API ERROR: $label returned HTTP $status" >&2
    cat "$body" >&2 || true
    echo >&2
    rm -f "$body"
    fail "$label failed"
  fi
  rm -f "$body"
}

health
PID_BEFORE="$(prod_pid)"

configure_member() {
  local id="$1" label="$2" member config patch
  member="$(api_get "/agents/$id")"
  [[ "$(jq -r '.companyId // empty' <<<"$member")" == "$COMPANY_ID" ]] || fail "$label company mismatch"
  config="$(jq -c --arg repo "$REPO" --arg api "$API_BASE" '
    .adapterConfig
    | .cwd = $repo
    | .paperclipApiUrl = $api
    | .allowPaperclipApiAccess = true
  ' <<<"$member")"
  jq -e '[.. | objects | select(.type? == "secret_ref")] | length >= 1' <<<"$config" >/dev/null \
    || fail "$label config lost governed secret_ref"
  patch="$(jq -n --argjson adapterConfig "$config" '{adapterConfig:$adapterConfig,replaceAdapterConfig:true}')"
  api_patch "/agents/$id" "$patch" "$label coordination upgrade"
}

configure_member "$SENTINEL_ID" "Sentinel Governor"
configure_member "$RECORDER_ID" "Selarix Recorder"

for id in "$SENTINEL_ID" "$RECORDER_ID"; do
  member="$(api_get "/agents/$id")"
  [[ "$(jq -r '.adapterConfig.allowPaperclipApiAccess // false' <<<"$member")" == "true" ]] \
    || fail "reviewer/recorder API access did not persist for $id"
  [[ "$(jq -r '.adapterConfig.cwd // empty' <<<"$member")" == "$REPO" ]] \
    || fail "reviewer/recorder canonical cwd did not persist for $id"
done

health
PID_AFTER="$(prod_pid)"
[[ "$PID_AFTER" == "$PID_BEFORE" ]] || fail "production PID changed: before=$PID_BEFORE after=$PID_AFTER"

echo "QSL MISSION CONTROL V0.1 REVIEWER COORDINATION PASS"
echo "Sentinel: canonical repo RO + loopback staging API"
echo "Selarix: canonical repo RO + loopback staging API"
echo "Production isolation: PASS (PID $PID_BEFORE)"
