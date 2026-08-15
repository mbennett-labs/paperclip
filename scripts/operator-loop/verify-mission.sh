#!/usr/bin/env bash
# Operator Loop V0 — Mission Verification (Stage C)
#
# Runs mission-relevant tests, typecheck, and build.
# Captures results as evidence. Does NOT mutate state beyond running build tools.
# Failed checks emit bounded diagnostics so the recovery owner can diagnose the
# actual failure instead of receiving only a generic verifier exit status.
#
# Usage:
#   ./verify-mission.sh --mission-id ID [--repo-dir DIR] [--skip-tests] [--skip-typecheck] [--skip-build]
#
# Exit codes:
#   0  All selected verifications passed
#   1  One or more verifications failed
#   2  Usage error

set -euo pipefail

MISSION_ID=""
REPO_DIR=""
SKIP_TESTS=false
SKIP_TYPECHECK=false
SKIP_BUILD=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mission-id)
      MISSION_ID="$2"; shift 2 ;;
    --repo-dir)
      REPO_DIR="$2"; shift 2 ;;
    --skip-tests) SKIP_TESTS=true; shift ;;
    --skip-typecheck) SKIP_TYPECHECK=true; shift ;;
    --skip-build) SKIP_BUILD=true; shift ;;
    --help|-h)
      echo "Usage: $0 --mission-id ID [--repo-dir DIR]"
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
TESTS_OUTPUT=""
TYPECHECK_OUTPUT=""
BUILD_OUTPUT=""
DIFF_CHECK_OUTPUT=""
TESTS_STATUS="skipped"
TYPECHECK_STATUS="skipped"
BUILD_STATUS="skipped"
DIFF_CHECK_STATUS="clean"
DIAGNOSTIC_LINES="${VERIFY_DIAGNOSTIC_LINES:-200}"

emit_failure_diagnostics() {
  local stage="$1"
  local output="$2"

  echo "--- ${stage} diagnostics (last ${DIAGNOSTIC_LINES} lines) ---" >&2
  if [[ -n "$output" ]]; then
    printf '%s\n' "$output" | tail -n "$DIAGNOSTIC_LINES" >&2
  else
    echo "(no output captured)" >&2
  fi
  echo "--- end ${stage} diagnostics ---" >&2
}

echo "=== Operator Loop V0 — Verification ==="
echo "  Mission: $MISSION_ID"
echo "  Repo: $REPO_DIR"
echo ""

# ── C1: Run unit/integration tests ───────────────────────────────────────────

if [[ "$SKIP_TESTS" != "true" ]]; then
  echo "--- Running tests (pnpm test:run) ---"
  if TESTS_OUTPUT="$(cd "$REPO_DIR" && pnpm test:run 2>&1)"; then
    TESTS_STATUS="passed"
    echo "PASS: Tests passed"
    PASSED=$((PASSED + 1))
  else
    TESTS_STATUS="failed"
    echo "FAIL: Tests failed" >&2
    emit_failure_diagnostics "tests" "$TESTS_OUTPUT"
    FAILED=$((FAILED + 1))
  fi
else
  echo "SKIP: Tests skipped (--skip-tests)"
fi

# ── C2: Run typecheck ────────────────────────────────────────────────────────

if [[ "$SKIP_TYPECHECK" != "true" ]]; then
  echo "--- Running typecheck (pnpm -r typecheck) ---"
  if TYPECHECK_OUTPUT="$(cd "$REPO_DIR" && pnpm -r typecheck 2>&1)"; then
    TYPECHECK_STATUS="passed"
    echo "PASS: Typecheck passed"
    PASSED=$((PASSED + 1))
  else
    TYPECHECK_STATUS="failed"
    echo "FAIL: Typecheck failed" >&2
    emit_failure_diagnostics "typecheck" "$TYPECHECK_OUTPUT"
    FAILED=$((FAILED + 1))
  fi
else
  echo "SKIP: Typecheck skipped (--skip-typecheck)"
fi

# ── C3: Run build ────────────────────────────────────────────────────────────

if [[ "$SKIP_BUILD" != "true" ]]; then
  echo "--- Running build (pnpm build) ---"
  if BUILD_OUTPUT="$(cd "$REPO_DIR" && pnpm build 2>&1)"; then
    BUILD_STATUS="passed"
    echo "PASS: Build passed"
    PASSED=$((PASSED + 1))
  else
    BUILD_STATUS="failed"
    echo "FAIL: Build failed" >&2
    emit_failure_diagnostics "build" "$BUILD_OUTPUT"
    FAILED=$((FAILED + 1))
  fi
else
  echo "SKIP: Build skipped (--skip-build)"
fi

# ── C4: Run git diff --check ─────────────────────────────────────────────────

echo "--- Running git diff --check ---"
DIFF_CHECK_OUTPUT="$(cd "$REPO_DIR" && git diff --check 2>&1)" || true
if [[ -z "$DIFF_CHECK_OUTPUT" ]]; then
  DIFF_CHECK_STATUS="clean"
  echo "PASS: git diff --check clean"
  PASSED=$((PASSED + 1))
else
  DIFF_CHECK_STATUS="whitespace_warnings"
  echo "WARNING: git diff --check found whitespace issues:"
  echo "$DIFF_CHECK_OUTPUT"
fi

# ── Summary ──────────────────────────────────────────────────────────────────

echo ""
echo "=== Verification Summary ==="
echo "  Mission: $MISSION_ID"
echo "  Passed: $PASSED"
echo "  Failed: $FAILED"

# ── Output verification evidence as JSON ─────────────────────────────────────

echo ""
echo "=== Verification Evidence (JSON) ==="
cat <<EVIDENCE
{
  "mission_id": "$MISSION_ID",
  "tests": "$TESTS_STATUS",
  "typecheck": "$TYPECHECK_STATUS",
  "build": "$BUILD_STATUS",
  "diff_check": "$DIFF_CHECK_STATUS",
  "diagnostic_tail_lines": $DIAGNOSTIC_LINES,
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EVIDENCE

if [[ $FAILED -gt 0 ]]; then
  echo ""
  echo "VERDICT: VERIFICATION FAILED ($FAILED check(s) failed)"
  exit 1
fi

echo ""
echo "VERDICT: VERIFICATION PASSED"
exit 0