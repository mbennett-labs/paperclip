#!/usr/bin/env bash
set -euo pipefail

# QSL Mission Control V0.1 — isolated writable Mission Cell workspace
#
# Flight #1 and the ownership audit established that the canonical staging
# deployment tree is intentionally protected from both the staging service
# identity and OpenClaw. Do not chmod/chown that tree for agent convenience.
#
# This bounded staging-only operation:
# - adds fail-closed Hermes cwdAccess/cwdWriteRoot policy
# - keeps Director/Sentinel/Selarix read-only
# - creates an isolated writable clone for QSL-1 Flight #2 implementation
# - gives a future temporary Staging Engineer rw only inside that clone
# - keeps Verification Engineer read-only over the same clone
# - updates the Director's instructions to use the isolated workspace
# - leaves QSL-1 BLOCKED and does not wake/retry it
# - restarts only the exact staging service and proves production PID continuity

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
NODE22="${QSL_NODE22:-/usr/local/bin/node22}"
OPENCLAW_USER="${QSL_OPENCLAW_USER:-openclaw}"

fail() { echo "BLOCKED: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "missing command: $1"; }
for cmd in git python3 pnpm curl jq systemctl runuser install chown stat; do need "$cmd"; done
[[ -x "$NODE22" ]] || fail "Node 22 runtime not found/executable at $NODE22"
[[ "$API_BASE" == "http://127.0.0.1:3101/api" || "$API_BASE" == "http://localhost:3101/api" ]] || fail "refusing non-staging API base: $API_BASE"
[[ -d "$REPO/.git" ]] || fail "staging repo not found: $REPO"
cd "$REPO"
[[ "$(git branch --show-current)" == "$WORK_BRANCH" ]] || fail "expected branch $WORK_BRANCH"
[[ -z "$(git status --porcelain --untracked-files=no)" ]] || fail "tracked staging worktree is dirty"

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

# Confirm the canonical deployment tree remains protected. This is an invariant,
# not a problem to repair with chmod/chown.
if runuser -u "$OPENCLAW_USER" -- test -w "$REPO"; then
  fail "OpenClaw unexpectedly has write access to canonical staging repo"
fi
STAGING_USER="$(systemctl show "$STAGING_SERVICE" --property=User --value)"
if runuser -u "$STAGING_USER" -- test -w "$REPO"; then
  fail "staging service unexpectedly has write access to canonical staging repo"
fi
echo "Canonical staging repo protection: PASS (read-only to staging/OpenClaw identities)"

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

# 1) Explicit cwd mount policy in Hermes config.
path = "packages/adapters/hermes/src/server/config-schema.ts"
old = '''      {
        key: "containment.workspaceDir",
        label: "Containment workspace directory",
        type: "text",
        hint: "Writable sandbox root. Hermes can read/write files inside this directory. Defaults to a temp directory if unset.",
      },
      {
        key: "containment.homeDir",'''
new = '''      {
        key: "containment.workspaceDir",
        label: "Containment workspace directory",
        type: "text",
        hint: "Writable sandbox root. Hermes can read/write files inside this directory. Defaults to a temp directory if unset.",
      },
      {
        key: "containment.cwdAccess",
        label: "Contained cwd access",
        type: "select",
        default: "ro",
        options: [
          { value: "ro", label: "Read-only (default)" },
          { value: "rw", label: "Read/write — bounded by cwd write root" },
        ],
        hint: "Keep read-only for control-plane/reviewer agents. rw is only for bounded implementation workers and requires containment.cwdWriteRoot.",
      },
      {
        key: "containment.cwdWriteRoot",
        label: "Contained cwd write root",
        type: "text",
        hint: "Required when cwdAccess=rw. The real resolved cwd must remain inside this absolute root. '/' is rejected.",
      },
      {
        key: "containment.homeDir",'''
replace_once(path, old, new)

# 2) Fail-closed rw resolver.
path = "packages/adapters/hermes/src/server/execute.ts"
p = Path(path)
text = p.read_text()
marker = "export async function resolveContainedHermesCwdAccess("
if marker not in text:
    anchor = '''/**
 * Apply the contained execution identity to the child environment.'''
    idx = text.find(anchor)
    if idx < 0:
        raise SystemExit(f"BLOCKED: {path}: contained identity anchor not found")
    helper = '''export async function resolveContainedHermesCwdAccess(
  config: Record<string, unknown>,
  cwd: string,
): Promise<"ro" | "rw"> {
  const requested = cfgString(config["containment.cwdAccess"]) || "ro";
  if (requested === "ro") return "ro";
  if (requested !== "rw") {
    throw new Error(`Invalid containment.cwdAccess "${requested}". Must be "ro" or "rw".`);
  }

  const configuredRoot = cfgString(config["containment.cwdWriteRoot"]);
  if (!configuredRoot || !path.isAbsolute(configuredRoot)) {
    throw new Error("containment.cwdAccess=rw requires an absolute containment.cwdWriteRoot.");
  }

  const [realCwd, realRoot] = await Promise.all([
    fs.realpath(cwd),
    fs.realpath(configuredRoot),
  ]);
  if (realRoot === path.parse(realRoot).root) {
    throw new Error("containment.cwdWriteRoot may not be the filesystem root.");
  }
  if (realCwd !== realRoot && !realCwd.startsWith(realRoot + path.sep)) {
    throw new Error("Contained writable cwd escapes containment.cwdWriteRoot.");
  }
  return "rw";
}

'''
    text = text[:idx] + helper + text[idx:]
    p.write_text(text)

old = '''    const extraPaths: { path: string; access: "ro" | "rw" }[] = [{ path: cwd, access: "ro" }];'''
new = '''    const cwdAccess = await resolveContainedHermesCwdAccess(config, cwd);
    const extraPaths: { path: string; access: "ro" | "rw" }[] = [{ path: cwd, access: cwdAccess }];'''
replace_once(path, old, new)

# 3) Resource manifest: protected canonical repo + isolated mission workspace.
path = "doc/plans/QSL_MISSION_CONTROL_RESOURCE_MANIFEST_V0_1.md"
p = Path(path)
text = p.read_text()
old = '''- Director access: read-only evidence/discovery
- Staging Engineer access: bounded writable contained workspace when explicitly assembled for an L0/L1 coding mission
- Verification Engineer access: read-only independent verification'''
new = '''- Director access: canonical staging repo read-only evidence/discovery (`containment.cwdAccess=ro`)
- Canonical staging deployment tree stays protected; do not chmod/chown it for Mission Cells
- QSL-1 Flight #2 implementation workspace: `/opt/paperclip-mission-cells/QSL-1/flight-2-implementation`
- Staging Engineer access: read/write only inside that isolated clone (`containment.cwdAccess=rw`, `containment.cwdWriteRoot=/opt/paperclip-mission-cells/QSL-1/flight-2-implementation`)
- Verification Engineer access: the same isolated clone read-only (`containment.cwdAccess=ro`)
- Sentinel Governor / Selarix Recorder: canonical repo and mission workspace read-only
- `rw` is fail-closed unless the real resolved cwd remains inside the configured absolute write root; filesystem root is never accepted'''
replace_once(path, old, new)
p.write_text(text)
PY

cat > packages/adapters/hermes/src/server/qsl-contained-cwd-access.test.ts <<'EOF'
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveContainedHermesCwdAccess } from "./execute.js";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((candidate) => fs.rm(candidate, { recursive: true, force: true })));
});

