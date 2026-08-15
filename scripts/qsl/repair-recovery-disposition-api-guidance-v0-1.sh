#!/usr/bin/env bash
set -euo pipefail

# QSL Mission Control V0.1 — recovery disposition API guidance repair.
#
# Root cause:
# Hermes intentionally suppresses its normal agent template for Paperclip
# recovery wakes so the recovery owner does not perform the deliverable work.
# That also suppresses the Paperclip API guidance required to persist a valid
# issue disposition. A recovery run can therefore succeed conversationally
# while leaving the issue in_progress, causing successful_run_missing_state.
#
# This bounded repair adds a recovery-only API template: enough authority and
# mechanics to record a disposition, without re-enabling the generic deliverable
# workflow. It also refreshes the already-provisioned QSL-1 isolated workspace.
#
# Staging only. QSL-1 remains blocked. Production is read-only evidence only.

REPO="${QSL_STAGING_REPO:-/opt/paperclip-deployments/thebinmap-email-ops-staging}"
WORK_BRANCH="feat/qsl-mission-control-v0-1-reliability"
MISSION_IDENTIFIER="${QSL_MISSION_IDENTIFIER:-QSL-1}"
MISSION_WORKSPACE="${QSL_MISSION_WORKSPACE:-/opt/paperclip-mission-cells/QSL-1/flight-2-implementation}"
PROD_SERVICE="paperclip-thebinmap-prod.service"
STAGING_SERVICE="paperclip-thebinmap-staging.service"
OPENCLAW_USER="${QSL_OPENCLAW_USER:-openclaw}"
NODE22="${QSL_NODE22_BIN:-/usr/local/bin/node22}"

