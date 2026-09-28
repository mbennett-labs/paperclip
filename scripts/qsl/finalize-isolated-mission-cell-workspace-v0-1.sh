#!/usr/bin/env bash
set -euo pipefail

# QSL Mission Control V0.1 — final bounded workspace finalization.
#
# Prior finish attempt proved the isolated workspace and read-only control-plane
# policy, then failed because markdown backticks inside a double-quoted shell
# string were interpreted as command substitutions. This script avoids that
# class of bug by building the policy from a single-quoted heredoc and only then
# substituting the workspace placeholder.
#
# No source edits. No service restart. No production mutation. No QSL-1 wake.

REPO="${QSL_STAGING_REPO:-/opt/paperclip-deployments/thebinmap-email-ops-staging}"
WORK_BRANCH="feat/qsl-mission-control-v0-1-reliability"
MISSION_IDENTIFIER="${QSL_MISSION_IDENTIFIER:-QSL-1}"
MISSION_WORKSPACE="${QSL_MISSION_WORKSPACE:-/opt/paperclip-mission-cells/QSL-1/flight-2-implementation}"
API_BASE="${PAPERCLIP_STAGING_API_BASE:-http://127.0.0.1:3101/api}"
COMPANY_ID="${QSL_MISSION_CONTROL_COMPANY_ID:-f32509d2-8cad-4754-baab-c87148c4c69a}"
DIRECTOR_ID="${QSL_MISSION_CONTROL_DIRECTOR_ID:-0db9b4e5-531b-4fe6-9e02-a28ccbe0b9f3}"
SENTINEL_ID="${QSL_SENTINEL_GOVERNOR_ID:-413d0fce-52af-4764-bef5-6038ff1cd864}"
RECORDER_ID="${QSL_SELARIX_RECORDER_ID:-038946e0-f4bb-47e1-82b7-8818f7ab5f9f}"
PROD_SERVICE="paperclip-thebinmap-prod.service"
STAGING_SERVICE="paperclip-thebinmap-staging.service"
OPENCLAW_USER="${QSL_OPENCLAW_USER:-openclaw}"

