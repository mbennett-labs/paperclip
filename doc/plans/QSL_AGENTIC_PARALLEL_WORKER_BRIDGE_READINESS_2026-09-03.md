# QSL Agentic Parallel Worker Bridge — Readiness (2026-09-03)

Lane: E (support) — make it possible for ChatGPT/QSL/Paperclip to dispatch and
supervise cheap-model Mission Cell work without manual terminal relaying.
Foreground product: Execution Verifier V0. Priority: Agentic Market Seeding.

Every claim below was verified from the repo or from today's GitHub Actions /
issue-#34 evidence. Nothing was executed against the VPS.

## 1. Current truth by area

| Area | State | Evidence |
| --- | --- | --- |
| QSL fork state | `mbennett-labs/paperclip` (upstream `paperclipai/paperclip`, last sync `sync/upstream-2026-06`) | `git remote -v` |
| Current-upstream integration | `feat/qsl-current-upstream-integration` @ `d14423fed` merges Mission Control V0 (#21), Hermes containment V0 (#22), Email Intake Ops V0 (#23), Hermes synthetic POC V0 (#24) | `git log` |
| ChatGPT/orchestrator bridge | `feat/qsl-chatgpt-orchestrator-bridge-v1` @ `dbda8c7da` (source repair promoted today); server route, shared types/validators, 17-op allowlist | `server/src/routes/qsl-orchestrator-bridge.ts`, `packages/shared/src/{types,validators}/qsl-orchestrator-bridge.ts` |
| Staging bridge transport | Branch-native commit-triggered: `.qsl/bridge-requests/<request_id>.json` → GH Actions dispatch → bounded SSH forced command → staging API → sanitized comment on issue #34 + `.qsl/bridge-ledger.json` | `.github/workflows/qsl-chatgpt-orchestrator-bridge-dispatch.yml` |
| Forced-command operator (repo) | `ops/staging-bridge-v0` `.qsl/staging-ops/operator-v1.sh` = `qsl-staging-ops-v1.1.1` incl. `bridge-dispatch-readonly` (64KB stdin cap, jq validation, `environment=staging` gate, hardcoded 8-op read-only allowlist, transport envelope with real HTTP status, fail-closed). **v1.1.1 fixes a runtime defect in v1.1.0** — see §5a | commits `30b877594`, `363d2bffd` |
| Operator v1.0 vs v1.1 drift | **CONFIRMED** (2026-09-03 record; **resolved 2026-09-04** — v1.1.1 installed, see §4 update). VPS ran v1.0.0; repo had v1.1.x. Today 21:26 UTC diagnostic bundle (run `33807976388`, issue #34): `OPERATOR=qsl-staging-ops-v1.0.0`. Consequence: today's three `status` requests hit the installed v1.0.0 operator, which has no `bridge-dispatch-readonly` op → `unsupported operation` → result posted as **UNKNOWN** | issue #34 comments, 2026-09-03 |
| GitHub Actions bridge paths | Dispatch: push to `feat/qsl-chatgpt-orchestrator-bridge-v1` with `paths: .qsl/bridge-requests/**`, `environment: staging`, secrets `QSL_STAGING_OPS_KEY` / `QSL_STAGING_KNOWN_HOSTS`, SSH `root@69.62.69.140`. Validate: typecheck + 3 bridge test suites + no-shell-orchestration proof | both workflow files on the bridge branch |
| Staging server-side bridge API | Deployed: staging deploy checkout runs branch `fix/qsl-email-mime-normalization-20260903` @ `bb1bbb3a`; API health `200 ok` | diagnostic bundle 2026-09-03 |

> **CORRECTION 2026-09-04**: the row above implied `bb1bbb3a` contained
> `server/src/routes/qsl-orchestrator-bridge.ts`. **It did not.** After the
> operator v1.1.1 install, a fresh status request failed with
> **"API route not found"** — the live staging base lacked the route. The route
> plus its app registration were added to the exact live staging base by the
> minimal integration commit `be6eac052d6215cc3a02bd5f62cb332088bc6f5d`
> ("fix(staging): add read-only QSL orchestrator bridge route on live staging
> base"), then `server/dist` was built, the service was restarted onto the
> built runtime, and the path was proven (direct localhost HTTP 200 / PASS,
> then GitHub transport PASS). See
> `QSL_WORKER_BRIDGE_HARVEST_2026-09-04.md` §1 for the exact sequence.
| Hermes/OpenRouter worker execution | Built-in `hermes_local` + `hermes_gateway` (no plugin install); OpenRouter key delivered only via governed company secrets (plaintext rejected, digest verified); bwrap containment with fail-closed egress; `containment.providerPreset="openrouter"` allowlists only `openrouter.ai:443` (subdomain/port denials tested) | `server/src/adapters/builtin-adapter-types.ts`, `packages/adapters/hermes/src/server/*` tests |
| Model selection for cheap workers | `adapterConfig.model` + provider auto-detect (`MODEL_PREFIX_PROVIDER_HINTS`: `deepseek`/`qwen`/`llama` → auto, `glm-` → zai, `kimi`/`moonshot` → kimi-coding, `minimax` → minimax); default model `auto` (never forces a frontier model); explicit `provider: "openrouter"` supported | `packages/adapters/hermes/src/shared/constants.ts` |
| Issue/result return path | Read-only ops live: `status`, `list-missions`, `get-mission`, `list-tasks`, `get-task`, `list-approvals`, `list-mail-triage`, `get-mail-thread-summary` → `{result_class, evidence_summary, affected_ids}`. Bounded writes (`create-task`, `update-task`, `assign-task`, `create-approval-request`, `create-outbound-draft`, `record-mission-evidence`) fail-closed until durable server-side receipts + `PAPERCLIP_BRIDGE_ENABLE_BOUNDED_WRITES=true`. Human-gated: `execute-approved-send`, `publish-approved-asset`, `accept-approved-commercial-commitment` | bridge route on bridge branch |

## 2. Minimum architecture for a bounded worker mission

Example missions: "research these markets", "implement this isolated branch".

```
ChatGPT/QSL (supervisor)
  └─ commit .qsl/bridge-requests/<request_id>.json  → push to bridge branch
       └─ GH Actions dispatch (staging env, bounded SSH key)
             └─ ssh forced command `bridge-dispatch-readonly` (operator v1.1.1)
                 └─ POST /api/qsl-orchestrator-bridge/companies/:id/bridge
                      └─ staging Paperclip
                           ├─ read-only: mission/task state, approvals, evidence
                           └─ (writes fail-closed until durable receipts)
                           └─ worker agent: hermes_local, model=openrouter/<cheap>
                                OPENROUTER_API_KEY from governed company secrets
                                bwrap containment, egress openrouter.ai:443 only
            └─ sanitized result → issue #34 comment + .qsl/bridge-ledger.json
```

Return contract to the supervising workflow:
- **status**: `result_class` (PASS/BLOCKED/FAIL) in the transport envelope,
  persisted in the ledger and the result comment.
- **result**: operation-specific payload (`evidence_summary`, `affected_ids`).
- **evidence**: `evidence_summary` (≤ 50K chars server-side, sanitized for
  egress); run transcripts stay inside staging Paperclip.
- **branch/SHA**: staging deploy git metadata (diagnostic bundle reports
  HEAD/BRANCH); worker output branches are ordinary Paperclip workspaces, so a
  mission can carry its branch/SHA in evidence once `record-mission-evidence`
  is enabled.

Cost discipline: workers should be DeepSeek / GLM / Kimi / MiniMax / Qwen class
via `openrouter/...` model ids; the orchestrator never assumes frontier models
(default model is `auto`).

## 3. What already works without root/server changes

- The full loop up to the operator gate: commit request → dispatch workflow →
  bounded SSH → BLOCKED/FAIL classification → ledger → issue #34 comment
  (proven by today's runs; transport green, result truthful after today's fix).
- Repo-side validation: 77 bridge tests, server typecheck, no-shell-orchestration
  proof all green locally and in CI.
- Staging server-side bridge API is already deployed (no deploy needed).
- Entire Hermes worker stack repo-side: adapters, containment, secret gating,
  cheap-model configuration — provable locally via tests.
- Windows local dev of the bridge: fixed by pinning bridge `.mjs` to LF.

## 4. Exact one-time human/root step (executed successfully 2026-09-04)

> **UPDATE 2026-09-04**: this step was executed. Operator `qsl-staging-ops-v1.1.1`
> is installed on staging and proven by direct + GitHub-transport status PASS.
> The drift described below is resolved. Text below preserved as the 2026-09-03
> record.

The `root@69.62.69.140` forced-command dispatcher is the installed v1.0.0
operator; only root can replace it (it is root-owned and referenced from
`/root/.ssh/authorized_keys`). One-time, pinned, reversible:

```sh
# on the staging VPS, as root, from the staging deploy checkout
sudo -H bash .qsl/staging-ops/bootstrap-operator-v1.sh <40-char-SHA-of-ops/staging-bridge-v0>
```

Why this script is safe: it requires an explicit 40-char SHA, fetches and
verifies that object in the staging checkout, extracts `operator-v1.sh` +
`CEO_AGENTS.md` from git at that SHA, `bash -n` syntax-checks them, backs up the
current dispatcher to `<dispatcher>.v0` before install, installs, and records
the source SHA in `/usr/local/share/qsl-staging-ops/operator-source-sha`.

Post-install verification (repo-side, no root):
1. `operator-version` forced command → expect `qsl-staging-ops-v1.1.1`.
2. Commit one new `.qsl/bridge-requests/status-...json` → expect a `PASS`
   transport envelope comment on issue #34 and a ledger entry with
   `result: PASS` (not UNKNOWN).

## 4a. Follow-up review (2026-09-04): operator runtime defect found, fixed

Independent review claimed `bridge_dispatch_readonly` was invoked (line 206)
before its definition (line 233) in operator-v1.sh v1.1.0. **Reproduced and
confirmed** against the actual branch:

```
$ printf "" | bash operator-v1.sh bridge-dispatch-readonly   # empty stdin
./operator-v1.sh: line 206: bridge_dispatch_readonly: command not found
EXIT=127, stdout empty (no envelope) — same for malformed JSON
```

`bash -n` passes because the file is syntactically valid; bash executes
top-to-bottom, so every real `bridge-dispatch-readonly` dispatch died before
any envelope existed. Installing v1.1.0 unmodified would have locked the
bridge transport with `command not found` on every request.

Fix (branch `work/qsl-operator-dispatch-order-fix`, fast-forwarded to
`ops/staging-bridge-v0` @ `363d2bffd`, VERSION bumped to **v1.1.1**):

- moved the function definition (body byte-identical; allowlist, gates, and
  envelope behavior unchanged; no authority broadened) above the case
  dispatch, with a comment explaining why;
- added `.qsl/staging-ops/operator-runtime-test.sh` — a REAL execution test
  (not `bash -n`): runs the operator with empty / malformed / non-staging /
  missing-operation / non-allowlisted / bounded-write inputs and asserts the
  structured BLOCKED envelope, exit 1, and absence of `command not found`;
  no network required (all paths return before curl);
- added `qsl-staging-operator-runtime-test` CI workflow (syntax checks +
  structural definition-before-dispatch guard + the runtime test); green on
  both branches: runs `33828374803`, `33828388585`;
- added the same structural guard to `bootstrap-operator-v1.sh` (exit 7,
  pre-install) so a re-introduced ordering defect can never be installed;
- `*.sh` pinned to LF via `.gitattributes` (CRLF working copies fail at
  runtime under WSL/Git Bash).

Bootstrap/rollback review conclusion: `.v0` is the **legacy pre-V1
dispatcher** that `operator-v1.sh` delegates to for v0-era ops
(`LEGACY="${BASH_SOURCE[0]}.v0"`, ops `health|live-shadow-report|
deploy-email-plugin`) — it is NOT a generic rollback slot and must never be
overwritten by an upgrade. Added a **separate timestamped+SHA pre-upgrade
snapshot** (`<dispatcher>.pre-<UTC ts>-<sha8>`, retention 3) of the currently
installed dispatcher, so a bad V1→V1' upgrade rolls back without regressing
legacy delegation; the bootstrap now prints `ROLLBACK_CMD` and expects
`operator-version` to report the candidate version post-install.

## 5. Repo-only work completed this session

1. `feat/qsl-chatgpt-orchestrator-bridge-v1` @ `dbda8c7da` —
   `fix(qsl): promote dispatcher source repair and fail-closed transport classification`:
   - defined `requestJson` inside `callBridgeViaSsh` (source repair) and removed
     the temporary runtime-patch step from the dispatch workflow;
   - SSH transport failures now classify as **FAIL** with the sanitized
     operator stderr (previously an opaque **UNKNOWN** — this is exactly what
     hid the v1.0/v1.1 drift today); FAIL exits non-zero;
   - 8 new unit tests: stdin serialization, forced-command args, envelope
     parsing, FAIL classification, healthy-envelope PASS path;
   - `.gitattributes` pins `scripts/qsl-chatgpt-orchestrator-bridge/*.mjs` to
     LF (Vite/vitest on Windows cannot import CRLF `.mjs`; this broke local
     runs, CI was unaffected).
2. Follow-up (2026-09-04), `ops/staging-bridge-v0` + `work/qsl-operator-dispatch-order-fix`
   @ `363d2bffd4cb5ad29b37491fdca9301abbc533ee` — see §4a: reproduced,
   fixed, and regression-tested the operator dispatch-order defect; hardened
   the bootstrap with a structural guard and a separate pre-upgrade rollback
   snapshot.
3. This readiness document (branch `work/agentic-e-worker-bridge-20260903`).

## 6. Tests run

- Operator runtime test (real execution, WSL bash 5.1 + jq 1.7.1, no network):
  buggy v1.1.0 → **6/6 execution cases FAIL** with exit 127
  `bridge_dispatch_readonly: command not found` (suite exit 1 — test detects
  the defect); fixed v1.1.1 → **7/7 PASS** (6 BLOCKED-envelope cases +
  `operator-version` reports `qsl-staging-ops-v1.1.1`).
- Function-body diff vs v1.1.0 → **identical** (allowlist/behavior preserved).
- Bootstrap structural guard simulation: REJECT buggy operator (exit 7),
  ACCEPT fixed operator.
- `bash -n` on operator, bootstrap, runtime test → pass.
- CI `QSL Staging Operator Runtime Test` → **success** on both pushes
  (runs `33828374803`, `33828388585`).
- Bridge vitest suites re-run after all changes → **77 passed**.
- `pnpm --filter @paperclipai/server typecheck` → pass.
- `node --check` + CLI `--help` smoke of `dispatch-request.mjs` → pass.
- CI validate workflow on the source-repair push: run `33823571113`.

## 7. Terminal state

> **SUPERSEDED 2026-09-04**: the §4 bootstrap was executed successfully on
> 2026-09-04. Exact sequence preserved from the 2026-09-04 evidence:
> 1. Operator v1.1.1 installed.
> 2. Fresh status request failed "API route not found" (live staging base had
>    no orchestrator route — the §1 `bb1bbb3a` row's containment claim was
>    wrong).
> 3. Minimal staging integration commit
>    `be6eac052d6215cc3a02bd5f62cb332088bc6f5d` added the read-only route plus
>    app registration on the exact live staging base.
> 4. `server/dist` was built.
> 5. Service was restarted onto the built runtime.
> 6. Direct localhost bridge status returned HTTP 200 / PASS.
> 7. Fresh GitHub request `12cf5014f62b8518d3a2ae977103298a779eb8ce`
>    (`request_id=status-20260904-1345-chatgpt`); dispatch workflow run
>    `33879822426` completed success; issue #34 recorded
>    `result PASS`, evidence "Status resolved. Recent issues: 5.".
>
> The evidence-backed terminal status is now **READ_ONLY_BRIDGE_PROVED** — see
> `QSL_WORKER_BRIDGE_HARVEST_2026-09-04.md` for the harvest, invariants, and
> current authority boundary. Text below preserved as the 2026-09-03 record.

**ROOT_BOOTSTRAP_READY** — repo-side work is complete (bridge transport source
repair + operator dispatch-order fix v1.1.1 + runtime tests + bootstrap
hardening, all green locally and in CI). The single remaining step for
read-only dispatch is the one-time pinned operator bootstrap in §4, run from
`ops/staging-bridge-v0` @ `363d2bffd`:

```sh
sudo -H bash .qsl/staging-ops/bootstrap-operator-v1.sh 363d2bffd4cb5ad29b37491fdca9301abbc533ee
```

Bounded-write worker result return additionally requires the documented
server-side durable-receipt work (already fail-closed, no data risk until
explicitly enabled).
