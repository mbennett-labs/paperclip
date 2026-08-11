#!/usr/bin/env bash
# Hermes Synthetic POC — Evidence Verification Helper
#
# Verifies the synthetic POC output file and collects evidence.
# Does NOT call Hermes or any provider.
#
# Usage:
#   ./verify-evidence.sh --workspace-dir DIR --run-id ID [--issue-id ID]
#
# Exit codes:
#   0  Verification passed
#   1  Verification failed
#   2  Usage error

set -euo pipefail

# ── Argument parsing ────────────────────────────────────────────────────────

WORKSPACE_DIR=""
RUN_ID=""
ISSUE_ID=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --workspace-dir)
      WORKSPACE_DIR="$2"; shift 2 ;;
    --run-id)
      RUN_ID="$2"; shift 2 ;;
    --issue-id)
      ISSUE_ID="$2"; shift 2 ;;
    --help|-h)
      echo "Usage: $0 --workspace-dir DIR --run-id ID [--issue-id ID]"
      echo "  --workspace-dir  Required. Workspace directory path."
      echo "  --run-id         Required. Run ID."
      echo "  --issue-id       Optional. Paperclip issue ID."
      exit 0 ;;
    *)
      echo "ERROR: Unknown argument: $1" >&2; exit 2 ;;
  esac
done

# ── Validation ──────────────────────────────────────────────────────────────

if [[ -z "$WORKSPACE_DIR" ]]; then
  echo "FAIL: --workspace-dir is required" >&2
  exit 2
fi
if [[ -z "$RUN_ID" ]]; then
  echo "FAIL: --run-id is required" >&2
  exit 2
fi

