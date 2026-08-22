#!/usr/bin/env bash
# QSL ChatGPT Orchestrator Bridge V1 — Runner Script
#
# Called by the GitHub Actions workflow to process structured bridge requests
# from ChatGPT. Validates, dispatches to localhost Paperclip API, and posts
# sanitized results as GitHub issue comments.
#
# Usage:
#   ./run-bridge-operation.sh --request-json '{"request_id":"...","operation":"...",...}'
#     --api-base http://localhost:3101 --company-id <uuid> --result-issue 34
#
# Environment:
#   GITHUB_TOKEN            GitHub token for posting comments
#   PAPERCLIP_API_BASE      Paperclip API base URL (default: http://localhost:3101)
#   PAPERCLIP_COMPANY_ID    Default company ID

set -euo pipefail

REQUEST_JSON=""
API_BASE="${PAPERCLIP_API_BASE:-http://localhost:3101}"
COMPANY_ID="${PAPERCLIP_COMPANY_ID:-}"
RESULT_ISSUE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --request-json) REQUEST_JSON="$2"; shift 2 ;;
    --api-base)     API_BASE="$2"; shift 2 ;;
    --company-id)   COMPANY_ID="$2"; shift 2 ;;
    --result-issue) RESULT_ISSUE="$2"; shift 2 ;;
    --help|-h)
      echo "Usage: $0 --request-json JSON --company-id ID [--api-base URL] [--result-issue N]"
      exit 0 ;;
    *) echo "ERROR: Unknown argument: $1" >&2; exit 2 ;;
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

# ── Helper: post sanitized result to GitHub (MUST be defined before use) ────

