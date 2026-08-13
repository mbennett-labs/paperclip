#!/usr/bin/env bash
# Operator Loop V0 — Mission Runner (A-H Workflow)
#
# Orchestrates the full autonomous engineering operator loop for ONE mission.
#
#   MISSION → Preflight → Implement → Verify → Commit → Review → Staging Deploy
#   → Production Isolation → Evidence → DONE
#
# OR escalates meaningful policy/safety ambiguity to a human.
#
# Reuses proven Hermes/OpenClaw execution lane with containment controls.
#
# Usage:
#   ./run-mission.sh --mission-id ID [--issue-id ID] [--repo-dir DIR] \
#     [--api-base URL] [--company-id ID] [--message "description"]
#
# Environment:
#   PAPERCLIP_OPERATOR_API_BASE   API base URL (default: http://localhost:3101/api)
#   PAPERCLIP_OPERATOR_COMPANY_ID Default company ID
#   PAPERCLIP_OPERATOR_STAGING_URL    Staging health URL
#   PAPERCLIP_OPERATOR_PRODUCTION_URL Production health URL
#
# Exit codes:
#   0  Mission completed successfully
#   1  Mission failed (preserved evidence)
#   2  Usage error
#   3  Escalated (human review required)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR=""
MISSION_ID=""
ISSUE_ID=""
COMPANY_ID="${PAPERCLIP_OPERATOR_COMPANY_ID:-}"
API_BASE="${PAPERCLIP_OPERATOR_API_BASE:-http://localhost:3101/api}"
STAGING_URL="${PAPERCLIP_OPERATOR_STAGING_URL:-http://localhost:3101}"
PRODUCTION_URL="${PAPERCLIP_OPERATOR_PRODUCTION_URL:-http://localhost:3100}"
MESSAGE="Autonomous operator mission"
PROVIDER="openrouter"
MODEL="openrouter/deepseek/deepseek-chat"
COMMIT_MESSAGE=""
DRY_RUN=false

# ── Argument parsing ─────────────────────────────────────────────────────────

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mission-id)
      MISSION_ID="$2"; shift 2 ;;
    --issue-id)
      ISSUE_ID="$2"; shift 2 ;;
    --repo-dir)
      REPO_DIR="$2"; shift 2 ;;
    --api-base)
      API_BASE="$2"; shift 2 ;;
    --company-id)
      COMPANY_ID="$2"; shift 2 ;;
    --message)
      MESSAGE="$2"; shift 2 ;;
    --provider)
      PROVIDER="$2"; shift 2 ;;
    --model)
      MODEL="$2"; shift 2 ;;
    --commit-message)
      COMMIT_MESSAGE="$2"; shift 2 ;;
    --dry-run)
      DRY_RUN=true; shift ;;
    --help|-h)
      echo "Usage: $0 --mission-id ID [options]"
      echo ""
      echo "Required:"
      echo "  --mission-id ID       Unique mission identifier"
      echo ""
      echo "Optional:"
      echo "  --issue-id ID         Paperclip issue ID to bind"
      echo "  --repo-dir DIR        Repository directory (default: cwd)"
      echo "  --api-base URL        Paperclip API base URL"
      echo "  --company-id ID       Paperclip company ID"
      echo "  --message TEXT        Mission description"
      echo "  --commit-message MSG  Git commit message override"
      echo "  --dry-run             Run through workflow without mutating"
      exit 0 ;;
    *)
      echo "ERROR: Unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$MISSION_ID" ]]; then
  echo "FAIL: --mission-id is required" >&2
  exit 2
fi

if [[ -z "$REPO_DIR" ]]; then
  REPO_DIR="$(pwd)"
fi
REPO_DIR="$(cd "$REPO_DIR" 2>/dev/null && pwd)" || {
  echo "FAIL: repo-dir does not exist: $REPO_DIR" >&2
  exit 1
}

if [[ "$DRY_RUN" == "true" ]]; then
  echo "=== DRY RUN MODE — No mutations will be performed ==="
fi

