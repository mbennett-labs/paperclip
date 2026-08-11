#!/usr/bin/env bash
# Hermes Synthetic POC — Preflight Verification Helper
#
# Verifies the host is ready for a contained Hermes synthetic task run.
# Does NOT execute Hermes, call any provider, or expose secrets.
#
# Usage:
#   ./preflight.sh --run-id ID [--workspace-dir DIR] [--issue-id ID]
#
# Exit codes:
#   0  All checks passed
#   1  Required condition failed
#   2  Usage error (missing required arg, invalid arg)

set -euo pipefail

# ── Argument parsing ────────────────────────────────────────────────────────

RUN_ID=""
WORKSPACE_DIR=""
ISSUE_ID=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --run-id)
      RUN_ID="$2"; shift 2 ;;
    --workspace-dir)
      WORKSPACE_DIR="$2"; shift 2 ;;
    --issue-id)
      ISSUE_ID="$2"; shift 2 ;;
    --help|-h)
      echo "Usage: $0 --run-id ID [--workspace-dir DIR] [--issue-id ID]"
      echo "  --run-id        Required. Run ID (alphanumeric, hyphens, underscores only)."
      echo "  --workspace-dir Optional. Override sandbox workspace directory."
      echo "  --issue-id      Optional. Paperclip issue ID for evidence tracking."
      exit 0 ;;
    *)
      echo "ERROR: Unknown argument: $1" >&2; exit 2 ;;
  esac
done

# ── Run ID validation ───────────────────────────────────────────────────────

