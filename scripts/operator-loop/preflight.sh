#!/usr/bin/env bash
# Operator Loop V0 — Preflight Verification
#
# Verifies the repository and staging environment are ready
# for an autonomous operator mission. Does NOT call any provider or mutate state.
#
# Usage:
#   ./preflight.sh --mission-id ID [--repo-dir DIR] [--staging-url URL] [--staging-pid PID]
#
# Exit codes:
#   0  All checks passed
#   1  Required preflight condition failed
#   2  Usage error

set -euo pipefail

MISSION_ID=""
REPO_DIR=""
STAGING_HEALTH_URL="${PAPERCLIP_OPERATOR_STAGING_HEALTH_URL:-http://localhost:3101/api/health}"
PRODUCTION_HEALTH_URL="${PAPERCLIP_OPERATOR_PRODUCTION_HEALTH_URL:-http://localhost:3100/api/health}"
STAGING_PID=""
PRODUCTION_PID=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mission-id)
      MISSION_ID="$2"; shift 2 ;;
    --repo-dir)
      REPO_DIR="$2"; shift 2 ;;
    --staging-url)
      STAGING_HEALTH_URL="$2"; shift 2 ;;
    --production-url)
      PRODUCTION_HEALTH_URL="$2"; shift 2 ;;
    --staging-pid)
      STAGING_PID="$2"; shift 2 ;;
    --production-pid)
      PRODUCTION_PID="$2"; shift 2 ;;
    --help|-h)
      echo "Usage: $0 --mission-id ID [--repo-dir DIR] [--staging-url URL]"
      exit 0 ;;
    *)
      echo "ERROR: Unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$MISSION_ID" ]]; then
  echo "FAIL: --mission-id is required" >&2
  exit 2
fi

if [[ "$MISSION_ID" =~ [^a-zA-Z0-9_-] ]]; then
  echo "FAIL: mission-id contains invalid characters: $MISSION_ID" >&2
  exit 1
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

check() {
  local label="$1"; local detail="${2:-}"; shift 2
  if "$@"; then
    echo "PASS: $label ${detail:+($detail)}"
    PASSED=$((PASSED + 1))
  else
    echo "FAIL: $label ${detail:+($detail)}" >&2
    FAILED=$((FAILED + 1))
  fi
}

echo "=== Operator Loop V0 — Preflight ==="
echo "  Mission: $MISSION_ID"
echo "  Repo: $REPO_DIR"
echo ""

# ── A1: Verify expected repo ─────────────────────────────────────────────────

check "Repo directory exists" "$REPO_DIR" test -d "$REPO_DIR"
check "Git repo detected" "" bash -c 'cd "$1" && git rev-parse --git-dir >/dev/null 2>&1' _ "$REPO_DIR"

# ── A2: Verify expected branch / base ────────────────────────────────────────

BRANCH=""
if [[ -d "$REPO_DIR/.git" ]]; then
  BRANCH="$(git -C "$REPO_DIR" branch --show-current 2>/dev/null || echo "unknown")"
fi
echo "  Branch: $BRANCH"
check "Branch is not detached HEAD" "$BRANCH" test "$BRANCH" != "HEAD"

# ── A3: Verify clean/known working state ─────────────────────────────────────

DIRTY=""
DIRTY="$(git -C "$REPO_DIR" status --porcelain 2>/dev/null || echo "")"
if [[ -n "$DIRTY" ]]; then
  echo "  WARNING: Working directory is not clean" >&2
  echo "  Unstaged/uncommitted files may be affected by the mission"
  echo "  Dirty files:"
  echo "$DIRTY" | head -20
  # Not a hard fail — operator may intend to modify files
fi

# ── A4: Capture HEAD ─────────────────────────────────────────────────────────

INITIAL_HEAD=""
INITIAL_HEAD="$(git -C "$REPO_DIR" rev-parse HEAD 2>/dev/null || echo "unknown")"
echo "  HEAD: $INITIAL_HEAD"

check "HEAD is a valid commit" "$INITIAL_HEAD" test "${#INITIAL_HEAD}" -eq 40

# ── A5: Verify staging health ────────────────────────────────────────────────

STAGING_HEALTH=""
STAGING_HEALTH="$(curl -s -o /dev/null -w '%{http_code}' "$STAGING_HEALTH_URL" 2>/dev/null || echo "000")"
check "Staging health endpoint returns 200" "HTTP $STAGING_HEALTH" test "$STAGING_HEALTH" = "200"

# ── A6: Record staging PID ───────────────────────────────────────────────────

if [[ -z "$STAGING_PID" ]]; then
  STAGING_PID="$(ss -tlnp 2>/dev/null | grep 3101 | grep -oP 'pid=\K\d+' | head -1 || echo "")"
fi
echo "  Staging PID: ${STAGING_PID:-<unknown>}"

# ── A7: Record production PID WITHOUT modifying it ───────────────────────────

if [[ -z "$PRODUCTION_PID" ]]; then
  PRODUCTION_PID="$(ss -tlnp 2>/dev/null | grep 3100 | grep -oP 'pid=\K\d+' | head -1 || echo "")"
fi

PRODUCTION_HEALTH=""
PRODUCTION_HEALTH="$(curl -s -o /dev/null -w '%{http_code}' "$PRODUCTION_HEALTH_URL" 2>/dev/null || echo "000")"
check "Production health endpoint returns 200" "HTTP $PRODUCTION_HEALTH" test "$PRODUCTION_HEALTH" = "200"
echo "  Production PID: ${PRODUCTION_PID:-<unknown>}"

# ── A8: Production files/config must not be in staging repo (heuristic) ──────

PROD_REF=""
PROD_REF="$(git -C "$REPO_DIR" log --oneline -1 --grep="production" 2>/dev/null || echo "")"
if [[ -n "$PROD_REF" ]]; then
  echo "  INFO: Recent commits reference 'production'. Verify scope is staging-only."
fi

# ── Summary ──────────────────────────────────────────────────────────────────

echo ""
echo "=== Preflight Summary ==="
echo "  Mission: $MISSION_ID"
echo "  Repo: $REPO_DIR"
echo "  Branch: $BRANCH"
echo "  HEAD: $INITIAL_HEAD"
echo "  Staging: HTTP $STAGING_HEALTH (PID: ${STAGING_PID:-<unknown>})"
echo "  Production: HTTP $PRODUCTION_HEALTH (PID: ${PRODUCTION_PID:-<unknown>})"
echo "  Passed: $PASSED"
echo "  Failed: $FAILED"

# ── Export preflight evidence ────────────────────────────────────────────────

echo ""
echo "=== Preflight Evidence (JSON) ==="
cat <<EVIDENCE
{
  "mission_id": "$MISSION_ID",
  "repo_dir": "$REPO_DIR",
  "branch": "$BRANCH",
  "initial_head": "$INITIAL_HEAD",
  "staging_health_http": "$STAGING_HEALTH",
  "staging_pid": "${STAGING_PID:-null}",
  "production_health_http": "$PRODUCTION_HEALTH",
  "production_pid": "${PRODUCTION_PID:-null}",
  "workspace_clean": $([[ -z "$DIRTY" ]] && echo "true" || echo "false"),
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EVIDENCE

if [[ $FAILED -gt 0 ]]; then
  echo ""
  echo "VERDICT: PREFLIGHT FAILED ($FAILED check(s) failed)"
  exit 1
fi

echo ""
echo "VERDICT: PREFLIGHT PASSED"
exit 0