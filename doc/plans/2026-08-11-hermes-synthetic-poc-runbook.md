# Hermes Synthetic POC Runbook

**Date:** 2026-08-11
**Branch:** `feat/hermes-synthetic-poc-v0`
**Base:** `origin/feat/qsl-current-upstream-integration`
**Status:** Ready for human-approved execution

---

## 1. Purpose

Execute the first contained Hermes synthetic task through the Paperclip control plane and verify that:

- Hermes runs inside Bubblewrap OS containment
- Writes are confined to the authorized workspace
- The output file is correct
- No writes leak to host paths
- OpenRouter egress is restricted to `openrouter.ai:443`

This is a **synthetic** POC: Hermes is instructed to write `3` to `./hermes-poc.txt` inside its workspace. No real work product is produced. Paperclip approvals and API key forwarding are tested separately in a later POC.

---

## 2. Prerequisites

### 2.1 Required

| Condition | How to verify |
|---|---|
| Linux host | `uname -s` outputs `Linux` |
| Bubblewrap >= 0.4.0 | `bwrap --version` |
| User namespaces enabled | `unshare --user true` succeeds |
| Branch `feat/hermes-synthetic-poc-v0` | `git branch --show-current` |
| Base `feat/qsl-current-upstream-integration` reachable | `git merge-base HEAD origin/feat/qsl-current-upstream-integration` succeeds |
| OPENROUTER_API_KEY set (but never printed) | `$OPENROUTER_API_KEY` is non-empty, has a **$1 hard account/key limit** |
| PAPERCLIP_API_KEY NOT forwarded to Hermes | `allowPaperclipApiAccess: false` in agent config |
| `--yolo` disabled | The Hermes adapter config has `dangerouslySkipHermesApprovals: false` |
| Paperclip service running | `curl http://localhost:3100/api/health` returns 200 |

### 2.2 Cost Safety

- **Hard loss boundary:** The $1 limit on the OpenRouter API key. This is the external enforce.
- **Observed cost:** Post-run, check the OpenRouter dashboard. Not guaranteed by POC code.
- **Paperclip budget:** Advisory only. Mission Control exposes company-level cost, not issue-scoped.

### 2.3 Key Handling

```
NEVER PRINT, LOG, HASH, PARTIALLY DISPLAY, OR INSPECT THE REAL OPENROUTER_API_KEY.
```

The preflight script checks that the key is *present* but never reveals its value.

---

## 3. Runbook Files

All scripts are in `scripts/hermes-poc/`:

| File | Purpose |
|---|---|
| `preflight.sh` | Verify host readiness before execution |
| `verify-evidence.sh` | Verify output after execution |
| `cleanup.sh` | Safely remove the exact-run workspace |

---

## 4. Execution Procedure

### 4.1 Preflight (offline, no Hermes)

```bash
export OPENROUTER_API_KEY="<your-key>"
./scripts/hermes-poc/preflight.sh --run-id poc-001
```

Expected: `VERDICT: PREFLIGHT PASSED` with zero failures. If any check fails, resolve before proceeding.

Run ID convention: `poc-<NNN>` where NNN is a three-digit sequence number.

### 4.2 Configure Hermes in Paperclip

Create or use a Hermes agent in Paperclip with these settings:

| Config key | Value |
|---|---|
| `allowPaperclipApiAccess` | `false` |
| `dangerouslySkipHermesApprovals` | `false` |
| `containment` | `true` |
| `containment.providerPreset` | `openrouter` |
| `containment.workspaceDir` | `/tmp/paperclip-hermes-sandbox-poc-001` |
| `containment.executionUid` | A non-root UID (e.g., 1000) |

### 4.3 Execute Synthetic Task

Create a Paperclip issue assigned to the Hermes agent with this prompt:

```
Write the number 3 to the file ./hermes-poc.txt in your workspace. Do nothing else.
```

Execute through the Paperclip board. Note the run ID from the board UI.

### 4.4 Post-Run Verification (offline, no Hermes)

```bash
./scripts/hermes-poc/verify-evidence.sh \
  --workspace-dir /tmp/paperclip-hermes-sandbox-poc-001 \
  --run-id poc-001
```

