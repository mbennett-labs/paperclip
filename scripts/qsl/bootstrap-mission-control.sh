#!/usr/bin/env bash
set -euo pipefail

# QSL Mission Control bootstrap
# Staging-only. Idempotent. Does not touch production except read-only health/PID checks.

API_BASE="${PAPERCLIP_STAGING_API_BASE:-http://127.0.0.1:3101/api}"
SOURCE_COMPANY_ID="${QSL_SOURCE_COMPANY_ID:-f5609cfe-37ff-4061-a3c7-35ae55dbcc2b}"
SOURCE_HERMES_ID="${QSL_SOURCE_HERMES_ID:-65c8be90-be41-40c5-8232-1d8bfce01a15}"
COMPANY_NAME="QSL Mission Control"
PROD_SERVICE="paperclip-thebinmap-prod.service"
STAGING_SERVICE="paperclip-thebinmap-staging.service"

fail() { echo "BLOCKED: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"; }
need curl
need jq
need systemctl

[[ "$API_BASE" == "http://127.0.0.1:3101/api" || "$API_BASE" == "http://localhost:3101/api" ]] \
  || fail "refusing non-staging API base: $API_BASE"

api_get() {
  curl -fsS "$API_BASE$1"
}

api_post() {
  local path="$1" payload="$2"
  curl -fsS -X POST "$API_BASE$path" -H 'Content-Type: application/json' --data-binary "$payload"
}

api_patch() {
  local path="$1" payload="$2"
  curl -fsS -X PATCH "$API_BASE$path" -H 'Content-Type: application/json' --data-binary "$payload"
}

production_pid() {
  systemctl show "$PROD_SERVICE" --property=MainPID --value
}

staging_pid() {
  systemctl show "$STAGING_SERVICE" --property=MainPID --value
}

echo "== QSL Mission Control bootstrap =="

[[ "$(systemctl is-active "$PROD_SERVICE")" == "active" ]] || fail "production service is not active"
[[ "$(systemctl is-active "$STAGING_SERVICE")" == "active" ]] || fail "staging service is not active"

PROD_PID_BEFORE="$(production_pid)"
STAGING_PID_BEFORE="$(staging_pid)"
curl -fsS http://127.0.0.1:3100/api/health >/dev/null || fail "production health failed before bootstrap"
curl -fsS http://127.0.0.1:3101/api/health >/dev/null || fail "staging health failed before bootstrap"

echo "Production baseline PID: $PROD_PID_BEFORE"
echo "Staging PID: $STAGING_PID_BEFORE"

# Clone the already-proven Hermes/OpenClaw staging lane instead of inventing a new adapter config.
SOURCE_CONFIGS="$(api_get "/companies/$SOURCE_COMPANY_ID/agent-configurations")"
SOURCE="$(jq -c --arg id "$SOURCE_HERMES_ID" '.[] | select(.id == $id)' <<<"$SOURCE_CONFIGS")"
[[ -n "$SOURCE" ]] || fail "proven Hermes source configuration not found"

ADAPTER_TYPE="$(jq -r '.adapterType' <<<"$SOURCE")"
[[ "$ADAPTER_TYPE" == "hermes_local" ]] || fail "expected hermes_local source adapter, got: $ADAPTER_TYPE"

ADAPTER_CONFIG="$(jq -c '.adapterConfig' <<<"$SOURCE")"
RUNTIME_CONFIG="$(jq -c '.runtimeConfig' <<<"$SOURCE")"

# Never manufacture or substitute credentials. If the safe config endpoint redacted a required value,
# stop and let a human resolve the secret reference rather than creating a broken or less-safe lane.
if grep -Eq 'REDACTED|<redacted>|"\*\*\*"' <<<"$ADAPTER_CONFIG"; then
  fail "source adapter config contains redacted values; credential references must be resolved before bootstrap"
fi

# New control-plane members are wake-on-demand by default; no timer heartbeat.
RUNTIME_CONFIG="$(jq -c '.heartbeat = ((.heartbeat // {}) + {enabled:false,wakeOnDemand:true})' <<<"$RUNTIME_CONFIG")"

COMPANIES="$(api_get "/companies")"
COMPANY_ID="$(jq -r --arg name "$COMPANY_NAME" '[.[] | select(.name == $name)][0].id // empty' <<<"$COMPANIES")"

if [[ -z "$COMPANY_ID" ]]; then
  COMPANY_PAYLOAD="$(jq -n --arg name "$COMPANY_NAME" '{
    name:$name,
    description:"Internal QSL control plane that assembles governed temporary Mission Cells. One bounded mission in; verified result or one meaningful escalation out.",
    budgetMonthlyCents:0
  }')"
  COMPANY="$(api_post "/companies" "$COMPANY_PAYLOAD")"
  COMPANY_ID="$(jq -r '.id' <<<"$COMPANY")"
  echo "Created company: $COMPANY_ID"
