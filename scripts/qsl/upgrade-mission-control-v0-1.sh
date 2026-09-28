#!/usr/bin/env bash
set -euo pipefail

# QSL Mission Control V0.1 reliability upgrade
#
# One bounded, staging-only operation. This script:
# - branches from the CURRENT staging HEAD (preserving local QSL/Hermes history)
# - patches the runtime execution contract fail-closed
# - adds tests and a resource manifest
# - runs targeted tests, full typecheck and build
# - commits the reliability slice
# - restarts ONLY the exact staging systemd unit
# - verifies production PID/health continuity
# - upgrades the Mission Control Director and QSL-1 structured mission contract
#
# It does NOT unblock/retry QSL-1, touch production, print secrets, create new
# external egress, or create temporary paid Mission Cell members.

REPO="${QSL_STAGING_REPO:-/opt/paperclip-deployments/thebinmap-email-ops-staging}"
BASE_BRANCH="feat/qsl-current-upstream-integration"
WORK_BRANCH="feat/qsl-mission-control-v0-1-reliability"
API_BASE="${PAPERCLIP_STAGING_API_BASE:-http://127.0.0.1:3101/api}"
COMPANY_ID="${QSL_MISSION_CONTROL_COMPANY_ID:-f32509d2-8cad-4754-baab-c87148c4c69a}"
DIRECTOR_ID="${QSL_MISSION_CONTROL_DIRECTOR_ID:-0db9b4e5-531b-4fe6-9e02-a28ccbe0b9f3}"
SENTINEL_ID="${QSL_SENTINEL_GOVERNOR_ID:-413d0fce-52af-4764-bef5-6038ff1cd864}"
RECORDER_ID="${QSL_SELARIX_RECORDER_ID:-038946e0-f4bb-47e1-82b7-8818f7ab5f9f}"
MISSION_IDENTIFIER="${QSL_MISSION_IDENTIFIER:-QSL-1}"
PROD_SERVICE="paperclip-thebinmap-prod.service"
STAGING_SERVICE="paperclip-thebinmap-staging.service"

fail() { echo "BLOCKED: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "missing command: $1"; }
for cmd in git python3 pnpm curl jq systemctl; do need "$cmd"; done

[[ "$API_BASE" == "http://127.0.0.1:3101/api" || "$API_BASE" == "http://localhost:3101/api" ]] \
  || fail "refusing non-staging API base: $API_BASE"
[[ -d "$REPO/.git" ]] || fail "staging repo not found: $REPO"
cd "$REPO"

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
BASE_HEAD="$(git rev-parse HEAD)"
CURRENT_BRANCH="$(git branch --show-current)"
TRACKED_DIRTY="$(git status --porcelain --untracked-files=no)"
[[ -z "$TRACKED_DIRTY" ]] || fail "tracked staging worktree is dirty; refusing to patch"
[[ "$CURRENT_BRANCH" == "$BASE_BRANCH" || "$CURRENT_BRANCH" == "$WORK_BRANCH" ]] \
  || fail "unexpected staging branch: $CURRENT_BRANCH"

echo "Production baseline PID: $PROD_PID_BEFORE"
echo "Staging source HEAD: $BASE_HEAD"
echo "Staging source branch: $CURRENT_BRANCH"

if [[ "$CURRENT_BRANCH" != "$WORK_BRANCH" ]]; then
  if git show-ref --verify --quiet "refs/heads/$WORK_BRANCH"; then
    fail "local reliability branch already exists while staging is on $CURRENT_BRANCH; inspect before reuse"
  fi
  git switch -c "$WORK_BRANCH"
fi

python3 <<'PY'
from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    if new in text:
        return
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"BLOCKED: {path}: expected exactly one patch anchor, found {count}")
    p.write_text(text.replace(old, new, 1))

