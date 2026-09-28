#!/usr/bin/env bash
set -euo pipefail

REPO="/opt/paperclip-deployments/thebinmap-email-ops-staging"
RELIABILITY_BRANCH="feat/qsl-mission-control-v0-1-reliability"
EXPECTED_HEAD="29a6a123550110712118cb76209748ea3946e40e"
WORKSPACE="/opt/paperclip-mission-cells/QSL-1/flight-2-implementation"
STAGING_SERVICE="paperclip-thebinmap-staging.service"
PRODUCTION_SERVICE="paperclip-thebinmap-prod.service"
STAGING_HEALTH="http://127.0.0.1:3101/api/health"
PRODUCTION_HEALTH="http://127.0.0.1:3100/api/health"
COMPANY_ID="f32509d2-8cad-4754-baab-c87148c4c69a"
ISSUE_ID="74c738f4-a413-45a1-a2cd-15b7ff8094f6"
SENTINEL_ID="413d0fce-52af-4764-bef5-6038ff1cd864"
DISPATCH_URL="http://127.0.0.1:3101/api/companies/${COMPANY_ID}/operator-review-dispatch"

cd "$REPO"

PROD_PID_BEFORE="$(systemctl show -p MainPID --value "$PRODUCTION_SERVICE")"
if [[ -z "$PROD_PID_BEFORE" || "$PROD_PID_BEFORE" == "0" ]]; then
  echo "BLOCKED: production service has no live PID" >&2
  exit 1
fi
if [[ "$(systemctl is-active "$PRODUCTION_SERVICE")" != "active" ]]; then
  echo "BLOCKED: production service is not active" >&2
  exit 1
fi
PROD_HTTP_BEFORE="$(curl -s -o /dev/null -w '%{http_code}' "$PRODUCTION_HEALTH" || true)"
if [[ "$PROD_HTTP_BEFORE" != "200" ]]; then
  echo "BLOCKED: production baseline health is HTTP $PROD_HTTP_BEFORE" >&2
  exit 1
fi

echo "Production baseline: active PID=$PROD_PID_BEFORE HTTP=$PROD_HTTP_BEFORE"

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

if [[ ! -x /usr/local/bin/node22 ]]; then
  echo "BLOCKED: /usr/local/bin/node22 is unavailable" >&2
  exit 1
fi

NODE_SHIM_DIR="$(mktemp -d /tmp/qsl-node22.XXXXXX)"
BUNDLE=""
DISPATCH_BODY="$(mktemp /tmp/qsl-review-dispatch.XXXXXX.json)"
cleanup() {
  rm -rf "$NODE_SHIM_DIR"
  rm -f "$DISPATCH_BODY"
  if [[ -n "$BUNDLE" ]]; then rm -f "$BUNDLE"; fi
}
trap cleanup EXIT
ln -s /usr/local/bin/node22 "$NODE_SHIM_DIR/node"
export PATH="$NODE_SHIM_DIR:/usr/local/bin:$PATH"

NODE_VERSION="$(node --version)"
case "$NODE_VERSION" in
  v22.*) ;;
  *) echo "BLOCKED: expected Node 22, got $NODE_VERSION" >&2; exit 1 ;;
esac

echo "Test/build Node: $NODE_VERSION"

(
  cd server
  ../node_modules/.bin/vitest run \
    --config vitest.config.ts \
    src/__tests__/qsl-operator-review-dispatch.test.ts \
    src/__tests__/qsl-operator-mission-evidence-retention.test.ts
)
echo "Review dispatch + evidence retention tests: PASS"

pnpm --filter @paperclipai/server typecheck
pnpm --filter @paperclipai/server build
echo "Server typecheck/build: PASS"

if [[ ! -d "$WORKSPACE/.git" ]]; then
  echo "BLOCKED: isolated Mission Cell workspace missing: $WORKSPACE" >&2
  exit 1
fi
WORKSPACE_OWNER="$(stat -c '%U' "$WORKSPACE")"
if [[ -n "$(runuser -u "$WORKSPACE_OWNER" -- git -C "$WORKSPACE" status --porcelain)" ]]; then
  echo "BLOCKED: isolated Mission Cell workspace is not clean" >&2
  runuser -u "$WORKSPACE_OWNER" -- git -C "$WORKSPACE" status --short >&2
  exit 1
fi

BUNDLE="$(mktemp /tmp/qsl-review-dispatch.XXXXXX.bundle)"
git bundle create "$BUNDLE" HEAD
chmod 0644 "$BUNDLE"
runuser -u "$WORKSPACE_OWNER" -- git -C "$WORKSPACE" fetch "$BUNDLE" HEAD
runuser -u "$WORKSPACE_OWNER" -- git -C "$WORKSPACE" reset --hard FETCH_HEAD
WORKSPACE_HEAD="$(runuser -u "$WORKSPACE_OWNER" -- git -C "$WORKSPACE" rev-parse HEAD)"
if [[ "$WORKSPACE_HEAD" != "$EXPECTED_HEAD" ]]; then
  echo "BLOCKED: Mission Cell workspace HEAD mismatch" >&2
  exit 1
