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

check "on required branch (feat/hermes-synthetic-poc-v0 or feat/qsl-current-upstream-integration)" \
  "$(git branch --show-current 2>/dev/null || echo "unknown")" \
  bash -c 'b="$(git branch --show-current 2>/dev/null)"; test "$b" = "feat/hermes-synthetic-poc-v0" -o "$b" = "feat/qsl-current-upstream-integration"'

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

# ── 7. Workspace can be created (disposable probe — MUST NOT leave residue) ─
#
# The real run workspace (${SANDBOX_PARENT}/paperclip-hermes-sandbox-${RUN_ID})
# is created by the Paperclip server at execution time, under the server's own
# UID.  If preflight creates it here (as root), the staging service (UID 997)
# cannot later mkdir inside it and Hermes execution fails with EACCES.
#
# So this step proves the sandbox parent is writable using a disposable probe
# directory that is created and removed in the same command.  It never touches
# the real run workspace.

check "workspace dir can be created and removed under $SANDBOX_PARENT" "" \
  bash -c 'd="$(mktemp -d "${1}/paperclip-hermes-preflight-XXXXXX")" && rmdir "$d"' _ "$SANDBOX_PARENT"

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

# ── 10. Provider key check — credential-validity prerequisite ONLY ──────────
#
# WARNING: OPENROUTER_API_KEY set in the shell is NOT the delivery mechanism
# to the Hermes child process. The governed delivery path is:
#
#   Company secret → agent secret binding (secret_ref)
#     → resolveAdapterConfigForRuntime (resolves plaintext)
#       → config.__resolvedEnvKeys (governed provenance stamp)
#         → buildHermesChildEnv (governedKeys gate)
#           → child_process.spawn({ env, envMode: "replace" })
#
# Plaintext config.env.* values that match secret-shaped keys are REJECTED
# unless they appear in __resolvedEnvKeys (governed secret pathway).
#
# This check ONLY verifies the credential is available for Paperclip config.
# IT DOES NOT DELIVER THE KEY TO HERMES.

if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
  echo "PASS: OPENROUTER_API_KEY is set in environment (credential available for Paperclip config; key value not inspected)"
  PASSED=$((PASSED + 1))
  echo "  NOTE: This check verifies the credential EXISTS. The actual delivery to"
  echo "  Hermes requires the governed secret pathway: company secret → agent"
  echo "  secret_ref binding → __resolvedEnvKeys → child environment."
else
  echo "FAIL: OPENROUTER_API_KEY is not set" >&2
  echo "  BLOCKED: The OpenRouter API key must be available as a company secret" >&2
  echo "  in Paperclip and bound to the agent via a secret_ref config binding." >&2
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

# ── 15. Hermes/OpenClaw executable check (fail-closed) ─────────────────────
#
# Resolves the configured command exactly as execute.ts does:
#   resolveHermesCommand: config.hermesCommand → config.command → "hermes"
#   resolveCommandPath: absolute path or PATH walk with X_OK check
#
# Does NOT start an agent, call a provider, or execute Hermes/OpenClaw.
#
# When the binary is under /home/openclaw (OpenClaw installation), the
# version probe runs as the openclaw user because the binary requires
# Node >=22.12.0 which is only available in the openclaw user's PATH.

HERMES_CMD="${HERMES_COMMAND:-hermes}"
HERMES_PATH="$(command -v "$HERMES_CMD" 2>/dev/null || true)"

if [[ -z "$HERMES_PATH" ]]; then
  echo "FAIL: Hermes/OpenClaw CLI '$HERMES_CMD' not found in PATH" >&2
  echo "  BLOCKED: The Hermes/OpenClaw CLI must be installed before POC execution." >&2
  echo "  If using OpenClaw: set HERMES_COMMAND=/home/openclaw/.local/bin/openclaw" >&2
  echo "  Or configure the path in Paperclip agent config: config.hermesCommand" >&2
  FAILED=$((FAILED + 1))
