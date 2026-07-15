# 04A — Run Lifecycle: States, Transitions, Log Capture & Restart Semantics

> **Scope:** The complete lifecycle of a single `heartbeatRuns` row, from queueing through terminal completion, including process supervision, output streaming, liveness classification, and restart boundaries.
> **Status:** Read-only audit. All claims verified against implementation.

---

## 1. Run Schema (`heartbeatRuns`)

Source: `packages/db/src/schema/heartbeat_runs.ts`

| Field | Runtime Significance |
|---|---|
| `status` | `queued` → `running` → (`succeeded` \| `failed` \| `cancelled` \| `timed_out` \| `scheduled_retry`) |
| `invocationSource` | `on_demand`, `timer`, `assignment`, `automation` |
| `triggerDetail` | `manual`, `ping`, `callback`, `system` |
| `wakeupRequestId` | FK to `agentWakeupRequests`; links run to its originating wake. |
| `sessionIdBefore` / `sessionIdAfter` | Session identity captured before and after execution; used for resume decisions and compaction analysis. |
| `exitCode` / `signal` / `error` / `errorCode` | Process-level and semantic failure codes. |
| `usageJson` | Raw provider usage (input tokens, output tokens, cached tokens). |
| `resultJson` | Provider-specific structured output; can be large; has safe truncation rules. |
| `logStore` / `logRef` / `logBytes` / `logSha256` / `logCompressed` | References to external log storage (currently only `local_file`). |
| `stdoutExcerpt` / `stderrExcerpt` | Byte-capped excerpts for UI display without reading full logs. |
| `processPid` / `processGroupId` / `processStartedAt` | OS-level process tracking for orphan detection and termination. |
| `retryOfRunId` | Self-referencing FK for bounded transient retries. |
| `scheduledRetryAt` / `scheduledRetryAttempt` / `scheduledRetryReason` | Retry scheduling metadata. |
| `livenessState` / `livenessReason` / `continuationAttempt` | Post-run classification consumed by recovery. |
| `lastUsefulActionAt` / `nextAction` | Evidence timestamp and extracted next-step text. |
| `contextSnapshot` | JSON capture of wake context (issueId, taskKey, wakeReason, etc.) for sorting and recovery queries. |

### 1.1 Database Indexes

The schema declares four composite indexes:
- `companyAgentStartedIdx` — list runs for an agent.
- `companyLivenessIdx` — filter recovery scans by liveness state.
- `companyStatusLastOutputIdx` — detect stale active runs.
- `companyStatusProcessStartedIdx` — orphan detection.

---

## 2. Run Status Transitions

### 2.1 Creation (`heartbeat.ts` — inside `executeRun` flow)

A run is created with `status = "queued"`. It is immediately transitioned to `"running"` when the adapter process is spawned. If the scheduler decides a retry is needed before spawning, it may be created directly as `"scheduled_retry"`.

### 2.2 Terminal Status Assignment (`heartbeat.ts` — `setRunStatus()`)

```ts
async function setRunStatus(runId, status, patch?) {
  const updated = await db.update(heartbeatRuns)
    .set({ status, ...patch, updatedAt: new Date() })
    .where(eq(heartbeatRuns.id, runId))
    .returning()
    .then(rows => rows[0] ?? null);

  if (updated) {
    if (updated.status === "failed" || updated.status === "timed_out") {
      recordAgentFailure(updated.agentId); // quota protection
    }
    publishLiveEvent({ ... });
    publishRunLifecyclePluginEvent(updated);
  }
}
```

Every status change:
1. Persists to DB.
2. If terminal failure, increments the in-memory quota-protection window.
3. Pushes a live WebSocket event for UI refresh.
4. Publishes a plugin domain event (`agent.run.started` / `.finished` / `.failed` / `.cancelled`).

### 2.3 Cancellation (`heartbeat.ts`)

Cancellation is allowed while `status` is in `CANCELLABLE_HEARTBEAT_RUN_STATUSES`:
- `queued` — soft-cancel by marking status.
- `running` / `scheduled_retry` — sends `SIGTERM` to `processPid` / `processGroupId`, then marks status.

The `terminateHeartbeatRunProcess()` helper delegates to `terminateLocalService()` from `local-service-supervisor.ts` with a configurable grace period.

### 2.4 Timeout

If the adapter process exceeds `timeoutSec`, `runAdapterExecutionTargetProcess()` (from `@paperclipai/adapter-utils`) kills the process and returns `timedOut: true`. The heartbeat service then sets `status = "timed_out"`.

---

## 3. Process Supervision & Orphan Detection

### 3.1 Process Tracking

During execution, the adapter utilities record:
- `processPid` — the direct child PID.
- `processGroupId` — the process group for group-kill safety.
- `processStartedAt` — timestamp for staleness calculations.

