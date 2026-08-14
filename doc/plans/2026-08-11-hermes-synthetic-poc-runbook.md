# Hermes Synthetic POC Runbook

**Date:** 2026-08-11
**Branch:** `feat/qsl-current-upstream-integration` (post-merge staging) or `feat/hermes-synthetic-poc-v0` (pre-merge worktree)
**Base:** `origin/feat/qsl-current-upstream-integration`
**Status:** Ready for human-approved execution (blocked: containment.executionUid must be configured; see section 2.1a)

---

## 0. Runtime Deployment Gate

**CRITICAL:** This branch is a worktree. The live POC **cannot** begin until:

1. This branch is reviewed, approved, and merged into `feat/qsl-current-upstream-integration`.
2. The merged code is deployed to staging (where the Paperclip service runs).
3. The restarted Paperclip service is proven to contain the required containment implementation (PR #22, `feat/hermes-containment-v0`, merged at `dc9905e5`).
4. The service's Hermes adapter loads the containment code from the deployed build, not the worktree.

The preflight script checks that the worktree branch and commit match expectations, but the running Paperclip service **must** be independently verified to include the containment implementation. Do **not** restart or deploy services in this mission.

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
| Hermes/OpenClaw CLI installed | `HERMES_COMMAND=/home/openclaw/.local/bin/openclaw bash scripts/hermes-poc/preflight.sh --run-id poc-001` finds the binary |
| Bubblewrap >= 0.4.0 | `bwrap --version` |
| User namespaces enabled | `bwrap --unshare-user --ro-bind / / /bin/true` |
| Non-root UID for containment | When the Paperclip host process is root, `containment.executionUid` must be set to a non-zero value (e.g., `1000`) in the Hermes agent config. Runtime enforcement in `local-process-sandbox.ts` REJECTS containmentRequired=true without executionUid when host UID is 0. Preflight does NOT fail simply because it runs as root. |
| Branch `feat/qsl-current-upstream-integration` or `feat/hermes-synthetic-poc-v0` | `git branch --show-current` |
| Base `feat/qsl-current-upstream-integration` reachable | `git merge-base HEAD origin/feat/qsl-current-upstream-integration` succeeds |
| OPENROUTER_API_KEY available as Paperclip company secret | Key exists in Paperclip secrets with a **$1 hard account/key limit** |
| Agent config binds secret via `secret_ref` | `config.env.OPENROUTER_API_KEY` uses `type: "secret_ref"`, not plaintext |
| PAPERCLIP_API_KEY NOT forwarded to Hermes | `allowPaperclipApiAccess: false` in agent config |
| `--yolo` disabled | The Hermes adapter config has `dangerouslySkipHermesApprovals: false` |
| Paperclip service running and deployed from merged branch | `curl http://localhost:3100/api/health` returns 200; service built from merged containment branch |

**Note:** This host uses OpenClaw (not the Python `hermes` CLI). The `hermes_local` adapter works with OpenClaw by setting `config.hermesCommand` to `/home/openclaw/.local/bin/openclaw` in the agent config. The preflight accepts any executable via the `HERMES_COMMAND` env var.

### 2.1a UID/GID Contract

**Paperclip/server MAY run as root. Preflight MAY run as root.**
**A contained Hermes/OpenClaw child MUST NEVER execute as root (UID 0).**

When the Paperclip host process is UID 0, `containment.executionUid` is **mandatory** — the runtime (`local-process-sandbox.ts`) will REJECT `containmentRequired=true` without a non-zero `executionUid`.

The operator MUST:

- Configure `containment.executionUid` to a non-zero value (e.g., `1000` — user `ubuntu`)
- Optionally configure `containment.executionGid` (defaults to `executionUid` if unset)
- The workspace directory (`/tmp/paperclip-hermes-sandbox-<runId>`) is mounted via `--bind` inside the sandbox; ownership inside the tmpfs root maps to the configured UID

With `--unshare-user` and a non-zero UID, bwrap creates a new user namespace where the child runs as the configured UID/GID. Runtime enforcement (not merely preflight prose) prevents unsafe execution — the sandbox fails closed before spawning the child if the configuration would result in root-contained execution.

The preflight script detects the host environment and reports whether a suitable non-root UID exists, but cannot mechanically inspect the Paperclip agent config. Final verification that `containment.executionUid` is actually set belongs to the runtime/API/operator step.

### 2.2 Governed Secret Delivery

The **shell** `OPENROUTER_API_KEY` used by preflight is a credential-validity prerequisite only. It proves the key exists. It does **NOT** deliver the key to the Hermes child process.

The actual governed delivery path (all verified in existing code):

```
Company secret (Paperclip DB)
  ↓
Agent config binding: config.env.OPENROUTER_API_KEY = { type: "secret_ref", secretId: "sec_..." }
  ↓
resolveAdapterConfigForRuntime (secrets.ts)
  → resolves plaintext value, stamps __resolvedEnvKeys = ["OPENROUTER_API_KEY"]
  ↓
buildHermesChildEnv (child-env.ts)
  → blocked key check: isBlocked("OPENROUTER_API_KEY") → true
  → governed gate: governedKeys.has("OPENROUTER_API_KEY") → true → ALLOWED
  ↓
child_process.spawn("hermes", ..., { env, envMode: "replace" })
  → only the constructed env dict is passed (no process.env inheritance)
```

**Plaintext config.env secrets are REJECTED.** If `OPENROUTER_API_KEY` is set as a plain string (not via `secret_ref`), `buildHermesChildEnv` pushes it to `rejectedConfigSecrets` and does NOT forward it to the child.

### 2.3 Key Handling

```
NEVER PRINT, LOG, HASH, PARTIALLY DISPLAY, OR INSPECT THE REAL OPENROUTER_API_KEY.
```

The preflight script checks that the key is *present* but never reveals its value. The governed path in section 2.2 ensures the key reaches Hermes without appearing in logs.

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

### 4.1 Preflight (offline, no Hermes/OpenClaw execution)

```bash
export OPENROUTER_API_KEY="<your-key>"
HERMES_COMMAND=/home/openclaw/.local/bin/openclaw \
  bash scripts/hermes-poc/preflight.sh --run-id poc-001
```

The `HERMES_COMMAND` env var points to the actual OpenClaw binary on this host. The preflight will probe `--version` using the openclaw user's environment (which has the required Node >=22.12.0).

Expected: `VERDICT: PREFLIGHT PASSED` with zero failures. If any check fails, resolve before proceeding.

Run ID convention: `poc-<NNN>` where NNN is a three-digit sequence number.

### 4.2 Configure Hermes in Paperclip

Create or use a Hermes agent in Paperclip with these settings:

| Config key | Value |
|---|---|
| `hermesCommand` | `/home/openclaw/.local/bin/openclaw` |
| `allowPaperclipApiAccess` | `false` |
| `dangerouslySkipHermesApprovals` | `false` |
| `containment` | `true` |
| `containment.providerPreset` | `openrouter` |
| `containment.workspaceDir` | `/tmp/paperclip-hermes-sandbox-poc-001` |
| `containment.executionUid` | A non-root UID (e.g., `1000`) |

The `hermesCommand` field tells the hermes_local adapter to use OpenClaw instead of the default `hermes` CLI. The preflight's `HERMES_COMMAND` env var mirrors this config key.

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

---

## Operator-Mission UUID Incident — Resolved — 2026-08-14

### Verdict

**RESOLVED — invalid caller/test input, not a database or migration defect.**

### Verified API Contract

Operator Mission routes require the canonical Paperclip company UUID:

`/api/companies/:companyId/...`

TheBinMap staging company UUID:

`f5609cfe-37ff-4061-a3c7-35ae55dbcc2b`

Verified behavior:

- Correct UUID request → normal `404 Operator mission not found`
- Invalid slug `thebinmap` → `500 Internal Server Error`
- Database error: `invalid input syntax for type uuid: "thebinmap"`

### Root Cause

A caller/test supplied the company slug `thebinmap` where the UUID-only API
contract requires the canonical company UUID.

### Explicitly Disproven

The incident was not caused by:

- database schema incompatibility
- missing migration
- staging environment configuration
- systemd environment injection
- a requirement for slug-to-UUID resolution

### Operational Rule

Operator Mission submissions MUST use the canonical company UUID:

`f5609cfe-37ff-4061-a3c7-35ae55dbcc2b`

Do not substitute `thebinmap`.

### Follow-Up Hardening

Malformed/non-UUID `:companyId` values should return `400 Bad Request`
instead of reaching PostgreSQL and producing `500 Internal Server Error`.

This is defensive hardening and is not a V0.1 blocker.

### Verification Principle

**Observe the value before repairing the value.**
