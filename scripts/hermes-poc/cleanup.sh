#!/usr/bin/env bash
# Hermes Synthetic POC — Safe Exact-Run Cleanup Helper
#
# Removes only the exact validated workspace for a known run ID.
# Exits nonzero on any unsafe or ambiguous target.
#
# Usage:
#   ./cleanup.sh --workspace-dir DIR --run-id ID [--force]
#
# Exit codes:
#   0  Cleanup successful
#   1  Cleanup skipped (unsafe target)
#   2  Usage error

set -euo pipefail

# ── Argument parsing ────────────────────────────────────────────────────────

WORKSPACE_DIR=""
RUN_ID=""
FORCE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --workspace-dir)
      WORKSPACE_DIR="$2"; shift 2 ;;
    --run-id)
      RUN_ID="$2"; shift 2 ;;
    --force)
      FORCE=1; shift ;;
    --help|-h)
      echo "Usage: $0 --workspace-dir DIR --run-id ID [--force]"
      echo "  --workspace-dir  Required. Exact workspace directory to remove."
      echo "  --run-id         Required. Run ID for path validation."
      echo "  --force          Skip confirmation prompt."
      exit 0 ;;
    *)
      echo "ERROR: Unknown argument: $1" >&2; exit 2 ;;
  esac
done

# ── Validation ──────────────────────────────────────────────────────────────

if [[ -z "$RUN_ID" ]]; then
  echo "FAIL: run-id is empty. Refusing to clean up." >&2
  exit 1
fi

if [[ "$RUN_ID" =~ [^a-zA-Z0-9_-] ]]; then
  echo "FAIL: run-id contains invalid characters: $RUN_ID" >&2
  exit 1
fi

if [[ ${#RUN_ID} -lt 3 ]]; then
  echo "FAIL: run-id too short (min 3 chars): $RUN_ID" >&2
  exit 1
fi

if [[ ${#RUN_ID} -gt 128 ]]; then
  echo "FAIL: run-id too long (max 128 chars)" >&2
  exit 1
fi

if [[ -z "$WORKSPACE_DIR" ]]; then
  echo "FAIL: --workspace-dir is required" >&2
  exit 2
fi

if [[ "$WORKSPACE_DIR" != /* ]]; then
  echo "FAIL: workspace-dir is not absolute: $WORKSPACE_DIR" >&2
  exit 1
fi

# ── Resolve the real path (no symlink tricks, no .. traversal) ─────────────

SANDBOX_PARENT="/tmp"

# Validate workspace_dir pattern BEFORE resolving (catch unsafe paths early)
if [[ "$WORKSPACE_DIR" != "$SANDBOX_PARENT"/* ]]; then
  echo "FAIL: workspace-dir is not inside sandbox parent ($SANDBOX_PARENT): $WORKSPACE_DIR" >&2
  exit 1
fi

# Check the directory doesn't contain path traversal tricks
if [[ "$WORKSPACE_DIR" =~ \.\. ]] || [[ "$WORKSPACE_DIR" =~ /\./ ]]; then
  echo "FAIL: workspace-dir contains path traversal: $WORKSPACE_DIR" >&2
  exit 1
fi

RESOLVED="$(realpath -e "$WORKSPACE_DIR" 2>/dev/null || echo "")"
if [[ -z "$RESOLVED" && -d "$WORKSPACE_DIR" ]]; then
  RESOLVED="$(cd "$WORKSPACE_DIR" && pwd -P 2>/dev/null || echo "")"
fi

if [[ -z "$RESOLVED" ]]; then
  if [[ -d "$WORKSPACE_DIR" ]]; then
    echo "FAIL: Cannot resolve real path for: $WORKSPACE_DIR" >&2
    exit 1
  else
    echo "INFO: Workspace directory does not exist: $WORKSPACE_DIR"
    echo "  Nothing to clean up."
    exit 0
  fi
fi

# ── Safety gates ────────────────────────────────────────────────────────────

# Gate 1: Not root
if [[ "$RESOLVED" == "/" ]]; then
  echo "FAIL: Refusing to remove root filesystem (/)!" >&2
  exit 1
fi

# Gate 2: Not /tmp itself
if [[ "$RESOLVED" == "/tmp" ]] || [[ "$RESOLVED" == "/tmp/" ]]; then
  echo "FAIL: Refusing to remove /tmp!" >&2
  exit 1
fi

# Gate 3: Not the sandbox parent
if [[ "$RESOLVED" == "$SANDBOX_PARENT" ]]; then
  echo "FAIL: Refusing to remove sandbox parent directory ($SANDBOX_PARENT)!" >&2
  exit 1
fi

# Gate 4: Must match expected pattern
EXPECTED_PATH="${SANDBOX_PARENT}/paperclip-hermes-sandbox-${RUN_ID}"
if [[ "$RESOLVED" != "$EXPECTED_PATH" ]]; then
  echo "FAIL: Resolved path ($RESOLVED) does not match expected path ($EXPECTED_PATH)" >&2
  exit 1
fi

# Gate 6: Must be a directory
if [[ ! -d "$RESOLVED" ]]; then
  echo "INFO: Target is not a directory: $RESOLVED"
  echo "  Nothing to clean up."
  exit 0
fi

# Gate 7: Must be writable (we should be able to remove it)
if [[ ! -w "$RESOLVED" ]]; then
  echo "FAIL: Target is not writable: $RESOLVED" >&2
  exit 1
fi

# ── Confirmation ────────────────────────────────────────────────────────────

echo "Cleanup target:"
echo "  Run ID:      $RUN_ID"
echo "  Workspace:   $RESOLVED"
echo ""

if [[ $FORCE -ne 1 ]]; then
  echo -n "Remove this workspace? [y/N] "
  read -r CONFIRM
  if [[ "$CONFIRM" != "y" ]] && [[ "$CONFIRM" != "Y" ]]; then
    echo "Cleanup aborted by user."
    exit 0
  fi
fi

# ── Execute ─────────────────────────────────────────────────────────────────

echo "Removing: $RESOLVED"
rm -rf "$RESOLVED"

if [[ -d "$RESOLVED" ]]; then
  echo "FAIL: Directory still exists after removal: $RESOLVED" >&2
  exit 1
fi

echo "PASS: Workspace cleaned up successfully."
exit 0