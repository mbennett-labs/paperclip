# 04 — Agent Runtime: Execution Heartbeat, Session & Adapter Invocation

> **Scope:** How an agent is defined, how it receives work, how the heartbeat scheduler turns a wakeup into an executed adapter process, and how sessions/logs/costs are tracked.
> **Status:** Read-only audit. All claims verified against implementation.

---

## 1. Agent Definition & Runtime Surface

### 1.1 Agent Schema (`packages/db/src/schema/agents.ts`)

An `agents` row defines the runtime identity of a worker:

| Field | Purpose |
|---|---|
| `companyId` | Strict company scoping. |
| `adapterType` | Which registered server adapter drives execution (e.g. `claude_local`, `codex_local`). Default: `process`. |
| `adapterConfig` | JSON blob passed to the adapter `execute()` call (model, cwd, timeout, etc.). |
| `runtimeConfig` | JSON blob for Paperclip-side runtime behavior (session compaction thresholds, etc.). |
| `defaultEnvironmentId` | Optional environment lease for remote execution contexts. |
| `budgetMonthlyCents` / `spentMonthlyCents` | Agent-level budget envelope, updated reactively on every cost event. |
| `status` | `idle`, `running`, `paused`, `terminated`, `error`, `pending_approval`. |
| `permissions` | JSON capabilities blob; enforced in route/service layers, not the adapter. |
| `reportsTo` | Self-referencing FK for organizational hierarchy (used by recovery to find managers). |

### 1.2 Agent API Keys (`packages/db/src/schema/agent_api_keys.ts`)

Agent authentication uses bearer tokens stored in `agent_api_keys`. The secret is hashed at rest (`hash` column) and never returned in list responses. Board users create keys; agents consume them. Keys are company-scoped and must not access other companies (`budgets.ts` and route guards enforce this).

---

## 2. Wakeup Request Lifecycle

### 2.1 Queueing a Wakeup (`server/src/services/agents.ts` / `heartbeat.ts`)

Every heartbeat starts as an `agentWakeupRequests` row (`packages/db/src/schema/agent_wakeup_requests.ts`):

- `source`: `timer` | `assignment` | `on_demand` | `automation`
- `triggerDetail`: `manual` | `ping` | `callback` | `system`
- `status`: `queued` → `claimed` → `completed` | `failed`
- `coalescedCount`: incremented when duplicate wakes for the same agent are collapsed.
- `idempotencyKey`: used by recovery continuations to prevent duplicate wakeups (`buildRunLivenessContinuationIdempotencyKey` in `recovery/run-liveness-continuations.ts`).

The `issue-assignment-wakeup.ts` helper (`queueIssueAssignmentWakeup`) is the narrow bridge between issue mutations and the heartbeat queue: when an issue is assigned to an agent, it calls `heartbeat.wakeup()` with `source: "assignment"`.

### 2.2 Claim & Execution (`heartbeat.ts` — `heartbeatService`)

Inside `heartbeatService`, the scheduler pulls queued wakes, claims them (`status = "claimed"`), and begins a `heartbeatRuns` row. The core execution path for a local process adapter is:

1. Resolve adapter configuration via `resolveExecutionRunAdapterConfig()` (secret resolution, env binding).
2. Resolve workspace via `resolveWorkspaceForRun()`.
3. Resolve session state via `resolveSessionBeforeForWakeup()`.
4. Invoke `environmentRunOrchestrator` if an environment lease is required.
5. Call `adapter.execute()` with the assembled `AdapterExecutionContext`.
6. Stream stdout/stderr through `runLogStore.append()`.
7. On completion: compute liveness, record costs, update sessions, write activity log, publish live event.

---

## 3. Heartbeat Scheduler Mechanics

### 3.1 Run Status Machine (`heartbeat.ts` lines 152–155)