### 3.2 Is the Process Still Alive? (`heartbeat.ts` lines 1823–1834)

```ts
function isProcessAlive(pid) {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = error?.code;
    if (code === "EPERM") return true;  // alive but we lack permission
    if (code === "ESRCH") return false; // no such process
    return false;
  }
}
```

This is a best-effort check. PID recycling on Linux means `isProcessAlive` is a necessary but not sufficient signal.

### 3.3 Process Loss (`heartbeat.ts` lines 1860–1874)

When the server detects that a `"running"` run’s PID is gone but the run was not explicitly cancelled, it builds a `processLoss` message:

```ts
function buildProcessLossMessage(run, options?) {
  if (options?.descendantOnly && run.processGroupId) {
    return `Process lost -- parent pid ${run.processPid} exited, but descendant process group ${run.processGroupId} was still alive and was terminated`;
  }
  if (run.processPid) {
    return `Process lost -- child pid ${run.processPid} is no longer running`;
  }
  return "Process lost -- server may have restarted";
}
```

Process loss triggers a `failed` terminal status (unless the run had already reached a terminal state before the loss was detected).

---

## 4. Output Streaming & Log Persistence

### 4.1 Dual Output Path

Every stdout/stderr chunk from the adapter process travels along two parallel paths:

1. **Run Log Store** (`run-log-store.ts`) — append-only NDJSON file.
2. **Heartbeat Run Events** (`heartbeatRunEvents` table) — structured DB rows.

### 4.2 Log Store Format (`run-log-store.ts`)

```ts
const line = JSON.stringify({ ts: event.ts, stream: event.stream, chunk: event.chunk });
await fs.appendFile(absPath, `${line}\n`, "utf8");
```

Each line is a JSON object. The store supports offset-based streaming reads for UI tailing.

### 4.3 Event Table Boundaries (`heartbeat.ts` lines 126–134)

```ts
const MAX_PERSISTED_LOG_CHUNK_CHARS = 64 * 1024;
const MAX_RUN_EVENT_PAYLOAD_STRING_CHARS = 16 * 1024;
const MAX_RUN_EVENT_PAYLOAD_ARRAY_ITEMS = 50;
const MAX_RUN_EVENT_PAYLOAD_OBJECT_KEYS = 100;
const MAX_RUN_EVENT_PAYLOAD_DEPTH = 6;
```

Large payloads are truncated with `_truncated: true` markers. Base64 image data is redacted inline via regex:

```ts
const INLINE_BASE64_IMAGE_DATA_RE = /("type":"image","source":\{"type":"base64","data":")([A-Za-z0-9+/=]{1024,})(")/g;
```

### 4.4 Excerpt Accumulation (`heartbeat.ts` lines 753–755)

```ts
function appendExcerpt(prev, chunk) {
  return appendWithByteCap(prev, chunk, MAX_EXCERPT_BYTES);
}
```

`stdoutExcerpt` and `stderrExcerpt` are capped at `MAX_EXCERPT_BYTES` (defined in adapters utils) so the UI can show a preview without fetching the full log file.

### 4.5 Safe Result JSON Projection (`heartbeat.ts` lines 662–706)

The `heartbeatRunSafeResultJsonColumn` uses a SQL expression to automatically downsize oversized `resultJson` at query time:

- If `pg_column_size(resultJson) > HEARTBEAT_RUN_SAFE_RESULT_JSON_MAX_BYTES`, strip it to only `summary`, `result`, `message`, `error`, truncated `stdout`/`stderr`, and cost fields.
- Adds `truncated: true` and `truncationReason: "oversized_result_json"`.

This means the full `resultJson` is still in the DB, but list APIs and legacy-ASCII-safe queries receive a capped view.

---

## 5. Restart & Retry Semantics

### 5.1 Bounded Transient Retry

When a run ends with `errorFamily === "transient_upstream"`, `computeBoundedTransientHeartbeatRetrySchedule()` calculates the next `scheduledRetryAt`. A new wakeup is enqueued with `source: "automation"` and `triggerDetail: "system"`. The `scheduledRetryAttempt` field is incremented.

If `scheduledRetryAttempt >= BOUNDED_TRANSIENT_HEARTBEAT_RETRY_MAX_ATTEMPTS`, no further retry is scheduled and the run remains terminal.

### 5.2 Process Loss Retry (`heartbeat.ts`)

If a running process is detected as lost (server restart or PID death), the run is marked `failed`. A separate logic path checks `processLossRetryCount`. If below a threshold, a recovery wakeup may be enqueued with `retryOfRunId` pointing to the lost run.

### 5.3 Session Resume on Retry (`heartbeat.ts` — `resolveExplicitResumeSessionOverride()`)