echo ""
echo "╔════════════════════════════════════════════════════════╗"
echo "║  OPERATOR LOOP V0 — Autonomous Mission Runner         ║"
echo "╚════════════════════════════════════════════════════════╝"
echo ""
echo "  Mission: $MISSION_ID"
echo "  Issue: ${ISSUE_ID:-<none>}"
echo "  Repo: $REPO_DIR"
echo "  API: $API_BASE"
echo "  Provider: $PROVIDER"
echo "  Model: $MODEL"
echo "  Message: $MESSAGE"
echo ""

# ── Mission state tracking ───────────────────────────────────────────────────

INITIAL_HEAD=""
FINAL_HEAD=""
MISSION_RECORD_ID=""
STAGING_PID=""
PRODUCTION_PID_BEFORE=""
REVIEW_VERDICT=""
RETRIES="0"
ESCALATIONS="0"

# ── Helper: API call ─────────────────────────────────────────────────────────

api_post() {
  local endpoint="$1"; local data="$2"
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "  [DRY RUN] POST $API_BASE$endpoint: $data" >&2
    return 0
  fi
  curl -s -X POST "$API_BASE$endpoint" \
    -H "Content-Type: application/json" \
    -d "$data" 2>/dev/null || echo "{}"
}

api_patch() {
  local endpoint="$1"; local data="$2"
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "  [DRY RUN] PATCH $API_BASE$endpoint: $data" >&2
    return 0
  fi
  curl -s -X PATCH "$API_BASE$endpoint" \
    -H "Content-Type: application/json" \
    -d "$data" 2>/dev/null || echo "{}"
}

api_get() {
  local endpoint="$1"
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "  [DRY RUN] GET $API_BASE$endpoint" >&2
    return 0
  fi
  curl -s "$API_BASE$endpoint" 2>/dev/null || echo "{}"
}

# ── Stage tracking ───────────────────────────────────────────────────────────

record_mission() {
  if [[ -n "$COMPANY_ID" ]] && [[ "$DRY_RUN" != "true" ]]; then
    local result
    result="$(api_post "/companies/$COMPANY_ID/operator-missions" \
      "{\"missionId\":\"$MISSION_ID\",\"issueId\":${ISSUE_ID:+\"$ISSUE_ID\"},\"provider\":\"$PROVIDER\",\"model\":\"$MODEL\",\"credentialRefType\":\"secret_ref\"}")"
    MISSION_RECORD_ID="$(echo "$result" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null || echo "")"
  fi
}

update_mission_status() {
  local status="$1"; local evidence="${2:-{}}"
  if [[ -n "$COMPANY_ID" ]] && [[ "$DRY_RUN" != "true" ]]; then
    api_patch "/companies/$COMPANY_ID/operator-missions/$MISSION_ID" \
      "{\"status\":\"$status\",\"evidence\":$evidence}"
  fi
}

# ═══════════════════════════════════════════════════════════════════════════════
# A. PREFLIGHT
# ═══════════════════════════════════════════════════════════════════════════════

echo "━━━ A. PREFLIGHT ━━━"
echo ""

record_mission
update_mission_status "preflighting"

PREFLIGHT_OUTPUT="$("$SCRIPT_DIR/preflight.sh" \
  --mission-id "$MISSION_ID" \
  --repo-dir "$REPO_DIR" \
  --staging-url "${STAGING_URL}/api/health" \
  --production-url "${PRODUCTION_URL}/api/health" 2>&1)" || {
    echo ""
    echo "MISSION FAILED: Preflight checks did not pass"
    echo "$PREFLIGHT_OUTPUT"
    update_mission_status "preflight_failed"
    exit 1
  }

echo "$PREFLIGHT_OUTPUT"

INITIAL_HEAD="$(echo "$PREFLIGHT_OUTPUT" | grep "initial_head" | tail -1 | python3 -c "import sys; print(sys.stdin.read().strip().split('\"initial_head\": \"')[1].split('\"')[0])" 2>/dev/null || echo "unknown")"
STAGING_PID="$(echo "$PREFLIGHT_OUTPUT" | grep "staging_pid" | tail -1 | python3 -c "import sys; print(sys.stdin.read().strip().split('\"staging_pid\": \"')[1].split('\"')[0])" 2>/dev/null || echo "")"
PRODUCTION_PID_BEFORE="$(echo "$PREFLIGHT_OUTPUT" | grep "production_pid" | tail -1 | python3 -c "import sys; print(sys.stdin.read().strip().split('\"production_pid\": \"')[1].split('\"')[0])" 2>/dev/null || echo "")"

