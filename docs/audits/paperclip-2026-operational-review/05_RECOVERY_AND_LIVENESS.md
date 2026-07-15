# 05 — Recovery & Liveness: Bounded Retry, Orphan Handling, and Watchdog Escalation

> **Scope:** The recovery service (`recovery/service.ts`), bounded liveness continuations, stale-run watchdog, stranded-issue recovery, and the pause-hold guard.
> **Status:** Read-only audit. All claims verified against implementation.

---

## 1. Recovery Service Architecture

### 1.1 Service Factory (`recovery/service.ts` lines 297–303)

```ts
export function recoveryService(db: Db, deps: { enqueueWakeup: RecoveryWakeup }) {
  const issuesSvc = issueService(db);
  const treeControlSvc = issueTreeControlService(db);
  const budgets = budgetService(db);
  const instanceSettings = instanceSettingsService(db);
  const runLogStore = getRunLogStore();
  ...
}
```

The recovery service is stateless and instantiated per-DB-connection. It depends on `enqueueWakeup` (the heartbeat scheduler’s wakeup function) as its only side-effect hook. All other mutations go through `issuesSvc`, `treeControlSvc`, and direct DB writes.

### 1.2 Recovery Timer Integration

Recovery runs on a periodic timer (not inside the service itself; the caller is the server’s background job scheduler). The exported functions are:

- `scanSilentActiveRuns()` — stale active run watchdog.
- `reconcileStrandedAssignedIssues()` — detect and recover lost assignment/continuation paths.
- `reconcileIssueGraphLiveness()` — dependency-graph analysis and escalation.
- `recordWatchdogDecision()` — board/agent decision capture for stale runs.

---

## 2. Bounded Liveness Continuations

### 2.1 Motivation

When a run ends with `livenessState = "plan_only"` or `"empty_response"`, the agent described work but did not execute it. The recovery system can enqueue a **continuation wake** to prompt the agent to take concrete action.

### 2.2 Decision Logic (`recovery/run-liveness-continuations.ts`)

`decideRunLivenessContinuation()` applies a strict precondition filter:

| Check | Failure Result |
|---|---|
| `livenessState` not actionable | `skip` |
| No linked issue | `skip` |
| Issue no longer assigned to source agent | `skip` |
| Issue status not `todo` or `in_progress` | `skip` |
| Issue has `executionState` (blocked by policy) | `skip` |
| Agent not invokable (`active`/`idle`/`running`/`error`) | `skip` |
| Budget hard-stop active | `skip` |
| `continuationAttempt >= maxAttempts` | `exhausted` |
| Prior and current error signatures identical | `skip` |
| Idempotent wake already exists | `skip` |

### 2.3 Max Attempts

```ts
export const DEFAULT_MAX_LIVENESS_CONTINUATION_ATTEMPTS = 2;
```

This is a **hard ceiling**, not configurable per-agent in the current code. The `maxAttempts` parameter exists but defaults to 2 everywhere.

### 2.4 Idempotency

Each continuation wake carries an `idempotencyKey`:

```ts
export function buildRunLivenessContinuationIdempotencyKey(input) {
  return [
    RUN_LIVENESS_CONTINUATION_REASON,
    input.issueId,
    input.sourceRunId,
    input.livenessState,
    String(input.nextAttempt),
  ].join(":");
}
```

`findExistingRunLivenessContinuationWake()` queries `agentWakeupRequests` for any row with the same key and status in `queued`, `deferred_issue_execution`, or `completed`. If found, the continuation is suppressed.

### 2.5 Exhaustion Behavior

When max attempts are reached, the system:
1. Posts a `"Bounded liveness continuation exhausted"` comment on the issue (idempotent, keyed by `createdByRunId`).
2. Does **not** escalate to a manager issue automatically. The issue remains in its current state until a human intervenes.

---

## 3. Stranded Assigned Issue Recovery

### 3.1 Definition

A **stranded assigned issue** is an issue with `assigneeAgentId != null`, `assigneeUserId == null`, status in `todo` or `in_progress`, and **no active execution path** (no running run and no queued deferred wake for that issue).

### 3.2 Recovery Flow (`recovery/service.ts` lines 1467–1601)

For each candidate:

1. **Check invokability** — agent must exist, belong to the company, and be invokable.
2. **Check active execution path** — skip if a run or deferred wake is already queued.
3. **Check pause hold** — skip if `isAutomaticRecoverySuppressedByPauseHold()` returns true.
4. **Resolve latest run** — find the most recent `heartbeatRuns` row with `contextSnapshot->>issueId` matching.

#### Branch A: Status = `todo`

- If no latest run or latest run succeeded → skip (normal idle state).
- If `didAutomaticRecoveryFail(latestRun, "assignment_recovery")` → **escalate** (see 3.3).
- Otherwise → enqueue stranded-issue recovery wake with `retryReason: "assignment_recovery"`.

#### Branch B: Status = `in_progress`

- If no latest run and no `checkoutRunId` / `executionRunId` → skip.
- If `didAutomaticRecoveryFail(latestRun, "issue_continuation_needed")` → **escalate**.
- Otherwise → enqueue continuation recovery wake with `retryReason: "issue_continuation_needed"`.

### 3.3 Escalation (`recovery/service.ts` lines 1383–1465)