fail() { echo "BLOCKED: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "missing command: $1"; }
for cmd in git python3 pnpm curl jq systemctl runuser mktemp chmod rm; do need "$cmd"; done
[[ -x "$NODE22" ]] || fail "Node 22 runtime missing: $NODE22"
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

python3 <<'PY'
from pathlib import Path

execute = Path("packages/adapters/hermes/src/server/execute.ts")
text = execute.read_text()

if "const HERMES_RECOVERY_PROMPT_TEMPLATE" not in text:
    anchor = '''const HERMES_DEFAULT_PROMPT_TEMPLATE = ['''
    start = text.find(anchor)
    if start < 0:
        raise SystemExit("BLOCKED: Hermes default prompt template anchor missing")
    end_marker = '''].join("\\n");\n\nfunction renderConditionalSections'''
    end = text.find(end_marker, start)
    if end < 0:
        raise SystemExit("BLOCKED: Hermes default prompt template end anchor missing")
    end += len('''].join("\\n");''')
    recovery_template = r'''

const HERMES_RECOVERY_PROMPT_TEMPLATE = [
  'You are "{{agent.name}}", the recovery owner for a Paperclip-managed issue.',
  "",
  "Paperclip runtime identity:",
  "- Agent ID: {{agent.id}}",
  "- Company ID: {{agent.companyId}}",
  "- Run ID: {{run.id}}",
  "- API base: {{paperclipApiUrl}}",
  "",
  "Paperclip recovery API guidance:",
  "- This is a recovery heartbeat. Recover the issue state; do not perform the deliverable work.",
  "- Before returning, persist exactly one valid issue disposition through the Paperclip API. A narrative response is not a disposition.",
  "- Use `curl` from the terminal and the existing `$PAPERCLIP_API_URL`, `$PAPERCLIP_API_KEY`, and `$PAPERCLIP_RUN_ID` environment variables.",
  "- Include the Authorization and X-Paperclip-Run-Id headers on the mutating issue request.",
  "- Valid dispositions are `done`, `in_review`, `blocked`, or `in_progress` only when a live continuation path actually exists.",
  "- If work is incomplete and no live continuation path exists, use `blocked` with a concise blocker owner and next action.",
  "- Do not copy transcript text into the disposition comment; summarize only the durable state and next action.",
  "",
  "Recovery disposition update pattern:",
  "```bash",
  "api=\"${PAPERCLIP_API_URL%/}\"",
  "case \"$api\" in */api) ;; *) api=\"$api/api\" ;; esac",
  "status=blocked  # deliberately replace only if another valid disposition is actually supported",
  "body=$(cat <<'MD'",
  "Recovery disposition: <concise durable state, blocker/owner if any, and next action>",
  "MD",
  ")",
  "jq -n --arg status \"$status\" --arg comment \"$body\" '{status:$status, comment:$comment}' | \\",
  "  curl -sS -X PATCH \"$api/issues/{{context.issueId}}\" \\",
  "    -H \"Authorization: Bearer $PAPERCLIP_API_KEY\" \\",
  "    -H \"X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID\" \\",
  "    -H \"Content-Type: application/json\" \\",
  "    --data-binary @-",
  "```",
].join("\\n");'''
    text = text[:end] + recovery_template + text[end:]

old = '''  const rendered = isPaperclipRecoveryWakePayload(context.paperclipWake)
    ? ""
    : renderTemplate(renderConditionalSections(template, vars), vars);'''
new = '''  const recoveryWake = isPaperclipRecoveryWakePayload(context.paperclipWake);
  const renderedTemplate = recoveryWake ? HERMES_RECOVERY_PROMPT_TEMPLATE : template;
  const rendered = renderTemplate(renderConditionalSections(renderedTemplate, vars), vars);'''
if new not in text:
    if old not in text:
        raise SystemExit("BLOCKED: Hermes recovery rendered-template anchor missing")
    text = text.replace(old, new, 1)
execute.write_text(text)

test = Path("packages/adapters/hermes/src/server/prompt-rendering.test.ts")
t = test.read_text()
marker = 'test("recovery wake keeps minimal disposition API guidance while suppressing generic deliverable workflow"'
if marker not in t:
    t += r'''


test("recovery wake keeps minimal disposition API guidance while suppressing generic deliverable workflow", () => {
  const prompt = buildPrompt(baseContext({
    paperclipWake: {
      reason: "source_scoped_recovery_action",
      issue: {
        id: "issue-1",
        identifier: "QSL-1",
        title: "Finish Operator Loop V0.1",
        status: "blocked",
        priority: "medium",
        workMode: "standard",
      },
      checkedOutByHarness: true,
      commentWindow: { requestedCount: 0, includedCount: 0, missingCount: 0 },
      comments: [],
      fallbackFetchNeeded: false,
    },
  }), {
    paperclipApiUrl: "http://127.0.0.1:3101/api",
  });

  expect(prompt).toContain("Recovery contract: your job is to RECOVER this task, not to do the work.");
  expect(prompt).toContain("Paperclip recovery API guidance:");
  expect(prompt).toContain("A narrative response is not a disposition.");
  expect(prompt).toContain("$PAPERCLIP_API_URL");
  expect(prompt).toContain("Authorization: Bearer $PAPERCLIP_API_KEY");
  expect(prompt).toContain("X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID");
  expect(prompt).toContain('PATCH \"$api/issues/issue-1\"');
  expect(prompt).toContain("`in_progress` only when a live continuation path actually exists");
  expect(prompt).not.toContain("Safe multiline update pattern:");
  expect(prompt).not.toContain('You are "Hermes Engineer", an AI agent employee in a Paperclip-managed company.');
});
'''
test.write_text(t)
PY

EXPECTED_DIRTY="$(git status --porcelain | awk '{print $2}' | sort)"
EXPECTED=$'packages/adapters/hermes/src/server/execute.ts\npackages/adapters/hermes/src/server/prompt-rendering.test.ts'
[[ "$EXPECTED_DIRTY" == "$EXPECTED" ]] || {
  echo "Unexpected dirty paths:" >&2
  git status --short >&2
  fail "repair touched files outside the bounded two-file slice"
}

export PATH="$(dirname "$NODE22"):$PATH"
if [[ "$(node --version)" != v22.* ]]; then
  alias_node_dir="$(mktemp -d)"
  ln -s "$NODE22" "$alias_node_dir/node"
  export PATH="$alias_node_dir:$PATH"
fi
echo "Test/build Node: $(node --version)"

(
  cd packages/adapters/hermes
  pnpm exec vitest run src/server/prompt-rendering.test.ts
  pnpm typecheck
  pnpm build
)
pnpm --dir server typecheck
pnpm --dir server build

git add packages/adapters/hermes/src/server/execute.ts packages/adapters/hermes/src/server/prompt-rendering.test.ts
git commit -m "fix(qsl): preserve disposition API guidance on recovery wakes"
HEAD_NOW="$(git rev-parse HEAD)"

# Restart staging only, then prove exact service health.
systemctl restart "$STAGING_SERVICE"
for _ in $(seq 1 30); do
  if [[ "$(systemctl is-active "$STAGING_SERVICE")" == "active" ]] && curl -fsS http://127.0.0.1:3101/api/health >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
health

# Refresh the existing isolated Mission Cell workspace without adding a remote.
[[ -d "$MISSION_WORKSPACE/.git" ]] || fail "mission workspace missing: $MISSION_WORKSPACE"
[[ -z "$(runuser -u "$OPENCLAW_USER" -- git -C "$MISSION_WORKSPACE" status --porcelain)" ]] || fail "mission workspace is dirty"
bundle="$(mktemp /tmp/qsl-recovery-disposition.XXXXXX.bundle)"
git bundle create "$bundle" HEAD
chmod 0644 "$bundle"
runuser -u "$OPENCLAW_USER" -- git -C "$MISSION_WORKSPACE" fetch "$bundle" HEAD
runuser -u "$OPENCLAW_USER" -- git -C "$MISSION_WORKSPACE" reset --hard FETCH_HEAD
rm -f "$bundle"
[[ "$(runuser -u "$OPENCLAW_USER" -- git -C "$MISSION_WORKSPACE" rev-parse HEAD)" == "$HEAD_NOW" ]] || fail "mission workspace HEAD refresh failed"
[[ -z "$(runuser -u "$OPENCLAW_USER" -- git -C "$MISSION_WORKSPACE" remote)" ]] || fail "mission workspace unexpectedly has a remote"

# QSL-1 must remain blocked; this repair never retries the mission.
MISSION_STATUS="$(curl -fsS http://127.0.0.1:3101/api/issues/$MISSION_IDENTIFIER | jq -r '.status // empty')"
[[ "$MISSION_STATUS" == "blocked" ]] || fail "$MISSION_IDENTIFIER unexpectedly left blocked state: $MISSION_STATUS"

PID_AFTER="$(production_pid)"
[[ "$PID_AFTER" == "$PID_BEFORE" ]] || fail "production PID continuity failed: before=$PID_BEFORE after=$PID_AFTER"
health

echo
echo "QSL RECOVERY DISPOSITION API GUIDANCE REPAIR PASS"
echo "Reliability HEAD: $HEAD_NOW"
echo "Recovery wakes: minimal Paperclip disposition API guidance preserved"
echo "Generic deliverable workflow on recovery wakes: still suppressed"
echo "Regression test: PASS"
echo "Mission Cell workspace refreshed: $MISSION_WORKSPACE"
echo "$MISSION_IDENTIFIER: BLOCKED (intentionally not retried)"
echo "Production isolation: PASS (PID $PID_BEFORE)"
