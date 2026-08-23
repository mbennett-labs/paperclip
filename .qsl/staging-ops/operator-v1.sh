#!/usr/bin/env bash
set -euo pipefail

VERSION="qsl-staging-ops-v1.1.0"
SERVICE="paperclip-thebinmap-staging.service"
STAGING_USER="paperclip-thebinmap-staging"
STAGING_ROOT="/home/paperclip-thebinmap-staging/.paperclip-staging/instances/thebinmap-email-ops-staging"
DEPLOY_ROOT="/opt/paperclip-deployments/thebinmap-email-ops-staging"
API="http://127.0.0.1:3101/api"
COMPANY_ID="f5609cfe-37ff-4061-a3c7-35ae55dbcc2b"
CEO_ID="0fed0dae-12af-45e4-86a5-0c9bcc8f3ed5"
CEO_DIR="$STAGING_ROOT/companies/$COMPANY_ID/agents/$CEO_ID/instructions"
CEO_FILE="$CEO_DIR/AGENTS.md"
TEMPLATE="/usr/local/share/qsl-staging-ops/CEO_AGENTS.md"
LEGACY="${BASH_SOURCE[0]}.v0"

original="${SSH_ORIGINAL_COMMAND:-${*:-}}"
read -r -a argv <<< "$original"
op="${argv[0]:-}"

log_event() {
  local outcome="$1"
  logger -t qsl-staging-ops -- "version=$VERSION op=${op:-none} outcome=$outcome"
}

fail() {
  log_event "FAIL"
  printf 'QSL_STAGING_OPS_ERROR: %s\n' "$1" >&2
  exit 1
}

