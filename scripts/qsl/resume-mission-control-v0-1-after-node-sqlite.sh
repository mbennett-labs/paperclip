#!/usr/bin/env bash
set -euo pipefail

# Resume the QSL Mission Control V0.1 reliability upgrade after the focused
# recovery-service test was blocked by the host's default Node 20 runtime
# lacking node:sqlite. This script uses a temporary PATH shim for the already
# installed /usr/local/bin/node22; it does not change the system Node install.
#
# Expected entry state:
# - staging repo is on feat/qsl-mission-control-v0-1-reliability
# - the V0.1 source patches from upgrade-mission-control-v0-1.sh are present
#   but uncommitted because the original script failed before git add/commit
# - production has not been mutated

REPO="${QSL_STAGING_REPO:-/opt/paperclip-deployments/thebinmap-email-ops-staging}"
WORK_BRANCH="feat/qsl-mission-control-v0-1-reliability"
API_BASE="${PAPERCLIP_STAGING_API_BASE:-http://127.0.0.1:3101/api}"
COMPANY_ID="${QSL_MISSION_CONTROL_COMPANY_ID:-f32509d2-8cad-4754-baab-c87148c4c69a}"
DIRECTOR_ID="${QSL_MISSION_CONTROL_DIRECTOR_ID:-0db9b4e5-531b-4fe6-9e02-a28ccbe0b9f3}"
SENTINEL_ID="${QSL_SENTINEL_GOVERNOR_ID:-413d0fce-52af-4764-bef5-6038ff1cd864}"
RECORDER_ID="${QSL_SELARIX_RECORDER_ID:-038946e0-f4bb-47e1-82b7-8818f7ab5f9f}"
MISSION_IDENTIFIER="${QSL_MISSION_IDENTIFIER:-QSL-1}"
PROD_SERVICE="paperclip-thebinmap-prod.service"
STAGING_SERVICE="paperclip-thebinmap-staging.service"
NODE22="${QSL_NODE22:-/usr/local/bin/node22}"

