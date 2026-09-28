#!/usr/bin/env bash
set -euo pipefail

# QSL Mission Control V0.1 — resume after local git clone refused the
# protected deployment repository because of Git safe.directory ownership.
#
# Do not weaken ownership or add a persistent global safe.directory exception.
# Instead, export the already-verified local reliability branch to a temporary
# git bundle, then clone that bundle into the isolated Mission Cell workspace.
#
# Entry state expected:
# - branch feat/qsl-mission-control-v0-1-reliability
# - HEAD is the committed cwdAccess/workspace gate from the prior run
# - staging policy has already been restarted/health-checked
# - QSL-1 is still BLOCKED

REPO="${QSL_STAGING_REPO:-/opt/paperclip-deployments/thebinmap-email-ops-staging}"
WORK_BRANCH="feat/qsl-mission-control-v0-1-reliability"
MISSION_IDENTIFIER="${QSL_MISSION_IDENTIFIER:-QSL-1}"
MISSION_ROOT="${QSL_MISSION_ROOT:-/opt/paperclip-mission-cells/QSL-1}"
MISSION_WORKSPACE="${QSL_MISSION_WORKSPACE:-$MISSION_ROOT/flight-2-implementation}"
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
for cmd in git curl jq systemctl runuser install chown mktemp find rmdir; do need "$cmd"; done
[[ "$API_BASE" == "http://127.0.0.1:3101/api" || "$API_BASE" == "http://localhost:3101/api" ]] || fail "refusing non-staging API base: $API_BASE"
[[ -d "$REPO/.git" ]] || fail "staging repo not found: $REPO"
cd "$REPO"
[[ "$(git branch --show-current)" == "$WORK_BRANCH" ]] || fail "expected branch $WORK_BRANCH"
[[ -z "$(git status --porcelain)" ]] || fail "reliability worktree is not clean"

grep -q 'resolveContainedHermesCwdAccess' packages/adapters/hermes/src/server/execute.ts || fail "cwd access gate missing from deployed source"
grep -q 'flight-2-implementation' doc/plans/QSL_MISSION_CONTROL_RESOURCE_MANIFEST_V0_1.md || fail "isolated workspace manifest block missing"
HEAD_NOW="$(git rev-parse HEAD)"

