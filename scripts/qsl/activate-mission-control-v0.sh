#!/usr/bin/env bash
set -euo pipefail

# QSL Mission Control V0 activation
#
# Purpose: activate the three persistent Mission Control members after the
# company, local governed skills, dedicated OPENROUTER_API_KEY secret, and
# human-approved budget already exist.
#
# This script is staging-only, idempotent, strips source-agent instruction
# bundle paths before cloning the proven Hermes lane, captures API error bodies,
# and refuses to report PASS if any member creation fails.

API_BASE="${PAPERCLIP_STAGING_API_BASE:-http://127.0.0.1:3101/api}"
SOURCE_COMPANY_ID="${QSL_SOURCE_COMPANY_ID:-f5609cfe-37ff-4061-a3c7-35ae55dbcc2b}"
SOURCE_HERMES_ID="${QSL_SOURCE_HERMES_ID:-65c8be90-be41-40c5-8232-1d8bfce01a15}"
COMPANY_ID="${QSL_MISSION_CONTROL_COMPANY_ID:-f32509d2-8cad-4754-baab-c87148c4c69a}"
AGENT_BUDGET_CENTS="${QSL_MISSION_CONTROL_AGENT_BUDGET_CENTS:-}"
TARGET_SECRET_NAME="OPENROUTER_API_KEY"
PROD_SERVICE="paperclip-thebinmap-prod.service"
STAGING_SERVICE="paperclip-thebinmap-staging.service"

