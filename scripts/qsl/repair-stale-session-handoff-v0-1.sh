#!/usr/bin/env bash
set -euo pipefail

# QSL Mission Control V0.1 — stale runtime-session handoff repair.
#
# Flight #2 proved that the Director now receives its managed instructions and a
# valid workspace, but a fresh run treated a prior Paperclip/OpenClaw run ID as
# a live OpenClaw session and called session_status on it. Prior runtime session
# handles are historical evidence only. This patch makes that boundary explicit
# whenever a continuation summary is injected into an agent wake prompt.
#
# Bounded scope:
# - patch one shared wake-prompt helper
# - add one Hermes integration regression test
# - run focused test/typecheck/build gates
# - restart only the canonical staging service
# - refresh the already-isolated QSL-1 workspace to the new clean HEAD
# - leave QSL-1 BLOCKED; do not wake/retry it
# - production stays read-only and PID-continuous

REPO="${QSL_STAGING_REPO:-/opt/paperclip-deployments/thebinmap-email-ops-staging}"
WORK_BRANCH="feat/qsl-mission-control-v0-1-reliability"
MISSION_IDENTIFIER="${QSL_MISSION_IDENTIFIER:-QSL-1}"
MISSION_WORKSPACE="${QSL_MISSION_WORKSPACE:-/opt/paperclip-mission-cells/QSL-1/flight-2-implementation}"
API_BASE="${PAPERCLIP_STAGING_API_BASE:-http://127.0.0.1:3101/api}"
PROD_SERVICE="paperclip-thebinmap-prod.service"
STAGING_SERVICE="paperclip-thebinmap-staging.service"
OPENCLAW_USER="${QSL_OPENCLAW_USER:-openclaw}"