post_result() {
  local result_class="${1:-UNKNOWN}"
  local affected_ids="${2:-none}"
  local evidence="${3:-}"
  local error_msg="${4:-}"

  local ts
  ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  local comment_body="### QSL ChatGPT Orchestrator Bridge V1

- operation: \`${OPERATION}\`
- request_id: \`${REQUEST_ID}\`
- result: **${result_class}**
- timestamp: \`${ts}\`"

  if [[ -n "$affected_ids" ]] && [[ "$affected_ids" != "none" ]]; then
    comment_body="${comment_body}
- affected_ids: \`${affected_ids}\`"
  fi

  if [[ -n "$evidence" ]]; then
    comment_body="${comment_body}
- evidence: ${evidence}"
  fi

  if [[ -n "$error_msg" ]]; then
    comment_body="${comment_body}
- error: ${error_msg}"
  fi

  comment_body=$(echo "$comment_body" | sed -E 's/(sk-[a-zA-Z0-9]{20,})/[REDACTED]/g')

  if [[ -n "$RESULT_ISSUE" ]] && [[ -n "${GITHUB_TOKEN:-}" ]]; then
    echo "$comment_body" | gh issue comment "$RESULT_ISSUE" --body-file -
    echo "Result posted to issue #${RESULT_ISSUE}"
  else
    echo "=== Would post result (no GitHub context) ==="
    echo "$comment_body"
  fi
}

# ── Parse request ────────────────────────────────────────────────────────────

REQUEST_ID=$(echo "$REQUEST_JSON" | jq -r '.request_id // ""')
OPERATION=$(echo "$REQUEST_JSON" | jq -r '.operation // ""')
ENVIRONMENT=$(echo "$REQUEST_JSON" | jq -r '.environment // "staging"')
AUTHORITY_APPROVAL_ID=$(echo "$REQUEST_JSON" | jq -r '.authority_approval_id // ""')
TARGET_IDS_RAW=$(echo "$REQUEST_JSON" | jq -r '.target_ids // [] | join(",")')
PAYLOAD=$(echo "$REQUEST_JSON" | jq -c '.payload // {}')

if [[ -z "$REQUEST_ID" ]]; then
  REQUEST_ID="bridge-$(date +%s)-$RANDOM"
fi

if [[ -z "$OPERATION" ]]; then
  echo "FAIL: missing operation" >&2
  post_result "BLOCKED" "" "Missing operation field in request"
  exit 1
fi

# ── Security: fail closed on prohibited patterns ────────────────────────────

PROHIBITED_PATTERNS=("shell" "exec" "sql" "credential" "secret" "deploy" "restart" "production" "destructive" "migrate" "drop")
for pattern in "${PROHIBITED_PATTERNS[@]}"; do
  if echo "$OPERATION" | grep -qi "$pattern"; then
    echo "BLOCKED: prohibited pattern: $pattern" >&2
    post_result "BLOCKED" "" "Prohibited operation pattern: $pattern"
    exit 1
  fi
done

# ── Validate environment ─────────────────────────────────────────────────────

if [[ "$ENVIRONMENT" != "staging" ]]; then
  echo "BLOCKED: only staging allowed, got: $ENVIRONMENT" >&2
  post_result "BLOCKED" "" "Only staging environment is allowed"
  exit 1
fi

# ── Authorized actor gate ────────────────────────────────────────────────────

HUMAN_GATED_OPS=("execute-approved-send" "publish-approved-asset" "accept-approved-commercial-commitment")
for gated in "${HUMAN_GATED_OPS[@]}"; do
  if [[ "$OPERATION" == "$gated" ]]; then
    if [[ -z "$AUTHORITY_APPROVAL_ID" ]]; then
      echo "BLOCKED: human-gated op '$OPERATION' requires authority_approval_id" >&2
      post_result "BLOCKED" "" "Human-gated operation requires authority_approval_id"
      exit 1
    fi
  fi
done

# ── Build API request ────────────────────────────────────────────────────────

API_BODY=$(jq -n \
  --arg operation "$OPERATION" \
  --argjson target_ids "[$([ -n "$TARGET_IDS_RAW" ] && echo "$TARGET_IDS_RAW" | tr ',' '\n' | sed 's/^/"/;s/$/"/' | tr '\n' ',' | sed 's/,$//' || true)]" \
  --argjson payload "$PAYLOAD" \
  --arg authority_approval_id "$AUTHORITY_APPROVAL_ID" \
  --arg environment "$ENVIRONMENT" \
  '{
    operation: $operation,
    environment: $environment,
    target_ids: $target_ids,
    payload: $payload,
    authority_approval_id: $authority_approval_id
  } | if .authority_approval_id == "" then del(.authority_approval_id) else . end | if (.target_ids | length) == 0 then del(.target_ids) else . end')

API_URL="${API_BASE}/api/qsl-orchestrator-bridge/companies/${COMPANY_ID}/bridge"

echo "=== Dispatching bridge operation ==="
echo "operation: $OPERATION"
echo "request_id: $REQUEST_ID"

# ── Call Paperclip API ───────────────────────────────────────────────────────

HTTP_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$API_URL" \
  -H "Content-Type: application/json" \
  -d "$API_BODY" 2>&1) || {
    echo "FAIL: API call failed" >&2
    post_result "FAIL" "" "Paperclip API call failed"
    exit 1
  }

HTTP_CODE=$(echo "$HTTP_RESPONSE" | tail -1)
RESPONSE_BODY=$(echo "$HTTP_RESPONSE" | sed '$d')

echo "HTTP $HTTP_CODE"

if [[ "$HTTP_CODE" -ge 400 ]]; then
  RESULT_CLASS="FAIL"
  if [[ "$HTTP_CODE" -eq 403 ]]; then
    RESULT_CLASS="BLOCKED"
  fi
  SANITIZED_ERROR=$(echo "$RESPONSE_BODY" | jq -r '.sanitized_error // .error // "API error"')
  post_result "$RESULT_CLASS" "" "" "$SANITIZED_ERROR"
  exit 1
fi

RESULT_CLASS=$(echo "$RESPONSE_BODY" | jq -r '.result_class // "UNKNOWN"')
AFFECTED_IDS=$(echo "$RESPONSE_BODY" | jq -r '.affected_ids // [] | join(",")')
EVIDENCE=$(echo "$RESPONSE_BODY" | jq -r '.evidence_summary // ""')
SANITIZED_ERROR=$(echo "$RESPONSE_BODY" | jq -r '.sanitized_error // ""')

post_result "$RESULT_CLASS" "$AFFECTED_IDS" "$EVIDENCE" "$SANITIZED_ERROR"

echo "=== Bridge operation complete: $RESULT_CLASS ==="