# DESIGN EXPLANER: Work Packaging and Flow

This document describes the end-to-end operational flow of work through the Paperclip control plane: how a piece of work is created, claimed, executed, monitored, decided upon, and resolved. It covers the full journey from human intent to agent execution to human review.

## The Core Cycle

```
Human creates Issue
       ↓
Agent assigned (or self-assigned via checkout)
       ↓
Heartbeat scheduler queues wakeup → Agent receives invocation
       ↓
Agent checks out issue → status = in_progress, run locked
       ↓
Agent performs work (tool calls, file edits, browser actions, LLM calls)
       ↓
Run steps + transcript entries recorded in real time
       ↓
Agent completes, blocks, or requests review → status update
       ↓
Human reviews (approves, requests changes, comments)
       ↓
Issue reaches terminal state (done / cancelled)
```

## 1. Work Creation

### Human-Created Issues
- **Entry Point:** Board UI → `POST /api/companies/:companyId/projects/:projectId/issues`
- **Route:** `server/src/routes/issues.ts` line ~882
- **Schema:** `createIssueSchema` from `@paperclipai/shared`
- **Service:** `issueService.create(companyId, data)` (`server/src/services/issues.ts` lines 2364-2540)

Key fields:
- `title`, `description` (optional body)
- `status` defaults to `backlog` or `todo` depending on workflow
- `assigneeAgentId` or `assigneeUserId` (mutually exclusive)
- `blockedByIssueIds` for dependency declaration
- `labelIds` for categorization
- `projectWorkspaceId` / `executionWorkspaceId` for isolated execution
- `parentId` for sub-issue hierarchy

### Agent-Created Issues
Agents can create issues via API using their `agent_api_key`. Creation path is identical but `createdByAgentId` is set. Agents may also create **child issues** via `createChildIssueSchema` (`server/src/routes/issues.ts`), which:
- Inherits project/goal from parent
- Optionally blocks the parent until the child is `done`
- Enforces max 25 children per helper (`MAX_CHILD_ISSUES_CREATED_BY_HELPER`)

### Routine-Generated Issues
`routineService` (`server/src/services/routines.ts`) can spawn issues from scheduled automations (e.g., scan for TODOs, generate reports). These carry `originKind = "routine_execution"`.

## 2. Assignment and Checkout

### Assignment
Assignment sets `assigneeAgentId` or `assigneeUserId`. Constraints:
- Agent assignee must be active (`status !== "pending_approval"` and `!== "terminated"`)
- User assignee must have active company membership
- `in_progress` status **requires** an assignee

### Checkout (Agent-Owned Issues Only)
Checkout is the atomic claim of execution rights (`server/src/services/issues.ts` lines 2759-2880+):

1. Agent heartbeat or API call invokes `checkout(issueId, agentId, expectedStatuses, checkoutRunId)`
2. Preconditions checked:
   - Issue in expected status (typically `todo`, `backlog`, or `blocked`)
   - No unresolved blockers
   - No active tree pause/hold gate
   - Agent is assignable
3. Atomic update sets:
   - `status = "in_progress"`
   - `checkoutRunId = checkoutRunId`
   - `executionRunId = checkoutRunId`
   - `executionLockedAt = now`
   - `startedAt = now` (if first time)
4. If conflict (another agent holds lock), service attempts **stale checkout adoption** if the old run is terminal.

### Checkout Invariants
- `checkoutRunId` is the ownership lock; `executionRunId` is the live process. They match during normal execution but may diverge during recovery.
- Changing assignee unconditionally clears both locks.
- Leaving `in_progress` unconditionally clears both locks.

## 3. Heartbeat Dispatch and Run Lifecycle

### Heartbeat Scheduler
The heartbeat service (`server/src/services/heartbeat.ts`, inferred from `heartbeatService` usage) maintains the agent execution loop:

1. Agent registers with company
2. Scheduler periodically checks for actionable work (assigned `todo`/`in_progress` issues, wakeup requests)
3. When work is found, scheduler creates a `heartbeat_run` row in `heartbeatRuns` table
4. Run status starts as `"queued"`, transitions to `"running"`, and eventually `"succeeded"`, `"failed"`, `"cancelled"`, or `"timed_out"`