# 1) Structured mission contract validator.
path = "packages/shared/src/validators/issue.ts"
old = '''export const issueExecutionPolicySchema = z.object({
  mode: z.enum(ISSUE_EXECUTION_POLICY_MODES).optional().default("normal"),
  commentRequired: z.boolean().optional().default(true),
  stages: z.array(issueExecutionStageSchema).default([]),
  monitor: issueExecutionMonitorPolicySchema.optional().nullable(),
  reviewPreset: lowTrustReviewPresetPolicySchema.optional(),
  authorizationPolicy: trustAuthorizationPolicySchema.optional(),
});'''
new = '''export const issueMissionAcceptanceCriterionSchema = z.object({
  id: z.string().trim().min(1).max(64),
  text: z.string().trim().min(1).max(5000),
}).strict();

export const issueMissionContractSchema = z.object({
  version: z.literal(1).optional().default(1),
  objective: z.string().trim().min(1).max(20000),
  authorityLevel: z.enum(["L0", "L1", "L2", "L3", "L4"]),
  acceptanceCriteria: z.array(issueMissionAcceptanceCriterionSchema).min(1).max(20),
  maxRepairRetries: z.number().int().positive().max(10),
  requiredStages: z.array(z.enum([
    "implementation",
    "verification",
    "sentinel_review",
    "provenance_receipt",
  ])).min(1).max(10),
  provider: z.string().trim().min(1).max(120),
  model: z.string().trim().min(1).max(240),
  productionIsolationRequired: z.boolean(),
}).strict();

export const issueExecutionPolicySchema = z.object({
  mode: z.enum(ISSUE_EXECUTION_POLICY_MODES).optional().default("normal"),
  commentRequired: z.boolean().optional().default(true),
  stages: z.array(issueExecutionStageSchema).default([]),
  monitor: issueExecutionMonitorPolicySchema.optional().nullable(),
  reviewPreset: lowTrustReviewPresetPolicySchema.optional(),
  authorizationPolicy: trustAuthorizationPolicySchema.optional(),
  missionContract: issueMissionContractSchema.optional(),
});'''
replace_once(path, old, new)

# 2) Shared type surface.
path = "packages/shared/src/types/issue.ts"
old = '''export interface IssueExecutionPolicy {
  mode: IssueExecutionPolicyMode;
  commentRequired: boolean;
  stages: IssueExecutionStage[];
  monitor?: IssueExecutionMonitorPolicy | null;
  reviewPreset?: LowTrustReviewPresetPolicy;
  authorizationPolicy?: TrustAuthorizationPolicy;
}'''
new = '''export interface IssueMissionAcceptanceCriterion {
  id: string;
  text: string;
}

export type IssueMissionAuthorityLevel = "L0" | "L1" | "L2" | "L3" | "L4";
export type IssueMissionRequiredStage =
  | "implementation"
  | "verification"
  | "sentinel_review"
  | "provenance_receipt";

export interface IssueMissionContract {
  version: 1;
  objective: string;
  authorityLevel: IssueMissionAuthorityLevel;
  acceptanceCriteria: IssueMissionAcceptanceCriterion[];
  maxRepairRetries: number;
  requiredStages: IssueMissionRequiredStage[];
  provider: string;
  model: string;
  productionIsolationRequired: boolean;
}

export interface IssueExecutionPolicy {
  mode: IssueExecutionPolicyMode;
  commentRequired: boolean;
  stages: IssueExecutionStage[];
  monitor?: IssueExecutionMonitorPolicy | null;
  reviewPreset?: LowTrustReviewPresetPolicy;
  authorizationPolicy?: TrustAuthorizationPolicy;
  missionContract?: IssueMissionContract;
}'''
replace_once(path, old, new)

# 3) Preserve missionContract through execution-policy normalization and monitor stripping.
path = "server/src/services/issue-execution-policy.ts"
old = '''export function stripMonitorFromExecutionPolicy(policy: IssueExecutionPolicy | null): IssueExecutionPolicy | null {
  if (!policy) return null;
  if (!policy.monitor) return policy;
  if (policy.stages.length === 0) return null;
  return {
    mode: policy.mode,
    commentRequired: policy.commentRequired,
    stages: policy.stages,
  };
}'''
new = '''export function stripMonitorFromExecutionPolicy(policy: IssueExecutionPolicy | null): IssueExecutionPolicy | null {
  if (!policy) return null;
  if (!policy.monitor) return policy;
  const hasNonMonitorPolicy = policy.stages.length > 0 || Boolean(policy.reviewPreset) ||
    Boolean(policy.authorizationPolicy) || Boolean(policy.missionContract);
  if (!hasNonMonitorPolicy) return null;
  return {
    mode: policy.mode,
    commentRequired: policy.commentRequired,
    stages: policy.stages,
    ...(policy.reviewPreset ? { reviewPreset: policy.reviewPreset } : {}),
    ...(policy.authorizationPolicy ? { authorizationPolicy: policy.authorizationPolicy } : {}),
    ...(policy.missionContract ? { missionContract: policy.missionContract } : {}),
  };
}'''
replace_once(path, old, new)

