#!/usr/bin/env bash
set -euo pipefail

# QSL Mission Control V0.1 — resume verifier diagnostics gate after pnpm scope failure.
#
# The verifier repair is already present at TARGET_HEAD. The previous resume gate
# attempted `pnpm exec` from scripts/operator-loop, which is not a pnpm workspace
# package. This gate invokes Paperclip's root-installed Vitest binary while setting
# the Operator Loop directory as Vitest's root, then completes the evidence gate.
#
# Staging only. No mission retry. No service restart. Production is read-only.

REPO="${QSL_STAGING_REPO:-/opt/paperclip-deployments/thebinmap-email-ops-staging}"
WORK_BRANCH="feat/qsl-mission-control-v0-1-reliability"
TARGET_HEAD="5744e9bae68227cdae2eed812333b3456625170d"
MISSION_IDENTIFIER="${QSL_MISSION_IDENTIFIER:-QSL-1}"
MISSION_WORKSPACE="${QSL_MISSION_WORKSPACE:-/opt/paperclip-mission-cells/QSL-1/flight-2-implementation}"
PROD_SERVICE="paperclip-thebinmap-prod.service"
STAGING_SERVICE="paperclip-thebinmap-staging.service"
OPENCLAW_USER="${QSL_OPENCLAW_USER:-openclaw}"
NODE22="${QSL_NODE22_BIN:-/usr/local/bin/node22}"

fail() { echo "BLOCKED: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "missing command: $1"; }
for cmd in git curl jq systemctl runuser mktemp chmod rm bash; do need "$cmd"; done
[[ -x "$NODE22" ]] || fail "Node 22 runtime missing: $NODE22"
[[ -d "$REPO/.git" ]] || fail "staging repo missing: $REPO"

production_pid() { systemctl show "$PROD_SERVICE" --property=MainPID --value; }
health() {
  [[ "$(systemctl is-active "$PROD_SERVICE")" == "active" ]] || fail "production service inactive"
  [[ "$(systemctl is-active "$STAGING_SERVICE")" == "active" ]] || fail "staging service inactive"
  curl -fsS http://127.0.0.1:3100/api/health >/dev/null || fail "production health failed"
  curl -fsS http://127.0.0.1:3101/api/health >/dev/null || fail "staging health failed"
}

health
PID_BEFORE="$(production_pid)"
[[ "$PID_BEFORE" =~ ^[1-9][0-9]*$ ]] || fail "invalid production PID: $PID_BEFORE"
echo "Production baseline PID: $PID_BEFORE"

cd "$REPO"
[[ "$(git branch --show-current)" == "$WORK_BRANCH" ]] || fail "expected branch $WORK_BRANCH"
[[ -z "$(git status --porcelain)" ]] || fail "reliability worktree is dirty"
[[ "$(git rev-parse HEAD)" == "$TARGET_HEAD" ]] || fail "unexpected reliability HEAD: $(git rev-parse HEAD)"
echo "Reliability HEAD: $TARGET_HEAD"

# Force Node 22 for Vitest without changing host-wide Node configuration.
node_alias_dir="$(mktemp -d)"
trap 'rm -rf "$node_alias_dir"' EXIT
ln -s "$NODE22" "$node_alias_dir/node"
export PATH="$node_alias_dir:$PATH"
echo "Test Node: $(node --version)"

VITEST="$REPO/node_modules/.bin/vitest"
[[ -x "$VITEST" ]] || fail "root Vitest binary missing: $VITEST"

bash -n scripts/operator-loop/verify-mission.sh
"$VITEST" \
  --root scripts/operator-loop \
  --config "$REPO/scripts/operator-loop/vitest.config.ts" \
  run \
  __tests__/authority-policy.test.ts \
  __tests__/verify-mission-output.test.ts

# Behavioral assertions must remain present in source, in addition to the runtime test.
[[ -f scripts/operator-loop/__tests__/verify-mission-output.test.ts ]] || fail "behavioral verifier regression test missing"
grep -q 'TEST_DIAGNOSTIC_SENTINEL' scripts/operator-loop/__tests__/verify-mission-output.test.ts || fail "diagnostic sentinel assertion missing"
grep -q 'tests: "failed"' scripts/operator-loop/__tests__/verify-mission-output.test.ts || fail "per-stage failed evidence assertion missing"
grep -q 'typecheck: "passed"' scripts/operator-loop/__tests__/verify-mission-output.test.ts || fail "per-stage passed evidence assertion missing"
grep -q 'build: "passed"' scripts/operator-loop/__tests__/verify-mission-output.test.ts || fail "build passed evidence assertion missing"

# Refresh the isolated Mission Cell workspace from the already-tested reliability HEAD.
[[ -d "$MISSION_WORKSPACE/.git" ]] || fail "mission workspace missing: $MISSION_WORKSPACE"
[[ -z "$(runuser -u "$OPENCLAW_USER" -- git -C "$MISSION_WORKSPACE" status --porcelain)" ]] || fail "mission workspace is dirty"
bundle="$(mktemp /tmp/qsl-verifier-diagnostics.XXXXXX.bundle)"
git bundle create "$bundle" HEAD
chmod 0644 "$bundle"
runuser -u "$OPENCLAW_USER" -- git -C "$MISSION_WORKSPACE" fetch "$bundle" HEAD
runuser -u "$OPENCLAW_USER" -- git -C "$MISSION_WORKSPACE" reset --hard FETCH_HEAD
rm -f "$bundle"
[[ "$(runuser -u "$OPENCLAW_USER" -- git -C "$MISSION_WORKSPACE" rev-parse HEAD)" == "$TARGET_HEAD" ]] || fail "mission workspace HEAD refresh failed"
[[ -z "$(runuser -u "$OPENCLAW_USER" -- git -C "$MISSION_WORKSPACE" remote)" ]] || fail "mission workspace unexpectedly has a remote"

# Mission remains blocked until the gate is fully proven.
MISSION_STATUS="$(curl -fsS http://127.0.0.1:3101/api/issues/$MISSION_IDENTIFIER | jq -r '.status // empty')"
[[ "$MISSION_STATUS" == "blocked" ]] || fail "$MISSION_IDENTIFIER unexpectedly left blocked state: $MISSION_STATUS"

PID_AFTER="$(production_pid)"
[[ "$PID_AFTER" == "$PID_BEFORE" ]] || fail "production PID continuity failed: before=$PID_BEFORE after=$PID_AFTER"
health

echo
echo "QSL VERIFIER DIAGNOSTICS REPAIR PASS"
echo "Reliability HEAD: $TARGET_HEAD"
echo "Operator-loop Vitest root: PASS"
echo "Failed-stage diagnostics: bounded and visible"
echo "Per-stage verification evidence: independent"
echo "Behavioral regression: PASS"
echo "Mission Cell workspace refreshed: $MISSION_WORKSPACE"
echo "$MISSION_IDENTIFIER: BLOCKED (intentionally not retried)"
echo "Production isolation: PASS (PID $PID_BEFORE)"