production_pid() { systemctl show "$PROD_SERVICE" --property=MainPID --value; }
health() {
  [[ "$(systemctl is-active "$PROD_SERVICE")" == "active" ]] || fail "production service inactive"
  [[ "$(systemctl is-active "$STAGING_SERVICE")" == "active" ]] || fail "staging service inactive"
  curl -fsS http://127.0.0.1:3100/api/health >/dev/null || fail "production health failed"
  curl -fsS http://127.0.0.1:3101/api/health >/dev/null || fail "staging health failed"
}
api_get() { curl -fsS "$API_BASE$1"; }
api_patch_json() {
  local path="$1" payload="$2" label="$3" body status
  body="$(mktemp)"
  status="$(curl -sS -o "$body" -w '%{http_code}' -X PATCH "$API_BASE$path" -H 'Content-Type: application/json' --data-binary "$payload")" || {
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

# Protected deployment ownership is intentional.
STAGING_USER="$(systemctl show "$STAGING_SERVICE" --property=User --value)"
runuser -u "$OPENCLAW_USER" -- test ! -w "$REPO" || fail "OpenClaw unexpectedly has write access to canonical staging repo"
runuser -u "$STAGING_USER" -- test ! -w "$REPO" || fail "staging service unexpectedly has write access to canonical staging repo"
echo "Canonical staging repo protection: PASS"

# The failed clone may have left an empty destination directory. Never delete a
# valid repository or any non-empty workspace automatically.
if [[ -e "$MISSION_WORKSPACE" ]]; then
  if git -C "$MISSION_WORKSPACE" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    fail "mission workspace already contains a git repository; refusing to replace it"
  fi
  if find "$MISSION_WORKSPACE" -mindepth 1 -maxdepth 1 -print -quit | grep -q .; then
    echo "Existing non-empty failed-clone path:" >&2
    find "$MISSION_WORKSPACE" -mindepth 1 -maxdepth 2 -print >&2 || true
    fail "mission workspace exists and is non-empty; manual inspection required"
  fi
  rmdir "$MISSION_WORKSPACE"
fi

install -d -o root -g root -m 0755 /opt/paperclip-mission-cells
install -d -o root -g root -m 0755 "$MISSION_ROOT"

BUNDLE="$(mktemp /tmp/qsl-flight2.XXXXXX.bundle)"
trap 'rm -f "$BUNDLE"' EXIT
# Create the bundle from the current, already-verified local branch. This avoids
# persistent Git safe.directory changes and does not require network credentials.
git bundle create "$BUNDLE" "$WORK_BRANCH"
git bundle verify "$BUNDLE" >/dev/null
git clone --branch "$WORK_BRANCH" "$BUNDLE" "$MISSION_WORKSPACE"

[[ "$(git -C "$MISSION_WORKSPACE" rev-parse HEAD)" == "$HEAD_NOW" ]] || fail "mission clone HEAD does not match reliability HEAD"
chown -R "$OPENCLAW_USER:$OPENCLAW_USER" "$MISSION_WORKSPACE"
runuser -u "$OPENCLAW_USER" -- test -w "$MISSION_WORKSPACE" || fail "OpenClaw cannot write isolated mission workspace"
runuser -u "$OPENCLAW_USER" -- git -C "$MISSION_WORKSPACE" status --porcelain | grep -q . && fail "fresh mission workspace is dirty"
runuser -u "$OPENCLAW_USER" -- sh -c "printf 'workspace-write-proof\n' > '$MISSION_WORKSPACE/.qsl-write-proof' && rm '$MISSION_WORKSPACE/.qsl-write-proof'"
echo "Isolated Mission Cell workspace clone: PASS"

configure_ro_member() {
  local id="$1" label="$2" member config patch
  member="$(api_get "/agents/$id")"
  [[ "$(jq -r '.companyId // empty' <<<"$member")" == "$COMPANY_ID" ]] || fail "$label company mismatch"
  config="$(jq -c '.adapterConfig | .["containment.cwdAccess"] = "ro" | del(.["containment.cwdWriteRoot"])' <<<"$member")"
  patch="$(jq -n --argjson adapterConfig "$config" '{adapterConfig:$adapterConfig,replaceAdapterConfig:true}')"
  api_patch_json "/agents/$id" "$patch" "$label read-only containment policy"
}
configure_ro_member "$DIRECTOR_ID" "Mission Control Director"
configure_ro_member "$SENTINEL_ID" "Sentinel Governor"
configure_ro_member "$RECORDER_ID" "Selarix Recorder"

DIRECTOR="$(api_get "/agents/$DIRECTOR_ID")"
CURRENT_INSTRUCTIONS="$(jq -r '.instructionsBundle.files["AGENTS.md"] // empty' <<<"$DIRECTOR")"
[[ -n "$CURRENT_INSTRUCTIONS" ]] || fail "Director AGENTS.md instructions are missing"
if ! grep -q 'QSL-1 Flight #2 isolated workspace policy' <<<"$CURRENT_INSTRUCTIONS"; then
  DIRECTOR_INSTRUCTIONS="$CURRENT_INSTRUCTIONS

## QSL-1 Flight #2 isolated workspace policy

The canonical staging deployment repository remains protected and read-only to Mission Cells. Do not chmod/chown it and do not give an implementation worker direct write access to it.

For QSL-1 Flight #2, use this isolated implementation clone:
`$MISSION_WORKSPACE`

When assembling the temporary Staging Engineer, clone your governed Hermes/OpenClaw model/secret configuration but set:
- `cwd=$MISSION_WORKSPACE`
- `containment.cwdAccess=rw`
- `containment.cwdWriteRoot=$MISSION_WORKSPACE`
- keep containment enabled, non-root execution UID/GID, OpenRouter/DeepSeek Chat, and loopback Paperclip API access
- monthly budget must remain within the already-approved per-member ceiling; do not expand provider/model/spend authority

When assembling the independent Verification Engineer, use the same mission workspace as `cwd` but keep `containment.cwdAccess=ro` and do not set a write root. The verifier must not implement the change it reviews.

The implementation commit stays in the isolated mission clone until verification, Sentinel review, and Selarix provenance are complete. Do not mutate the protected canonical staging deployment tree as a workaround.
"
  PATCH="$(jq -n --arg instructions "$DIRECTOR_INSTRUCTIONS" '{instructionsBundle:{entryFile:"AGENTS.md",files:{"AGENTS.md":$instructions}}}')"
  api_patch_json "/agents/$DIRECTOR_ID" "$PATCH" "update Director isolated-workspace instructions"
fi

MISSION="$(api_get "/issues/$MISSION_IDENTIFIER")"
[[ "$(jq -r '.status // empty' <<<"$MISSION")" == "blocked" ]] || fail "$MISSION_IDENTIFIER unexpectedly left blocked state"
health
PID_FINAL="$(production_pid)"
[[ "$PID_FINAL" == "$PID_BEFORE" ]] || fail "production PID continuity failed: before=$PID_BEFORE final=$PID_FINAL"

for id in "$DIRECTOR_ID" "$SENTINEL_ID" "$RECORDER_ID"; do
  member="$(api_get "/agents/$id")"
  [[ "$(jq -r '.adapterConfig["containment.cwdAccess"] // "ro"' <<<"$member")" == "ro" ]] || fail "persistent member $id is not read-only"
done

echo
echo "QSL ISOLATED MISSION CELL WORKSPACE GATE PASS"
echo "Reliability HEAD: $HEAD_NOW"
echo "Canonical staging deployment: protected / read-only to Mission Cells"
echo "QSL-1 Flight #2 workspace: $MISSION_WORKSPACE"
echo "Staging Engineer policy: rw only inside isolated workspace"
echo "Verification Engineer policy: same workspace, read-only"
echo "Director/Sentinel/Selarix: read-only"
echo "QSL-1: BLOCKED (intentionally not retried)"
echo "Production isolation: PASS (PID $PID_BEFORE)"
