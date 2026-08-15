#!/usr/bin/env bash
set -euo pipefail

# Repair a bookkeeping bug in the first isolated-workspace patch attempt:
# replace_once() wrote the new resource-manifest block and a stale p.write_text(text)
# immediately restored the old content. No runtime/deploy mutation happened.
# Repair only that expected manifest block, then hand off to the already-bounded
# package-scoped resume gate.

REPO="${QSL_STAGING_REPO:-/opt/paperclip-deployments/thebinmap-email-ops-staging}"
WORK_BRANCH="feat/qsl-mission-control-v0-1-reliability"
BOOTSTRAP_REF="${QSL_BOOTSTRAP_REF:-origin/ops/qsl-mission-control-bootstrap}"
MANIFEST="doc/plans/QSL_MISSION_CONTROL_RESOURCE_MANIFEST_V0_1.md"

fail() { echo "BLOCKED: $*" >&2; exit 1; }
[[ -d "$REPO/.git" ]] || fail "staging repo not found: $REPO"
cd "$REPO"
[[ "$(git branch --show-current)" == "$WORK_BRANCH" ]] || fail "expected branch $WORK_BRANCH"

# Refuse unrelated dirt before touching the manifest.
ALLOWED_DIRTY_RE='^(doc/plans/QSL_MISSION_CONTROL_RESOURCE_MANIFEST_V0_1\.md|packages/adapters/hermes/src/server/config-schema\.ts|packages/adapters/hermes/src/server/execute\.ts|packages/adapters/hermes/src/server/qsl-contained-cwd-access\.test\.ts)$'
DIRTY_PATHS="$(git status --porcelain | sed -E 's/^.. //')"
[[ -n "$DIRTY_PATHS" ]] || fail "expected bounded uncommitted V0.1 changes, but worktree is clean"
while IFS= read -r path; do
  [[ "$path" =~ $ALLOWED_DIRTY_RE ]] || fail "unexpected dirty path present: $path"
done <<<"$DIRTY_PATHS"

python3 <<'PY'
from pathlib import Path

p = Path("doc/plans/QSL_MISSION_CONTROL_RESOURCE_MANIFEST_V0_1.md")
text = p.read_text()
new = '''- Director access: canonical staging repo read-only evidence/discovery (`containment.cwdAccess=ro`)
- Canonical staging deployment tree stays protected; do not chmod/chown it for Mission Cells
- QSL-1 Flight #2 implementation workspace: `/opt/paperclip-mission-cells/QSL-1/flight-2-implementation`
- Staging Engineer access: read/write only inside that isolated clone (`containment.cwdAccess=rw`, `containment.cwdWriteRoot=/opt/paperclip-mission-cells/QSL-1/flight-2-implementation`)
- Verification Engineer access: the same isolated clone read-only (`containment.cwdAccess=ro`)
- Sentinel Governor / Selarix Recorder: canonical repo and mission workspace read-only
- `rw` is fail-closed unless the real resolved cwd remains inside the configured absolute write root; filesystem root is never accepted'''
old = '''- Director access: read-only evidence/discovery
- Staging Engineer access: bounded writable contained workspace when explicitly assembled for an L0/L1 coding mission
- Verification Engineer access: read-only independent verification'''

if new in text:
    print("Resource manifest isolated workspace block: already present")
elif text.count(old) == 1:
    p.write_text(text.replace(old, new, 1))
    print("Resource manifest isolated workspace block: repaired")
else:
    raise SystemExit("BLOCKED: resource manifest is neither expected old nor expected new form")
PY

grep -q 'flight-2-implementation' "$MANIFEST" || fail "resource manifest repair did not persist"

# Confirm the other partial source changes from the first attempt are still present.
grep -q 'resolveContainedHermesCwdAccess' packages/adapters/hermes/src/server/execute.ts || fail "cwd access resolver patch is missing"
grep -q 'containment.cwdAccess' packages/adapters/hermes/src/server/config-schema.ts || fail "cwd access config patch is missing"
[[ -f packages/adapters/hermes/src/server/qsl-contained-cwd-access.test.ts ]] || fail "cwd access test file is missing"

echo "Manifest repair: PASS"

git show "$BOOTSTRAP_REF":scripts/qsl/resume-isolated-mission-cell-workspace-after-vitest-scope-v0-1.sh | bash