Expected: `VERDICT: VERIFICATION PASSED`.
This proves:
1. `hermes-poc.txt` exists in the authorized workspace
2. Contents are exactly `3`
3. `/tmp/hermes-poc.txt` does NOT exist on the host
4. No file was written outside the authorized workspace

### 4.5 Cleanup (offline, no Hermes)

```bash
./scripts/hermes-poc/cleanup.sh \
  --workspace-dir /tmp/paperclip-hermes-sandbox-poc-001 \
  --run-id poc-001
```

The script validates the target before removal. It rejects `/`, `/tmp`, path traversal, run-ID mismatch, and paths outside the sandbox parent.

---

## 5. Cancellation Contract

If the run must be terminated:

- Use **only** the Paperclip board's cancel button, which tracks the exact PID/process group
- Or use the paperclip-cli run cancellation command (if available)
- The Hermes adapter registers run IDs in `runningProcesses` map with trackable process group IDs
- `pkill -f` and `killall` are **prohibited** — they do not scope to the exact run

Cleanup scripts do not kill processes. They only remove workspace directories.

---

## 6. Evidence Contract

The `verify-evidence.sh` script collects:

| Evidence | Source |
|---|---|
| Run ID | Operator-provided |
| Issue ID | Operator-provided (optional) |
| Start/finish timestamps | Paperclip board |
| Branch and commit | `git rev-parse HEAD` |
| Containment config (redacted) | Paperclip agent config (no secrets) |
| Workspace path | Operator-provided |
| Tracked PID/process group | Paperclip board / agent logs |
| File hash (SHA-256) | `sha256sum` of `hermes-poc.txt` |
| File contents check | `cat` output vs expected `3` |
| Host `/tmp/hermes-poc.txt` absence | `test -f /tmp/hermes-poc.txt` |
| Bubblewrap process-tree evidence | Paperclip logs |
| Network policy evidence | Agent config (openrouter.ai:443) |
| Exit code | Paperclip run status |
| Cancellation evidence (if applicable) | Paperclip logs |
| Provider cost (observed, not guaranteed) | OpenRouter dashboard |
| Known limitations | Included in verification output |

---

## 7. Known Limitations

1. Provider cost is observed from the provider dashboard, not guaranteed by the POC code.
2. The $1 OpenRouter key limit is the external hard-loss boundary. No code enforces a $0.10 task ceiling.
3. Cost reporting is company-level in Mission Control, not issue-scoped.
4. Full filesystem audit beyond known dangerous paths is not performed.
5. This POC tests contained execution only. Paperclip approvals and API key forwarding are tested separately.
6. Verification uses exact path matching. Dynamic run-ID directories are supported through the default pattern.

---

## 8. Test Results

The helper tests in `scripts/hermes-poc/__tests__/helpers.test.ts` cover 12 scenarios:

1. Empty run ID is rejected (cleanup, preflight)
2. Path traversal is rejected (cleanup)
3. `/`, `/tmp`, and sandbox parent are rejected (cleanup)
4. Workspace outside approved parent is rejected (cleanup)
5. Exact approved workspace is accepted and removed (cleanup)
6. Verification fails when output file is missing (verify)
7. Verification fails when contents differ from `3` (verify)
8. Verification passes for exact expected file (verify)
9. Host `/tmp/hermes-poc.txt` is detected as violation (verify)
10. Secrets never appear in helper output (preflight)
11. Missing Bubblewrap fails preflight (preflight)
12. Unsafe cancellation patterns are absent (all scripts)

Run with:
```bash
npx vitest run scripts/hermes-poc/__tests__/helpers.test.ts
```

---

## 9. Future POC: Paperclip Questions and Approvals

A separate later POC will test:
- Hermes approval prompts mapping into Paperclip approval records
- PAPERCLIP_API_KEY forwarding with governed secret delivery
- The Paperclip task bridge helper for workspace-relative operations

This runbook does NOT implement or execute that POC.

---

## 10. Post-Run Disposition

After successful execution and verification:

1. Save the verification output as evidence
2. Check the OpenRouter dashboard for observed cost
3. Run cleanup
4. Document any issues or surprises
5. Proceed to the approval-gated POC if this one succeeds