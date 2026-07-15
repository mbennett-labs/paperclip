# End of Day Log — 2026-07-14

## Executive Summary

Completed Sprint 3 of the Paperclip 2026 Operational Audit. Gathered implementation evidence across the full agent runtime stack (heartbeat scheduler, adapter invocation, session management), deep recovery/liveness mechanisms, cost/budget governance, secret binding, fork-specific Python governance layer, and the QSL bridge/review system. Synthesized eight design explainer documents with file references for every conclusion.

No production code was modified. No commits were made. The repository contains only new audit documentation.

---

## Work Completed

### Sprint 2 Handoff (Completed Prior, Verified Today)
- Relocated Sprint 2 readouts from `doc/plans/sprint-foundations/` to `docs/audits/paperclip-2026-operational-review/` after byte-for-byte identity verification.
- Deleted originals and cleaned up empty directories.

### Sprint 3 Evidence Gathering
Read and analyzed the following source files:

**Core Runtime**
- `server/src/services/heartbeat.ts` (full, ~2858 lines in two passes)
- `server/src/services/agents.ts`
- `server/src/services/run-log-store.ts`
- `server/src/services/issue-assignment-wakeup.ts`
- `server/src/adapters/index.ts`

**Adapter Execution**
- `packages/adapters/claude-local/src/server/execute.ts`
- `packages/adapters/codex-local/src/server/execute.ts`
- `packages/adapters/claude-local/src/index.ts`
- `packages/adapters/codex-local/src/index.ts`

**Recovery & Liveness**
- `server/src/services/recovery/service.ts` (full, ~2240 lines)
- `server/src/services/recovery/run-liveness-continuations.ts`
- `server/src/services/recovery/issue-graph-liveness.ts`
- `server/src/services/run-liveness.ts`

**Governance**
- `server/src/services/costs.ts`
- `server/src/services/budgets.ts`
- `server/src/services/secrets.ts`
- `server/src/services/workspace-runtime.ts`
- `server/src/services/adapter-plugin-store.ts`

**Schema Objects**
- `packages/db/src/schema/heartbeat_runs.ts`
- `packages/db/src/schema/heartbeat_run_events.ts`
- `packages/db/src/schema/heartbeat_run_watchdog_decisions.ts`
- `packages/db/src/schema/agent_wakeup_requests.ts`
- `packages/db/src/schema/agent_task_sessions.ts`
- `packages/db/src/schema/agent_runtime_state.ts`
- `packages/db/src/schema/budget_policies.ts`
- `packages/db/src/schema/budget_incidents.ts`
- `packages/db/src/schema/agents.ts`
- `packages/db/src/schema/environments.ts`
- `packages/db/src/schema/qsl_findings.ts`

**QSL Bridge & Fork Governance**
- `server/src/routes/qsl-bridge.ts`
- `server/src/services/qsl-review.ts`
- `scripts/runtime_guardian.py`
- `scripts/governance_checkpoint.py`

### Sprint 3 Documents Synthesized
All written to `docs/audits/paperclip-2026-operational-review/`:

1. `04_AGENT_RUNTIME.md`
2. `04A_RUN_LIFECYCLE.md`
3. `05_RECOVERY_AND_LIVENESS.md`
4. `05A_ISSUE_GRAPH_LIVENESS.md`
5. `06_COST_AND_BUDGET_GOVERNANCE.md`
6. `06A_SECRET_AND_ENVIRONMENT_BINDING.md`
7. `07_FORK_GOVERNANCE_LAYER.md`
8. `08_QSL_BRIDGE_AND_REVIEW_SYSTEM.md`

---

## Major Discoveries

1. **In-memory quota protection resets on server restart.** The sliding-window failure rate limiter (`agentFailureTimestamps`) lives inside `heartbeatService` closure and is not persisted. A restart gives every agent a blank slate.

2. **Dual session stores with subtle merge logic.** `agentTaskSessions` (task-scoped) and `agentRuntimeState` (agent singleton) both exist. The `resolveNextSessionState()` function iterates through codec serialize/deserialize, display ID truncation, and fallback chains that could cause cross-task session leakage if a codec misbehaves.

3. **Inline cost finalization blocks run completion.** `costService.createEvent()` triggers `budgets.evaluateCostEvent()` synchronously during heartbeat run finalization. A slow aggregate query directly extends the run's wall-clock latency.

4. **Recovery issues can backlog-pollute.** Every escalation (stranded issue, stale run, liveness violation) creates a full `issues` row. In a large company with many agents, recovery issues could outnumber real work items.

5. **Pause holds are manual-release only, forever.** Once `treeControlSvc.createHold(mode: "pause", releasePolicy: { strategy: "manual" })` is created during escalation, there is no auto-expiry or timed release. A forgotten hold strangles automatic execution permanently.

6. **QSL fingerprint collision risk.** `computeFingerprint()` uses only `title + threat_category + severity`. Two distinct security findings with the same title and severity will share a fingerprint and suppress each other.

7. **DB fallback to bridge files loses review state.** When the DB is unavailable, the QSL API returns raw `issues.json` without any `occurrenceCount`, review decision, or history. A board operator doing a review during a DB outage sees all findings as `new`.

