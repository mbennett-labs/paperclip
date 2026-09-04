# QSL Worker Bridge — Lane E Harvest & Runbook (2026-09-04)

Lane: E (governed worker bridge harvest). Branch: `work/agentic-e-worker-bridge-20260903`.
Companion to `doc/plans/QSL_AGENTIC_PARALLEL_WORKER_BRIDGE_READINESS_2026-09-03.md`
(that document's terminal status `ROOT_BOOTSTRAP_READY` is superseded — see §1).

Every claim here is grounded in repo source at the cited SHAs or in today's
staging PASS evidence. No production access. No new deployment. No credential
changes. Bounded writes remain disabled.

## 1. Terminal status (reconciled 2026-09-04)

**READ_ONLY_BRIDGE_PROVED** — the full staging transport path is proven
end-to-end PASS; read-only dispatch is live; bounded writes remain fail-closed
pending durable server-side receipts.

Evidence chain verified today (2026-09-04):

| Step | Result |
| --- | --- |
| ChatGPT → GitHub request → Actions dispatch → bounded SSH operator v1.1.1 → staging localhost QSL orchestrator API → Paperclip read-only data → sanitized result → ledger/issue receipt | **PASS** |
| Operator v1.1.1 installed on staging (bootstrap from §4 of the readiness doc, SHA `363d2bffd`) | done |
| Orchestrator route present in staging runtime | verified via direct smoke |
| Direct bridge status smoke (staging localhost) | HTTP 200, `result_class: PASS` |
| Fresh GitHub status request (external transport, same path) | **PASS** |
| Production | untouched |

The readiness document's `ROOT_BOOTSTRAP_READY` status described the state
*before* the one-time operator bootstrap. That step was executed today
successfully, so the correct evidence-backed terminal status is
READ_ONLY_BRIDGE_PROVED. Nothing in the readiness doc's technical content is
reversed; only the terminal state moved.

## 2. Deployment invariants (harvested)

These five invariants are the durable lesson of 2026-09-03 → 2026-09-04. They
apply to every future staging/production bridge change:

1. **Source commit ≠ loaded runtime proof.** The staging checkout can be on a
   different branch/SHA than the repo work (`fix/qsl-email-mime-normalization-20260903`
   @ `bb1bbb3a` was deployed while bridge work lived on
   `feat/qsl-chatgpt-orchestrator-bridge-v1`), and the installed operator was
   v1.0.0 while the repo had v1.1.x. A source SHA alone never proves what is
   actually running.
2. **Build artifact must be verified.** The staging runtime executes the
   compiled artifact (`server/dist/index.js`), not `server/src`. A route added
   in source does not exist at runtime until it is built, loaded, and verified.
3. **Service entrypoint must be verified.** Confirm the running process is
   actually executing `server/dist/index.js` (not a stale entrypoint) before
   attributing behavior to source state.
4. **Runtime must be exercised directly.** The direct bridge status smoke
   (HTTP 200 / `result_class: PASS` against the staging localhost API) is the
   minimum proof that source + build + entrypoint agree.
5. **External transport must prove the same path.** Only after the direct
   smoke passes does a fresh GitHub-side status request
   (ChatGPT → GitHub → Actions → SSH operator → API → ledger/issue receipt)
   count as end-to-end proof. Both legs are required; neither substitutes for
   the other.

## 3. Exact safe authority boundary (current)

Three operation classes (defined in
`packages/shared/src/types/qsl-orchestrator-bridge.ts` on
`feat/qsl-chatgpt-orchestrator-bridge-v1`), enforced at **two independent
fail-closed gates**:

| Class | Operations | Gate 1: operator allowlist (`bridge-dispatch-readonly`, `ops/staging-bridge-v0` @ `363d2bffd`) | Gate 2: server route |
| --- | --- | --- | --- |
| Read-only (8) | `status`, `list-missions`, `get-mission`, `list-tasks`, `get-task`, `list-approvals`, `list-mail-triage`, `get-mail-thread-summary` | ALLOWED (hardcoded allowlist, 64KB stdin cap, jq validation, `environment=staging` gate) | allowed |
| Bounded write (6) | `create-task`, `update-task`, `assign-task`, `create-approval-request`, `create-outbound-draft`, `record-mission-evidence` | **REJECTED** — "operation not in read-only allowlist" | **BLOCKED** — HTTP 403 unless `PAPERCLIP_BRIDGE_ENABLE_BOUNDED_WRITES=true` (not set) |
| Human-gated (3) | `execute-approved-send`, `publish-approved-asset`, `accept-approved-commercial-commitment` | **REJECTED** (same allowlist) | BLOCKED |

Fail-closed belt-and-suspenders: the operator's hardcoded allowlist is
authoritative at the transport layer — even if the server flag were ever set
to `true`, bounded-write and human-gated operations never reach the bridge API
(operator-v1.sh header comment, lines 73–76). The server route independently
returns `server_side_idempotency_not_implemented` for bounded writes
(`server/src/routes/qsl-orchestrator-bridge.ts`, lines 85–102).

**Net authority today: read-only bridge restored and proven; bounded writes
fail-closed at both gates; human-gated sends unreachable.**

## 4. Minimum durable-receipt work required before bounded writes

The server route currently fail-closes bounded writes because
**server-side idempotency/receipts do not exist** (route comment, lines
85–89: prevents duplicate mutation when execution succeeds but the runner
fails before persisting its client-side ledger — today `.qsl/bridge-ledger.json`
is client-side only).

Minimum work before any write enablement can be *considered* (not implemented
in this lane):

1. **Durable server-side request receipts**: persist a receipt keyed by
   `request_id` atomically with (or durably before) applying any mutation, so
   a crash after execution but before client ledger persist cannot cause
   double-application. Receipts must live in the server's own storage, not the
   client-side `.qsl/bridge-ledger.json`.
2. **Replay semantics**: define and test duplicate-`request_id` behavior
   (idempotent replay returning the original receipt, never re-mutating).
3. **Activity-log receipts**: every applied bounded write must write an
   activity-log entry (control-plane invariant) linking `request_id` → actor →
   mutation.
4. **Explicit enablement**: only then set `PAPERCLIP_BRIDGE_ENABLE_BOUNDED_WRITES=true`
   in staging, and extend the SSH operator with a separate bounded-write
   forced command/allowlist (the current `bridge-dispatch-readonly` allowlist
   stays read-only).
5. Staged proof order for enablement: direct API smoke → external GitHub
   transport smoke → bounded-write exercise on a disposable company, mirroring
   §2 invariants.

## 5. Runbook — verifying the boundary without changing it

Read-only, no-deploy verification (executed 2026-09-04, all green):

```sh
# Extract the installed operator source SHA and run the real-execution test
git show 363d2bffd:.qsl/staging-ops/operator-v1.sh
git show 363d2bffd:.qsl/staging-ops/operator-runtime-test.sh
bash .qsl/staging-ops/operator-runtime-test.sh   # 7/7 PASS (see §6)
```

Windows/WSL harness pitfalls encountered today (operational knowledge):

- `*.sh` must be LF. Extracting via Windows (`Out-File`) introduces CRLF →
  `set -euo pipefail` fails with "invalid option name". This is exactly why
  the repo pins `*.sh` to LF via `.gitattributes` (readiness doc §4a). Fix:
  `sed -i 's/\r$//'` after extraction.
- A Windows `jq.exe` invoked from WSL cannot open WSL paths (`/tmp/...`) as
  file arguments → every jq-parsed case reports "invalid JSON". Use a native
  Linux jq binary (`jq-linux-amd64`) under WSL for the runtime test.
- The `bounded-write operation rejected by read-only gate` runtime-test case
  (valid staging JSON, `operation=record-mission-evidence`) is the direct
  local proof of Gate 1 in §3.

## 6. Tests run today (2026-09-04)

- Operator runtime test (real execution, WSL bash 5.1.16, jq 1.7.1 native
  Linux binary, no network) against v1.1.1 source @ `363d2bffd`: **7/7 PASS**
  — 6 structured BLOCKED-envelope fail-closed cases (incl. bounded-write
  rejection) + `operator-version` reports `qsl-staging-ops-v1.1.1`.
- Structural verification of v1.1.1 operator source: function
  `bridge_dispatch_readonly` defined at line 84, `case` dispatch after it;
  read-only allowlist exactly the 8 ops in §3.
- Bridge vitest suites (77 tests) and server typecheck: not re-run in this
  worktree (docs-only branch, no `node_modules`; the route/tests live on
  `feat/qsl-chatgpt-orchestrator-bridge-v1`). Already green in CI (runs
  `33828374803`, `33828388585` per readiness doc §6).

## 7. Explicit non-actions

- Production: not accessed, not changed.
- No new deployment; no bounded-write enablement; no credential changes.
- No durable-receipt implementation (§4 is a definition only, nothing
  enabling).
- Solved transport work not reopened.