fail() { echo "BLOCKED: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "missing command: $1"; }
for cmd in git curl jq systemctl runuser grep mktemp cat; do need "$cmd"; done
[[ "$API_BASE" == "http://127.0.0.1:3101/api" || "$API_BASE" == "http://localhost:3101/api" ]] || fail "refusing non-staging API base: $API_BASE"
[[ -d "$REPO/.git" ]] || fail "staging repo missing: $REPO"
cd "$REPO"
[[ "$(git branch --show-current)" == "$WORK_BRANCH" ]] || fail "expected branch $WORK_BRANCH"
[[ -z "$(git status --porcelain)" ]] || fail "reliability worktree is dirty"
HEAD_NOW="$(git rev-parse HEAD)"

production_pid() { systemctl show "$PROD_SERVICE" --property=MainPID --value; }
health() {
  [[ "$(systemctl is-active "$PROD_SERVICE")" == "active" ]] || fail "production service inactive"
  [[ "$(systemctl is-active "$STAGING_SERVICE")" == "active" ]] || fail "staging service inactive"
  curl -fsS http://127.0.0.1:3100/api/health >/dev/null || fail "production health failed"
  curl -fsS http://127.0.0.1:3101/api/health >/dev/null || fail "staging health failed"
}
api_get() { curl -fsS "$API_BASE$1"; }
api_put_json() {
  local path="$1" payload="$2" label="$3" body status
  body="$(mktemp)"
  status="$(curl -sS -o "$body" -w '%{http_code}' -X PUT "$API_BASE$path" -H 'Content-Type: application/json' --data-binary "$payload")" || {
    rm -f "$body"; fail "$label transport failure";
  }
  if [[ "$status" != "200" ]]; then
    echo "API ERROR: $label returned HTTP $status" >&2
    cat "$body" >&2 || true
    echo >&2
    rm -f "$body"
    fail "$label failed"
  fi
  rm -f "$body"
}

health
PID_BEFORE="$(production_pid)"
[[ "$PID_BEFORE" =~ ^[1-9][0-9]*$ ]] || fail "invalid production PID: $PID_BEFORE"
echo "Production baseline PID: $PID_BEFORE"

# Canonical deployment protection remains invariant.
STAGING_USER="$(systemctl show "$STAGING_SERVICE" --property=User --value)"
runuser -u "$OPENCLAW_USER" -- test ! -w "$REPO" || fail "OpenClaw unexpectedly can write canonical staging repo"
runuser -u "$STAGING_USER" -- test ! -w "$REPO" || fail "staging service unexpectedly can write canonical staging repo"
echo "Canonical staging repo protection: PASS"

# Workspace must already exist and be owned/usable by OpenClaw.
[[ -d "$MISSION_WORKSPACE/.git" ]] || fail "isolated mission workspace repository missing"
WORKSPACE_HEAD="$(runuser -u "$OPENCLAW_USER" -- git -C "$MISSION_WORKSPACE" rev-parse HEAD)"
[[ "$WORKSPACE_HEAD" == "$HEAD_NOW" ]] || fail "mission workspace HEAD $WORKSPACE_HEAD != reliability HEAD $HEAD_NOW"
[[ -z "$(runuser -u "$OPENCLAW_USER" -- git -C "$MISSION_WORKSPACE" status --porcelain)" ]] || fail "isolated mission workspace is dirty"
runuser -u "$OPENCLAW_USER" -- test -w "$MISSION_WORKSPACE" || fail "OpenClaw cannot write isolated mission workspace"
[[ -z "$(runuser -u "$OPENCLAW_USER" -- git -C "$MISSION_WORKSPACE" remote)" ]] || fail "isolated mission workspace unexpectedly has a git remote"
echo "Isolated Mission Cell workspace: PASS (correct HEAD, writable, clean, no remote)"

# Persistent control-plane members remain read-only.
for spec in \
  "$DIRECTOR_ID|Mission Control Director" \
  "$SENTINEL_ID|Sentinel Governor" \
  "$RECORDER_ID|Selarix Recorder"; do
  id="${spec%%|*}"
  label="${spec#*|}"
  member="$(api_get "/agents/$id")"
  [[ "$(jq -r '.companyId // empty' <<<"$member")" == "$COMPANY_ID" ]] || fail "$label company mismatch"
  [[ "$(jq -r '.adapterConfig["containment.cwdAccess"] // "ro"' <<<"$member")" == "ro" ]] || fail "$label is not read-only"
  [[ -z "$(jq -r '.adapterConfig["containment.cwdWriteRoot"] // empty' <<<"$member")" ]] || fail "$label unexpectedly has a write root"
done
echo "Persistent control-plane read-only policy: PASS"

# Read the Director managed instruction entry through the dedicated API.
BUNDLE="$(api_get "/agents/$DIRECTOR_ID/instructions-bundle")"
ENTRY_FILE="$(jq -r '.entryFile // empty' <<<"$BUNDLE")"
[[ -n "$ENTRY_FILE" ]] || fail "Director instructions bundle entryFile missing"
FILE_JSON="$(curl -fsS -G "$API_BASE/agents/$DIRECTOR_ID/instructions-bundle/file" --data-urlencode "path=$ENTRY_FILE")"
CURRENT_INSTRUCTIONS="$(jq -r '.content // empty' <<<"$FILE_JSON")"
[[ -n "$CURRENT_INSTRUCTIONS" ]] || fail "Director managed instructions are empty/missing"

MARKER='QSL-1 Flight #2 isolated workspace policy'
if ! grep -Fq "$MARKER" <<<"$CURRENT_INSTRUCTIONS"; then
  POLICY_TEMPLATE="$(cat <<'EOF'
## QSL-1 Flight #2 isolated workspace policy

The canonical staging deployment repository remains protected and read-only to Mission Cells. Do not chmod/chown it and do not give an implementation worker direct write access to it.

For QSL-1 Flight #2, use this isolated implementation clone:
`__MISSION_WORKSPACE__`

When assembling the temporary Staging Engineer, clone the governed Hermes/OpenClaw model/secret configuration but set:
- `cwd=__MISSION_WORKSPACE__`
- `containment.cwdAccess=rw`
- `containment.cwdWriteRoot=__MISSION_WORKSPACE__`
- keep containment enabled, non-root execution UID/GID, OpenRouter/DeepSeek Chat, and loopback Paperclip API access
- monthly budget must remain within the already-approved per-member ceiling; do not expand provider/model/spend authority

When assembling the independent Verification Engineer, use the same mission workspace as `cwd` but keep `containment.cwdAccess=ro` and do not set a write root. The verifier must not implement the change it reviews.

The implementation commit stays in the isolated mission clone until verification, Sentinel review, and Selarix provenance are complete. Do not mutate the protected canonical staging deployment tree as a workaround. Do not add a git remote or push from the Mission Cell workspace; promotion is a separate governed step.
EOF
)"
  POLICY="${POLICY_TEMPLATE//__MISSION_WORKSPACE__/$MISSION_WORKSPACE}"
  DIRECTOR_INSTRUCTIONS="${CURRENT_INSTRUCTIONS}"$'\n\n'"${POLICY}"
  PAYLOAD="$(jq -n --arg path "$ENTRY_FILE" --arg content "$DIRECTOR_INSTRUCTIONS" '{path:$path,content:$content}')"
  api_put_json "/agents/$DIRECTOR_ID/instructions-bundle/file" "$PAYLOAD" "update Director managed instructions"
fi

VERIFY_FILE_JSON="$(curl -fsS -G "$API_BASE/agents/$DIRECTOR_ID/instructions-bundle/file" --data-urlencode "path=$ENTRY_FILE")"
jq -r '.content // empty' <<<"$VERIFY_FILE_JSON" | grep -Fq "$MARKER" || fail "Director Flight #2 instructions marker did not persist"
echo "Director managed instructions update: PASS ($ENTRY_FILE)"

MISSION="$(api_get "/issues/$MISSION_IDENTIFIER")"
[[ "$(jq -r '.status // empty' <<<"$MISSION")" == "blocked" ]] || fail "$MISSION_IDENTIFIER unexpectedly left blocked state"
health
PID_FINAL="$(production_pid)"
[[ "$PID_FINAL" == "$PID_BEFORE" ]] || fail "production PID continuity failed: before=$PID_BEFORE final=$PID_FINAL"

echo
echo "QSL ISOLATED MISSION CELL WORKSPACE GATE PASS"
echo "Reliability HEAD: $HEAD_NOW"
echo "Canonical staging deployment: protected / read-only to Mission Cells"
echo "QSL-1 Flight #2 workspace: $MISSION_WORKSPACE"
echo "Staging Engineer policy: rw only inside isolated workspace"
echo "Verification Engineer policy: same workspace, read-only"
echo "Director/Sentinel/Selarix: read-only"
echo "Mission Cell git remotes: none"
echo "QSL-1: BLOCKED (intentionally not retried)"
echo "Production isolation: PASS (PID $PID_BEFORE)"