### Wakeup Requests
`agent_wakeup_requests` table stores queued invocations:
- `status`: `"queued"` | `"deferred_issue_execution"` | ...
- `payload` contains `issueId`, wake reason, execution stage context
- Agent polls or is pushed wakeup requests

### Run Fields
`heartbeatRuns` (`packages/db/src/schema/heartbeat_runs.ts`):
- `status`: `"queued"` | `"running"` | `"succeeded"` | `"failed"` | `"cancelled"` | `"timed_out"`
- `agentId`: which agent is executing
- `invocationSource`: why the run was created (`"assignment"`, `"automation"`, etc.)
- `triggerDetail`: human-readable trigger reason
- `contextSnapshot`: JSON containing `issueId`, `taskId` (same as issueId), `executionStage`, etc.
- `wakeupRequestId`: links back to the originating wakeup
- `startedAt`, `finishedAt`

## 4. Execution Workspaces and Tree Control

### Execution Workspaces
For isolated agent execution (experimental), issues carry:
- `executionWorkspaceId`: pointer to `execution_workspaces` row
- `executionWorkspacePreference`: e.g., `"reuse_existing"`
- `executionWorkspaceSettings`: JSON config (mode, environment, etc.)

Workspaces are validated on issue create/update (`assertValidExecutionWorkspace` in `issueService`).

### Tree Control / Pause Holds
`issueTreeControlService` (`server/src/services/issue-tree-control.ts`) manages subtree-level gates:
- `getActivePauseHoldGate(companyId, issueId)` returns active pause/hold state
- If a gate exists, checkout is blocked unless the run is a verified interaction wake (`isVerifiedIssueTreeControlInteractionWake`)
- Used for coordinated pauses across parent/sub-issue hierarchies

## 5. Agent Work Execution

### What an Agent Does During a Run
An agent adapter (Claude, Codex, Hermes, Droid, etc.) receives:
- Issue context (title, description, acceptance criteria)
- Project/goal context
- Comment thread history
- Blocker status
- Execution stage instructions (if in approval/review flow)

### Tool Calls and Steps
The agent performs actions that are logged as `run_steps`:
- `type`: `"tool_use"`, `"thinking"`, `"llm_call"`, etc.
- `status`, `input`, `output`, `thinking`, `startedAt`, `finishedAt`

### Transcript Entries
Human-readable/structured logs written to `run_transcript_entries`:
- Captures stderr, tool groups, file operations
- Used by UI (`RunTranscriptView.tsx`) for real-time display
- Denormalized `task_id` for efficient queries

### Budget Hard-Stop
Before and during execution, the control plane checks `budget_snapshots`:
- If spend ≥ budget, agent operations are paused
- Status may move to `"paused"` or `"blocked"`
- Budget alerts logged in `activity_log`

## 6. Agent Mutation Permission Model

Agents mutate issues via the same REST API as the board, authenticated with `agent_api_key`. The permission model (`server/src/routes/issues.ts` lines 594-644):

### General Rule
- Agent can mutate its **own** checked-out `in_progress` issue
- Agent must provide `runId` in request context
- Service verifies `checkoutRunId` matches the agent's active run

### Checkout Lock Adoption
If an agent's run is stale (terminal/missing), another run from the same agent can adopt the checkout lock automatically (`adoptStaleCheckoutRun`, `adoptUnownedCheckoutRun`). This is logged as `issue.checkout_lock_adopted`.

### Management Override
A manager agent (reporting-chain ancestor) or agent with `tasks:manage_active_checkouts` permission can intervene in a subordinate's active checkout without taking ownership (`hasActiveCheckoutManagementOverride`, lines 562-592).

### Forbidden Mutations
- Agents cannot normally mutate another agent's active issue unless they have override permission
- Agents cannot resume cancelled issues (must use dedicated restore flow)
- Agents cannot bypass active subtree pause holds

## 7. Comment-Driven Wakeups and Interactions

### Human Comments on Closed/Blocked Issues
When a human comments on a `done`, `cancelled`, or `blocked` issue that has an `assigneeAgentId`, the system implicitly moves it to `todo` (`shouldImplicitlyMoveCommentedIssueToTodo`, `server/src/routes/issues.ts` lines 188-200). This wakes the assigned agent.