```ts
const EXECUTION_PATH_HEARTBEAT_RUN_STATUSES = ["queued", "running", "scheduled_retry"] as const;
const CANCELLABLE_HEARTBEAT_RUN_STATUSES      = ["queued", "running", "scheduled_retry"] as const;
const HEARTBEAT_RUN_TERMINAL_STATUSES         = ["succeeded", "failed", "cancelled", "timed_out"] as const;
const UNSUCCESSFUL_HEARTBEAT_RUN_TERMINAL_STATUSES = ["failed", "cancelled", "timed_out"] as const;
```

Terminal statuses stop the execution path. `scheduled_retry` is a special queued state used for bounded transient retries.

### 3.2 Bounded Transient Retry Schedule (`heartbeat.ts` lines 162–171)

```ts
const BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS = [
  2 * 60 * 1000,   // 2 min
  10 * 60 * 1000,  // 10 min
  30 * 60 * 1000,  // 30 min
  2 * 60 * 60 * 1000, // 2 hr
] as const;
const BOUNDED_TRANSIENT_HEARTBEAT_RETRY_MAX_ATTEMPTS = BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS.length;
```

Jitter is ±25%. A run that fails with `errorFamily === "transient_upstream"` gets a `scheduledRetryAt` and is re-enqueued automatically. After 4 attempts, the failure is terminal.

### 3.3 Quota Protection (`heartbeat.ts` lines 2007–2039)

A sliding-window failure rate limiter lives in-memory inside `heartbeatService`:

- `QUOTA_PROTECTION_MAX_FAILURES_PER_HOUR = 2`
- `QUOTA_PROTECTION_WINDOW_MS = 60 * 60 * 1000`
- After two failures within an hour, further enqueue attempts for that agent are rejected.
- A deduplicated alert is emitted once per hour.

This is purely in-memory; server restart resets the counters. It is a last-resort circuit breaker, not a durable policy.

---

## 4. Session Management

### 4.1 Dual Session Stores

Paperclip maintains **two** session persistence layers:

| Store | Schema | Scope | Key |
|---|---|---|---|
| `agentTaskSessions` | `packages/db/src/schema/agent_task_sessions.ts` | Per-task/issue | `(companyId, agentId, adapterType, taskKey)` |
| `agentRuntimeState` | `packages/db/src/schema/agent_runtime_state.ts` | Per-agent singleton | `agentId` (primary key) |

`agentTaskSessions` is the modern, task-scoped store. `agentRuntimeState` is the legacy fallback. The scheduler prefers `agentTaskSessions` when a `taskKey` is derivable.

### 4.2 Task Key Derivation (`heartbeat.ts` lines 1281–1316)

```ts
function deriveTaskKey(contextSnapshot, payload) {
  return (
    contextSnapshot?.taskKey ??
    contextSnapshot?.taskId ??
    contextSnapshot?.issueId ??
    payload?.taskKey ?? ...
  );
}

const HEARTBEAT_TASK_KEY = "__heartbeat__";

export function deriveTaskKeyWithHeartbeatFallback(contextSnapshot, payload) {
  const explicit = deriveTaskKey(contextSnapshot, payload);
  if (explicit) return explicit;
  if (contextSnapshot?.wakeSource === "timer") return HEARTBEAT_TASK_KEY;
  return null;
}
```

Timer wakes with no issue context fall back to the synthetic `__heartbeat__` key, allowing them to resume a previous session instead of starting fresh every heartbeat.

### 4.3 Session Resume vs. Reset (`heartbeat.ts` lines 1318–1333)

```ts
export function shouldResetTaskSessionForWake(contextSnapshot) {
  if (contextSnapshot?.forceFreshSession === true) return true;
  const wakeReason = readNonEmptyString(contextSnapshot?.wakeReason);
  if (
    wakeReason === "issue_assigned" ||
    wakeReason === "execution_review_requested" ||
    wakeReason === "execution_approval_requested" ||
    wakeReason === "execution_changes_requested"
  ) return true;
  return false;
}
```