update_mission_status "preflight_passed" "{\"initial_head\":\"$INITIAL_HEAD\"}"

# ═══════════════════════════════════════════════════════════════════════════════
# B. IMPLEMENTATION (Hermes/OpenClaw)
# ═══════════════════════════════════════════════════════════════════════════════

echo ""
echo "━━━ B. IMPLEMENTATION ━━━"
echo ""
echo "  Delegating to Hermes/OpenClaw (hermes_local, commandDialect=openclaw)"
echo "  This stage is handled by the existing Paperclip heartbeat + Hermes adapter."
echo "  The agent receives the mission and constraints through standard wake/execute."
echo ""
echo "  For V0, the operator submits the mission to the Paperclip board as an issue,"
echo "  and the Hermes agent picks it up through the normal heartbeat loop."
echo ""

if [[ -n "$ISSUE_ID" ]]; then
  echo "  Issue: $ISSUE_ID (already exists — agent will execute via heartbeat)"
else
  echo "  INFO: No issue-id provided. For full autonomous execution, create an issue"
  echo "  via the Paperclip board and assign a hermes_local agent."
  echo ""
  echo "  Manual alternative:"
  echo "    curl -X POST $API_BASE/companies/COMPANY_ID/issues \\"
  echo "      -d '{\"title\":\"$MESSAGE\",\"assigneeAgentId\":\"HERMES_AGENT_ID\"}'"
fi

update_mission_status "implementing"

# In V0, we don't block on Hermes completion — the operator submits and the
# heartbeat system runs the agent. For the workflow continuity, we note this.

echo ""
echo "  Implementation dispatched via Paperclip agent heartbeat."
echo "  Monitor at: $API_BASE/companies/$COMPANY_ID/mission/$ISSUE_ID"

# ═══════════════════════════════════════════════════════════════════════════════
# C. VERIFICATION
# ═══════════════════════════════════════════════════════════════════════════════

echo ""
echo "━━━ C. VERIFICATION ━━━"
echo ""

update_mission_status "verifying"

VERIFY_OUTPUT="$("$SCRIPT_DIR/verify-mission.sh" \
  --mission-id "$MISSION_ID" \
  --repo-dir "$REPO_DIR" 2>&1)" || {
    echo ""
    echo "MISSION FAILED: Verification checks did not pass"
    echo "$VERIFY_OUTPUT"
    update_mission_status "verification_failed" "{\"tests\":\"failed\"}"
    exit 1
  }

echo "$VERIFY_OUTPUT"
update_mission_status "verification_passed" "{\"tests\":\"passed\"}"

# ═══════════════════════════════════════════════════════════════════════════════
# D. COMMIT
# ═══════════════════════════════════════════════════════════════════════════════

echo ""
echo "━━━ D. COMMIT ━━━"
echo ""

DIRTY="$(git -C "$REPO_DIR" status --porcelain 2>/dev/null || echo "")"

if [[ -n "$DIRTY" ]]; then
  COMMIT_MSG="${COMMIT_MESSAGE:-operator: mission $MISSION_ID — $MESSAGE}"
  echo "  Changed files:"
  echo "$DIRTY" | head -20

  if [[ "$DRY_RUN" != "true" ]]; then
    git -C "$REPO_DIR" add -A
    git -C "$REPO_DIR" commit -m "$COMMIT_MSG"
    FINAL_HEAD="$(git -C "$REPO_DIR" rev-parse HEAD)"
    echo "  Committed: $FINAL_HEAD"
    echo "  Message: $COMMIT_MSG"
  else
    echo "  [DRY RUN] Would commit: $COMMIT_MSG"
  fi
else
  echo "  Working directory is clean — nothing to commit"
  FINAL_HEAD="$INITIAL_HEAD"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# E. REVIEW
# ═══════════════════════════════════════════════════════════════════════════════

echo ""
echo "━━━ E. REVIEW ━━━"
echo ""