A retry wakeup can carry `payload.resumeFromRunId`. The scheduler reads that run’s `sessionIdAfter` and attempts to resume the same session, allowing the agent to continue context across retries.

---

## 6. Liveness Bookkeeping After Run Completion

### 6.1 Classification Trigger

Immediately after `setRunStatus()` transitions to a terminal state, `classifyRunLiveness()` (`server/src/services/run-liveness.ts`) is called with:

- Run status, error, errorCode
- Issue state (if linked)
- `resultJson` content
- Evidence counts (comments, document revisions, work products, etc.)

### 6.2 Liveness States

From `run-liveness.ts` (`classifyRunLiveness()` returns one of):

| State | Meaning |
|---|---|
| `advanced` | Run produced concrete evidence of progress. |
| `completed` | Issue is `done` or `cancelled`. |
| `blocked` | Issue is `blocked` or output declared a concrete blocker. |
| `plan_only` | Run described runnable future work without concrete action evidence. |
| `empty_response` | Run succeeded without useful output or concrete evidence. |
| `needs_followup` | Produced useful output but no concrete action; may need human review. |
| `failed` | Run ended in failure, timeout, or cancellation. |

### 6.3 Actionability Extraction

`classifyRunActionability()` scans output text with regex heuristics:
- `APPROVAL_REQUIRED_RE` → `approval_required`
- `EXTERNAL_BLOCKER_RE` / `BLOCKER_RE` → `blocked_external`
- `MANAGER_REVIEW_RE` → `manager_review`
- `RUNNABLE_RE` → `runnable`
- Otherwise → `unknown`

These are **not** structured fields from the adapter; they are inferred from free-text output.

### 6.4 Continuation Attempt Counter

`continuationAttempt` on `heartbeatRuns` counts how many times the recovery system has retried a `plan_only` or `empty_response` run for the same issue. It is read and incremented by `run-liveness-continuations.ts`.

---

## 7. Watchdog: Stale Active Run Detection

### 7.1 Silence Thresholds (`recovery/service.ts` lines 41–43)

```ts
export const ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS = 60 * 60 * 1000;   // 1 hour
export const ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS = 4 * 60 * 60 * 1000; // 4 hours
export const ACTIVE_RUN_OUTPUT_CONTINUE_REARM_MS = 30 * 60 * 1000;         // 30 min
```

### 7.2 Silence Evaluation

`buildRunOutputSilence()` computes:
- `silenceStartedAt` = `lastOutputAt` ?? `processStartedAt` ?? `startedAt` ?? `createdAt`
- `silenceAgeMs` = now - silenceStartedAt
- `level` = `ok` / `suspicious` / `critical` / `snoozed`

A run is only evaluated if `status === "running"`.

### 7.3 Snooze Decisions (`heartbeatRunWatchdogDecisions`)

Board operators or recovery agents can record `snooze`, `continue`, or `dismissed_false_positive` decisions. Snoozes have a max duration of `MAX_WATCHDOG_SNOOZE_DURATION_MS = 7 days`.

The `heartbeat_run_watchdog_decisions` table (`packages/db/src/schema/heartbeat_run_watchdog_decisions.ts`) stores:
- `decision`, `snoozedUntil`, `reason`
- `createdByAgentId` / `createdByUserId` / `createdByRunId` — full actor attribution.

---

## 8. Architectural Contradictions

1. **Process loss detection is racy.** `isProcessAlive(pid)` races against PID recycling. A recycled PID could make a dead run appear alive, delaying orphan recovery.

2. **Log store is singleton-cached with no eviction.** `getRunLogStore()` caches the store instance forever. Changing `RUN_LOG_BASE_PATH` at runtime has no effect.

3. **Safe result JSON uses SQL expression for truncation.** The `heartbeatRunSafeResultJsonColumn` SQL is complex and must be kept in sync with the TS constants (`HEARTBEAT_RUN_RESULT_SUMMARY_MAX_CHARS`, etc.). There is no compile-time check that the SQL and TS agree.

4. **Dual output path (file + DB events) doubles storage.** Every chunk is written to NDJSON and also inserted as a `heartbeatRunEvents` row. There is no deduplication or shared backing; large runs create significant DB pressure.

5. **In-memory `activeRunExecutions` set is not crash-safe.** The `Set<string>` tracking active executions is lost on restart, so a server crash while a run is `running` leaves the DB row stranded until the watchdog detects it.

6. **Liveness classification is regex-based on free text.** Heuristics like `PLANNING_ONLY_RE` and `BLOCKER_RE` are brittle. A well-structured adapter result that doesn’t match the regex will be misclassified, leading to unnecessary recovery continuations or missed blockers.
