#!/usr/bin/env bash
set -euo pipefail

# QSL Mission Control V0.1 — bounded writable staging workspace gate
#
# Flight #1 proved that control-plane members can now discover the canonical
# repository, but the Hermes containment adapter still mounts every resolved
# cwd read-only. That is correct for the Director/Sentinel/Recorder, but it
# means a temporary Staging Engineer cannot actually implement a bounded edit.
#
# This script adds an explicit, fail-closed containment.cwdAccess contract:
# - default: ro
# - rw requires containment.cwdWriteRoot
# - cwd must resolve inside that realpath root
# - root '/' is rejected
#
# For QSL, the only approved writable root in this slice is the staging repo.
# Production remains unmounted/unmodified. QSL-1 remains BLOCKED.

REPO="${QSL_STAGING_REPO:-/opt/paperclip-deployments/thebinmap-email-ops-staging}"
WORK_BRANCH="feat/qsl-mission-control-v0-1-reliability"
PROD_SERVICE="paperclip-thebinmap-prod.service"
STAGING_SERVICE="paperclip-thebinmap-staging.service"
NODE22="${QSL_NODE22:-/usr/local/bin/node22}"

fail() { echo "BLOCKED: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "missing command: $1"; }
for cmd in git python3 pnpm curl systemctl runuser; do need "$cmd"; done
[[ -x "$NODE22" ]] || fail "Node 22 runtime not found/executable at $NODE22"
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

health
PID_BEFORE="$(production_pid)"
[[ "$PID_BEFORE" =~ ^[1-9][0-9]*$ ]] || fail "invalid production PID: $PID_BEFORE"
echo "Production baseline PID: $PID_BEFORE"

# The staging service identity must already own/write its source tree. We do not
# chmod/chown anything here; inability to write is a real blocker.
STAGING_USER="$(systemctl show "$STAGING_SERVICE" --property=User --value)"
[[ -n "$STAGING_USER" ]] || fail "staging service User is empty"
runuser -u "$STAGING_USER" -- test -w "$REPO" || fail "staging service identity cannot write staging repo"

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

# 1) Expose the explicit cwd mount policy in the Hermes adapter schema.
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

# 2) Fail-closed workspace-access resolver and realpath boundary.
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

# 3) Update the governed resource manifest the Director is already instructed
#    to read before diagnosing/assembling implementation work.
path = "doc/plans/QSL_MISSION_CONTROL_RESOURCE_MANIFEST_V0_1.md"
p = Path(path)
text = p.read_text()
old = '''- Director access: read-only evidence/discovery
- Staging Engineer access: bounded writable contained workspace when explicitly assembled for an L0/L1 coding mission
- Verification Engineer access: read-only independent verification'''
new = '''- Director access: read-only evidence/discovery (`containment.cwdAccess=ro`)
- Staging Engineer access: bounded writable staging workspace only when explicitly assembled for an L0/L1 coding mission (`containment.cwdAccess=rw`, `containment.cwdWriteRoot=/opt/paperclip-deployments/thebinmap-email-ops-staging`)
- Verification Engineer access: read-only independent verification (`containment.cwdAccess=ro`)
- Sentinel Governor / Selarix Recorder: read-only (`containment.cwdAccess=ro`)
- `rw` is fail-closed unless the real resolved cwd remains inside the configured absolute write root; filesystem root is never accepted'''
replace_once(path, old, new)
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
    await expect(resolveContainedHermesCwdAccess({
      "containment.cwdAccess": "rw",
    }, child)).rejects.toThrow("requires an absolute containment.cwdWriteRoot");
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
  git commit -m "fix(qsl): gate writable staging workspace for Mission Cells"
fi
HEAD_NOW="$(git rev-parse HEAD)"

systemctl restart "$STAGING_SERVICE"
for _ in $(seq 1 30); do
  curl -fsS http://127.0.0.1:3101/api/health >/dev/null 2>&1 && break
  sleep 1
done
health
PID_AFTER="$(production_pid)"
[[ "$PID_AFTER" == "$PID_BEFORE" ]] || fail "production PID changed: before=$PID_BEFORE after=$PID_AFTER"

# No mission wake/unblock here. This only makes the resource available for a
# future explicitly assembled Staging Engineer.
echo
echo "QSL MISSION CELL WRITABLE STAGING WORKSPACE GATE PASS"
echo "HEAD: $HEAD_NOW"
echo "Default contained cwd access: ro"
echo "Bounded implementation access: rw only inside explicit realpath write root"
echo "Approved QSL write root: $REPO"
echo "QSL-1: untouched / remains BLOCKED"
echo "Production isolation: PASS (PID $PID_BEFORE)"
