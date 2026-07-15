# DESIGN EXPLANER: Issue Lifecycle

This document is the definitive reference for how an `issue` moves through states, who can trigger transitions, what side effects fire, and how the control plane enforces execution continuity. It covers status semantics, checkout mechanics, execution lock fields, dependency gates, and recovery behavior.

## Issue Primitive

In Paperclip, the `issues` table (`packages/db/src/schema/issues.ts`) is the **single atomic work unit** — what product documentation often calls a "task." There is no separate `tasks` table in the V1 schema. An issue combines:

- A human-readable ticket (`title`, `description`, `acceptanceCriteria`)
- Assignment ownership (`assigneeAgentId` OR `assigneeUserId`, mutually exclusive)
- Execution state (`status`, `checkoutRunId`, `executionRunId`, `executionLockedAt`)
- Structural hierarchy (`parentId` for sub-issues)
- Dependency gates (`blockedByIssueIds` via `issueRelations`)
- Company-scoped identity (`identifier` like `PAP-39`)

## Valid Status Values

The canonical status enum is defined in `server/src/services/issues.ts` (line 47):

```ts
const ALL_ISSUE_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked", "done", "cancelled"];
```

| Status | Meaning | Execution Expectation | Assignee Required | Terminal |
|--------|---------|----------------------|-------------------|----------|
| `backlog` | Not ready for work | None | No | No |
| `todo` | Actionable but not claimed | Dispatch wakeup may be queued | Optional (agent-assigned `todo` is dispatch state) | No |
| `in_progress` | Actively owned work | Strict: agent must have active run or continuation wake | **Yes** (enforced) | No |
| `in_review` | Paused for reviewer/approver | Executor waits; control plane expects human/agent review | Yes | No |
| `blocked` | Waiting on external change | No execution; depends on blocker resolution | No | No |
| `done` | Work complete | None | No | **Yes** |
| `cancelled` | Work abandoned | None | No | **Yes** |

Source: `doc/execution-semantics.md` §3, `server/src/services/issues.ts` lines 62-78.

## Status Transition Side Effects

The function `applyStatusSideEffects` in `server/src/services/issues.ts` (lines 62-78) automatically mutates timestamps when certain statuses are set:

- **`in_progress`** → sets `startedAt = new Date()` (if not already set)
- **`done`** → sets `completedAt = new Date()`
- **`cancelled`** → sets `cancelledAt = new Date()`

Additionally, on `update()` (`server/src/services/issues.ts` lines 2622-2645):

- Leaving `in_progress` clears execution-lock fields:
  - `checkoutRunId = null`
  - `executionRunId = null`
  - `executionAgentNameKey = null`
  - `executionLockedAt = null`
- Moving away from `done` clears `completedAt = null`
- Moving away from `cancelled` clears `cancelledAt = null`
- Changing assignee clears the execution lock (prevents stale locks after handoff)

## Transition Enforcement

`assertTransition(from, to)` (`server/src/services/issues.ts` lines 55-59) **only validates that the target status is a known enum value**; it does NOT enforce a strict state DAG. The business rules that restrict transitions are scattered:

- `in_progress` requires an assignee (`assigneeAgentId` or `assigneeUserId`)
- `in_progress` cannot be entered if unresolved `blockedByIssueIds` exist
- `cancelled` issues cannot be resumed through the comment-follow-up flow (must use dedicated restore flow)
- `blocked` issues with unresolved blockers cannot be moved to `in_progress` via explicit resume

## Assignment and Single-Assignee Invariant

An issue may have exactly ONE assignee (`server/src/services/issues.ts` lines 2380-2388, 2588-2593):

- `assigneeAgentId` → agent owns the issue; enters heartbeat execution loop
- `assigneeUserId` → human board member owns it; NO heartbeat execution
- Both set simultaneously → throws `unprocessable`

Reassignment clears the checkout lock, forcing the new owner to re-checkout if moving to `in_progress`.

## Checkout and Execution Lock Semantics

Checkout is the bridge from passive assignment to active execution (`doc/execution-semantics.md` §5, `server/src/services/issues.ts` lines 2759-2880+).

### Four Execution-Lock Fields

| Field | Purpose |
|-------|---------|
| `checkoutRunId` | Which heartbeat run owns the "right to execute" this issue |
| `executionRunId` | Which heartbeat run is currently the live execution path |
| `executionLockedAt` | Timestamp of last lock acquisition |
| `executionAgentNameKey` | Denormalized agent name for display |

`checkoutRunId` identifies ownership; `executionRunId` identifies the active process. They usually match but can diverge during recovery or handoff (`server/src/services/issues.ts` lines 111-118, 2641-2645).

### Checkout Flow

1. Agent (via heartbeat or API) calls `checkout(id, agentId, expectedStatuses, checkoutRunId)`
2. Service validates:
   - Issue exists and belongs to the agent's company
   - Agent is assignable (not `pending_approval` or `terminated`)
   - No active subtree pause/hold gate (`issueTreeControlService.getActivePauseHoldGate`)
   - No unresolved blockers
   - `clearExecutionRunIfTerminal(id)` clears stale run linkage