async function roots() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "qsl-hermes-cwd-"));
  cleanup.push(root);
  const allowed = path.join(root, "allowed");
  const child = path.join(allowed, "mission");
  const outside = path.join(root, "outside");
  await fs.mkdir(child, { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  return { allowed, child, outside };
}

describe("Hermes contained cwd access", () => {
  it("defaults to read-only", async () => {
    const { child } = await roots();
    await expect(resolveContainedHermesCwdAccess({}, child)).resolves.toBe("ro");
  });

  it("allows rw only inside the explicit realpath root", async () => {
    const { allowed, child } = await roots();
    await expect(resolveContainedHermesCwdAccess({
      "containment.cwdAccess": "rw",
      "containment.cwdWriteRoot": allowed,
    }, child)).resolves.toBe("rw");
  });

  it("rejects rw without a bounded root", async () => {
    const { child } = await roots();
    await expect(resolveContainedHermesCwdAccess({ "containment.cwdAccess": "rw" }, child))
      .rejects.toThrow("requires an absolute containment.cwdWriteRoot");
  });

  it("rejects cwd outside the configured write root", async () => {
    const { allowed, outside } = await roots();
    await expect(resolveContainedHermesCwdAccess({
      "containment.cwdAccess": "rw",
      "containment.cwdWriteRoot": allowed,
    }, outside)).rejects.toThrow("escapes containment.cwdWriteRoot");
  });

  it("rejects filesystem root as the writable boundary", async () => {
    const { child } = await roots();
    await expect(resolveContainedHermesCwdAccess({
      "containment.cwdAccess": "rw",
      "containment.cwdWriteRoot": path.parse(child).root,
    }, child)).rejects.toThrow("may not be the filesystem root");
  });
});
EOF

NODE_SHIM="$(mktemp -d)"
trap 'rm -rf "$NODE_SHIM"' EXIT
ln -s "$NODE22" "$NODE_SHIM/node"
export PATH="$NODE_SHIM:$PATH"
echo "Test/build Node: $(node -v)"

pnpm exec vitest run \
  packages/adapters/hermes/src/server/qsl-contained-cwd-access.test.ts \
  packages/adapters/hermes/src/server/qsl-paperclip-api-containment.test.ts
pnpm --filter @paperclipai/hermes-paperclip-adapter typecheck
pnpm --filter @paperclipai/hermes-paperclip-adapter build
pnpm --filter @paperclipai/server typecheck
pnpm --filter @paperclipai/server build

git add \
  packages/adapters/hermes/src/server/config-schema.ts \
  packages/adapters/hermes/src/server/execute.ts \
  packages/adapters/hermes/src/server/qsl-contained-cwd-access.test.ts \
  doc/plans/QSL_MISSION_CONTROL_RESOURCE_MANIFEST_V0_1.md

git diff --cached --check
if ! git diff --cached --quiet; then
  git commit -m "fix(qsl): isolate writable workspace for implementation Mission Cells"
fi
HEAD_NOW="$(git rev-parse HEAD)"

# Deploy the policy only to staging.
systemctl restart "$STAGING_SERVICE"
for _ in $(seq 1 30); do
  curl -fsS http://127.0.0.1:3101/api/health >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS http://127.0.0.1:3101/api/health >/dev/null || fail "staging failed health after exact-unit restart"
[[ "$(production_pid)" == "$PID_BEFORE" ]] || fail "production PID changed during staging restart"
curl -fsS http://127.0.0.1:3100/api/health >/dev/null || fail "production health failed after staging restart"

# Create a fresh, independent git clone for the temporary implementation cell.
# It intentionally does NOT share writable .git metadata with the protected
# deployment tree. New commits remain in the mission workspace until reviewed.
if [[ -e "$MISSION_WORKSPACE" ]]; then
  fail "mission workspace already exists: $MISSION_WORKSPACE"
fi
install -d -o root -g root -m 0755 /opt/paperclip-mission-cells
install -d -o root -g root -m 0755 "$MISSION_ROOT"
git clone --no-hardlinks --branch "$WORK_BRANCH" "$REPO" "$MISSION_WORKSPACE"
chown -R "$OPENCLAW_USER:$OPENCLAW_USER" "$MISSION_WORKSPACE"

runuser -u "$OPENCLAW_USER" -- test -w "$MISSION_WORKSPACE" || fail "OpenClaw cannot write isolated mission workspace"
runuser -u "$OPENCLAW_USER" -- git -C "$MISSION_WORKSPACE" status --porcelain >/tmp/qsl-mission-workspace-status.$$
[[ ! -s /tmp/qsl-mission-workspace-status.$$ ]] || { cat /tmp/qsl-mission-workspace-status.$$ >&2; rm -f /tmp/qsl-mission-workspace-status.$$; fail "fresh mission workspace is dirty"; }
rm -f /tmp/qsl-mission-workspace-status.$$
runuser -u "$OPENCLAW_USER" -- sh -c "printf 'workspace-write-proof\n' > '$MISSION_WORKSPACE/.qsl-write-proof' && rm '$MISSION_WORKSPACE/.qsl-write-proof'"

# Keep persistent control-plane members explicitly read-only under the new gate.
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

# Update the Director's managed instructions without changing QSL-1 state.
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

# Final invariants: no automatic mission wake/retry.
MISSION="$(api_get "/issues/$MISSION_IDENTIFIER")"
[[ "$(jq -r '.status // empty' <<<"$MISSION")" == "blocked" ]] || fail "$MISSION_IDENTIFIER unexpectedly left blocked state"
health
PID_FINAL="$(production_pid)"
[[ "$PID_FINAL" == "$PID_BEFORE" ]] || fail "production PID continuity failed: before=$PID_BEFORE final=$PID_FINAL"

# Re-verify persistent members are read-only under the new config.
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