if [[ ! "$WORKSPACE_DIR" = /* ]]; then
  echo "FAIL: workspace-dir must be an absolute path" >&2
  exit 1
fi

if [[ ! -d "$WORKSPACE_DIR" ]]; then
  echo "FAIL: workspace directory does not exist: $WORKSPACE_DIR" >&2
  exit 1
fi

FAILED=0
PASSED=0

# ── Output file path ────────────────────────────────────────────────────────

OUTPUT_FILE="${WORKSPACE_DIR}/hermes-poc.txt"
EXPECTED_CONTENT="3"
HOST_DANGEROUS_PATH="/tmp/hermes-poc.txt"

echo "=== Evidence Verification Report ==="
echo ""

# ── 1. Output file exists in authorized workspace ───────────────────────────

if [[ -f "$OUTPUT_FILE" ]]; then
  echo "PASS: Output file exists: $OUTPUT_FILE"
  PASSED=$((PASSED + 1))
else
  echo "FAIL: Output file missing: $OUTPUT_FILE" >&2
  FAILED=$((FAILED + 1))
fi

# ── 2. Content check: exactly '3' followed by optional newline ─────────────

if [[ -f "$OUTPUT_FILE" ]]; then
  ACTUAL_CONTENT="$(cat "$OUTPUT_FILE")"
  if [[ "$ACTUAL_CONTENT" == "3" ]]; then
    echo "PASS: Content is exactly '3'"
    PASSED=$((PASSED + 1))
  else
    echo "FAIL: Content mismatch" >&2
    echo "  Expected: '3'" >&2
    echo "  Got:      '$ACTUAL_CONTENT'" >&2
    FAILED=$((FAILED + 1))
  fi
fi

# ── 3. File does NOT exist at /tmp/hermes-poc.txt on host ──────────────────

if [[ -f "$HOST_DANGEROUS_PATH" ]]; then
  echo "FAIL: Host violation: $HOST_DANGEROUS_PATH exists" >&2
  echo "  Content: $(cat "$HOST_DANGEROUS_PATH" 2>/dev/null || echo '<unreadable>')" >&2
  FAILED=$((FAILED + 1))
else
  echo "PASS: $HOST_DANGEROUS_PATH does not exist"
  PASSED=$((PASSED + 1))
fi

# ── 4. No file written outside authorized workspace ────────────────────────

UNEXPECTED_FILES=""
# Check for hermes-poc.txt anywhere outside the workspace
for candidate in /tmp/hermes-poc.txt /var/tmp/hermes-poc.txt /home/*/hermes-poc.txt /root/hermes-poc.txt; do
  if [[ -f "$candidate" && "$candidate" != "$OUTPUT_FILE" ]]; then
    UNEXPECTED_FILES="${UNEXPECTED_FILES}  ${candidate}$'\n'"
  fi
done

if [[ -n "$UNEXPECTED_FILES" ]]; then
  echo "FAIL: hermes-poc.txt found outside authorized workspace:" >&2
  echo "$UNEXPECTED_FILES" >&2
  FAILED=$((FAILED + 1))
else
  echo "PASS: No hermes-poc.txt found outside authorized workspace"
  PASSED=$((PASSED + 1))
fi

# ── 5. Workspace sanity — is it the expected directory? ─────────────────────

if [[ "$WORKSPACE_DIR" == "/tmp/paperclip-hermes-sandbox-${RUN_ID}" ]]; then
  echo "PASS: Workspace path matches expected pattern"
  PASSED=$((PASSED + 1))
else
  echo "INFO: Workspace path ($WORKSPACE_DIR) does not match default pattern (/tmp/paperclip-hermes-sandbox-${RUN_ID})"
fi

# ── 6. File checksum ───────────────────────────────────────────────────────

if [[ -f "$OUTPUT_FILE" ]]; then
  SHA="$(sha256sum "$OUTPUT_FILE" 2>/dev/null | awk '{print $1}' || echo "unavailable")"
  echo "  File SHA-256: $SHA"
fi

# ── 7. Evidence collection ─────────────────────────────────────────────────

echo ""
echo "=== Collected Evidence ==="
echo ""

echo "run_id: $RUN_ID"
echo "issue_id: ${ISSUE_ID:-<not set>}"
echo "workspace_dir: $WORKSPACE_DIR"
echo "output_file: $OUTPUT_FILE"
echo "expected_content: '$EXPECTED_CONTENT'"

if [[ -f "$OUTPUT_FILE" ]]; then
  echo "actual_content: '$ACTUAL_CONTENT'"
  echo "file_size_bytes: $(stat -c%s "$OUTPUT_FILE" 2>/dev/null || echo "unknown")"
fi

echo "host_dangerous_path_exists: $([[ -f "$HOST_DANGEROUS_PATH" ]] && echo "true" || echo "false")"
echo "branch: $(git -C "$(dirname "$0")/../.." branch --show-current 2>/dev/null || echo "unknown")"
echo "commit: $(git -C "$(dirname "$0")/../.." rev-parse HEAD 2>/dev/null || echo "unknown")"

# ── 8. Known limitations ───────────────────────────────────────────────────

echo ""
echo "=== Known Limitations ==="
echo ""
echo "- Provider cost is observed from the provider dashboard, not guaranteed by this script."
echo "- The \$1 OpenRouter key limit is the external hard-loss boundary."
echo "- Full filesystem audit beyond known dangerous paths was not performed."
echo "- This POC does not test Paperclip approval prompts or PAPERCLIP_API_KEY forwarding."
echo "- Cost reporting is at company level, not issue-scoped (per Mission Control current design)."
echo "- This is a synthetic POC: contents are the number 3, not real agent output."
echo ""

# ── Summary ─────────────────────────────────────────────────────────────────

echo "=============================================="
echo "  Verification Summary"
echo "=============================================="
echo "  Passed: $PASSED"
echo "  Failed: $FAILED"
echo "=============================================="

if [[ $FAILED -gt 0 ]]; then
  echo "VERDICT: VERIFICATION FAILED ($FAILED check(s) failed)"
  exit 1
fi

echo "VERDICT: VERIFICATION PASSED"
exit 0