8. **Python governance layer is file-only, not DB-backed.** `runtime_guardian.py` and `governance_checkpoint.py` read the filesystem and write to `logs/`. The escalation state and checkpoint chain are not replicated or backed up by Paperclip's PostgreSQL backup system.

9. **Checkpoint chain integrity check is O(n²) in the worst case.** The `format_summary_text()` function recomputes expected chain IDs by iterating all previous entries for each checkpoint.

---

## Repository State

**Branch:** `docs/paperclip-operational-audit-2026`

**Outstanding untracked files:**
- `doc/plans/2026-07-08-thebinmap-intelligence-constitution.md` (pre-existing, never committed)
- `docs/audits/` (entire audit directory tree, newly created)

**Production code modified:** None. Read-only audit.

**Commits made:** None.

---

## Architectural Insights

- The heartbeat scheduler is the central nervous system of the agent runtime, but its failure-handling logic (quota protection, transient retry, process loss) is scattered across `heartbeat.ts`, `run-liveness.ts`, and `recovery/service.ts` with overlapping but not unified abstractions.
- Budget enforcement is a **pre-check gate** (`getInvocationBlock`) plus a **post-hoc inline trigger** (`evaluateCostEvent`). These two paths are not transactionally coordinated; a cost event could slip through the pre-check under race conditions.
- Secret resolution happens at runtime, not at config-save time. This is correct for rotation support but means every run start can trigger external provider calls without visible timeout or circuit breaker.
- The QSL bridge's dual-mode (file/DB) architecture is a pragmatic availability choice, but it creates a **split-brain** scenario where the file view and DB view can diverge silently for hours if the sync step fails.
- Recovery's owner candidate ranking is copy-pasted with minor variations across stranded-issue, stale-run, and liveness-escalation resolution. A consolidated `resolveOwnerCandidate()` utility does not exist.

---

## Risks Identified

| Risk | Impact | Likelihood | Owner |
|---|---|---|---|
| In-memory quota loss on restart | Agent hammering upstream APIs after restart | Medium | Infrastructure |
| Session leakage across tasks | Sensitive context from one task bleeding into another | Low | Runtime engineering |
| Run finalization blocked by slow budget query | Cascading run delays, timer drift | Medium | Database / SRE |
| Recovery issue backlog explosion | Operational noise drowning real work | Medium | Recovery engineering |
| Forgotten pause holds | Entire agent execution permanently stalled | Low | Recovery engineering |
| QSL fingerprint collision | Security findings silently merged | Medium | Security integration |
| DB outage reveals stale bridge data | False positives in security review | Low | Security integration |
| Guardian escalation state lost on host failure | Undetected critical health degradation | Medium | Infrastructure |

---

## Questions Remaining

1. What is the intended migration path for `agentTaskSessions` replacing `agentRuntimeState`? Is deprecation planned?
2. Do external secret providers (in `secrets/provider-registry.js`) implement circuit breakers or timeouts? If a provider is slow, what happens to run start latency?
3. Is there a retention or rotation policy for `approvals.jsonl`, guardian logs (`guardian-{timestamp}.json`), and checkpoint index (`checkpoint-index.jsonl`)?
4. How does `instance_settings.getExperimental()` scope feature flags — globally per instance, or could it become per-company? The issue graph liveness auto-recovery toggle is global.
5. What is the exact resolution order when a budget hard-stop triggers during a run whose execution already passed the pre-check gate (`getInvocationBlock()` returned `null`) but whose cost event later crosses the threshold?
6. Where is the adapter registry (`getServerAdapter`) populated for external plugin adapters loaded via `adapter-plugin-store.ts`? Is there a startup bootstrap sequence?
7. How does `issueTreeControlService` enforce company boundaries when querying pause holds? Could a multi-company admin's session leak cross-company hold state?

---

## Tomorrow's Plan

**Priority 1 — Cross-System Interaction Map**
Produce a final integration document (`09_CROSS_SYSTEM_INTERACTION_MAP.md`) that traces a failure through the entire stack: run failure → liveness classification → continuation attempt → budget pre-check → recovery escalation → pause hold → issue graph liveness → board operator decision → checkpoint recording. This is the capstone readout that validates whether the system forms a coherent closed loop or a tangle of disjoint safety nets.

**Priority 2 — Plugin / External Adapter Discovery**
Trace the external adapter loading path: `adapter-plugin-store.ts` → startup bootstrap → `registerServerAdapter()` → UI parser registration (`ui/parse-stdout.ts`, `ui/build-config.ts`). Understand how Hermes (`hermes_local`) and Droid are loaded, and whether the plugin loader has any hardcoded references contrary to the "zero hardcoded imports" rule in `AGENTS.md`.

**Priority 3 — UI Execution Loop**
Deep-read the React board UI for operator intervention: how the board renders runs, liveness states, stale-run evaluations, and recovery issues; how the board triggers watchdog decisions (`snooze`/`continue`/`dismiss`); how the QSL findings review panel is wired to the bridge API.

## Definition of Success for Tomorrow

- `09_CROSS_SYSTEM_INTERACTION_MAP.md` is written and traces at least three end-to-end scenarios (budget hard-stop → run cancellation, liveness exhaustion → escalation, and orphaned blocker → recovery wakeup).
- Plugin loader code path is documented with exact file references.
- OR UI execution loop is read and summarized with operator-facing safety boundary analysis.