else
  echo "Reusing company: $COMPANY_ID"
fi

# Mission Control is intentionally allowed to assemble temporary Mission Cells without forcing Michael
# to approve ordinary L0/L1 staffing. Authority limits remain in the charter/instructions and production
# stays human-authorized.
api_patch "/companies/$COMPANY_ID" '{"requireBoardApprovalForNewAgents":false}' >/dev/null

create_skill_if_missing() {
  local slug="$1" name="$2" description="$3" markdown="$4"
  local existing
  existing="$(api_get "/companies/$COMPANY_ID/skills" | jq -r --arg slug "$slug" '[.[] | select(.slug == $slug)][0].id // empty')"
  if [[ -n "$existing" ]]; then
    echo "Skill exists: $slug"
    return 0
  fi
  local payload
  payload="$(jq -n --arg name "$name" --arg slug "$slug" --arg description "$description" --arg markdown "$markdown" \
    '{name:$name,slug:$slug,description:$description,markdown:$markdown}')"
  api_post "/companies/$COMPANY_ID/skills" "$payload" >/dev/null
  echo "Created skill: $slug"
}

MISSION_CELL_DOCTRINE=$(cat <<'EOF'
# QSL Mission Cell Doctrine

A Mission Cell is a temporary, bounded organizational unit assembled for a specific mission from designated skills, tools, models, evidence sources, permissions, budgets, approval gates, and retirement conditions.

Paperclip may call runtime members agents; QSL-facing language uses Mission Cell.

Lifecycle: receive mission -> charter -> classify authority -> select capabilities -> assemble -> execute -> independently verify -> persist evidence -> capability harvest -> retire temporary members.

Temporary Mission Cells should die. Valuable capabilities should not.
EOF
)

PRODUCTION_SAFETY=$(cat <<'EOF'
# QSL Production and Process Safety

Production is L3 human authority. No Mission Cell may restart, deploy, mutate config, mutate DB, change secrets, add egress, or perform destructive production work without explicit human approval.

Before staging work capture live production service state, PID, port, and health. After the mission require the same PID and healthy service/port. PID is evidence, not permanent identity.

Prohibited: pkill -f paperclip; pkill -f tsx; pkill node; killall node; equivalent broad process termination.

Staging service actions must target the exact canonical staging systemd unit.
EOF
)

EVIDENCE_PROVENANCE=$(cat <<'EOF'
# QSL Evidence and Provenance

Execution success is not mission success until required provenance is persisted.

Bind mission -> Paperclip issue -> primary execution run -> change -> verification -> review -> receipt -> terminal state.

Do not mark completed with missing lineage. Evidence failure blocks or escalates.

Observe the value before repairing the value. Never invent identifiers, receipts, statuses, or evidence.
EOF
)

CAPABILITY_HARVEST=$(cat <<'EOF'
# QSL Capability Harvest

Use the Selarix Toolshed and Paperclip company skill library as the governed capability inventory.

Owned/forked repositories are candidate capability sources, not automatically trusted executable code. Select the minimum capability set that materially improves mission speed, completion probability, or evidence quality.

Trust progression: markdown/reference -> assets -> scripts/executables only after review.

After each mission record reusable skills, evidence of successful use, limitations, trust level, and whether a temporary Mission Cell should be retired.
EOF
)

create_skill_if_missing "qsl-mission-cell-doctrine" "QSL Mission Cell Doctrine" "Canonical bounded Mission Cell lifecycle and terminology." "$MISSION_CELL_DOCTRINE"
create_skill_if_missing "qsl-production-safety" "QSL Production Safety" "Production isolation, process safety, and human authority gates." "$PRODUCTION_SAFETY"
create_skill_if_missing "qsl-evidence-provenance" "QSL Evidence Provenance" "Mission-to-run evidence chain and fail-closed completion standard." "$EVIDENCE_PROVENANCE"
create_skill_if_missing "qsl-capability-harvest" "QSL Capability Harvest" "Governed Toolshed selection, trust progression, and post-mission harvesting." "$CAPABILITY_HARVEST"

agent_id_by_name() {
  local name="$1"
  api_get "/companies/$COMPANY_ID/agents" | jq -r --arg name "$name" '[.[] | select(.name == $name)][0].id // empty'
}