else
  check "Hermes/OpenClaw CLI found and executable" "$HERMES_PATH" \
    test -x "$HERMES_PATH"

  # Probe --version in the intended execution context.
  # If the binary is under /home/openclaw, run as the openclaw user
  # because that user's environment has the correct Node runtime.
  HERMES_VERSION=""
  VERSION_OK=0

  if [[ "$HERMES_PATH" = /home/openclaw/* ]] && command -v sudo >/dev/null 2>&1; then
    if sudo -u openclaw env \
      HOME=/home/openclaw \
      PATH="/home/openclaw/.local/bin:/usr/local/bin:/usr/bin:/bin" \
      "$HERMES_PATH" --version >/dev/null 2>&1; then
      HERMES_VERSION="$(sudo -u openclaw env \
        HOME=/home/openclaw \
        PATH="/home/openclaw/.local/bin:/usr/local/bin:/usr/bin:/bin" \
        "$HERMES_PATH" --version 2>&1 | head -1 || true)"
      VERSION_OK=1
    fi
  else
    if "$HERMES_PATH" --version >/dev/null 2>&1; then
      HERMES_VERSION="$("$HERMES_PATH" --version 2>&1 | head -1 || true)"
      VERSION_OK=1
    fi
  fi

  if [[ $VERSION_OK -eq 1 ]]; then
    echo "PASS: $HERMES_CMD --version succeeded"
    echo "  Version: $HERMES_VERSION"
    PASSED=$((PASSED + 1))
  else
    echo "  WARN: $HERMES_CMD --version failed (binary exists at $HERMES_PATH but may need runtime dependencies)"
    if [[ "$HERMES_PATH" = /home/openclaw/* ]]; then
      echo "  The OpenClaw binary requires Node >=22.12.0, available in the"
      echo "  openclaw user's environment. Paperclip will execute through bwrap"
      echo "  with the configured containment.executionUid and HOME."
    fi
    echo "  This is non-fatal for preflight but should be verified before POC execution."
  fi
fi

# ── 16. UID/GID contract ─────────────────────────────────────────────────────
#
# The UID of the preflight shell is NOT the same thing as:
#   - the Paperclip server UID
#   - the contained Hermes/OpenClaw child UID
#
# Invariant:
#   Paperclip/preflight MAY run as root.
#   A contained Hermes/OpenClaw child MUST NEVER execute as root (UID 0).
#
# Runtime enforcement (local-process-sandbox.ts):
#   containmentRequired=true + no executionUid + host UID 0 → REJECT
#
# This preflight cannot mechanically inspect the Paperclip agent config
# (containment.executionUid is set there). It detects the host environment
# and reports whether a suitable non-root UID exists for configuration.
# Final verification that containment.executionUid is actually set in the
# agent config belongs to the runtime/API/operator step.

CURRENT_UID="$(id -u 2>/dev/null || echo 0)"
CURRENT_GID="$(id -g 2>/dev/null || echo 0)"

echo "  Preflight shell UID: $CURRENT_UID, GID: $CURRENT_GID"

# Detect a suitable containment UID on this host.
# This must exist as a real system user because the workspace is mounted
# via --bind inside the bwrap sandbox and filesystem ownership maps to this UID.
CONTAINMENT_UID_CANDIDATE=""
if command -v getent >/dev/null 2>&1; then
  CONTAINMENT_UID_CANDIDATE="$(getent passwd 1000 2>/dev/null | cut -d: -f1 || true)"
fi

if [[ "$CURRENT_UID" == "0" ]]; then
  # Paperclip/preflight running as root is permitted.
  # But the contained child must never be root — containment.executionUid is mandatory.
  echo "INFO: Preflight shell is running as root (UID 0)."
  echo "  Running Paperclip or preflight as root is permitted."
  echo "  A contained Hermes/OpenClaw child MUST NEVER execute as root."
  echo "  When the host process is root, containment.executionUid is MANDATORY."
  echo "  Runtime enforcement REJECTS containmentRequired=true without executionUid."
  if [[ -n "$CONTAINMENT_UID_CANDIDATE" ]]; then
    check "suitable containment UID available" "$CONTAINMENT_UID_CANDIDATE (UID 1000)" \
      test -n "$CONTAINMENT_UID_CANDIDATE"
    echo "  REQUIRED OPERATOR ACTION: Set containment.executionUid=1000"
    echo "  in the Hermes agent config in Paperclip. This value is NOT inspected"
    echo "  by this offline preflight — final verification is at runtime."
  else
    echo "FAIL: No non-root system user detected on this host." >&2
    echo "  A non-root user must exist before containment.executionUid can be configured." >&2
    FAILED=$((FAILED + 1))
  fi
elif [[ -z "$CONTAINMENT_UID_CANDIDATE" ]]; then
  echo "WARN: No user at UID 1000 detected on this system."
  echo "  When the host process is non-root (UID $CURRENT_UID), the child inherits that UID."
  echo "  An explicit containment.executionUid is still recommended for defense-in-depth."
else
  check "suitable containment UID available" "$CONTAINMENT_UID_CANDIDATE (UID 1000)" \
    test -n "$CONTAINMENT_UID_CANDIDATE"
fi

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