old = '''  const reviewPreset = parsed.data.reviewPreset;
  const authorizationPolicy = parsed.data.authorizationPolicy;

  if (stages.length === 0 && !monitor && !reviewPreset && !authorizationPolicy) return null;

  return {
    mode: parsed.data.mode ?? "normal",
    commentRequired: true,
    stages,
    ...(monitor ? { monitor } : {}),
    ...(reviewPreset ? { reviewPreset } : {}),
    ...(authorizationPolicy ? { authorizationPolicy } : {}),
  };'''
new = '''  const reviewPreset = parsed.data.reviewPreset;
  const authorizationPolicy = parsed.data.authorizationPolicy;
  const missionContract = parsed.data.missionContract;

  if (stages.length === 0 && !monitor && !reviewPreset && !authorizationPolicy && !missionContract) return null;

  return {
    mode: parsed.data.mode ?? "normal",
    commentRequired: true,
    stages,
    ...(monitor ? { monitor } : {}),
    ...(reviewPreset ? { reviewPreset } : {}),
    ...(authorizationPolicy ? { authorizationPolicy } : {}),
    ...(missionContract ? { missionContract } : {}),
  };'''
replace_once(path, old, new)

# 4) Mission retry cap may tighten, never loosen, Paperclip recovery defaults.
path = "server/src/services/recovery/service.ts"
p = Path(path)
text = p.read_text()
helper_marker = "export function effectiveContinuationRetryMaxAttempts("
if helper_marker not in text:
    anchor = '''export function classifyContinuationFailure(latestRun: LatestIssueRun): ContinuationRetryClassification {'''
    idx = text.find(anchor)
    if idx < 0:
        raise SystemExit(f"BLOCKED: {path}: classifyContinuationFailure anchor not found")
    # Insert the pure helper immediately before classifier; parseObject is already used in this module.
    helper = '''export function effectiveContinuationRetryMaxAttempts(
  platformMaxAttempts: number,
  executionPolicy: unknown,
): number {
  const policy = parseObject(executionPolicy);
  const missionContract = parseObject(policy.missionContract);
  const configured = missionContract.maxRepairRetries;
  if (typeof configured !== "number" || !Number.isInteger(configured) || configured < 1) {
    return platformMaxAttempts;
  }
  return Math.min(platformMaxAttempts, configured);
}

'''
    text = text[:idx] + helper + text[idx:]
    p.write_text(text)

old = '''          if (consecutive >= classification.maxAttempts) {
            const failureSummary = summarizeRunFailureForIssueComment(latestRun);'''
new = '''          const effectiveMaxAttempts = effectiveContinuationRetryMaxAttempts(
            classification.maxAttempts,
            issue.executionPolicy,
          );
          if (consecutive >= effectiveMaxAttempts) {
            const failureSummary = summarizeRunFailureForIssueComment(latestRun);'''
replace_once(path, old, new)

old = '''            const causeCopy = classification.errorCode
              ? ` Latest cause: \\`${classification.errorCode}\\`.`
              : "";
            const updated = await escalateStrandedAssignedIssue({'''
new = '''            const causeCopy = classification.errorCode
              ? ` Latest cause: \\`${classification.errorCode}\\`.`
              : "";
            const missionRetryCopy = effectiveMaxAttempts < classification.maxAttempts
              ? ` Mission contract retry cap: ${effectiveMaxAttempts}.`
              : "";
            const updated = await escalateStrandedAssignedIssue({'''
replace_once(path, old, new)

old = '''                `execution disappeared, but it still has no live execution path${attemptCopy}.${causeCopy}${failureSummary ?? ""} ` +
                "Moving it to `blocked` so it is visible for intervention.",'''
new = '''                `execution disappeared, but it still has no live execution path${attemptCopy}.${causeCopy}${missionRetryCopy}${failureSummary ?? ""} ` +
                "Moving it to `blocked` so it is visible for intervention.",'''
replace_once(path, old, new)