require_no_extra_args() {
  [[ ${#argv[@]} -eq 1 ]] || fail "unexpected arguments for $op"
}

api_get() {
  local path="$1"
  sudo -u "$STAGING_USER" -H curl -fsS --max-time 15 "$API$path"
}

api_patch_json() {
  local path="$1"
  local payload="$2"
  sudo -u "$STAGING_USER" -H curl -fsS --max-time 20 \
    -X PATCH \
    -H 'Content-Type: application/json' \
    --data "$payload" \
    "$API$path"
}

safe_ceo_config() {
  jq '{id,name,status,adapterType,adapterConfig:{model:(.adapterConfig.model // null),command:(.adapterConfig.command // null),instructionsFilePath:(.adapterConfig.instructionsFilePath // null),instructionsRootPath:(.adapterConfig.instructionsRootPath // null),instructionsEntryFile:(.adapterConfig.instructionsEntryFile // null),instructionsBundleMode:(.adapterConfig.instructionsBundleMode // null)},runtimeConfig:{heartbeat:(.runtimeConfig.heartbeat // null)}}'
}

delegate_legacy() {
  [[ -x "$LEGACY" ]] || fail "legacy dispatcher missing: $LEGACY"
  SSH_ORIGINAL_COMMAND="$original" "$LEGACY" "${argv[@]}"
}

case "$op" in
  health|live-shadow-report|deploy-email-plugin)
    delegate_legacy
    log_event "PASS"
    ;;

  operator-version)
    require_no_extra_args
    echo "$VERSION"
    echo "LEGACY_PRESENT=$([[ -x "$LEGACY" ]] && echo yes || echo no)"
    log_event "PASS"
    ;;

  inspect-ceo-config)
    require_no_extra_args
    echo "=== CEO CONFIG (SAFE FIELDS ONLY) ==="
    api_get "/agents/$CEO_ID/configuration" | safe_ceo_config
    echo
    echo "=== CEO INSTRUCTIONS FILE ==="
    printf 'EXPECTED=%s\n' "$CEO_FILE"
    if [[ -e "$CEO_FILE" ]]; then
      stat -c 'OWNER=%U GROUP=%G MODE=%a SIZE=%s' "$CEO_FILE"
      sudo -u "$STAGING_USER" test -r "$CEO_FILE" && echo 'READABLE_BY_STAGING=YES' || echo 'READABLE_BY_STAGING=NO'
    else
      echo 'EXISTS=NO'
    fi
    log_event "PASS"
    ;;

  repair-ceo-instructions)
    require_no_extra_args
    [[ -r "$TEMPLATE" ]] || fail "CEO instruction template missing"
    [[ "$CEO_FILE" == "$STAGING_ROOT"/* ]] || fail "CEO path escaped staging root"

    install -d -o "$STAGING_USER" -g "$STAGING_USER" -m 750 "$CEO_DIR"
    install -o "$STAGING_USER" -g "$STAGING_USER" -m 640 "$TEMPLATE" "$CEO_FILE"

    payload="$(jq -cn --arg path "$CEO_FILE" '{path:$path}')"
    echo "=== PATCH CEO INSTRUCTIONS PATH ==="
    api_patch_json "/agents/$CEO_ID/instructions-path" "$payload" >/tmp/qsl-ceo-path-response.json
    jq '{agentId,adapterConfigKey,path,cleared}' /tmp/qsl-ceo-path-response.json 2>/dev/null || cat /tmp/qsl-ceo-path-response.json
    rm -f /tmp/qsl-ceo-path-response.json

    echo
    echo "=== VERIFY CEO CONFIG ==="
    cfg="$(api_get "/agents/$CEO_ID/configuration")"
    printf '%s' "$cfg" | safe_ceo_config
    actual="$(printf '%s' "$cfg" | jq -r '.adapterConfig.instructionsFilePath // empty')"
    [[ "$actual" == "$CEO_FILE" ]] || fail "CEO instructionsFilePath verification failed"
    sudo -u "$STAGING_USER" test -r "$CEO_FILE" || fail "CEO instructions file is not readable by staging user"
    echo 'REPAIR_VERIFIED=YES'
    log_event "PASS"
    ;;

  test-ceo-task-access)
    [[ ${#argv[@]} -eq 2 ]] || fail "usage: test-ceo-task-access THE-N"
    issue="${argv[1]}"
    [[ "$issue" =~ ^THE-[0-9]+$ ]] || fail "invalid issue identifier"
    echo "=== TASK ACCESS PROOF ==="
    echo "EXECUTION_USER=$STAGING_USER"
    result="$(sudo -u "$STAGING_USER" -H curl -fsS --max-time 15 "$API/issues/$issue")"
    printf '%s' "$result" | jq '{id,identifier,title,status,priority,assigneeId,parentId}'
    resolved="$(printf '%s' "$result" | jq -r '.identifier // empty')"
    [[ "$resolved" == "$issue" ]] || fail "issue identifier did not resolve as requested"
    echo 'TASK_ACCESS=PASS'
    log_event "PASS"
    ;;

  restart-staging-service)
    require_no_extra_args
    echo "=== RESTART STAGING SERVICE ==="
    old_pid="$(systemctl show "$SERVICE" -p MainPID --value)"
    echo "OLD_PID=$old_pid"
    systemctl restart "$SERVICE"
    for _ in $(seq 1 20); do
      if [[ "$(systemctl is-active "$SERVICE" 2>/dev/null || true)" == "active" ]]; then
        if curl -fsS --max-time 5 "$API/health" >/tmp/qsl-staging-health.json 2>/dev/null; then
          break
        fi
      fi
      sleep 1
    done
    [[ "$(systemctl is-active "$SERVICE")" == "active" ]] || fail "staging service failed to become active"
    curl -fsS --max-time 5 "$API/health" >/tmp/qsl-staging-health.json || fail "staging API health failed after restart"
    new_pid="$(systemctl show "$SERVICE" -p MainPID --value)"
    echo "NEW_PID=$new_pid"
    jq '{status,version,serverVersion,deploymentMode,deploymentExposure,authReady,bootstrapStatus}' /tmp/qsl-staging-health.json
    rm -f /tmp/qsl-staging-health.json
    echo 'RESTART_VERIFIED=YES'
    log_event "PASS"
    ;;

  diagnostic-bundle)
    require_no_extra_args
    echo "=== QSL STAGING DIAGNOSTIC BUNDLE ==="
    date -u '+UTC=%Y-%m-%dT%H:%M:%SZ'
    echo "OPERATOR=$VERSION"
    echo
    echo "--- SERVICE ---"
    echo "ACTIVE=$(systemctl is-active "$SERVICE" 2>/dev/null || true)"
    echo "PID=$(systemctl show "$SERVICE" -p MainPID --value 2>/dev/null || true)"
    echo "USER=$(systemctl show "$SERVICE" -p User --value 2>/dev/null || true)"
    echo "WORKING_DIR=$(systemctl show "$SERVICE" -p WorkingDirectory --value 2>/dev/null || true)"
    echo
    echo "--- DEPLOYMENT GIT ---"
    git -C "$DEPLOY_ROOT" rev-parse HEAD 2>/dev/null | sed 's/^/HEAD=/' || true
    git -C "$DEPLOY_ROOT" branch --show-current 2>/dev/null | sed 's/^/BRANCH=/' || true
    if git -C "$DEPLOY_ROOT" diff --quiet --ignore-submodules -- 2>/dev/null && git -C "$DEPLOY_ROOT" diff --cached --quiet --ignore-submodules -- 2>/dev/null; then
      echo 'TREE_CLEAN=YES'
    else
      echo 'TREE_CLEAN=NO'
    fi
    echo
    echo "--- API HEALTH ---"
    curl -fsS --max-time 10 "$API/health" 2>/dev/null | jq '{status,version,serverVersion,deploymentMode,deploymentExposure,authReady,bootstrapStatus,serverInfo:{git:.serverInfo.git,databaseBackup:.serverInfo.databaseBackup}}' || echo 'API_HEALTH=UNAVAILABLE'
    echo
    echo "--- CEO CONFIG (SAFE FIELDS ONLY) ---"
    api_get "/agents/$CEO_ID/configuration" 2>/dev/null | safe_ceo_config || echo 'CEO_CONFIG=UNAVAILABLE'
    echo
    echo "--- CEO INSTRUCTIONS PATH ---"
    echo "EXPECTED=$CEO_FILE"
    if [[ -e "$CEO_FILE" ]]; then
      stat -c 'OWNER=%U GROUP=%G MODE=%a SIZE=%s' "$CEO_FILE" || true
      sudo -u "$STAGING_USER" test -r "$CEO_FILE" && echo 'READABLE_BY_STAGING=YES' || echo 'READABLE_BY_STAGING=NO'
    else
      echo 'EXISTS=NO'
    fi
    echo
    echo "--- DISK ---"
    df -h / "$STAGING_ROOT" 2>/dev/null | sed -n '1,4p'
    echo
    echo "--- RECENT SERVICE WARN/ERROR (REDACTED) ---"
    journalctl -u "$SERVICE" --since '-30 min' -n 160 --no-pager 2>/dev/null \
      | grep -Ei 'warn|error|fail|EACCES|permission|instructions|task|issue|opencode|poll' \
      | tail -n 100 \
      | sed -E \
          -e 's/(Bearer )[A-Za-z0-9._~+\/-]+/\1***REDACTED***/g' \
          -e 's/((api[_-]?key|token|password|secret)[=: ]+)[^ ,;]+/\1***REDACTED***/Ig' \
          -e 's/(OPENROUTER_API_KEY=)[^ ]+/\1***REDACTED***/g' \
      || true
    echo 'DIAGNOSTIC_BUNDLE_END=YES'
    log_event "PASS"
    ;;

  bridge-dispatch-readonly)
    require_no_extra_args
    bridge_dispatch_readonly
    log_event "PASS"
    ;;

  *)
    fail "unsupported operation"
    ;;