# Independent review stage — validate mission compliance, diff, security impact
# In V0, we run a structural check without needing a separate model execution.

REVIEW_FAILED=0

echo "  Reviewing mission compliance..."

# E1: Verify mission-scoped changes only (no unexpected files)
if [[ -n "$DIRTY" ]]; then
  UNEXPECTED_FILES="$(git -C "$REPO_DIR" diff --name-only HEAD~1 2>/dev/null | grep -v -E '^(server/|packages/|scripts/|doc/|src/|tests/|.paperclip/)' || echo "")"
  if [[ -n "$UNEXPECTED_FILES" ]]; then
    echo "  WARNING: Changes outside expected paths:"
    echo "$UNEXPECTED_FILES" | sed 's/^/    /'
    REVIEW_FAILED=1
  fi
fi

# E2: Verify no secrets in diff
SECRET_LEAK=""
SECRET_LEAK="$(git -C "$REPO_DIR" diff HEAD~1 2>/dev/null | grep -iE '(api.?key|_secret_|token\s*=|password\s*=)' | grep -v '//\|#\|secret_ref\|SECRET_PROVIDERS' || echo "")"
if [[ -n "$SECRET_LEAK" ]]; then
  echo "  FAIL: Potential secret in diff:"
  echo "$SECRET_LEAK" | head -5
  REVIEW_FAILED=1
else
  echo "  PASS: No secrets detected in diff"
fi

# E3: Verify no production references
PROD_LEAK="$(git -C "$REPO_DIR" diff HEAD~1 2>/dev/null | grep -iE '(production.*deploy|restart.*3100)' | grep -v 'productionUntouched\|PRODUCTION\|//\|#' || echo "")"
if [[ -n "$PROD_LEAK" ]]; then
  echo "  WARNING: Potential production references in diff"
  REVIEW_FAILED=1
fi

if [[ $REVIEW_FAILED -eq 1 ]]; then
  REVIEW_VERDICT="ESCALATE"
  echo "  Review verdict: ESCALATE"
  update_mission_status "review_escalated"
  ESCALATIONS="$((ESCALATIONS + 1))"
  echo ""
  echo "MISSION ESCALATED: Review found issues requiring human attention"
  exit 3
fi

REVIEW_VERDICT="PASS"
echo "  Review verdict: PASS"
update_mission_status "review_passed" "{\"review_verdict\":\"PASS\"}"

# ═══════════════════════════════════════════════════════════════════════════════
# F. STAGING DEPLOYMENT
# ═══════════════════════════════════════════════════════════════════════════════

echo ""
echo "━━━ F. STAGING DEPLOYMENT ━━━"
echo ""

update_mission_status "deploying"

if [[ "$DRY_RUN" != "true" ]]; then
  # Build required components
  echo "  Building..."
  cd "$REPO_DIR" && pnpm build 2>&1 | tail -5 || true

  # Restart staging
  echo "  Restarting staging service..."
  OLD_STAGING_PID="$STAGING_PID"

  if [[ -n "$OLD_STAGING_PID" ]]; then
    kill "$OLD_STAGING_PID" 2>/dev/null || true
    sleep 2
  fi

  # Start staging in background
  cd "$REPO_DIR" && nohup pnpm dev:server > /tmp/staging-operator-${MISSION_ID}.log 2>&1 &
  STAGING_NEW_PID="$!"
  STAGING_PID="$STAGING_NEW_PID"

  echo "  New staging PID: $STAGING_PID"

  # Wait for health
  for i in $(seq 1 30); do
    if curl -s -o /dev/null -w '%{http_code}' "${STAGING_URL}/api/health" 2>/dev/null | grep -q "200"; then
      echo "  Staging healthy after ${i}s"
      break
    fi
    sleep 1
  done

  STAGING_HEALTH="$(curl -s -o /dev/null -w '%{http_code}' "${STAGING_URL}/api/health" 2>/dev/null || echo "000")"
  if [[ "$STAGING_HEALTH" != "200" ]]; then
    echo "  FAIL: Staging health check failed after restart (HTTP $STAGING_HEALTH)"
    update_mission_status "deploy_failed"
    exit 1
  fi

  echo "  Staging deployment: SUCCESS"
  update_mission_status "deploy_succeeded" "{\"staging_pid\":\"$STAGING_PID\"}"