# 5) Exact loopback-only Paperclip API network target for contained Hermes.
path = "packages/adapters/hermes/src/server/execute.ts"
p = Path(path)
text = p.read_text()
helper_marker = "export function resolveContainedPaperclipApiAllowlistTarget("
if helper_marker not in text:
    anchor = '''// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------'''
    idx = text.find(anchor)
    if idx < 0:
        raise SystemExit(f"BLOCKED: {path}: output-parsing anchor not found")
    helper = '''export function resolveContainedPaperclipApiAllowlistTarget(apiUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(apiUrl);
  } catch {
    throw new Error("Contained Paperclip API URL must be a valid loopback HTTP URL.");
  }
  const hostname = parsed.hostname.toLowerCase();
  if (parsed.protocol !== "http:" || (hostname !== "127.0.0.1" && hostname !== "localhost")) {
    throw new Error("Contained Paperclip API access is restricted to loopback HTTP staging endpoints.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Contained Paperclip API URL must not contain credentials.");
  }
  const port = parsed.port || "80";
  return `${hostname}:${port}`;
}

'''
    text = text[:idx] + helper + text[idx:]
    p.write_text(text)

old = '''    if (providerPreset === "openrouter") {
      networkScope = "allowlist";
      networkAllowlist = ["openrouter.ai:443"];
    }

    await fs.mkdir(sandboxWorkspaceDir, { recursive: true });'''
new = '''    if (providerPreset === "openrouter") {
      networkScope = "allowlist";
      networkAllowlist = ["openrouter.ai:443"];
    }
    if (allowApiAccess) {
      const configuredPaperclipApiUrl =
        cfgString(config.paperclipApiUrl) ||
        process.env.PAPERCLIP_API_URL ||
        "http://127.0.0.1:3100/api";
      const paperclipApiTarget = resolveContainedPaperclipApiAllowlistTarget(configuredPaperclipApiUrl);
      networkScope = "allowlist";
      if (!networkAllowlist.includes(paperclipApiTarget)) networkAllowlist.push(paperclipApiTarget);
    }

    await fs.mkdir(sandboxWorkspaceDir, { recursive: true });'''
replace_once(path, old, new)
PY

# Add focused tests without disturbing existing large suites.
cat > server/src/__tests__/qsl-mission-contract-retry.test.ts <<'EOF'
import { describe, expect, it } from "vitest";
import { effectiveContinuationRetryMaxAttempts } from "../services/recovery/service.js";

describe("QSL mission contract continuation retry cap", () => {
  it("uses the platform limit when no mission contract exists", () => {
    expect(effectiveContinuationRetryMaxAttempts(3, null)).toBe(3);
  });

  it("allows a mission contract to tighten the platform retry limit", () => {
    expect(effectiveContinuationRetryMaxAttempts(3, {
      missionContract: { maxRepairRetries: 1 },
    })).toBe(1);
  });

  it("never lets a mission contract loosen the platform retry limit", () => {
    expect(effectiveContinuationRetryMaxAttempts(1, {
      missionContract: { maxRepairRetries: 9 },
    })).toBe(1);
  });
});
EOF

cat > packages/adapters/hermes/src/server/qsl-paperclip-api-containment.test.ts <<'EOF'
import { describe, expect, it } from "vitest";
import { resolveContainedPaperclipApiAllowlistTarget } from "./execute.js";

describe("Hermes contained Paperclip API target", () => {
  it("allows the exact loopback staging target", () => {
    expect(resolveContainedPaperclipApiAllowlistTarget("http://127.0.0.1:3101/api"))
      .toBe("127.0.0.1:3101");
  });

  it("allows localhost loopback", () => {
    expect(resolveContainedPaperclipApiAllowlistTarget("http://localhost:3101/api"))
      .toBe("localhost:3101");
  });

  it("rejects non-loopback and HTTPS targets", () => {
    expect(() => resolveContainedPaperclipApiAllowlistTarget("https://paperclip.example.com/api"))
      .toThrow("loopback HTTP staging endpoints");
    expect(() => resolveContainedPaperclipApiAllowlistTarget("http://10.0.0.5:3101/api"))
      .toThrow("loopback HTTP staging endpoints");
  });
});
EOF