### Thread Interactions
`issueThreadInteractionService` manages structured request/response flows:
- Agent requests confirmation → human accepts/rejects/responds
- `continuationPolicy`: `"wake_assignee"` or `"wake_assignee_on_accept"`
- On resolution, `queueResolvedInteractionContinuationWakeup` may enqueue a new heartbeat wakeup

### Explicit Resume Intent
`assertExplicitResumeIntentAllowed` (`server/src/routes/issues.ts` lines 646-728) guards comment-follow-up that attempts to resume work:
- Blocks cancelled issues (require restore flow)
- Blocks issues under active pause hold
- Blocks blocked issues with unresolved blockers
- Agents can only resume their own assigned issues (or with management override)

## 8. Status Transitions Back to Board

### Agent Completion
Agent marks issue `done` or `cancelled`:
- `done` → sets `completedAt`, clears locks, may trigger parent wakeup if all siblings terminal
- `cancelled` → sets `cancelledAt`, clears locks, terminal

### Review/Approval Gate
If execution policy requires review/approval (`issueExecutionPolicy`):
- Agent submits work → status moves to `in_review`
- Reviewer/approver decides: `approve` → `done`, `request_changes` → back to `in_progress` with `returnAssignee`
- Execution stage context passed in wakeup payload

### Human Override at Any Point
Board operators can:
- Change status directly via `PATCH /api/issues/:id`
- Reassign to different agent or human
- Add/remove blockers
- Pause via tree control
- Force-release checkout via admin endpoint (`POST /issues/:issueId/admin/force-release`)

## 9. Recovery Loop

### Startup and Periodic Reconciliation
On startup and periodic intervals, the recovery service (`server/src/services/recovery/issue-graph-liveness.ts`) performs:

1. **Reap orphaned `running` runs** — mark as terminal if process is gone
2. **Resume persisted `queued` runs** — re-enqueue valid queued wakeups
3. **Reconcile stranded assigned work**:
   - Assigned `todo` with failed run and no queued wake → dispatch recovery wake (once)
   - Assigned `in_progress` with no active run and no continuation → continuation wake (once)
   - If retry also fails → move to `blocked`, post visible comment
4. **Silent active-run watchdog** — scan `running` runs with no recent output
   - Suspicious silence → create medium-priority evaluation issue
   - Critical silence → create high-priority evaluation issue, block source issue
   - Supports `snooze` (time-bounded quiet) and `continue` (short acknowledgement)

### Recovery Outcomes
| Scenario | Action |
|----------|--------|
| Clear ownership, lost execution continuity | Auto-recover (retry wake, preserve owner) |
| Problem identified, bounded recovery owner | Create explicit recovery issue |
| Requires board judgment or unavailable info | Human escalation (visible comment trail) |

## 10. Work Products and Documents

### Work Products
`issue_work_products` table (linked to `issues`) stores deliverables:
- Title, description, status
- Linked to specific issue progress

### Issue Documents
`documents` + `issue_documents` stores structured artifacts:
- keyed documents (e.g., `"continuation_summary"`)
- revision history (`document_revisions`)
- agents/humans can create/update/restore revisions
- updates may expire stale thread interactions

## 11. Activity and Audit Trail

Every significant state change writes to `activity_log`:
- `action`: `issue.checkout_lock_adopted`, `issue.document_created`, `label.created`, etc.
- `entityType`, `entityId`
- `actorType`, `actorId`, `agentId`, `runId`
- `details`: JSON payload with relevant context

Unread tracking via `issue_read_states` and inbox archive via `issue_inbox_archives` give board members personal notification semantics.

---

*Last Updated: 2026-07-14*
*Evidence: `server/src/services/issues.ts`, `server/src/routes/issues.ts`, `doc/execution-semantics.md`, `packages/db/src/schema/issues.ts`, `packages/db/src/schema/heartbeat_runs.ts`, `packages/db/src/schema/agent_wakeup_requests.ts`, `server/src/services/recovery/issue-graph-liveness.ts`*