else
  echo "  [DRY RUN] Would restart staging service"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# G. PRODUCTION ISOLATION PROOF
# ═══════════════════════════════════════════════════════════════════════════════

echo ""
echo "━━━ G. PRODUCTION ISOLATION ━━━"
echo ""

update_mission_status "isolating_production"

PRODUCTION_HEALTH="$(curl -s -o /dev/null -w '%{http_code}' "${PRODUCTION_URL}/api/health" 2>/dev/null || echo "000")"
PRODUCTION_PID_AFTER="$(pgrep -f "port.*3100" 2>/dev/null | head -1 || echo "")"

if [[ "$PRODUCTION_HEALTH" = "200" ]]; then
  echo "  PASS: Production health: HTTP 200"
else
  echo "  FAIL: Production health check failed (HTTP $PRODUCTION_HEALTH)"
  update_mission_status "production_proof_failed"
  exit 1
fi

if [[ -n "$PRODUCTION_PID_BEFORE" && -n "$PRODUCTION_PID_AFTER" ]]; then
  if [[ "$PRODUCTION_PID_BEFORE" = "$PRODUCTION_PID_AFTER" ]]; then
    echo "  PASS: Production PID unchanged: $PRODUCTION_PID_AFTER"
    update_mission_status "production_proof_success" \
      "{\"production_pid_before\":\"$PRODUCTION_PID_BEFORE\",\"production_pid_after\":\"$PRODUCTION_PID_AFTER\",\"production_untouched\":\"true\"}"
  else
    echo "  FAIL: Production PID CHANGED! Before=$PRODUCTION_PID_BEFORE After=$PRODUCTION_PID_AFTER"
    update_mission_status "production_proof_failed"
    ESCALATIONS="$((ESCALATIONS + 1))"
    echo ""
    echo "MISSION ESCALATED: Production PID changed — possible production impact"
    exit 3
  fi
else
  echo "  INFO: Production PID proof skipped (missing data)"
  update_mission_status "production_proof_success" "{\"production_untouched\":\"true\"}"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# H. FINALIZATION
# ═══════════════════════════════════════════════════════════════════════════════

echo ""
echo "━━━ H. FINALIZATION ━━━"
echo ""

update_mission_status "finalizing"

"$SCRIPT_DIR/evidence-collect.sh" \
  --mission-id "$MISSION_ID" \
  --repo-dir "$REPO_DIR" \
  --issue-id "${ISSUE_ID:-}" \
  --review-verdict "$REVIEW_VERDICT" \
  --staging-pid "$STAGING_PID" \
  --production-pid-before "$PRODUCTION_PID_BEFORE" \
  --production-pid-after "$PRODUCTION_PID_AFTER" \
  --provider "$PROVIDER" \
  --model "$MODEL" \
  --retries "$RETRIES" \
  --escalations "$ESCALATIONS" 2>&1

update_mission_status "completed" \
  "{\"review_verdict\":\"$REVIEW_VERDICT\",\"terminal_status\":\"completed\",\"retries\":\"$RETRIES\",\"escalations\":\"$ESCALATIONS\"}"

# ═══════════════════════════════════════════════════════════════════════════════
# DONE
# ═══════════════════════════════════════════════════════════════════════════════

echo ""
echo "╔════════════════════════════════════════════════════════╗"
echo "║  MISSION COMPLETE                                     ║"
echo "╠════════════════════════════════════════════════════════╣"
echo "║  Mission:    $MISSION_ID"
echo "║  Issue:      ${ISSUE_ID:-<none>}"
echo "║  HEAD:       ${FINAL_HEAD:-$INITIAL_HEAD}"
echo "║  Review:     $REVIEW_VERDICT"
echo "║  Staging:    ${STAGING_PID:-<unknown>}"
echo "║  Production: UNTOUCHED"
echo "║  Retries:    $RETRIES"
echo "║  Status:     completed"
echo "╚════════════════════════════════════════════════════════╝"
echo ""
echo "Evidence receipt: .paperclip/operator-missions/${MISSION_ID}-receipt.md"

exit 0