# Add a validator regression test before the suite's final close.
python3 <<'PY'
from pathlib import Path
p = Path("packages/shared/src/validators/issue.test.ts")
text = p.read_text()
marker = 'it("preserves a structured QSL mission contract on primary issues"'
if marker not in text:
    insert = '''\n  it("preserves a structured QSL mission contract on primary issues", () => {
    const parsed = createIssueSchema.parse({
      title: "Bounded mission",
      executionPolicy: {
        missionContract: {
          version: 1,
          objective: "Return verified evidence or one meaningful escalation.",
          authorityLevel: "L1",
          acceptanceCriteria: [
            { id: "AC-1", text: "Canonical workspace is resolved before diagnosis." },
          ],
          maxRepairRetries: 1,
          requiredStages: ["implementation", "verification", "sentinel_review", "provenance_receipt"],
          provider: "openrouter",
          model: "openrouter/deepseek/deepseek-chat",
          productionIsolationRequired: true,
        },
      },
    });

    expect(parsed.executionPolicy?.missionContract?.acceptanceCriteria).toEqual([
      { id: "AC-1", text: "Canonical workspace is resolved before diagnosis." },
    ]);
    expect(parsed.executionPolicy?.missionContract?.maxRepairRetries).toBe(1);
  });\n'''
    close = text.rfind("\n});")
    if close < 0:
        raise SystemExit("BLOCKED: issue.test.ts final suite close not found")
    p.write_text(text[:close] + insert + text[close:])
PY

mkdir -p doc/plans
cat > doc/plans/QSL_MISSION_CONTROL_RESOURCE_MANIFEST_V0_1.md <<EOF
# QSL Mission Control Resource Manifest V0.1

Generated for the Mission Control V0.1 reliability slice.

## Canonical engineering workspace

- Resource: Paperclip staging repository
- Path: \`$REPO\`
- Reliability base HEAD: \`$BASE_HEAD\`
- Reliability branch: \`$WORK_BRANCH\`
- Director access: read-only evidence/discovery
- Staging Engineer access: bounded writable contained workspace when explicitly assembled for an L0/L1 coding mission
- Verification Engineer access: read-only independent verification

## Runtime surfaces

- Staging Paperclip API: \`http://127.0.0.1:3101/api\`
- Staging service: \`$STAGING_SERVICE\` — L1, exact-unit operations only
- Production service: \`$PROD_SERVICE\` — read-only evidence; human authority for any mutation
- Production API health evidence: \`http://127.0.0.1:3100/api/health\`

## Governed model lane

- Provider: OpenRouter
- Model: \`openrouter/deepseek/deepseek-chat\`
- Silent substitution: prohibited
- Provider secret: company-managed \`secret_ref\`; raw value must never be printed or copied into mission evidence

## Control-plane members

- Mission Control Director: \`$DIRECTOR_ID\`
- Sentinel Governor: \`$SENTINEL_ID\`
- Selarix Recorder: \`$RECORDER_ID\`

## Safety invariants

- No broad process kills.
- No production restart/deploy/config/DB/secret mutation without human approval.
- No new external egress without human approval.
- Contained Director Paperclip API access is loopback-only.
- Discover canonical source-controlled evidence before diagnosing missing files.
- A model-assumed path is not a root cause.
- Mission retry budgets may tighten platform recovery defaults and may never loosen them.
EOF

# Focused tests first; if any fail, do not restart staging.
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

if ! git diff --cached --quiet; then
  git commit -m "feat(qsl): harden Mission Control V0.1 execution contract"
fi
RELIABILITY_HEAD="$(git rev-parse HEAD)"

# Deploy only to staging.
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

# Upgrade the Director: canonical repo is visible RO; staging Paperclip API is
# explicitly enabled through the new loopback-only containment gate.
DIRECTOR="$(api_get "/agents/$DIRECTOR_ID")"
[[ "$(jq -r '.companyId // empty' <<<"$DIRECTOR")" == "$COMPANY_ID" ]] || fail "Director company mismatch"
DIRECTOR_CONFIG="$(jq -c --arg repo "$REPO" --arg api "$API_BASE" '
  .adapterConfig
  | .cwd = $repo
  | .paperclipApiUrl = $api
  | .allowPaperclipApiAccess = true
' <<<"$DIRECTOR")"

# Preserve governed secret refs; never print adapter config.
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

# Persist QSL-1's nine acceptance criteria and one-retry contract as machine state.
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

# Final invariants. QSL-1 deliberately remains blocked; no wake is issued.
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
