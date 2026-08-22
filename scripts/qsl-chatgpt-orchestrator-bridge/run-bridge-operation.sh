#!/usr/bin/env bash
# QSL ChatGPT Orchestrator Bridge V1 — Runner Script
#
# Called by the GitHub Actions workflow to process structured bridge requests
# from ChatGPT. Validates, dispatches to localhost Paperclip API, and posts
# sanitized results as GitHub issue comments.
#
# Usage:
#   ./run-bridge-operation.sh --request-json '{"request_id":"...","operation":"...",...}'
#     --api-base http://localhost:3101 --company-id <uuid> --issue-number 35
#
# Environment:
#   GITHUB_TOKEN            GitHub token for posting comments
#   PAPERCLIP_API_BASE      Paperclip API base URL (default: http://localhost:3101)
#   PAPERCLIP_COMPANY_ID    Default company ID
#
# Exit codes:
#   0  Operation completed (result posted to GitHub)
#   1  Script error / invalid request
#   2  Usage error

set -euo pipefail

REQUEST_JSON=""
API_BASE="${PAPERCLIP_API_BASE:-http://localhost:3101/api}"
COMPANY_ID="${PAPERCLIP_COMPANY_ID:-}"
ISSUE_NUMBER=""

# ── Argument parsing ─────────────────────────────────────────────────────────

while [[ $# -gt 0 ]]; do
  case "$1" in
    --request-json)
      REQUEST_JSON="$2"; shift 2 ;;
    --api-base)
      API_BASE="$2"; shift 2 ;;
    --company-id)
      COMPANY_ID="$2"; shift 2 ;;
    --issue-number)
      ISSUE_NUMBER="$2"; shift 2 ;;
    *)
      echo "ERROR: Unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$REQUEST_JSON" ]]; then
  echo "FAIL: --request-json is required" >&2
  exit 2
fi

if [[ -z "$COMPANY_ID" ]]; then
  echo "FAIL: --company-id or PAPERCLIP_COMPANY_ID is required" >&2
  exit 2
fi

# ── Parse request ────────────────────────────────────────────────────────────

REQUEST_ID=$(echo "$REQUEST_JSON" | jq -r '.request_id // ""')
OPERATION=$(echo "$REQUEST_JSON" | jq -r '.operation // ""')
ENVIRONMENT=$(echo "$REQUEST_JSON" | jq -r '.environment // "staging"')
AUTHORITY_APPROVAL_ID=$(echo "$REQUEST_JSON" | jq -r '.authority_approval_id // ""')
TARGET_IDS=$(echo "$REQUEST_JSON" | jq -r '.target_ids // [] | join(",")')
PAYLOAD=$(echo "$REQUEST_JSON" | jq -c '.payload // {}')

if [[ -z "$REQUEST_ID" ]]; then
  REQUEST_ID="bridge-$(date +%s)-$RANDOM"
fi

if [[ -z "$OPERATION" ]]; then
  echo "FAIL: request must include 'operation'" >&2
  post_result "UNKNOWN" "" "Missing operation field in request"
  exit 1
fi

# ── Security: fail closed on prohibited patterns ────────────────────────────

PROHIBITED_PATTERNS=("shell" "exec" "sql" "credential" "secret" "deploy" "restart" "production" "destructive" "migrate" "drop")
for pattern in "${PROHIBITED_PATTERNS[@]}"; do
  if echo "$OPERATION" | grep -qi "$pattern"; then
    echo "BLOCKED: prohibited operation pattern detected: $pattern" >&2
    post_result "BLOCKED" "" "Prohibited operation pattern: $pattern"
    exit 1
  fi
done

# ── Validate environment ─────────────────────────────────────────────────────

if [[ "$ENVIRONMENT" != "staging" ]]; then
  echo "BLOCKED: only staging environment is allowed, got: $ENVIRONMENT" >&2
  post_result "BLOCKED" "" "Only staging environment is allowed"
  exit 1
fi

# ── Security: fail closed on ambiguous authority ─────────────────────────────

HUMAN_GATED=("execute-approved-send" "publish-approved-asset" "accept-approved-commercial-commitment")
for gated in "${HUMAN_GATED[@]}"; do
  if [[ "$OPERATION" == "$gated" ]]; then
    if [[ -z "$AUTHORITY_APPROVAL_ID" ]]; then
      echo "BLOCKED: human-gated operation '$OPERATION' requires authority_approval_id" >&2
      post_result "BLOCKED" "" "Human-gated operation requires authority_approval_id"
      exit 1
    fi
  fi
done

# ── Build API request body ───────────────────────────────────────────────────