create_member() {
  local name="$1" role="$2" title="$3" icon="$4" reports_to="$5" can_create="$6" capabilities="$7" prompt="$8"
  local existing
  existing="$(agent_id_by_name "$name")"
  if [[ -n "$existing" ]]; then
    echo "$existing"
    return 0
  fi

  local cfg payload
  cfg="$(jq -c --arg prompt "$prompt" '. + {promptTemplate:$prompt}' <<<"$ADAPTER_CONFIG")"
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
    '{
      name:$name,
      role:$role,
      title:$title,
      icon:$icon,
      reportsTo:(if $reportsTo == "" then null else $reportsTo end),
      capabilities:$capabilities,
      adapterType:$adapterType,
      adapterConfig:$adapterConfig,
      runtimeConfig:$runtimeConfig,
      budgetMonthlyCents:0,
      permissions:{canCreateAgents:$canCreateAgents},
      metadata:{qslObjectType:"mission_control_member",persistent:true,terminology:"Mission Cell"}
    }')"

  local created
  created="$(api_post "/companies/$COMPANY_ID/agents" "$payload")"
  jq -r '.id' <<<"$created"
}

DIRECTOR_PROMPT=$(cat <<'EOF'
You are the QSL Mission Control Director, the persistent control-plane lead for governed Mission Cells.

Operating contract: one bounded mission in; verified result or one meaningful escalation out.

Use Paperclip company skills and the Selarix Toolshed. Treat owned/forked repositories as candidate capability sources, not ambient executable authority. For each mission, create a Mission Charter, classify L0-L4 authority, select the minimum useful capabilities, and assemble temporary Mission Cell members only when needed.

You may create workers and assign tasks inside this company for L0/L1 work. Temporary workers should be retired after the mission unless repeated evidence justifies persistence.

Never authorize production, secrets, new egress, destructive actions, external publication/communications, or material spend. Escalate those to the human board.

Default execution provider/model for the proven Hermes lane is OpenRouter / openrouter/deepseek/deepseek-chat. No silent model substitution.

Use child issues for parallel delegated work. Do not poll humans. Do not stop at a plan when actionable work is authorized. Require Sentinel safety checks and Selarix evidence/provenance before consequential completion.
EOF
)

SENTINEL_PROMPT=$(cat <<'EOF'
You are Sentinel Governor for QSL Mission Control.

You are an independent safety and authority reviewer. You may block unsafe work. You do not implement the change you review.

Enforce production isolation, exact-service process safety, secret boundaries, provider/model/cost rules, egress limits, destructive-action gates, and QSL L0-L4 authority.

Production is human-authorized. Broad process termination is prohibited. Never weaken a control to make a mission pass.

Return PASS with evidence, or BLOCK with the exact violated rule and smallest safe next action.
EOF
)

RECORDER_PROMPT=$(cat <<'EOF'
You are Selarix Recorder for QSL Mission Control.

Your job is durable evidence and institutional memory, not implementation authority.

Persist and reconcile mission -> issue -> primary run -> change -> verification -> review -> receipt -> terminal state. Never infer missing identifiers. Never certify completed when required lineage is absent.

Produce concise Executive Packets for meaningful human decisions and capability-harvest records after missions. Preserve reusable capability knowledge; temporary Mission Cells may be retired.
EOF
)

DIRECTOR_ID="$(create_member \
  "Mission Control Director" "ceo" "Mission Control Director" "crown" "" true \
  "Mission intake, charters, authority classification, Toolshed capability selection, temporary Mission Cell assembly, task delegation, bounded execution oversight, capability harvest." \
  "$DIRECTOR_PROMPT")"

echo "Director: $DIRECTOR_ID"

SENTINEL_ID="$(create_member \
  "Sentinel Governor" "security" "Sentinel Governor" "shield" "$DIRECTOR_ID" false \
  "Independent production isolation, process safety, secrets, provider/model/cost, egress and authority review; can block unsafe work." \
  "$SENTINEL_PROMPT")"

echo "Sentinel: $SENTINEL_ID"

RECORDER_ID="$(create_member \
  "Selarix Recorder" "researcher" "Selarix Evidence Recorder" "database" "$DIRECTOR_ID" false \
  "Durable mission provenance, receipts, evidence reconciliation, Executive Packets, decision memory, capability harvest." \
  "$RECORDER_PROMPT")"

echo "Recorder: $RECORDER_ID"

# Verify both services remained healthy and production identity did not change.
PROD_PID_AFTER="$(production_pid)"
curl -fsS http://127.0.0.1:3100/api/health >/dev/null || fail "production health failed after bootstrap"
curl -fsS http://127.0.0.1:3101/api/health >/dev/null || fail "staging health failed after bootstrap"
[[ "$PROD_PID_AFTER" == "$PROD_PID_BEFORE" ]] || fail "production PID changed: before=$PROD_PID_BEFORE after=$PROD_PID_AFTER"

echo
echo "QSL Mission Control bootstrap PASS"
echo "Company ID: $COMPANY_ID"
echo "Mission Control Director: $DIRECTOR_ID"
echo "Sentinel Governor: $SENTINEL_ID"
echo "Selarix Recorder: $RECORDER_ID"
echo "Production isolation: PASS (PID $PROD_PID_BEFORE)"
echo
echo "Next mission: finish Operator Loop V0.1 using a temporary Staging Engineer + independent Verifier Mission Cell."
