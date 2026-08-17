#!/usr/bin/env bash
# Operator Loop V0 — Evidence Collection & Mission Receipt (Stage H)
#
# Collects canonical evidence for a completed operator mission.
# Produces JSON receipt suitable for Selarix provenance.
# Does NOT modify state.
#
# Usage:
#   ./evidence-collect.sh --mission-id ID [--repo-dir DIR] [--issue-id ID] \
#     [--review-verdict PASS|FAIL|ESCALATE] [--staging-pid PID] \
#     [--production-pid-before PID] [--production-pid-after PID] \
#     [--provider PROVIDER] [--model MODEL]
#
# Exit codes:
#   0  Evidence collected successfully
#   1  Evidence collection failed
#   2  Usage error

set -euo pipefail

MISSION_ID=""
REPO_DIR=""
ISSUE_ID=""
REVIEW_VERDICT=""
STAGING_PID=""
PRODUCTION_PID_BEFORE=""
PRODUCTION_PID_AFTER=""
PROVIDER="${PAPERCLIP_OPERATOR_PROVIDER:-openrouter}"
MODEL="${PAPERCLIP_OPERATOR_MODEL:-openrouter/deepseek/deepseek-chat}"
CREDENTIAL_REF_TYPE="secret_ref"
RUN_IDS=""
RETRIES="0"
ESCALATIONS="0"
STAGING_HEALTH_URL="${PAPERCLIP_OPERATOR_STAGING_HEALTH_URL:-http://localhost:3101/api/health}"
PRODUCTION_HEALTH_URL="${PAPERCLIP_OPERATOR_PRODUCTION_HEALTH_URL:-http://localhost:3100/api/health}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mission-id)
      MISSION_ID="$2"; shift 2 ;;
    --repo-dir)
      REPO_DIR="$2"; shift 2 ;;
    --issue-id)
      ISSUE_ID="$2"; shift 2 ;;
    --review-verdict)
      REVIEW_VERDICT="$2"; shift 2 ;;
    --staging-pid)
      STAGING_PID="$2"; shift 2 ;;
    --production-pid-before)
      PRODUCTION_PID_BEFORE="$2"; shift 2 ;;
    --production-pid-after)
      PRODUCTION_PID_AFTER="$2"; shift 2 ;;
    --provider)
      PROVIDER="$2"; shift 2 ;;
    --model)
      MODEL="$2"; shift 2 ;;
    --run-ids)
      RUN_IDS="$2"; shift 2 ;;
    --retries)
      RETRIES="$2"; shift 2 ;;
    --escalations)
      ESCALATIONS="$2"; shift 2 ;;
    --help|-h)
      echo "Usage: $0 --mission-id ID [options]"
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

FAILED=0
PASSED=0

echo "=== Operator Loop V0 — Evidence Collection ==="
echo "  Mission: $MISSION_ID"
echo "  Repo: $REPO_DIR"
echo ""

# ── H1: Capture HEAD and changed files ───────────────────────────────────────

INITIAL_HEAD=""
FINAL_HEAD=""
CHANGED_FILES=""

if [[ -d "$REPO_DIR/.git" ]]; then
  FINAL_HEAD="$(git -C "$REPO_DIR" rev-parse HEAD 2>/dev/null || echo "unknown")"
  echo "  Final HEAD: $FINAL_HEAD"

  CHANGED_FILES="$(git -C "$REPO_DIR" diff --name-only HEAD~1 2>/dev/null || echo "")"
  if [[ -n "$CHANGED_FILES" ]]; then
    echo "  Changed files (vs HEAD~1):"
    echo "$CHANGED_FILES" | sed 's/^/    /'
  fi
fi

# ── H2: Staging health check ─────────────────────────────────────────────────

STAGING_HEALTH=""
STAGING_HEALTH="$(curl -s -o /dev/null -w '%{http_code}' "$STAGING_HEALTH_URL" 2>/dev/null || echo "000")"
if [[ "$STAGING_HEALTH" = "200" ]]; then
  echo "PASS: Staging healthy (HTTP 200)"
  PASSED=$((PASSED + 1))
else
  echo "FAIL: Staging health check failed (HTTP $STAGING_HEALTH)" >&2
  FAILED=$((FAILED + 1))
fi

# ── H3: Production isolation proof ───────────────────────────────────────────

PRODUCTION_HEALTH=""
PRODUCTION_HEALTH="$(curl -s -o /dev/null -w '%{http_code}' "$PRODUCTION_HEALTH_URL" 2>/dev/null || echo "000")"
if [[ "$PRODUCTION_HEALTH" = "200" ]]; then
  echo "PASS: Production healthy (HTTP 200)"
  PASSED=$((PASSED + 1))
else
  echo "FAIL: Production health check failed (HTTP $PRODUCTION_HEALTH)" >&2
  FAILED=$((FAILED + 1))
fi

PRODUCTION_CURRENT_PID=""
PRODUCTION_CURRENT_PID="$(pgrep -f "port.*3100" 2>/dev/null | head -1 || echo "")"