fail() { echo "BLOCKED: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "missing command: $1"; }
for cmd in git curl jq systemctl pnpm grep; do need "$cmd"; done
[[ -x "$NODE22" ]] || fail "Node 22 runtime not found/executable at $NODE22"
[[ "$API_BASE" == "http://127.0.0.1:3101/api" || "$API_BASE" == "http://localhost:3101/api" ]] \
  || fail "refusing non-staging API base: $API_BASE"
[[ -d "$REPO/.git" ]] || fail "staging repo not found: $REPO"
cd "$REPO"
[[ "$(git branch --show-current)" == "$WORK_BRANCH" ]] || fail "expected branch $WORK_BRANCH"

production_pid() { systemctl show "$PROD_SERVICE" --property=MainPID --value; }
verify_health() {
  [[ "$(systemctl is-active "$PROD_SERVICE")" == "active" ]] || fail "production service inactive"
  [[ "$(systemctl is-active "$STAGING_SERVICE")" == "active" ]] || fail "staging service inactive"
  curl -fsS http://127.0.0.1:3100/api/health >/dev/null || fail "production health failed"
  curl -fsS http://127.0.0.1:3101/api/health >/dev/null || fail "staging health failed"
}
api_get() { curl -fsS "$API_BASE$1"; }
api_patch_json() {
  local path="$1" payload="$2" label="$3" body status
  body="$(mktemp)"
  status="$(curl -sS -o "$body" -w '%{http_code}' -X PATCH "$API_BASE$path" -H 'Content-Type: application/json' --data-binary "$payload")" \
    || { rm -f "$body"; fail "$label transport failure"; }
  if [[ "$status" != "200" ]]; then
    echo "API ERROR: $label returned HTTP $status" >&2
    cat "$body" >&2 || true
    echo >&2
    rm -f "$body"
    fail "$label failed"
  fi
  cat "$body"
  rm -f "$body"
}

verify_health
PROD_PID_BEFORE="$(production_pid)"
[[ "$PROD_PID_BEFORE" =~ ^[1-9][0-9]*$ ]] || fail "invalid production PID: $PROD_PID_BEFORE"
echo "Production baseline PID: $PROD_PID_BEFORE"

# Fail closed if the interrupted script did not leave the expected patch set.
grep -q 'missionContract: issueMissionContractSchema.optional()' packages/shared/src/validators/issue.ts \
  || fail "structured mission-contract validator patch is missing"
grep -q 'effectiveContinuationRetryMaxAttempts' server/src/services/recovery/service.ts \
  || fail "mission retry-cap patch is missing"
grep -q 'resolveContainedPaperclipApiAllowlistTarget' packages/adapters/hermes/src/server/execute.ts \
  || fail "loopback API containment patch is missing"
[[ -f server/src/__tests__/qsl-mission-contract-retry.test.ts ]] || fail "focused retry test is missing"
[[ -f packages/adapters/hermes/src/server/qsl-paperclip-api-containment.test.ts ]] || fail "focused containment test is missing"
[[ -f doc/plans/QSL_MISSION_CONTROL_RESOURCE_MANIFEST_V0_1.md ]] || fail "resource manifest is missing"

# Refuse unexpected tracked edits. Untracked proof artifacts outside this slice
# are ignored because git add below names the allowed files explicitly.
EXPECTED_TRACKED='^(packages/shared/src/validators/issue\.ts|packages/shared/src/validators/issue\.test\.ts|packages/shared/src/types/issue\.ts|server/src/services/issue-execution-policy\.ts|server/src/services/recovery/service\.ts|packages/adapters/hermes/src/server/execute\.ts)$'
while IFS= read -r changed; do
  [[ -z "$changed" ]] && continue
  [[ "$changed" =~ $EXPECTED_TRACKED ]] || fail "unexpected tracked edit in staging worktree: $changed"
done < <(git diff --name-only)

# Temporary Node 22 shim. Nothing is installed or changed globally.
NODE_SHIM="$(mktemp -d)"
trap 'rm -rf "$NODE_SHIM"' EXIT
ln -s "$NODE22" "$NODE_SHIM/node"
export PATH="$NODE_SHIM:$PATH"
node -e 'const major=Number(process.versions.node.split(".")[0]); if (major < 22) process.exit(22)'
echo "Test/build Node: $(node -v)"

# Re-run the exact failed gate and the other focused checks under Node 22.
pnpm exec vitest run \
  packages/shared/src/validators/issue.test.ts \
  server/src/__tests__/qsl-mission-contract-retry.test.ts \
  packages/adapters/hermes/src/server/qsl-paperclip-api-containment.test.ts

pnpm typecheck
pnpm build

# Commit only the bounded reliability slice.
git add \
  packages/shared/src/validators/issue.ts \
  packages/shared/src/validators/issue.test.ts \
  packages/shared/src/types/issue.ts \
  server/src/services/issue-execution-policy.ts \
  server/src/services/recovery/service.ts \
  server/src/__tests__/qsl-mission-contract-retry.test.ts \
  packages/adapters/hermes/src/server/execute.ts \
  packages/adapters/hermes/src/server/qsl-paperclip-api-containment.test.ts \
  doc/plans/QSL_MISSION_CONTROL_RESOURCE_MANIFEST_V0_1.md

git diff --cached --check
if ! git diff --cached --quiet; then
  git commit -m "feat(qsl): harden Mission Control V0.1 execution contract"
fi
RELIABILITY_HEAD="$(git rev-parse HEAD)"

# Deploy only to the exact staging unit.
systemctl restart "$STAGING_SERVICE"
for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:3101/api/health >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS http://127.0.0.1:3101/api/health >/dev/null || fail "staging failed health after exact-unit restart"
PROD_PID_AFTER_RESTART="$(production_pid)"
[[ "$PROD_PID_AFTER_RESTART" == "$PROD_PID_BEFORE" ]] \
  || fail "production PID changed during staging deploy: before=$PROD_PID_BEFORE after=$PROD_PID_AFTER_RESTART"
curl -fsS http://127.0.0.1:3100/api/health >/dev/null || fail "production health failed after staging deploy"

# Ground the Director in the canonical staging repo and enable only loopback
# Paperclip coordination through the newly deployed containment gate.
DIRECTOR="$(api_get "/agents/$DIRECTOR_ID")"
[[ "$(jq -r '.companyId // empty' <<<"$DIRECTOR")" == "$COMPANY_ID" ]] || fail "Director company mismatch"
DIRECTOR_CONFIG="$(jq -c --arg repo "$REPO" --arg api "$API_BASE" '
  .adapterConfig
  | .cwd = $repo
  | .paperclipApiUrl = $api
  | .allowPaperclipApiAccess = true
' <<<"$DIRECTOR")"
jq -e '[.. | objects | select(.type? == "secret_ref")] | length >= 1' <<<"$DIRECTOR_CONFIG" >/dev/null \
  || fail "Director config lost governed secret_ref"

DIRECTOR_INSTRUCTIONS=$(cat <<EOF
# Mission Control Director — V0.1

You are the persistent control-plane lead for governed QSL Mission Cells.

## Operating contract

One bounded mission in; verified result or one meaningful escalation out.
Do not make Michael the message bus.

## Canonical workplace

For Paperclip staging engineering missions, the canonical repository is:
\`$REPO\`

Your contained process starts in an ephemeral sandbox. The sandbox working directory is NOT evidence that a project file is missing. Before diagnosing filesystem absence:
1. read \`$REPO/doc/plans/QSL_MISSION_CONTROL_RESOURCE_MANIFEST_V0_1.md\`;
2. inspect the canonical repo, branch, HEAD, status and source-controlled artifacts;
3. distinguish a missing canonical artifact from a path merely assumed by a model.

Never create or restore a file solely because a model guessed that path should exist.

## Control-plane coordination

Use the governed Paperclip staging API advertised by \`PAPERCLIP_API_URL\` with \`PAPERCLIP_API_KEY\` for authorized company coordination. It is loopback-only under containment. Never point it at production or an external host.

You may create/assign L0/L1 temporary Mission Cell members when required and when their budget remains within already-approved policy. If a new member would expand financial authority beyond the approved per-member limit, BLOCK for human approval instead of self-implementing around the gate.

For a coding mission:
- orchestrate; do not repeatedly become the implementation worker;
- delegate implementation to a temporary Staging Engineer;
- delegate independent verification to a separate Verification Engineer;
- use Sentinel Governor for safety/authority review;
- use Selarix Recorder for provenance/final receipt.

A Staging Engineer may receive the canonical staging repo as its contained writable workspace for the bounded mission. A Verification Engineer receives read-only access and must not implement the change it reviews.

## Authority

L0/L1 staging work may proceed autonomously. Production mutation, secret changes, new external egress, destructive actions, external publication/communications, model/provider expansion, or material spend remain human authority.

Broad process termination is prohibited. Use exact canonical service units only.

Default governed model lane: OpenRouter / openrouter/deepseek/deepseek-chat. No silent substitution.

Start authorized work in the same wake. Completion requires evidence, required independent reviews, provenance, and production-isolation proof. Otherwise return one meaningful BLOCKED escalation.
EOF
)

DIRECTOR_PATCH="$(jq -n \
  --argjson adapterConfig "$DIRECTOR_CONFIG" \
  --arg instructions "$DIRECTOR_INSTRUCTIONS" \
  '{adapterConfig:$adapterConfig,replaceAdapterConfig:true,instructionsBundle:{entryFile:"AGENTS.md",files:{"AGENTS.md":$instructions}}}')"
api_patch_json "/agents/$DIRECTOR_ID" "$DIRECTOR_PATCH" "upgrade Mission Control Director" >/dev/null

# Persist QSL-1's acceptance criteria and one-retry contract. It must remain
# blocked; this script never wakes or resolves it.
MISSION="$(api_get "/issues/$MISSION_IDENTIFIER")"
MISSION_ID="$(jq -r '.id // empty' <<<"$MISSION")"
[[ -n "$MISSION_ID" ]] || fail "mission issue not found: $MISSION_IDENTIFIER"
[[ "$(jq -r '.status // empty' <<<"$MISSION")" == "blocked" ]] || fail "$MISSION_IDENTIFIER is not still blocked; refusing automatic mutation"
EXISTING_POLICY="$(jq -c '.executionPolicy // {}' <<<"$MISSION")"

MISSION_CONTRACT="$(jq -n '{
  version:1,
  objective:"Finish Operator Loop V0.1 so one bounded staging mission returns verified evidence or one meaningful escalation.",
  authorityLevel:"L1",
  acceptanceCriteria:[
    {id:"AC-1",text:"Root cause identified and repaired."},
    {id:"AC-2",text:"Appropriate tests/build/typecheck pass."},
    {id:"AC-3",text:"Mission-scoped commit exists."},
    {id:"AC-4",text:"Independent reviewer verdict exists."},
    {id:"AC-5",text:"Provenance contains the real issue ID and primary run ID."},
    {id:"AC-6",text:"JSON/Markdown receipt exists."},
    {id:"AC-7",text:"Production isolation passes."},
    {id:"AC-8",text:"Final state is COMPLETED or one meaningful BLOCKED escalation."},
    {id:"AC-9",text:"Reusable capability knowledge is harvested and temporary Mission Cell members are retired when appropriate."}
  ],
  maxRepairRetries:1,
  requiredStages:["implementation","verification","sentinel_review","provenance_receipt"],
  provider:"openrouter",
  model:"openrouter/deepseek/deepseek-chat",
  productionIsolationRequired:true
}')"

SENTINEL_STAGE_ID="d7860f1b-6c9a-4f41-bad1-3d50c76bba91"
SENTINEL_PARTICIPANT_ID="4e65e418-41e0-4dbd-95d7-46b53def0ff0"
RECORDER_STAGE_ID="10ac6206-343c-4d83-a04c-0c6064201c4d"
RECORDER_PARTICIPANT_ID="c606f8fd-e335-478d-874c-d8720b1544a0"
REVIEW_STAGES="$(jq -n \
  --arg sentinelStage "$SENTINEL_STAGE_ID" \
  --arg sentinelParticipant "$SENTINEL_PARTICIPANT_ID" \
  --arg sentinel "$SENTINEL_ID" \
  --arg recorderStage "$RECORDER_STAGE_ID" \
  --arg recorderParticipant "$RECORDER_PARTICIPANT_ID" \
  --arg recorder "$RECORDER_ID" \
  '[
    {id:$sentinelStage,type:"review",approvalsNeeded:1,participants:[{id:$sentinelParticipant,type:"agent",agentId:$sentinel,userId:null}]},
    {id:$recorderStage,type:"review",approvalsNeeded:1,participants:[{id:$recorderParticipant,type:"agent",agentId:$recorder,userId:null}]}
  ]')"
NEW_POLICY="$(jq -c \
  --argjson contract "$MISSION_CONTRACT" \
  --argjson stages "$REVIEW_STAGES" \
  '. + {mode:(.mode // "normal"),commentRequired:true,stages:$stages,missionContract:$contract}' \
  <<<"$EXISTING_POLICY")"
MISSION_PATCH="$(jq -n --argjson executionPolicy "$NEW_POLICY" '{executionPolicy:$executionPolicy}')"
api_patch_json "/issues/$MISSION_ID" "$MISSION_PATCH" "persist QSL-1 mission contract" >/dev/null

verify_health
PROD_PID_FINAL="$(production_pid)"
[[ "$PROD_PID_FINAL" == "$PROD_PID_BEFORE" ]] \
  || fail "production PID continuity failed: before=$PROD_PID_BEFORE final=$PROD_PID_FINAL"
VERIFY_MISSION="$(api_get "/issues/$MISSION_ID")"
[[ "$(jq -r '.status' <<<"$VERIFY_MISSION")" == "blocked" ]] || fail "mission unexpectedly left blocked state"
[[ "$(jq -r '.executionPolicy.missionContract.maxRepairRetries // empty' <<<"$VERIFY_MISSION")" == "1" ]] \
  || fail "mission retry contract did not persist"
[[ "$(jq -r '.executionPolicy.missionContract.acceptanceCriteria | length' <<<"$VERIFY_MISSION")" == "9" ]] \
  || fail "mission acceptance criteria did not persist"
VERIFY_DIRECTOR="$(api_get "/agents/$DIRECTOR_ID")"
[[ "$(jq -r '.adapterConfig.allowPaperclipApiAccess // false' <<<"$VERIFY_DIRECTOR")" == "true" ]] \
  || fail "Director Paperclip API access did not persist"
[[ "$(jq -r '.adapterConfig.cwd // empty' <<<"$VERIFY_DIRECTOR")" == "$REPO" ]] \
  || fail "Director canonical cwd did not persist"

echo
echo "QSL MISSION CONTROL V0.1 RELIABILITY UPGRADE PASS"
echo "Reliability branch: $WORK_BRANCH"
echo "Reliability HEAD: $RELIABILITY_HEAD"
echo "Structured acceptance criteria: 9/9"
echo "Mission repair retry cap: 1"
echo "Director canonical repo: $REPO (read-only mount under Director containment)"
echo "Director staging API coordination: enabled, loopback-only under containment"
echo "Sentinel + Selarix review stages: persisted"
echo "QSL-1 state: BLOCKED (intentionally not retried)"
echo "Production isolation: PASS (PID $PROD_PID_BEFORE)"