validate_run_id() {
  local id="$1"
  if [[ -z "$id" ]]; then
    echo "FAIL: run-id is empty" >&2
    return 1
  fi
  if [[ "$id" =~ [^a-zA-Z0-9_-] ]]; then
    echo "FAIL: run-id contains invalid characters: $id" >&2
    return 1
  fi
  if [[ ${#id} -lt 3 ]]; then
    echo "FAIL: run-id too short (min 3 chars): $id" >&2
    return 1
  fi
  if [[ ${#id} -gt 128 ]]; then
    echo "FAIL: run-id too long (max 128 chars)" >&2
    return 1
  fi
  if [[ "$id" == ".." ]] || [[ "$id" == "." ]]; then
    echo "FAIL: run-id is a path component" >&2
    return 1
  fi
  return 0
}

validate_run_id "$RUN_ID" || exit 1

# ── Sandbox parent ──────────────────────────────────────────────────────────

SANDBOX_PARENT="/tmp"

if [[ -z "$WORKSPACE_DIR" ]]; then
  WORKSPACE_DIR="${SANDBOX_PARENT}/paperclip-hermes-sandbox-${RUN_ID}"
fi

# Resolve absolute path
WORKSPACE_DIR="$(cd "$(dirname "$WORKSPACE_DIR")" 2>/dev/null && echo "$(pwd)/$(basename "$WORKSPACE_DIR")")" || true
if [[ ! "$WORKSPACE_DIR" = /* ]]; then
  echo "FAIL: workspace-dir must be an absolute path: $WORKSPACE_DIR" >&2
  exit 1
fi

FAILED=0
PASSED=0

check() {
  local label="$1"
  local detail="${2:-}"
  shift 2
  local cmd=("$@")
  if "${cmd[@]}"; then
    echo "PASS: $label ${detail:+($detail)}"
    PASSED=$((PASSED + 1))
  else
    echo "FAIL: $label ${detail:+($detail)}" >&2
    FAILED=$((FAILED + 1))
  fi
}

# ── 1. Linux host ───────────────────────────────────────────────────────────

check "Host is Linux" "$(uname -s)" \
  test "$(uname -s)" = "Linux"

# ── 2. Bubblewrap present ───────────────────────────────────────────────────

BWRAP=""
BWRAP="$(command -v bwrap 2>/dev/null || true)"
check "bwrap found in PATH" "" \
  test -n "$BWRAP" -a -x "$BWRAP"

# ── 3. Bubblewrap version ──────────────────────────────────────────────────

if [[ -n "$BWRAP" && -x "$BWRAP" ]]; then
  check "bwrap --version succeeds" "" \
    bash -c '"$1" --version >/dev/null 2>&1' _ "$BWRAP"
  BWRAP_VERSION="$("$BWRAP" --version 2>&1 || true)"
  echo "  bwrap version: $BWRAP_VERSION"
else
  echo "FAIL: bwrap not found, skipping version check" >&2
  FAILED=$((FAILED + 1))
fi

# ── 4. User namespaces usable ──────────────────────────────────────────────

check "user namespaces enabled" "" \
  test -e /proc/self/uid_map

# Verify we can actually create a namespace
if [[ -n "$BWRAP" && -x "$BWRAP" ]]; then
  check "bwrap --unshare-user works" "" \
    "$BWRAP" --unshare-user --ro-bind / / /bin/true
else
  echo "FAIL: bwrap not available, cannot verify user namespaces" >&2
  FAILED=$((FAILED + 1))
fi

# ── 5. Required branch and commit ──────────────────────────────────────────

check "on required branch (feat/hermes-synthetic-poc-v0)" \
  "$(git branch --show-current 2>/dev/null || echo "unknown")" \
  test "$(git branch --show-current 2>/dev/null)" = "feat/hermes-synthetic-poc-v0"

HEAD_COMMIT="$(git rev-parse HEAD 2>/dev/null || echo "unknown")"
echo "  HEAD: $HEAD_COMMIT"

check "HEAD resolves to a commit" "" \
  bash -c 'git rev-parse --verify HEAD >/dev/null 2>&1'

BASE_COMMIT="$(git merge-base HEAD origin/feat/qsl-current-upstream-integration 2>/dev/null || echo "unknown")"
echo "  Merge-base with origin/feat/qsl-current-upstream-integration: $BASE_COMMIT"

# ── 6. Working tree status ─────────────────────────────────────────────────

DIRTY_FILES="$(git diff --stat 2>/dev/null || true)"
STAGED_FILES="$(git diff --cached --stat 2>/dev/null || true)"
if [[ -n "$DIRTY_FILES" || -n "$STAGED_FILES" ]]; then
  echo "  WARNING: Working tree is not clean"
  echo "  Unstaged changes:"
  echo "$DIRTY_FILES" | sed 's/^/    /'
  echo "  Staged changes:"
  echo "$STAGED_FILES" | sed 's/^/    /'
  echo "  POC helpers are expected to be the only new files."
else
  echo "PASS: Working tree is clean"
  PASSED=$((PASSED + 1))
fi

# ── 7. Workspace can be created ────────────────────────────────────────────

check "workspace dir can be created: $WORKSPACE_DIR" "" \
  bash -c 'mkdir -p "$0" 2>/dev/null && test -d "$0" && test -w "$0"' "$WORKSPACE_DIR"

# ── 8. Sufficient resources ────────────────────────────────────────────────

AVAIL_KB="$(df --output=avail "$SANDBOX_PARENT" 2>/dev/null | tail -1 | tr -d ' ' || echo 0)"
check "disk free > 100MB on $SANDBOX_PARENT" "${AVAIL_KB}KB available" \
  test "$AVAIL_KB" -gt 102400

MEM_AVAIL="$(free -m 2>/dev/null | awk '/^Mem:/{print $7}' || echo 0)"
check "memory available > 256MB" "${MEM_AVAIL}MB available" \
  test "$MEM_AVAIL" -gt 256

# ── 9. No conflicting active processes ─────────────────────────────────────

# Check using process listing, NOT pkill/kill
HERMES_PROCS="$(pgrep -a hermes 2>/dev/null | grep -v "pgrep\|preflight\|grep" || true)"
BWRAP_PROCS="$(pgrep -a bwrap 2>/dev/null | grep -v "pgrep\|preflight\|grep" || true)"
if [[ -n "$HERMES_PROCS" ]]; then
  echo "  WARNING: Hermes processes found:"
  echo "$HERMES_PROCS" | sed 's/^/    /'
else
  echo "  No existing Hermes processes"
fi
if [[ -n "$BWRAP_PROCS" ]]; then
  echo "  WARNING: bwrap processes found:"
  echo "$BWRAP_PROCS" | sed 's/^/    /'
else
  echo "  No existing bwrap processes"
fi
if [[ -z "$HERMES_PROCS" && -z "$BWRAP_PROCS" ]]; then
  echo "PASS: No Hermes or bwrap POC processes active"
  PASSED=$((PASSED + 1))
else
  echo "FAIL: Hermes or bwrap processes are active. Terminate them before running the POC." >&2
  FAILED=$((FAILED + 1))
fi

# ── 10. Provider key check (never print or expose) ──────────────────────────

if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
  echo "PASS: OPENROUTER_API_KEY is set (value not inspected)"
  PASSED=$((PASSED + 1))
else
  echo "FAIL: OPENROUTER_API_KEY is not set" >&2
  FAILED=$((FAILED + 1))
fi

# ── 11. PAPERCLIP_API_KEY must NOT be forwarded ─────────────────────────────

if [[ -n "${PAPERCLIP_API_KEY:-}" ]]; then
  echo "WARN: PAPERCLIP_API_KEY is set in environment. For the POC, ensure allowPaperclipApiAccess is false."
else
  echo "PASS: PAPERCLIP_API_KEY is not set in environment"
  PASSED=$((PASSED + 1))
fi

# ── 12. bwrap can create a minimal sandbox ──────────────────────────────────

check "bwrap smoke test (--unshare-user /bin/true)" "" \
  "$BWRAP" --unshare-user --die-with-parent --ro-bind / / /bin/true

# ── 13. Paperclip service health (optional) ─────────────────────────────────

PAPERCLIP_URL="${PAPERCLIP_BASE_URL:-http://localhost:3100}"
if curl -s --max-time 5 "${PAPERCLIP_URL}/api/health" >/dev/null 2>&1; then
  echo "PASS: Paperclip service is reachable at $PAPERCLIP_URL"
  PASSED=$((PASSED + 1))
else
  echo "INFO: Paperclip service not reachable at $PAPERCLIP_URL (non-fatal for POC if not needed)"
fi

# ── 14. Unsafe patterns check ──────────────────────────────────────────────

UNSAFE_PATTERNS="pkill -f|killall|kill -9 -1"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
for script in preflight.sh verify-evidence.sh cleanup.sh; do
  if [[ -f "$SCRIPT_DIR/$script" ]]; then
    if grep -v '^UNSAFE_PATTERNS=' "$SCRIPT_DIR/$script" | grep -qE "$UNSAFE_PATTERNS" 2>/dev/null; then
      echo "FAIL: Unsafe cancellation pattern found in $script" >&2
      FAILED=$((FAILED + 1))
    else
      echo "PASS: $script is free of unsafe cancellation patterns"
      PASSED=$((PASSED + 1))
    fi
  fi
done

# ── Summary ─────────────────────────────────────────────────────────────────

echo ""
echo "=============================================="
echo "  Preflight Summary"
echo "=============================================="
echo "  Run ID:      $RUN_ID"
echo "  Workspace:   $WORKSPACE_DIR"
echo "  Issue ID:    ${ISSUE_ID:-<not set>}"
echo "  Branch:      $(git branch --show-current 2>/dev/null)"
echo "  Commit:      $HEAD_COMMIT"
echo "  Passed:      $PASSED"
echo "  Failed:      $FAILED"
echo "=============================================="

if [[ $FAILED -gt 0 ]]; then
  echo "VERDICT: PREFLIGHT FAILED ($FAILED check(s) failed)"
  exit 1
fi

echo "VERDICT: PREFLIGHT PASSED"
exit 0