Explicit assignment and execution-state transitions force a session reset. All other wakes attempt resume.

### 4.4 Session Compaction (`heartbeat.ts` lines 2209–2331)

Each agent can configure session compaction thresholds in `runtimeConfig`:

- `maxSessionRuns`
- `maxRawInputTokens`
- `maxSessionAgeHours`

When a threshold is crossed, `evaluateSessionCompaction()` returns `rotate: true` with a `handoffMarkdown` note injected into the next run’s prompt so the agent can rebuild minimal context.

---

## 5. Adapter Invocation Path

### 5.1 Registry (`server/src/adapters/registry.js` — re-exported in `index.ts`)

Adapters are registered by `type` string. The server adapter module must export:

- `execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult>`
- Optional `sessionCodec` for serialize/deserialize of session params.
- Optional `detectModel` for model auto-detection.

### 5.2 Claude Local Adapter (`packages/adapters/claude-local/src/server/execute.ts`)

**Command construction:**
- Always runs with `--print - --output-format stream-json --verbose`.
- Supports `--resume <sessionId>`, `--dangerously-skip-permissions`, `--chrome`, `--model`, `--effort`, `--max-turns`.
- On resumed sessions, skips `--append-system-prompt-file` to avoid wasting 5–10K tokens reinjecting instructions.
- Skills are discovered via `readPaperclipRuntimeSkillEntries()` and filtered by `desiredSkillNames`.

**Session handling:**
- `canResumeSession` is true only if `sessionId` matches, `promptBundleKey` matches, cwd matches, and remote execution identity matches.
- If session resume fails with `isClaudeUnknownSessionError`, the adapter automatically retries with a fresh session (`clearSessionOnMissingSession = true`).

**Billing detection:**
```ts
function resolveClaudeBillingType(env) {
  if (isBedrockAuth(env)) return "metered_api";
  return hasNonEmptyEnvValue(env, "ANTHROPIC_API_KEY") ? "api" : "subscription";
}
```

### 5.3 Codex Local Adapter (`packages/adapters/codex-local/src/server/execute.ts`)

**Command construction:**
- Prompt is piped via stdin (`codex -` or explicit prompt arg).
- Supports `fastMode` (GPT-5.4 only), `search`, `dangerouslyBypassApprovalsAndSandbox`.
- Managed `CODEX_HOME` is prepared per-company under `~/.paperclip/instances/<id>/companies/<companyId>/codex-home/`.
- Skills are injected as symlinks into `CODEX_HOME/skills/`.

**Transient fallback modes:**
```ts
type CodexTransientFallbackMode =
  | "same_session"
  | "safer_invocation"
  | "fresh_session"
  | "fresh_session_safer_invocation";
```

After repeated transient failures, the heartbeat scheduler escalates through these modes (see `resolveCodexTransientFallbackMode()` in `heartbeat.ts`), forcing fresh sessions and safer flags.

### 5.4 Execution Target Abstraction

Both adapters use `@paperclipai/adapter-utils/execution-target`:

- `readAdapterExecutionTarget()` parses `executionTarget` from context.
- `adapterExecutionTargetIsRemote()` gates remote workspace sync.
- `prepareAdapterExecutionTargetRuntime()` syncs local assets (skills, CODEX_HOME) to a remote host.
- `restoreRemoteWorkspace()` is called in a `finally` block to undo remote changes.

This means the same adapter code supports local and remote execution without branching the core `execute()` logic.

---

## 6. Workspace Resolution for Runs

### 6.1 Resolution Hierarchy (`heartbeat.ts` — `resolveWorkspaceForRun()`)

The function follows this priority:

1. **Project workspace** — if `useProjectWorkspace !== false` and the issue has a `projectId`, look up `projectWorkspaces` rows. Prefer the `preferredProjectWorkspaceId`. If a workspace has no local cwd, fall back to `ensureManagedProjectWorkspace()` which can `git clone` into `~/.paperclip/data/workspaces/...`.
2. **Task session cwd** — if no project workspace, use the previous session’s saved `cwd` if the directory still exists.
3. **Agent home fallback** — `resolveDefaultAgentWorkspaceDir(agentId)`.