fail() { echo "BLOCKED: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "missing command: $1"; }
need curl
need jq
need systemctl

[[ "$API_BASE" == "http://127.0.0.1:3101/api" || "$API_BASE" == "http://localhost:3101/api" ]] \
  || fail "refusing non-staging API base: $API_BASE"
[[ "$AGENT_BUDGET_CENTS" =~ ^[1-9][0-9]*$ ]] \
  || fail "set QSL_MISSION_CONTROL_AGENT_BUDGET_CENTS to the already-authorized positive integer"

api_get() { curl -fsS "$API_BASE$1"; }

api_post_json() {
  local path="$1" payload="$2" label="$3"
  local body_file status
  body_file="$(mktemp)"
  trap 'rm -f "$body_file"' RETURN

  status="$(curl -sS -o "$body_file" -w '%{http_code}' \
    -X POST "$API_BASE$path" \
    -H 'Content-Type: application/json' \
    --data-binary "$payload")" || fail "$label transport failure"

  if [[ "$status" != "200" && "$status" != "201" ]]; then
    echo "API ERROR: $label returned HTTP $status" >&2
    # Server error bodies are expected to contain validation text, not secrets.
    # Do not echo the submitted payload.
    cat "$body_file" >&2 || true
    echo >&2
    fail "$label was not created"
  fi

  cat "$body_file"
}

production_pid() {
  systemctl show "$PROD_SERVICE" --property=MainPID --value
}

verify_health() {
  [[ "$(systemctl is-active "$PROD_SERVICE")" == "active" ]] || fail "production service inactive"
  [[ "$(systemctl is-active "$STAGING_SERVICE")" == "active" ]] || fail "staging service inactive"
  curl -fsS http://127.0.0.1:3100/api/health >/dev/null || fail "production health failed"
  curl -fsS http://127.0.0.1:3101/api/health >/dev/null || fail "staging health failed"
}

verify_health
PROD_PID_BEFORE="$(production_pid)"
echo "Production baseline PID: $PROD_PID_BEFORE"

# Verify target company exists.
TARGET_COMPANY="$(api_get "/companies" | jq -c --arg id "$COMPANY_ID" '.[] | select(.id == $id)')"
[[ -n "$TARGET_COMPANY" ]] || fail "QSL Mission Control company not found: $COMPANY_ID"

# Verify the five governed company skills exist before any member activation.
SKILLS_JSON="$(api_get "/companies/$COMPANY_ID/skills")"
for slug in \
  qsl-mission-cell-doctrine \
  qsl-production-safety \
  qsl-evidence-provenance \
  qsl-capability-harvest \
  qsl-mission-cell-assembly; do
  jq -e --arg slug "$slug" '.[] | select(.slug == $slug)' <<<"$SKILLS_JSON" >/dev/null \
    || fail "required Mission Control skill missing: $slug"
done

# Verify dedicated company-scoped secret exists; never read its value.
SECRETS_JSON="$(api_get "/companies/$COMPANY_ID/secrets")"
TARGET_SECRET_ID="$(jq -r --arg name "$TARGET_SECRET_NAME" '[.[] | select(.name == $name)][0].id // empty' <<<"$SECRETS_JSON")"
[[ -n "$TARGET_SECRET_ID" ]] || fail "dedicated $TARGET_SECRET_NAME secret missing in QSL Mission Control"

# Clone only the proven non-secret Hermes/OpenClaw runtime shape.
SOURCE_CONFIGS="$(api_get "/companies/$SOURCE_COMPANY_ID/agent-configurations")"
SOURCE="$(jq -c --arg id "$SOURCE_HERMES_ID" '.[] | select(.id == $id)' <<<"$SOURCE_CONFIGS")"
[[ -n "$SOURCE" ]] || fail "proven Hermes source configuration not found"

ADAPTER_TYPE="$(jq -r '.adapterType' <<<"$SOURCE")"
[[ "$ADAPTER_TYPE" == "hermes_local" ]] || fail "source adapter is not hermes_local"

# Critical isolation repair:
# Do NOT clone the source agent's managed instruction paths. Those paths belong
# to the TheBinMap company/agent. Paperclip's own create-agent skill says local
# managed-bundle hires should provide promptTemplate and let Paperclip
# materialize a fresh bundle for the new member.
BASE_ADAPTER_CONFIG="$(jq -c --arg sid "$TARGET_SECRET_ID" '
  .adapterConfig
  | del(
      .instructionsFilePath,
      .instructionsRootPath,
      .instructionsEntryFile,
      .instructionsBundleMode,
      .agentsMdPath,
      .promptTemplate
    )
  | .env = (.env // {})
  | .env.OPENROUTER_API_KEY = {type:"secret_ref",secretId:$sid,version:"latest"}
' <<<"$SOURCE")"

# Refuse any leftover foreign secret reference.
FOREIGN_SECRET_IDS="$(jq -r --arg sid "$TARGET_SECRET_ID" '[.. | objects | select(.type? == "secret_ref") | .secretId | select(. != $sid)] | unique | .[]?' <<<"$BASE_ADAPTER_CONFIG")"
[[ -z "$FOREIGN_SECRET_IDS" ]] || fail "foreign secret_ref remains in cloned adapter config"

RUNTIME_CONFIG="$(jq -c '
  .runtimeConfig
  | .heartbeat = ((.heartbeat // {}) + {enabled:false,wakeOnDemand:true})
' <<<"$SOURCE")"

agent_id_by_name() {
  local name="$1"
  api_get "/companies/$COMPANY_ID/agents" | jq -r --arg name "$name" '[.[] | select(.name == $name)][0].id // empty'
}

create_member() {
  local name="$1" role="$2" title="$3" icon="$4" reports_to="$5" can_create="$6" capabilities="$7" prompt="$8" skills_json="$9"
  local existing cfg payload created id

  existing="$(agent_id_by_name "$name")"
  if [[ -n "$existing" ]]; then
    echo "Reusing $name: $existing" >&2
    printf '%s\n' "$existing"
    return 0
  fi

  cfg="$(jq -c --arg prompt "$prompt" '. + {promptTemplate:$prompt}' <<<"$BASE_ADAPTER_CONFIG")"
  payload="$(jq -n \
    --arg name "$name" \
    --arg role "$role" \
    --arg title "$title" \
    --arg icon "$icon" \
    --arg reportsTo "$reports_to" \
    --arg capabilities "$capabilities" \
    --arg adapterType "$ADAPTER_TYPE" \
    --argjson adapterConfig "$cfg" \
    --argjson runtimeConfig "$RUNTIME_CONFIG" \
    --argjson canCreateAgents "$can_create" \
    --argjson budgetMonthlyCents "$AGENT_BUDGET_CENTS" \
    --argjson desiredSkills "$skills_json" \
    '{
      name:$name,
      role:$role,
      title:$title,
      icon:$icon,
      reportsTo:(if $reportsTo == "" then null else $reportsTo end),
      capabilities:$capabilities,
      desiredSkills:$desiredSkills,
      adapterType:$adapterType,
      adapterConfig:$adapterConfig,
      runtimeConfig:$runtimeConfig,
      budgetMonthlyCents:$budgetMonthlyCents,
      permissions:{canCreateAgents:$canCreateAgents},
      metadata:{qslObjectType:"mission_control_member",persistent:true,terminology:"Mission Cell"}
    }')"

  created="$(api_post_json "/companies/$COMPANY_ID/agents" "$payload" "$name")"
  id="$(jq -r '.id // empty' <<<"$created")"
  [[ -n "$id" ]] || fail "$name response lacked an id"
  echo "Created $name: $id" >&2
  printf '%s\n' "$id"
}

DIRECTOR_PROMPT=$(cat <<'EOF'
You are the QSL Mission Control Director, the persistent control-plane lead for governed Mission Cells.

Operating contract: one bounded mission in; verified result or one meaningful escalation out.

For each mission: create a Mission Charter, classify L0-L4 authority, select the minimum useful governed capabilities, assemble temporary Mission Cell members only when needed, delegate with child issues, and require independent safety/evidence checks before completion.

You may create and assign L0/L1 workers inside QSL Mission Control. Never authorize production, secrets changes, new egress, destructive actions, external publication/communications, or material spend. Those remain human authority.

Default governed execution lane is OpenRouter / openrouter/deepseek/deepseek-chat. No silent model substitution.

Do not poll Michael or turn him into the message bus. Start actionable authorized work in the same wake. Return a verified result or one meaningful escalation.
EOF
)

SENTINEL_PROMPT=$(cat <<'EOF'
You are Sentinel Governor for QSL Mission Control.

Act as an independent safety and authority reviewer. Enforce production isolation, exact-service process safety, secret boundaries, provider/model/cost policy, egress limits, destructive-action gates, and QSL L0-L4 authority.

Production is human-authorized. Broad process termination is prohibited. Never weaken a control to make a mission pass. Do not implement the change you review.

Return PASS with evidence, or BLOCK with the violated rule and smallest safe next action.
EOF
)

RECORDER_PROMPT=$(cat <<'EOF'
You are Selarix Recorder for QSL Mission Control.

Own durable evidence and institutional memory. Bind mission -> issue -> primary execution run -> change -> verification -> review -> receipt -> terminal state.

Never infer missing identifiers and never certify completed when required lineage is absent. Produce concise Executive Packets for meaningful human decisions and capability-harvest records after missions.
EOF
)

DIRECTOR_ID="$(create_member \
  "Mission Control Director" "ceo" "Mission Control Director" "crown" "" true \
  "Mission intake, charters, authority classification, governed capability selection, temporary Mission Cell assembly, delegation, bounded execution oversight, capability harvest." \
  "$DIRECTOR_PROMPT" \
  '["qsl-mission-cell-doctrine","qsl-production-safety","qsl-evidence-provenance","qsl-capability-harvest","qsl-mission-cell-assembly"]')"

# A failed Director creation terminates the script before any dependent member
# is attempted. This prevents the previous false-PASS/blank-reporting state.
[[ -n "$DIRECTOR_ID" ]] || fail "Director activation failed"

SENTINEL_ID="$(create_member \
  "Sentinel Governor" "security" "Sentinel Governor" "shield" "$DIRECTOR_ID" false \
  "Independent production isolation, process safety, secrets, provider/model/cost, egress and authority review; may block unsafe work." \
  "$SENTINEL_PROMPT" \
  '["qsl-production-safety","qsl-evidence-provenance"]')"

RECORDER_ID="$(create_member \
  "Selarix Recorder" "researcher" "Selarix Evidence Recorder" "database" "$DIRECTOR_ID" false \
  "Durable mission provenance, receipts, reconciliation, Executive Packets, decision memory, capability harvest." \
  "$RECORDER_PROMPT" \
  '["qsl-evidence-provenance","qsl-capability-harvest","qsl-mission-cell-doctrine"]')"

[[ -n "$SENTINEL_ID" && -n "$RECORDER_ID" ]] || fail "persistent control plane incomplete"

# Verify org state from Paperclip, not local assumptions.
ORG_JSON="$(api_get "/companies/$COMPANY_ID/org")"
for id in "$DIRECTOR_ID" "$SENTINEL_ID" "$RECORDER_ID"; do
  jq -e --arg id "$id" '.. | objects | select(.id? == $id)' <<<"$ORG_JSON" >/dev/null \
    || fail "org verification missing member: $id"
done

verify_health
PROD_PID_AFTER="$(production_pid)"
[[ "$PROD_PID_AFTER" == "$PROD_PID_BEFORE" ]] \
  || fail "production PID changed: before=$PROD_PID_BEFORE after=$PROD_PID_AFTER"

echo
echo "QSL MISSION CONTROL V0 ACTIVATION PASS"
echo "Company ID: $COMPANY_ID"
echo "Mission Control Director: $DIRECTOR_ID"
echo "Sentinel Governor: $SENTINEL_ID"
echo "Selarix Recorder: $RECORDER_ID"
echo "Per-member monthly budget: $AGENT_BUDGET_CENTS cents"
echo "Production isolation: PASS (PID $PROD_PID_BEFORE)"