API_BODY=$(jq -n \
  --arg operation "$OPERATION" \
  --argjson target_ids "[$(echo "$TARGET_IDS" | tr ',' '\n' | sed 's/^/"/;s/$/"/' | tr '\n' ',' | sed 's/,$//')]" \
  --argjson payload "$PAYLOAD" \
  --arg authority_approval_id "$AUTHORITY_APPROVAL_ID" \
  '{
    operation: $operation,
    target_ids: $target_ids,
    payload: $payload,
    authority_approval_id: $authority_approval_id
  } | if .authority_approval_id == "" then del(.authority_approval_id) else . end | if (.target_ids | length) == 0 then del(.target_ids) else . end')

echo "=== Calling bridge API ==="
echo "Endpoint: $API_BASE/qsl-orchestrator-bridge/companies/$COMPANY_ID/bridge"
echo "Operation: $OPERATION"

# ── Call Paperclip API ───────────────────────────────────────────────────────

RESPONSE=$(curl -s -w "\n%{http_code}" \
  -X POST "$API_BASE/qsl-orchestrator-bridge/companies/$COMPANY_ID/bridge" \
  -H "Content-Type: application/json" \
  -d "$API_BODY" \
  2>&1) || {
    echo "FAIL: API call failed" >&2
    post_result "FAIL" "" "Paperclip API call failed"
    exit 1
  }

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
RESPONSE_BODY=$(echo "$RESPONSE" | sed '$d')

echo "HTTP $HTTP_CODE"
echo "$RESPONSE_BODY" | head -c 3000

if [[ "$HTTP_CODE" -ge 400 ]]; then
  RESULT_CLASS="FAIL"
  if [[ "$HTTP_CODE" -eq 403 ]]; then
    RESULT_CLASS="BLOCKED"
  fi
  SANITIZED_ERROR=$(echo "$RESPONSE_BODY" | jq -r '.sanitized_error // .error // "API error"')
  post_result "$RESULT_CLASS" "" "$SANITIZED_ERROR"
  exit 1
fi

# ── Extract result and post to GitHub ────────────────────────────────────────

RESULT_CLASS=$(echo "$RESPONSE_BODY" | jq -r '.result_class // "UNKNOWN"')
AFFECTED_IDS=$(echo "$RESPONSE_BODY" | jq -r '.affected_ids // [] | join(",")')
EVIDENCE=$(echo "$RESPONSE_BODY" | jq -r '.evidence_summary // ""')
SANITIZED_ERROR=$(echo "$RESPONSE_BODY" | jq -r '.sanitized_error // ""')

post_result "$RESULT_CLASS" "$AFFECTED_IDS" "$EVIDENCE" "$SANITIZED_ERROR"

echo "=== Bridge operation complete ==="
echo "request_id: $REQUEST_ID"
echo "operation: $OPERATION"
echo "result: $RESULT_CLASS"

# ── Helper: post sanitized result as GitHub issue comment ──────────────────

function post_result() {
  local result_class="${1:-UNKNOWN}"
  local affected_ids="${2:-}"
  local evidence="${3:-}"
  local error_msg="${4:-}"

  if [[ -z "$ISSUE_NUMBER" ]] || [[ -z "${GITHUB_TOKEN:-}" ]]; then
    echo "=== Would post result (no GitHub context) ==="
    echo "result: $result_class"
    echo "operation: $OPERATION"
    echo "request_id: $REQUEST_ID"
    echo "evidence: $evidence"
    echo "error: $error_msg"
    return 0
  fi

  local comment_body="### QSL ChatGPT Orchestrator Bridge V1

- operation: \`$OPERATION\`
- request_id: \`$REQUEST_ID\`
- result: **$result_class**"

  if [[ -n "$affected_ids" ]]; then
    comment_body="$comment_body
- affected_ids: \`$affected_ids\`"
  fi

  if [[ -n "$evidence" ]]; then
    comment_body="$comment_body
- evidence: $evidence"
  fi

  if [[ -n "$error_msg" ]]; then
    comment_body="$comment_body
- error: $error_msg"
  fi

  if [[ -n "$GITHUB_SHA" ]]; then
    comment_body="$comment_body
- commit: \`${GITHUB_SHA:0:10}\`"
  fi

  if [[ -n "${GITHUB_RUN_ID:-}" ]]; then
    comment_body="$comment_body
- run_id: \`$GITHUB_RUN_ID\`"
  fi

  # Sanitize: remove any potential secret patterns before posting
  comment_body=$(echo "$comment_body" | sed -E 's/(sk-[a-zA-Z0-9]{20,})/[REDACTED]/g')
  comment_body=$(echo "$comment_body" | sed -E 's/([a-zA-Z0-9+/]{40,})/[REDACTED]/g')

  echo "$comment_body" | gh issue comment "$ISSUE_NUMBER" --body-file -
  echo "Result posted to issue #$ISSUE_NUMBER"
}