Escalation creates a **recovery issue** (`originKind = "stranded_issue_recovery"`) assigned to a manager/creator/executive candidate. It then:
- Moves the source issue to `blocked`.
- Adds the recovery issue to the source issue’s `blockedByIssueIds`.
- Posts a comment explaining the failure.
- Logs activity.
- Creates a **pause hold** on the source issue (`mode: "pause"`, `releasePolicy: { strategy: "manual" }`) so automatic recovery cannot resume until a human releases it.

### 3.4 Owner Resolution (`recovery/service.ts` lines 1210–1244)

Candidate ranking for recovery owner:
1. Assignee’s `reportsTo` manager.
2. Creator’s `reportsTo` manager.
3. Creator agent itself.
4. `cto` role agents, then `ceo` role agents.
5. Original assignee as last resort.

Each candidate is checked for invokability and budget availability. The first match wins.

---

## 4. Unassigned Blocking Issue Recovery

### 4.1 Definition

An **orphan blocker** is an issue with:
- `status` in `todo` or `blocked`
- `assigneeAgentId` and `assigneeUserId` both null
- `createdByAgentId` not null
- At least one related issue blocked by it that is not `done`/`cancelled`

### 4.2 Reconciliation (`recovery/service.ts` lines 408–523)

For each orphan blocker:
1. Reassign it to `createdByAgentId`.
2. Post an "Assigned Orphan Blocker" comment.
3. Log activity.
4. Enqueue a wakeup for the creator agent.

If the creator agent is not invokable or has no budget, the issue is skipped.

---

## 5. Stale Active Run Watchdog

### 5.1 Scan Trigger

`scanSilentActiveRuns()` queries all `heartbeatRuns` with:
- `status = "running"`
- `coalesce(lastOutputAt, processStartedAt, startedAt, createdAt) <= suspicionBefore`

Where `suspicionBefore = now - ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS (1 hour)`.

### 5.2 Evaluation Outcomes

For each candidate:
- If a snooze decision is active → count as `snoozed`.
- Otherwise, `createOrUpdateStaleRunEvaluation()` creates or updates a review issue.

The review issue (`originKind = "stale_active_run_evaluation"`) contains:
- Run metadata (pid, process group, in-memory handle status)
- Log tail excerpt (last 8KB)
- Recent run events (last 8)
- Child issues and current blockers
- Decision checklist for the reviewer

### 5.3 Escalation to Critical (`recovery/service.ts` lines 875–1002)

If silence exceeds `ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS (4 hours)`:
- The evaluation issue priority is bumped to `high`.
- The **source issue** is blocked on the evaluation issue.
- A comment is posted on the source issue linking it to the evaluation.

### 5.4 Owner Resolution for Stale Runs (`recovery/service.ts` lines 662–694)

Candidate ranking:
1. Source issue assignee’s manager.
2. Running agent’s manager.
3. `cto` agents, then `ceo` agents.

Budget checks are applied.

### 5.5 Watchdog Decision Recording (`recovery/service.ts` lines 1048–1190)

Actors allowed to record decisions:
- **Board** (`type: "board"`) — any user.
- **Assigned recovery owner agent** (`type: "agent"`) — only if the evaluation issue exists, is bound to this run, and is assigned to the actor agent.

Decision types:
- `snooze` — extends the quiet-until deadline (max 7 days).
- `continue` — re-arms the evaluation for `ACTIVE_RUN_OUTPUT_CONTINUE_REARM_MS` (30 min).
- `dismissed_false_positive` — closes the evaluation.

---

## 6. Pause-Hold Guard

### 6.1 Purpose

Prevents automatic recovery from re-escalating or re-enqueuing an issue that has already been escalated. Gives humans a manual gate before automation resumes.

### 6.2 Suppression Check (`recovery/pause-hold-guard.ts` — inferred from usage)

`isAutomaticRecoverySuppressedByPauseHold(db, companyId, issueId, treeControlSvc)` queries the `issueTreeControlService` for an active hold on the issue. If found, recovery skips the issue.

The pause hold is created during escalation (see 3.3) with:
- `mode: "pause"`
- `releasePolicy: { strategy: "manual" }`
- Actor: `system`

---

## 7. Activity Logging

Every recovery action writes an `activityLog` entry:
- `actorType: "system"`
- `actorId: "system"`
- `action` values: `issue.updated`, `heartbeat.output_stale_detected`, `heartbeat.output_stale_escalated`, `issue.harness_liveness_escalation_created`, `issue.blockers.updated`, `budget.*`

This provides an immutable audit trail for post-mortem analysis.

---

## 8. Architectural Contradictions

1. **Recovery escalation creates issues, not alerts.** Every escalation becomes a full issue in the work system. In a high-churn environment, recovery issues could outnumber real work items, polluting the backlog.

2. **Pause holds are manual-release only.** Once a pause hold is created, there is no automatic expiration or timed release. If a human forgets to release it, the issue is stranded forever.

3. **`didAutomaticRecoveryFail()` is broad but not precise.** It catches any terminal failure on a recovery-originated run, including transient upstream errors that might resolve on their own. This can cause premature escalation.

4. **Stale run evidence collection is synchronous and heavy.** For each stale candidate, the system reads run log tail, queries 8 run events, child issues, and blockers — all in one `Promise.all`. With 100 candidates (the scan limit), this is a significant DB burst.

5. **Owner resolution repeats the same candidate query pattern in three places** (stranded issue, stale run, liveness escalation). The ranking logic is copy-pasted with minor variations, making consistency maintenance fragile.

6. **Recovery timer interval is not company-scoped.** `readRecoveryTimerIntervalMs()` returns a global value. A company with 10 agents and a company with 1000 agents use the same scan cadence.
