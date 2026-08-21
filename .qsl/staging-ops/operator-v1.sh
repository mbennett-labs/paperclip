#!/usr/bin/env bash
set -euo pipefail

VERSION="qsl-staging-ops-v1.0.0"
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

  *)
    fail "unsupported operation"
    ;;
esac