esac

# ── bridge-dispatch-readonly ──────────────────────────────────────────────
# QSL ChatGPT Orchestrator Bridge V1 — read-only over SSH forced command.
#
# Transport contract:
#   1. Read at most 65537 bytes from stdin.
#   2. If byte count > 65536, fail closed: request exceeds max size.
#   3. Parse JSON with jq.  Fail closed on malformed JSON.
#   4. Enforce environment == staging.
#   5. Enforce operation is in the hardcoded read-only allowlist.
#   6. Forward validated request to the localhost bridge API.
#   7. Capture actual HTTP status + response body into transport envelope.
#   8. Output exactly one JSON line to stdout.
#
# The allowlist here is AUTHORITATIVE — even if the server-side
# PAPERCLIP_BRIDGE_ENABLE_BOUNDED_WRITES flag is true, this gate
# prevents bounded-write and human-gated operations from ever
# reaching the bridge API.

bridge_dispatch_readonly() {
  local MAX=65536
  local TMP
  TMP=$(mktemp -d)
  trap 'rm -rf "$TMP"' RETURN

  local readonly_allowlist="status list-missions get-mission list-tasks get-task list-approvals list-mail-triage get-mail-thread-summary"

  head -c $((MAX + 1)) > "$TMP/request-raw"
  local byte_count
  byte_count=$(wc -c < "$TMP/request-raw")

  if [[ "$byte_count" -gt "$MAX" ]]; then
    printf '{"transport_version":1,"http_status":0,"body":{"result_class":"BLOCKED","sanitized_error":"request exceeds maximum size: %d bytes (limit %d)"}}\n' "$byte_count" "$MAX"
    exit 1
  fi

  if [[ "$byte_count" -eq 0 ]]; then
    printf '{"transport_version":1,"http_status":0,"body":{"result_class":"BLOCKED","sanitized_error":"request is empty"}}\n'
    exit 1
  fi

  if ! jq -c '.' "$TMP/request-raw" > "$TMP/request-parsed" 2>/dev/null; then
    printf '{"transport_version":1,"http_status":0,"body":{"result_class":"BLOCKED","sanitized_error":"invalid JSON"}}\n'
    exit 1
  fi

  local env op
  env=$(jq -r '.environment // empty' "$TMP/request-parsed")
  op=$(jq -r '.operation // empty' "$TMP/request-parsed")

  if [[ "$env" != "staging" ]]; then
    printf '{"transport_version":1,"http_status":0,"body":{"result_class":"BLOCKED","sanitized_error":"environment must be staging"}}\n'
    exit 1
  fi

  if [[ -z "$op" ]]; then
    printf '{"transport_version":1,"http_status":0,"body":{"result_class":"BLOCKED","sanitized_error":"missing operation"}}\n'
    exit 1
  fi

  local matched=""
  for allowed in $readonly_allowlist; do
    if [[ "$op" == "$allowed" ]]; then
      matched="yes"
      break
    fi
  done

  if [[ -z "$matched" ]]; then
    printf '{"transport_version":1,"http_status":0,"body":{"result_class":"BLOCKED","sanitized_error":"operation not in read-only allowlist: %s"}}\n' "$op"
    exit 1
  fi

  local http_status body
  http_status=$(curl -s -o "$TMP/response-body" -w '%{http_code}' \
    --max-time 15 \
    -X POST -H 'Content-Type: application/json' \
    "$API/qsl-orchestrator-bridge/companies/$COMPANY_ID/bridge" \
    -d @"$TMP/request-parsed")

  if body=$(jq -c '.' "$TMP/response-body" 2>/dev/null); then
    printf '{"transport_version":1,"http_status":%s,"body":%s}\n' "$http_status" "$body"
  else
    local raw
    raw=$(head -c 500 "$TMP/response-body")
    local safe_raw
    safe_raw=$(printf '%s' "$raw" | jq -Rs .)
    printf '{"transport_version":1,"http_status":%s,"body":{"result_class":"FAIL","sanitized_error":%s}}\n' "$http_status" "$safe_raw"
  fi
}