fi
if [[ -n "$(runuser -u "$WORKSPACE_OWNER" -- git -C "$WORKSPACE" remote 2>/dev/null || true)" ]]; then
  echo "BLOCKED: Mission Cell workspace unexpectedly has a git remote" >&2
  exit 1
fi
echo "Mission Cell workspace refresh: PASS ($WORKSPACE_HEAD)"

RESTART_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
systemctl restart "$STAGING_SERVICE"

STAGING_HTTP="000"
for i in $(seq 1 60); do
  if [[ "$(systemctl is-active "$STAGING_SERVICE" 2>/dev/null || true)" == "active" ]]; then
    STAGING_HTTP="$(curl -s -o /dev/null -w '%{http_code}' "$STAGING_HEALTH" || true)"
    if [[ "$STAGING_HTTP" == "200" ]]; then
      echo "Staging ready after ${i}s"
      break
    fi
  fi
  sleep 1
done
if [[ "$STAGING_HTTP" != "200" ]]; then
  echo "BLOCKED: staging did not become healthy within 60s (HTTP $STAGING_HTTP)" >&2
  journalctl -u "$STAGING_SERVICE" --since "$RESTART_AT" --no-pager | tail -80 >&2
  exit 1
fi

echo "Staging exact service restart/readiness: PASS"

PROD_PID_AFTER_RESTART="$(systemctl show -p MainPID --value "$PRODUCTION_SERVICE")"
PROD_HTTP_AFTER_RESTART="$(curl -s -o /dev/null -w '%{http_code}' "$PRODUCTION_HEALTH" || true)"
if [[ "$PROD_PID_AFTER_RESTART" != "$PROD_PID_BEFORE" || "$PROD_HTTP_AFTER_RESTART" != "200" ]]; then
  echo "BLOCKED: production isolation failed after staging restart" >&2
  echo "before_pid=$PROD_PID_BEFORE after_pid=$PROD_PID_AFTER_RESTART http=$PROD_HTTP_AFTER_RESTART" >&2
  exit 1
fi
echo "Production isolation after restart: PASS (PID $PROD_PID_AFTER_RESTART)"

DISPATCH_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
DISPATCH_HTTP="$(curl -sS -o "$DISPATCH_BODY" -w '%{http_code}' \
  -X POST "$DISPATCH_URL" \
  -H 'Content-Type: application/json' \
  -d "{\"issueId\":\"$ISSUE_ID\"}" || true)"

echo "Review dispatch HTTP: $DISPATCH_HTTP"
cat "$DISPATCH_BODY"
echo
if [[ "$DISPATCH_HTTP" != "202" ]]; then
  echo "BLOCKED: explicit review dispatch did not return HTTP 202" >&2
  exit 1
fi

# Prove that Sentinel actually enters QSL-1's run history. This deliberately
# verifies execution, not merely an accepted API request.
SENTINEL_SEEN=false
for i in $(seq 1 60); do
  RUNS_JSON="$(curl -s "http://127.0.0.1:3101/api/issues/$ISSUE_ID/runs" || true)"
  if printf '%s' "$RUNS_JSON" | grep -q "$SENTINEL_ID"; then
    SENTINEL_SEEN=true
    echo "Sentinel review run observed after ${i}s"
    break
  fi
  sleep 1
done

if [[ "$SENTINEL_SEEN" != "true" ]]; then
  echo "BLOCKED: dispatch returned 202 but Sentinel did not appear in QSL-1 run history within 60s" >&2
  journalctl -u "$STAGING_SERVICE" --since "$DISPATCH_AT" --no-pager \
    | grep -Ei "$SENTINEL_ID|$ISSUE_ID|execution_review_requested|wake|review" \
    | tail -120 >&2 || true
  exit 1
fi

PROD_PID_FINAL="$(systemctl show -p MainPID --value "$PRODUCTION_SERVICE")"
PROD_HTTP_FINAL="$(curl -s -o /dev/null -w '%{http_code}' "$PRODUCTION_HEALTH" || true)"
if [[ "$PROD_PID_FINAL" != "$PROD_PID_BEFORE" || "$PROD_HTTP_FINAL" != "200" ]]; then
  echo "BLOCKED: production isolation failed after review dispatch" >&2
  echo "before_pid=$PROD_PID_BEFORE final_pid=$PROD_PID_FINAL http=$PROD_HTTP_FINAL" >&2
  exit 1
fi

cat <<EOF

QSL EXPLICIT SENTINEL REVIEW DISPATCH PASS
Reliability HEAD: $HEAD_NOW
Review dispatch invariants: PASS
Evidence retention regression: PASS
Server typecheck/build on Node 22: PASS
Mission Cell workspace: $WORKSPACE
Staging readiness: PASS
Explicit review dispatch: HTTP 202
Sentinel review run: OBSERVED for QSL-1
Production isolation: PASS (PID $PROD_PID_FINAL)
EOF