fail() { echo "BLOCKED: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "missing command: $1"; }
for cmd in git curl jq systemctl runuser python3 pnpm mktemp ln chmod; do need "$cmd"; done
[[ "$API_BASE" == "http://127.0.0.1:3101/api" || "$API_BASE" == "http://localhost:3101/api" ]] || fail "refusing non-staging API base: $API_BASE"
[[ -d "$REPO/.git" ]] || fail "staging repo missing: $REPO"
cd "$REPO"
[[ "$(git branch --show-current)" == "$WORK_BRANCH" ]] || fail "expected branch $WORK_BRANCH"
[[ -z "$(git status --porcelain)" ]] || fail "reliability worktree is dirty"

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

STAGING_USER="$(systemctl show "$STAGING_SERVICE" --property=User --value)"
runuser -u "$OPENCLAW_USER" -- test ! -w "$REPO" || fail "OpenClaw unexpectedly can write canonical staging repo"
runuser -u "$STAGING_USER" -- test ! -w "$REPO" || fail "staging service unexpectedly can write canonical staging repo"
echo "Canonical staging repo protection: PASS"

[[ -d "$MISSION_WORKSPACE/.git" ]] || fail "isolated mission workspace repository missing"
[[ -z "$(runuser -u "$OPENCLAW_USER" -- git -C "$MISSION_WORKSPACE" status --porcelain)" ]] || fail "isolated mission workspace is dirty"
[[ -z "$(runuser -u "$OPENCLAW_USER" -- git -C "$MISSION_WORKSPACE" remote)" ]] || fail "isolated mission workspace unexpectedly has a git remote"

python3 <<'PY'
from pathlib import Path

server_utils = Path("packages/adapter-utils/src/server-utils.ts")
prompt_test = Path("packages/adapters/hermes/src/server/prompt-rendering.test.ts")

text = server_utils.read_text()
old = '''  if (normalized.continuationSummary) {
    lines.push(
      "",
      "Issue continuation summary:",
      normalized.continuationSummary.body,
    );
'''
new = '''  if (normalized.continuationSummary) {
    lines.push(
      "",
      "Issue continuation summary (historical evidence):",
      "- Runtime/session handles named in this summary belong to prior runs and are non-actionable on the current run.",
      "- Do not call `session_status` or any `sessions_*` tool with an identifier copied from this summary. Inspect prior execution through durable Paperclip issue/run evidence and the Paperclip API instead.",
      "- Only the current run's runtime session is live unless current-run metadata explicitly provides a resumable session.",
      normalized.continuationSummary.body,
    );
'''
if new not in text:
    if text.count(old) != 1:
        raise SystemExit("server-utils continuation-summary block did not match exactly once")
    server_utils.write_text(text.replace(old, new, 1))

marker = 'quarantines stale runtime session handles carried by continuation summaries'
test_text = prompt_test.read_text()
if marker not in test_text:
    test_text += r'''

test("quarantines stale runtime session handles carried by continuation summaries", () => {
  const staleSessionId = "d8c60dcf-5cc7-4944-a8fe-9e0a4a9bba86";
  const prompt = buildPrompt(baseContext({
    paperclipWake: {
      reason: "issue_assigned",
      issue: {
        id: "issue-1",
        identifier: "QSL-1",
        title: "Finish Operator Loop V0.1",
        status: "todo",
        priority: "medium",
        workMode: "standard",
      },
      continuationSummary: {
        body: `Prior run ${staleSessionId} failed; inspect session status before continuing.`,
        bodyTruncated: false,
      },
      checkedOutByHarness: true,
      commentWindow: { requestedCount: 0, includedCount: 0, missingCount: 0 },
      comments: [],
      fallbackFetchNeeded: false,
    },
  }), {});

  expect(prompt).toContain("Issue continuation summary (historical evidence):");
  expect(prompt).toContain("Runtime/session handles named in this summary belong to prior runs and are non-actionable");
  expect(prompt).toContain("Do not call `session_status` or any `sessions_*` tool with an identifier copied from this summary");
  expect(prompt).toContain("durable Paperclip issue/run evidence and the Paperclip API");
  expect(prompt).toContain(staleSessionId);
});
'''
    prompt_test.write_text(test_text)
PY

EXPECTED_DIRTY="$(git status --porcelain | awk '{print $2}' | sort)"
EXPECTED=$'packages/adapter-utils/src/server-utils.ts\npackages/adapters/hermes/src/server/prompt-rendering.test.ts'
[[ "$EXPECTED_DIRTY" == "$EXPECTED" ]] || { git status --short >&2; fail "unexpected dirty-file set after stale-session patch"; }

echo "Stale-session prompt boundary patch: prepared"

NODE_SHIM="$(mktemp -d)"
BUNDLE="$(mktemp /tmp/qsl-flight2-session-boundary.XXXXXX.bundle)"
cleanup() { rm -rf "$NODE_SHIM"; rm -f "$BUNDLE"; }
trap cleanup EXIT
ln -s /usr/local/bin/node22 "$NODE_SHIM/node"
export PATH="$NODE_SHIM:$PATH"
echo "Test/build Node: $(node --version)"

(
  cd packages/adapters/hermes
  pnpm exec vitest run src/server/prompt-rendering.test.ts
)
pnpm --filter @paperclipai/adapter-utils typecheck
pnpm --filter @paperclipai/adapter-utils build
pnpm --filter @paperclipai/hermes-paperclip-adapter typecheck
pnpm --filter @paperclipai/hermes-paperclip-adapter build
pnpm --filter @paperclipai/server typecheck
pnpm --filter @paperclipai/server build

git add packages/adapter-utils/src/server-utils.ts packages/adapters/hermes/src/server/prompt-rendering.test.ts
git diff --cached --check
git commit -m "fix(qsl): quarantine stale session handles in continuation prompts"
HEAD_NOW="$(git rev-parse HEAD)"

systemctl restart "$STAGING_SERVICE"
for _ in $(seq 1 30); do
  if [[ "$(systemctl is-active "$STAGING_SERVICE")" == "active" ]] && curl -fsS http://127.0.0.1:3101/api/health >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
health
PID_AFTER_RESTART="$(production_pid)"
[[ "$PID_AFTER_RESTART" == "$PID_BEFORE" ]] || fail "production PID continuity failed after staging restart: before=$PID_BEFORE after=$PID_AFTER_RESTART"

# Refresh the clean isolated Mission Cell clone to the exact new reliability
# HEAD without adding a persistent remote or weakening safe.directory policy.
git bundle create "$BUNDLE" HEAD
chmod 0644 "$BUNDLE"
runuser -u "$OPENCLAW_USER" -- git -C "$MISSION_WORKSPACE" fetch "$BUNDLE" HEAD
runuser -u "$OPENCLAW_USER" -- git -C "$MISSION_WORKSPACE" reset --hard FETCH_HEAD
WORKSPACE_HEAD="$(runuser -u "$OPENCLAW_USER" -- git -C "$MISSION_WORKSPACE" rev-parse HEAD)"
[[ "$WORKSPACE_HEAD" == "$HEAD_NOW" ]] || fail "Mission Cell workspace HEAD did not refresh to reliability HEAD"
[[ -z "$(runuser -u "$OPENCLAW_USER" -- git -C "$MISSION_WORKSPACE" status --porcelain)" ]] || fail "Mission Cell workspace dirty after refresh"
[[ -z "$(runuser -u "$OPENCLAW_USER" -- git -C "$MISSION_WORKSPACE" remote)" ]] || fail "Mission Cell workspace gained a persistent remote"

MISSION="$(curl -fsS "$API_BASE/issues/$MISSION_IDENTIFIER")"
[[ "$(jq -r '.status // empty' <<<"$MISSION")" == "blocked" ]] || fail "$MISSION_IDENTIFIER unexpectedly left blocked state"
health
PID_FINAL="$(production_pid)"
[[ "$PID_FINAL" == "$PID_BEFORE" ]] || fail "production PID continuity failed: before=$PID_BEFORE final=$PID_FINAL"

echo
echo "QSL STALE SESSION HANDOFF REPAIR PASS"
echo "Reliability HEAD: $HEAD_NOW"
echo "Continuation summaries: historical runtime handles explicitly non-actionable"
echo "Regression test: PASS"
echo "Mission Cell workspace refreshed: $MISSION_WORKSPACE"
echo "QSL-1: BLOCKED (intentionally not retried)"
echo "Production isolation: PASS (PID $PID_BEFORE)"