Warnings are collected and logged to stdout so the agent transcript contains context about workspace substitutions.

### 6.2 Managed Project Workspace (`heartbeat.ts` lines 541–590)

```ts
async function ensureManagedProjectWorkspace({ companyId, projectId, repoUrl }) {
  const cwd = resolveManagedProjectWorkspaceDir({ companyId, projectId, repoName });
  // If repoUrl provided and .git missing, git clone with 10 min timeout
  await execFile("git", ["clone", repoUrl, cwd], { timeout: MANAGED_WORKSPACE_GIT_CLONE_TIMEOUT_MS });
}
```

This is how Paperclip creates on-demand working copies for agents without manual setup.

---

## 7. Run Log Capture

### 7.1 Local File Store (`server/src/services/run-log-store.ts`)

```ts
export interface RunLogStore {
  begin(input: { companyId; agentId; runId }): Promise<RunLogHandle>;
  append(handle, event: { stream; chunk; ts }): Promise<number>;
  finalize(handle): Promise<RunLogFinalizeSummary>;
  read(handle, opts?: { offset?; limitBytes? }): Promise<RunLogReadResult>;
}
```

Only implementation: `local_file`. Logs are NDJSON lines under `<basePath>/<companyId>/<agentId>/<runId>.ndjson`. Path traversal is guarded by `resolveWithin()`.

### 7.2 In-Run Event Streaming (`heartbeat.ts`)

During execution, stdout/stderr chunks are:
1. Written to `runLogStore.append()`.
2. Truncated/redacted for live UI via `compactRunLogChunk()` (max 64K chars per chunk, head/tail truncation).
3. Stored as `heartbeatRunEvents` rows for structured querying.

The `heartbeatRunEvents` table (`packages/db/src/schema/heartbeat_run_events.ts`) stores typed events (`eventType`, `stream`, `level`, `message`, `payload`) with a `seq` per run for deterministic replay.

---

## 8. Cost Integration

After every run, the heartbeat service calls `costService.createEvent()` (`server/src/services/costs.ts`), which:
1. Inserts a `costEvents` row.
2. Recomputes monthly spend for the agent and company.
3. Updates `agents.spentMonthlyCents` and `companies.spentMonthlyCents`.
4. Triggers `budgets.evaluateCostEvent()` to check hard-stop thresholds.

This is a **synchronous, inline call** inside the run finalization path. A budget hard-stop can therefore pause the agent before the next wakeup.

---

## 9. Architectural Contradictions

1. **In-memory quota protection vs. durable state.** The sliding-window failure rate limiter (`agentFailureTimestamps`) lives only in the `heartbeatService` closure. A server restart resets it, making it unreliable as a safety boundary.

2. **Dual session stores with no migration plan.** `agentTaskSessions` and `agentRuntimeState` coexist. The merge logic in `resolveNextSessionState()` is subtle and relies on adapter-specific `sessionCodec` behavior; a codec bug could cause cross-task session leakage.

3. **Remote workspace restore in `finally` is best-effort.** If the server crashes during `execute()`, `restoreRemoteWorkspace()` never runs, leaving remote assets in place. There is no reconciliation daemon.

4. **Cost finalization is inline with run completion.** A slow budget evaluation query blocks the run status transition. This is not async-queue-based.

5. **Task key collision risk.** The synthetic `HEARTBEAT_TASK_KEY = "__heartbeat__"` means all timer wakes without issue context share one session. An agent with many timer-based tasks could inadvertently resume the wrong context.

6. **Adapter-specific transient retry logic leaks into heartbeat.** `resolveCodexTransientFallbackMode()` is hardcoded in `heartbeat.ts` instead of being adapter-provided, violating the plugin abstraction.