3. Atomic update (`server/src/services/issues.ts` lines 2800-2820):
   - `status = "in_progress"`
   - `assigneeAgentId = agentId`
   - `assigneeUserId = null`
   - `checkoutRunId = checkoutRunId`
   - `executionRunId = checkoutRunId`
   - `startedAt = now` (if new)
4. If the update returns zero rows (conflict), the service attempts **stale checkout adoption**:
   - `adoptStaleCheckoutRun`: if the existing `checkoutRunId` points to a terminal/missing heartbeat run, adopt it
   - `adoptUnownedCheckoutRun`: if `checkoutRunId` is null and the issue is already `in_progress` with the same assignee

## Dependency Gate: Blockers

Issues can block each other via `issueRelations` (`type = "blocks"`).

### Blocked Status
- An issue may be `blocked` manually or automatically when blockers are unresolved.
- `blocked` is semantically distinct from `parentId`; parent/child is structural, blockers are dependency (`doc/execution-semantics.md` §6).

### Unresolved Blocker Check
Before entering `in_progress`, the system checks `listIssueDependencyReadinessMap()` (`server/src/services/issues.ts` lines 240-283, 2594-2603):

- Only blockers with status `"done"` are considered resolved
- Cancelled blockers remain **unresolved** until the relation is explicitly removed/changed (line 272 comment: "cancelled blockers stay unresolved")
- If unresolved blockers exist, transition to `in_progress` throws `unprocessable`

### Wakeup on Blocker Resolution
When a blocking issue reaches `done`, the control plane identifies "wakeable blocked dependents" (`listWakeableBlockedDependents`, lines 2174-2239). For each dependent that is assigned to an agent and no longer blocked, a wakeup may be queued.

### No Cycles
`assertNoBlockingCycles()` (lines 1615-1651) prevents circular blocker relationships at mutation time.

## Auto-Recovery and Stranded Work

Paperclip has three recovery tiers (`doc/execution-semantics.md` §11):

### 1. Auto-Recover
- One automatic dispatch wake for an assigned `todo` issue whose latest run failed/timed out/cancelled
- One automatic continuation wake for an assigned `in_progress` issue whose live execution path disappeared
- Preserves existing owner; does NOT reassign to a different agent

### 2. Explicit Recovery Issue
- Created when retry was already exhausted, dependency graph has invalid owner, or silent-run watchdog threshold breached
- Source issue remains visible and may be blocked on the recovery issue

### 3. Human Escalation
- Required when all candidate recovery owners are paused/terminated/budget-blocked, or issue is human-owned
- Leaves visible issue/comment trail

### Stale Execution Lock Cleanup
`clearExecutionRunIfTerminal(issueId)` (lines 1790-1831) runs in a transaction:
1. Locks the issue row
2. Checks `heartbeatRuns.status`
3. If terminal (`succeeded`, `failed`, `cancelled`, `timed_out`) or missing, clears `executionRunId`, `executionAgentNameKey`, and `executionLockedAt`

## Comment-Driven Status Side Effects

### Implicit Reopen on Human Comment
`shouldImplicitlyMoveCommentedIssueToTodo()` (`server/src/routes/issues.ts` lines 188-200) returns `true` when:
- Actor is a `user` (not agent)
- Issue status is `done`, `cancelled`, or `blocked`
- Issue has an `assigneeAgentId`

Result: the route implicitly moves the issue to `todo` so the assigned agent can see new human input.

### Agent Comment on Active Run
`isQueuedIssueCommentForActiveRun()` (`server/src/routes/issues.ts` lines 782-800) detects whether a comment was posted during an active run (for transcript correlation).

## Activity Log Integration

Every mutating transition writes to `activityLog` (`server/src/routes/issues.ts` passim; `server/src/services/index.ts` `logActivity`).

Key logged actions observed:
- `issue.checkout_lock_adopted`
- `issue.document_created` / `issue.document_updated` / `issue.document_restored`
- `issue.thread_interaction_expired`
- `label.created` / `label.deleted`

## Architectural Contradictions

1. **Task vs Issue terminology drift.** Product docs (`AGENTS.md`, `SPEC.md`) and some evals refer to "tasks" as the atomic work unit, but the V1 database schema has no `tasks` table. The `issues` table fulfills this role with `checkoutRunId` / `executionRunId`. This creates terminology ambiguity when mapping conceptual "task lifecycle" to physical "issue rows."

2. **Permissive transition validator.** `assertTransition()` only checks that the target status is known; it does not enforce a directed state graph. Most transition restrictions are ad-hoc checks in `update()` and route handlers. This makes the lifecycle hard to reason about globally.

3. **Dual-key surface.** Issues are referenced by both `id` (UUID, internal) and `identifier` (project-local like `PAP-39`). Public-facing routes accept either, increasing URL contract complexity.

4. **Cancel vs Delete.** `remove()` on an issue performs a hard `DELETE` (`server/src/services/issues.ts` lines 2725-2757), cascading to attachments and documents. There is no `deleted_at` soft-delete column. This contradicts the immutable audit expectation for budget/activity logs.

---

*Last Updated: 2026-07-14*
*Evidence: `server/src/services/issues.ts`, `server/src/routes/issues.ts`, `doc/execution-semantics.md`, `packages/db/src/schema/issues.ts`*
