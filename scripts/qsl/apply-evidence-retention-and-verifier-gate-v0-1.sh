#!/usr/bin/env bash
set -euo pipefail

REPO="/opt/paperclip-deployments/thebinmap-email-ops-staging"
RELIABILITY_BRANCH="feat/qsl-mission-control-v0-1-reliability"
EXPECTED_HEAD="35f60f596fa4813329ab26fc2c10a3e38d84350a"
WORKSPACE="/opt/paperclip-mission-cells/QSL-1/flight-2-implementation"
STAGING_SERVICE="paperclip-thebinmap-staging.service"
PRODUCTION_SERVICE="paperclip-thebinmap-prod.service"
STAGING_HEALTH="http://127.0.0.1:3101/api/health"
PRODUCTION_HEALTH="http://127.0.0.1:3100/api/health"

cd "$REPO"

PROD_PID_BEFORE="$(systemctl show -p MainPID --value "$PRODUCTION_SERVICE")"
if [[ -z "$PROD_PID_BEFORE" || "$PROD_PID_BEFORE" == "0" ]]; then
  echo "BLOCKED: production service has no live PID" >&2
  exit 1
fi

echo "Production baseline PID: $PROD_PID_BEFORE"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "BLOCKED: canonical staging repository is not clean" >&2
  git status --short >&2
  exit 1
fi

CURRENT_BRANCH="$(git branch --show-current)"
if [[ "$CURRENT_BRANCH" != "$RELIABILITY_BRANCH" ]]; then
  echo "BLOCKED: expected branch $RELIABILITY_BRANCH, found $CURRENT_BRANCH" >&2
  exit 1
fi

git fetch origin "$RELIABILITY_BRANCH"
git merge --ff-only "origin/$RELIABILITY_BRANCH"

HEAD_NOW="$(git rev-parse HEAD)"
if [[ "$HEAD_NOW" != "$EXPECTED_HEAD" ]]; then
  echo "BLOCKED: reliability HEAD mismatch" >&2
  echo "expected=$EXPECTED_HEAD" >&2
  echo "actual=$HEAD_NOW" >&2
  exit 1
fi

echo "Reliability HEAD: $HEAD_NOW"

export PATH="/usr/local/bin:$PATH"
echo "Test Node: $(node --version)"

bash -n scripts/operator-loop/verify-mission.sh

(
  cd scripts/operator-loop
  ../../node_modules/.bin/vitest run \
    --config vitest.config.ts \
    __tests__/authority-policy.test.ts \
    __tests__/verify-mission-output.test.ts
)

echo "Operator Loop verifier/receipt tests: PASS"

(
  cd server
  ../node_modules/.bin/vitest run \
    --config vitest.config.ts \
    src/__tests__/qsl-operator-mission-evidence-retention.test.ts
)

echo "Cumulative mission evidence test: PASS"

pnpm --filter @paperclipai/server typecheck
pnpm --filter @paperclipai/server build

echo "Server typecheck/build: PASS"

if [[ ! -d "$WORKSPACE/.git" ]]; then
  echo "BLOCKED: isolated Mission Cell workspace missing: $WORKSPACE" >&2
  exit 1
fi

WORKSPACE_OWNER="$(stat -c '%U' "$WORKSPACE")"
if [[ -z "$WORKSPACE_OWNER" ]]; then
  echo "BLOCKED: could not determine Mission Cell workspace owner" >&2
  exit 1
fi

if [[ -n "$(runuser -u "$WORKSPACE_OWNER" -- git -C "$WORKSPACE" status --porcelain)" ]]; then
  echo "BLOCKED: isolated Mission Cell workspace is not clean; refusing to overwrite work" >&2
  runuser -u "$WORKSPACE_OWNER" -- git -C "$WORKSPACE" status --short >&2
  exit 1
fi

BUNDLE="$(mktemp /tmp/qsl-evidence-retention.XXXXXX.bundle)"
trap 'rm -f "$BUNDLE"' EXIT

git bundle create "$BUNDLE" HEAD
chmod 0644 "$BUNDLE"
runuser -u "$WORKSPACE_OWNER" -- git -C "$WORKSPACE" fetch "$BUNDLE" HEAD
runuser -u "$WORKSPACE_OWNER" -- git -C "$WORKSPACE" reset --hard FETCH_HEAD

WORKSPACE_HEAD="$(runuser -u "$WORKSPACE_OWNER" -- git -C "$WORKSPACE" rev-parse HEAD)"
if [[ "$WORKSPACE_HEAD" != "$EXPECTED_HEAD" ]]; then
  echo "BLOCKED: Mission Cell workspace HEAD mismatch after refresh" >&2
  exit 1
fi

if [[ -n "$(runuser -u "$WORKSPACE_OWNER" -- git -C "$WORKSPACE" remote 2>/dev/null || true)" ]]; then
  echo "BLOCKED: Mission Cell workspace unexpectedly has a git remote" >&2
  exit 1
fi

echo "Mission Cell workspace refresh: PASS ($WORKSPACE_HEAD)"

systemctl restart "$STAGING_SERVICE"
sleep 3

if [[ "$(systemctl is-active "$STAGING_SERVICE")" != "active" ]]; then
  echo "BLOCKED: staging service failed to restart" >&2
  exit 1
fi

STAGING_HTTP="$(curl -s -o /dev/null -w '%{http_code}' "$STAGING_HEALTH" || true)"
if [[ "$STAGING_HTTP" != "200" ]]; then
  echo "BLOCKED: staging health failed after exact service restart (HTTP $STAGING_HTTP)" >&2
  exit 1
fi

PROD_HTTP="$(curl -s -o /dev/null -w '%{http_code}' "$PRODUCTION_HEALTH" || true)"
PROD_PID_AFTER="$(systemctl show -p MainPID --value "$PRODUCTION_SERVICE")"

if [[ "$PROD_HTTP" != "200" ]]; then
  echo "BLOCKED: production health check failed (HTTP $PROD_HTTP)" >&2
  exit 1
fi

if [[ "$PROD_PID_AFTER" != "$PROD_PID_BEFORE" ]]; then
  echo "BLOCKED: production PID changed" >&2
  echo "before=$PROD_PID_BEFORE after=$PROD_PID_AFTER" >&2
  exit 1
fi

cat <<EOF

QSL EVIDENCE RETENTION + VERIFIER GATE PASS
Reliability HEAD: $HEAD_NOW
Operator Loop isolated test config: PASS
Durable verification receipt: PASS
Cumulative mission evidence: PASS
Server typecheck/build: PASS
Mission Cell workspace: $WORKSPACE
Staging exact service restart: PASS
QSL-1: NOT RETRIED
Production isolation: PASS (PID $PROD_PID_AFTER)
EOF