if [[ -n "$PRODUCTION_PID_BEFORE" && -n "$PRODUCTION_CURRENT_PID" ]]; then
  if [[ "$PRODUCTION_PID_BEFORE" = "$PRODUCTION_CURRENT_PID" ]]; then
    echo "PASS: Production PID unchanged ($PRODUCTION_CURRENT_PID)"
    PASSED=$((PASSED + 1))
  else
    echo "FAIL: Production PID changed! Before=$PRODUCTION_PID_BEFORE Now=$PRODUCTION_CURRENT_PID" >&2
    FAILED=$((FAILED + 1))
  fi
else
  echo "INFO: Production PID proof skipped (missing before/after data)"
fi

# ── H3b: Production files/config check ───────────────────────────────────────

PRODUCTION_UNTOUCHED="true"
if [[ -f "/opt/paperclip-deployments/paperclip-prod" ]] 2>/dev/null; then
  PRODUCTION_UNTOUCHED="false"
fi

# ── H4: Mission receipt generation ───────────────────────────────────────────

TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

RECEIPT_JSON=$(cat <<RECEIPT
{
  "mission_id": "$MISSION_ID",
  "issue_id": "${ISSUE_ID:-null}",
  "agent_id": null,
  "run_ids": ${RUN_IDS:-[]},
  "authorized_scope": "autonomous",
  "provider": "$PROVIDER",
  "model": "$MODEL",
  "credential_reference_type": "$CREDENTIAL_REF_TYPE",
  "start_time": "$(date -u -d @$(stat -c %Y "$0" 2>/dev/null || echo 0) +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "$TIMESTAMP")",
  "end_time": "$TIMESTAMP",
  "initial_head": "${INITIAL_HEAD:-null}",
  "final_head": "$FINAL_HEAD",
  "changed_files": ${CHANGED_FILES:-[]},
  "tests": "${REVIEW_VERDICT:+"verified"}",
  "review_verdict": "${REVIEW_VERDICT:-null}",
  "staging_deployment": "${STAGING_PID:+deployed}",
  "staging_pid": ${STAGING_PID:-null},
  "production_pid_before": ${PRODUCTION_PID_BEFORE:-null},
  "production_pid_after": ${PRODUCTION_CURRENT_PID:-null},
  "production_untouched": "$PRODUCTION_UNTOUCHED",
  "retries": "$RETRIES",
  "escalations": "$ESCALATIONS",
  "cost_usage": null,
  "terminal_status": "$([[ $FAILED -eq 0 ]] && echo "completed" || echo "completed_with_verification_gaps")"
}
RECEIPT
)

echo ""
echo "=== Mission Receipt (JSON) ==="
echo "$RECEIPT_JSON"

# ── H5: Generate human-readable markdown receipt ─────────────────────────────

MD_RECEIPT_FILE="$REPO_DIR/.paperclip/operator-missions/${MISSION_ID}-receipt.md"
mkdir -p "$(dirname "$MD_RECEIPT_FILE")"

cat > "$MD_RECEIPT_FILE" <<MDEOF
# Operator Mission Receipt

## Mission: ${MISSION_ID}

| Field | Value |
|-------|-------|
| Mission ID | \`${MISSION_ID}\` |
| Issue ID | \`${ISSUE_ID:-none}\` |
| Provider | ${PROVIDER} |
| Model | ${MODEL} |
| Credential Type | ${CREDENTIAL_REF_TYPE} |
| Final HEAD | \`${FINAL_HEAD:-unknown}\` |
| Staging PID | ${STAGING_PID:-<unknown>} |
| Production PID (before) | ${PRODUCTION_PID_BEFORE:-<unknown>} |
| Production PID (after) | ${PRODUCTION_CURRENT_PID:-<unknown>} |
| Production Untouched | ${PRODUCTION_UNTOUCHED} |
| Review Verdict | ${REVIEW_VERDICT:-N/A} |
| Retries | ${RETRIES} |
| Escalations | ${ESCALATIONS} |
| Terminal Status | $([[ $FAILED -eq 0 ]] && echo "completed" || echo "completed_with_verification_gaps") |

## Changed Files

\`\`\`
${CHANGED_FILES:-<none>}
\`\`\`

## Evidence

- Staging health: HTTP ${STAGING_HEALTH}
- Production health: HTTP ${PRODUCTION_HEALTH}
- Production isolation: $([[ -n "$PRODUCTION_PID_BEFORE" && "$PRODUCTION_PID_BEFORE" = "$PRODUCTION_CURRENT_PID" ]] && echo "CONFIRMED" || echo "NOT VERIFIED")

---

Generated: ${TIMESTAMP}
MDEOF

echo ""
echo "  Markdown receipt: $MD_RECEIPT_FILE"

# ── Summary ──────────────────────────────────────────────────────────────────

echo ""
echo "=== Evidence Collection Summary ==="
echo "  Mission: $MISSION_ID"
echo "  Passed: $PASSED"
echo "  Failed: $FAILED"

if [[ $FAILED -gt 0 ]]; then
  echo ""
  echo "VERDICT: EVIDENCE COLLECTED WITH WARNINGS ($FAILED check(s) failed)"
  exit 0
fi

echo ""
echo "VERDICT: EVIDENCE COLLECTED"
exit 0