#!/usr/bin/env bash
# Real-execution test for the QSL staging operator's bridge-dispatch-readonly
# forced command. This executes operator-v1.sh with a real bash and asserts the
# structured fail-closed envelope — it is NOT a `bash -n` syntax check.
#
# Specifically fails if Bash would produce "command not found" for
# bridge_dispatch_readonly (the case arm runs before the function definition).
#
# Requirements: bash, coreutils (head/wc/mktemp), jq. No network access is
# needed: every exercised path returns BLOCKED before any curl/API call.
#
# Usage: bash operator-runtime-test.sh [path/to/operator-v1.sh]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPERATOR="${1:-$SCRIPT_DIR/operator-v1.sh}"

pass=0
fail=0

say_pass() { echo "PASS: $1"; pass=$((pass + 1)); }
say_fail() { echo "FAIL: $1"; fail=$((fail + 1)); }

# run_case <name> <stdin-data> <expected_sanitized_error>
# Executes the operator and asserts:
#   exit code 1 (fail closed), exactly one stdout line, transport_version 1,
#   http_status 0, result_class BLOCKED, the expected sanitized_error, and no
#   "command not found" anywhere on stderr.
run_case() {
  local name="$1" stdin_data="$2" expected_error="$3"
  local out err status
  out="$(mktemp)"
  err="$(mktemp)"

  printf '%s' "$stdin_data" | bash "$OPERATOR" bridge-dispatch-readonly >"$out" 2>"$err" || status=$?
  status="${status:-0}"

  if [ "$status" -ne 1 ]; then
    say_fail "$name — expected exit 1, got $status"
    cat "$err" >&2
    rm -f "$out" "$err"
    return
  fi

  if grep -q "command not found" "$err"; then
    say_fail "$name — bash reported command not found (function defined after case arm?)"
    cat "$err" >&2
    rm -f "$out" "$err"
    return
  fi

  local line_count
  line_count="$(grep -c . "$out" || true)"
  if [ "$line_count" -ne 1 ]; then
    say_fail "$name — expected exactly one envelope line, got $line_count"
    rm -f "$out" "$err"
    return
  fi

  local checks
  checks="$(jq -r --arg err "$expected_error" '
    [ (.transport_version == 1),
      (.http_status == 0),
      (.body.result_class == "BLOCKED"),
      (.body.sanitized_error == $err)
    ] | all' "$out" 2>/dev/null || echo false)"

  if [ "$checks" = "true" ]; then
    say_pass "$name — structured BLOCKED envelope, exit 1, no command-not-found"
  else
    say_fail "$name — envelope did not match (expected sanitized_error: $expected_error): $(cat "$out")"
  fi
  rm -f "$out" "$err"
}

echo "== operator runtime test: $OPERATOR =="
bash -n "$OPERATOR"

# ── Real execution: fail-closed paths before any network access ─────────────
run_case "empty request"            ""                                      "request is empty"
run_case "malformed JSON"           '{ not valid json'                      "invalid JSON"
run_case "non-staging environment"  '{"environment":"production","operation":"status"}' "environment must be staging"
run_case "missing operation"        '{"environment":"staging"}'             "missing operation"
run_case "non-allowlisted operation" '{"environment":"staging","operation":"restart-production"}' "operation not in read-only allowlist: restart-production"
run_case "bounded-write operation rejected by read-only gate" '{"environment":"staging","operation":"record-mission-evidence"}' "operation not in read-only allowlist: record-mission-evidence"

# ── Operator identity still intact ───────────────────────────────────────────
version_line="$(bash "$OPERATOR" operator-version 2>/dev/null | head -1 || true)"
if printf '%s' "$version_line" | grep -q '^qsl-staging-ops-v1'; then
  say_pass "operator-version reports $version_line"
else
  say_fail "operator-version did not report a v1 version (got: $version_line)"
fi

echo "== $pass passed, $fail failed =="
[ "$fail" -eq 0 ]
