#!/usr/bin/env bash
set -euo pipefail

TARGET_SHA="${1:-}"
DEPLOY_ROOT="/opt/paperclip-deployments/thebinmap-email-ops-staging"
AUTHORIZED_KEYS="/root/.ssh/authorized_keys"
SHARE_DIR="/usr/local/share/qsl-staging-ops"

[[ "$EUID" -eq 0 ]] || { echo "ERROR: run as root" >&2; exit 2; }
[[ "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "ERROR: pass a 40-char Git commit SHA" >&2; exit 3; }
[[ -f "$AUTHORIZED_KEYS" ]] || { echo "ERROR: $AUTHORIZED_KEYS not found" >&2; exit 4; }
[[ -d "$DEPLOY_ROOT/.git" ]] || { echo "ERROR: staging git checkout not found" >&2; exit 5; }

find_dispatcher() {
  local cmd token candidate
  while IFS= read -r cmd; do
    for token in $cmd; do
      candidate="${token%\"}"
      candidate="${candidate#\"}"
      if [[ "$candidate" == /* && -f "$candidate" ]]; then
        if grep -q 'QSL_STAGING_OPS_ERROR' "$candidate" 2>/dev/null; then
          readlink -f "$candidate"
          return 0
        fi
      fi
    done
  done < <(sed -n 's/.*command="\([^"]*\)".*/\1/p' "$AUTHORIZED_KEYS")

  for candidate in \
    /usr/local/sbin/qsl-staging-ops \
    /usr/local/bin/qsl-staging-ops \
    /usr/local/sbin/qsl-staging-ops-bridge \
    /usr/local/bin/qsl-staging-ops-bridge; do
    if [[ -f "$candidate" ]] && grep -q 'QSL_STAGING_OPS_ERROR' "$candidate" 2>/dev/null; then
      readlink -f "$candidate"
      return 0
    fi
  done
  return 1
}

DISPATCHER="$(find_dispatcher)" || {
  echo "ERROR: could not locate the current forced-command QSL staging dispatcher" >&2
  echo "No changes were made." >&2
  exit 6
}

echo "CURRENT_DISPATCHER=$DISPATCHER"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

git -C "$DEPLOY_ROOT" fetch --quiet origin "$TARGET_SHA"
git -C "$DEPLOY_ROOT" cat-file -e "$TARGET_SHA^{commit}"
git -C "$DEPLOY_ROOT" show "$TARGET_SHA:.qsl/staging-ops/operator-v1.sh" > "$TMP/operator-v1.sh"
git -C "$DEPLOY_ROOT" show "$TARGET_SHA:.qsl/staging-ops/CEO_AGENTS.md" > "$TMP/CEO_AGENTS.md"

bash -n "$TMP/operator-v1.sh"
grep -q 'VERSION="qsl-staging-ops-v1' "$TMP/operator-v1.sh"
grep -q '^# CEO — TheBinMap Email Operations Staging' "$TMP/CEO_AGENTS.md"

# Structural guard: bridge_dispatch_readonly must be DEFINED before the
# `case "$op"` dispatch. bash -n cannot catch a definition placed after the
# case arm that invokes it (runtime "command not found"), so assert the order
# explicitly before anything is installed.
OPERATOR_DEF_LINE="$(grep -n '^bridge_dispatch_readonly()' "$TMP/operator-v1.sh" | cut -d: -f1)"
OPERATOR_CASE_LINE="$(grep -n 'case "\$op" in' "$TMP/operator-v1.sh" | cut -d: -f1)"
[[ -n "$OPERATOR_DEF_LINE" && -n "$OPERATOR_CASE_LINE" ]] || { echo "ERROR: operator structure check failed (missing function or case dispatch)" >&2; exit 7; }
[[ "$OPERATOR_DEF_LINE" -lt "$OPERATOR_CASE_LINE" ]] || {
  echo "ERROR: bridge_dispatch_readonly is defined (line $OPERATOR_DEF_LINE) after the case dispatch (line $OPERATOR_CASE_LINE)" >&2
  echo "This operator would fail at runtime with 'command not found'. Aborting." >&2
  exit 7
}

CANDIDATE_VERSION="$(grep -m1 '^VERSION=' "$TMP/operator-v1.sh" | cut -d '"' -f2)"
echo "CANDIDATE_VERSION=$CANDIDATE_VERSION"

# ── Legacy delegation target (.v0) ───────────────────────────────────────────
# ".v0" is the PRE-V1 legacy dispatcher that operator-v1.sh delegates to for
# the v0-era operations (health|live-shadow-report|deploy-email-plugin) via
# LEGACY="${BASH_SOURCE[0]}.v0". It is NOT a generic rollback slot: only ever
# created once, from the currently-installed pre-V1 dispatcher, and never
# overwritten afterwards. Rollback for V1→V1' upgrades uses the separate
# timestamped pre-upgrade snapshot below.
if [[ ! -e "$DISPATCHER.v0" ]]; then
  cp -a "$DISPATCHER" "$DISPATCHER.v0"
  chmod 755 "$DISPATCHER.v0"
  echo "LEGACY_BACKUP=$DISPATCHER.v0"
else
  echo "LEGACY_BACKUP_ALREADY_PRESENT=$DISPATCHER.v0"
fi

# ── Pre-upgrade rollback snapshot ─────────────────────────────────────────────
# Separate from .v0: captures the currently-installed V1 dispatcher before it
# is replaced, so a bad upgrade can be rolled back without regressing the
# legacy delegation target. Retention: keep the 3 most recent snapshots.
if [[ -f "$DISPATCHER" ]]; then
  PRE_UPGRADE_SNAPSHOT="${DISPATCHER}.pre-$(date -u +%Y%m%dT%H%M%SZ)-${TARGET_SHA:0:8}"
  cp -a "$DISPATCHER" "$PRE_UPGRADE_SNAPSHOT"
  chmod 755 "$PRE_UPGRADE_SNAPSHOT"
  echo "PRE_UPGRADE_SNAPSHOT=$PRE_UPGRADE_SNAPSHOT"
  snapshot_count=0
  while IFS= read -r old_snapshot; do
    snapshot_count=$((snapshot_count + 1))
    if [[ $snapshot_count -gt 3 ]]; then
      rm -f -- "$old_snapshot"
    fi
  done < <(ls -1t "${DISPATCHER}".pre-* 2>/dev/null)
else
  echo "PRE_UPGRADE_SNAPSHOT=NONE"
fi

install -d -o root -g root -m 755 "$SHARE_DIR"
install -o root -g root -m 644 "$TMP/CEO_AGENTS.md" "$SHARE_DIR/CEO_AGENTS.md"
install -o root -g root -m 755 "$TMP/operator-v1.sh" "$DISPATCHER"

printf '%s\n' "$TARGET_SHA" > "$SHARE_DIR/operator-source-sha"
chmod 644 "$SHARE_DIR/operator-source-sha"

bash -n "$DISPATCHER"
grep -q 'qsl-staging-ops-v1' "$DISPATCHER"

echo "OPERATOR_V1_INSTALLED=YES"
echo "SOURCE_SHA=$TARGET_SHA"
echo "DISPATCHER=$DISPATCHER"
echo "LEGACY=$DISPATCHER.v0"
if [[ -n "${PRE_UPGRADE_SNAPSHOT:-}" ]]; then
  echo "ROLLBACK_CMD=install -o root -g root -m 755 '$PRE_UPGRADE_SNAPSHOT' '$DISPATCHER'"
fi
echo "POST_INSTALL_CHECK=run operator-version over SSH and expect: $CANDIDATE_VERSION"
