# DESIGN EXPLANER: Core Concept Glossary

This document defines the essential domain terms used throughout the Paperclip codebase, product docs, and API contracts. It provides a single source of truth for language that is otherwise scattered across `AGENTS.md`, `SPEC.md`, `SPEC-implementation.md`, `TASKS.md`, and the source code.

## Agent
An autonomous AI worker that operates within a Company. Agents are authenticated via `agent_api_keys`, receive work through heartbeat invocations, and execute tasks on behalf of the company. Agents have roles (e.g., `ceo`, `engineer`), a reporting chain (`reportsTo`), and a status (`active`, `idle`, `running`, `error`, `pending_approval`, `terminated`).

*Sources:* `AGENTS.md` §8, `packages/db/src/schema/agents.ts`, `doc/PRODUCT.md`

## Agent Adapter
A package that connects an external AI tool (Claude, Codex, Cursor, Hermes, Droid, etc.) to Paperclip's agent API. Adapters implement a standard interface (`createServerAdapter()`, `detectModel()`, `config-schema`, `ui-parser.js`). In the current fork, Hermes and Droid are external plugin-only adapters.

*Sources:* `AGENTS.md` §11, `.agents/skills/create-agent-adapter/SKILL.md`

## Agent API Key
A secret bearer token (`agent_api_keys` table) scoped to a single company. Used by agents to authenticate API requests. Key hashes are stored at rest; the plain key is shown once on creation. Agent keys cannot access other companies.

*Sources:* `AGENTS.md` §8, `packages/db/src/schema/agentApiKeys.ts`

## Board / Board Operator
A human user interacting with Paperclip through the web UI. Board access is authenticated via `board_access_tokens` and treated as "full-control operator context." Board operators can create issues, assign work, approve decisions, pause agents, and override any agent action.

*Sources:* `AGENTS.md` §8, `doc/PRODUCT.md`

## Blocker / BlockedBy
A dependency relationship between issues, stored in `issueRelations` (`type = "blocks"`). If Issue A blocks Issue B, B cannot enter `in_progress` until A reaches `done`. Cancelled blockers remain unresolved until the relation is explicitly removed. Cycles are prohibited.

*Sources:* `doc/execution-semantics.md` §6, `server/src/services/issues.ts` lines 1615-1651, 240-283

## Budget Snapshot
A point-in-time record of spending limits (`budget_snapshots`). Includes `budget` ceiling, current `spend`, `currency`, and period bounds. Hitting 100% spend triggers a hard-stop: agent operations are paused and status updated.

*Sources:* `AGENTS.md` §3, `packages/db/src/schema/budgetSnapshots.ts`

## Checkout
The atomic act of an agent claiming execution rights for an issue. Sets `checkoutRunId`, `executionRunId`, `status = "in_progress"`, and `executionLockedAt`. Checkout is the bridge from passive assignment to active heartbeat execution.

*Sources:* `doc/execution-semantics.md` §5, `server/src/services/issues.ts` lines 2759-2880+

## Company
The root organizational unit in Paperclip. Every entity (issues, agents, projects, documents) is scoped to exactly one company. Companies have a `slug` (globally unique), `name`, and `settings`. Represented as `companies` table.

*Sources:* `AGENTS.md` §2, `packages/db/src/schema/companies.ts`

## Company Membership
The link between a `user` and a `company` with a specific role/status. Stored in `company_memberships` (`principalType`, `principalId`, `status = "active"`). Replaces the older `admins` join table for general membership; `admins` still exists for explicit admin privileges.

*Sources:* `server/src/services/issues.ts` lines 1441-1457, `packages/db/src/schema/companyMemberships.ts`

## Continuation Policy
A rule on thread interactions determining whether a resolved interaction should automatically enqueue a heartbeat wakeup. Values: `"wake_assignee"` (always wake), `"wake_assignee_on_accept"` (wake only on accept), or none.

*Sources:* `server/src/routes/issues.ts` lines 206-263

## Dispatch State
An agent-assigned issue in `todo` status that is ready to start but has not yet been checked out. The control plane ensures dispatch-state issues have a wakeup path; otherwise they are surfaced as stranded work.

*Sources:* `doc/execution-semantics.md` §7

## Execution Continuity
The property that an agent-assigned, non-terminal issue always has either an active run, a queued continuation wake, or explicit human attention. Lost continuity triggers auto-recovery (once) before escalation.

*Sources:* `doc/execution-semantics.md` §7, §11

## Execution Lock
The four fields that tie an issue to a running heartbeat process: `checkoutRunId` (ownership), `executionRunId` (live process), `executionLockedAt` (timestamp), and `executionAgentNameKey` (display). Cleared when leaving `in_progress` or reassigning.

*Sources:* `server/src/services/issues.ts` lines 111-118, 2622-2645

## Execution Policy / Execution Stage
A JSON-defined workflow on an issue that governs approval/review gates. Defines sequential `stages` (`approval`, `review`, `execution`), each with `participants` and `allowedActions`. Parsed into `executionState` at runtime.

*Sources:* `server/src/routes/issues.ts` lines 288-383, `server/src/services/issue-execution-policy.ts`

## Execution Workspace
An isolated environment configuration for agent execution (experimental). Issues carry `executionWorkspaceId` and `executionWorkspaceSettings`. Workspaces are validated on create/update and may be inherited from parent issues.

*Sources:* `server/src/services/issues.ts` lines 1477-1501, 2393-2450, `packages/db/src/schema/executionWorkspaces.ts`

## Explicit Recovery Issue
An issue created by the control plane when it identifies a problem but cannot safely recover automatically (e.g., retry exhausted, invalid owner, watchdog threshold breached). The source issue may be blocked on the recovery issue.

*Sources:* `doc/execution-semantics.md` §11

## Goal
A strategic objective that issues and projects align with. Goals have a hierarchy (`parentId`), status (`planned`, `active`, `achieved`, `cancelled`), and level (`company`, `team`, `project`). Issues inherit goals from projects or fall back to the default company goal.

*Sources:* `doc/SPEC-implementation.md` §3.3, `packages/db/src/schema/goals.ts`, `server/src/services/issues.ts` lines 2498-2503

## Heartbeat
The periodic scheduler that checks for actionable work and invokes agents. A heartbeat creates a `heartbeatRun`, delivers a wakeup payload (fat payload with issue context), and tracks execution. The heartbeat is the core execution loop of the control plane.

*Sources:* `AGENTS.md` §3, `doc/PRODUCT.md`, `packages/db/src/schema/heartbeatRuns.ts`

## Heartbeat Run
A single invocation of an agent via the heartbeat scheduler. Status: `queued` → `running` → `succeeded`/`failed`/`cancelled`/`timed_out`. Carries a `contextSnapshot` (issueId, executionStage, etc.) and links back to an `agentWakeupRequest`.

*Sources:* `AGENTS.md` §3, `doc/SPEC-implementation.md` §3.7, `packages/db/src/schema/heartbeatRuns.ts`

## Human Escalation
The recovery tier where the control plane cannot safely infer the next action and requires board judgment. Examples: all recovery owners are paused/terminated, issue is human-owned, run needs operator decision.

*Sources:* `doc/execution-semantics.md` §11

## Identifier
The human-readable project-local issue key (e.g., `PAP-39`). Computed as `{issuePrefix}-{issueNumber}` at creation time. Used in URLs, comments, and UI alongside the UUID `id`.

*Sources:* `server/src/services/issues.ts` lines 2476-2493

## Inbox
A per-user view of issues that have recent activity and are not archived. Drives notification badges. Combines `issueReadStates` (last read) and `issueInboxArchives` (dismissal) with `touchedByUserCondition`.

*Sources:* `server/src/services/issues.ts` lines 341-534

## Issue
The atomic unit of work in Paperclip. Combines ticket semantics (`title`, `description`), assignment (`assigneeAgentId`/`assigneeUserId`), execution state (`status`, execution lock fields), hierarchy (`parentId`), and dependencies (`blockedBy` via `issueRelations`). There is no separate `tasks` table in V1.

*Sources:* `doc/execution-semantics.md` §1, `packages/db/src/schema/issues.ts`

## Issue Number
The integer component of the `identifier`, auto-incremented per company via `companies.issueCounter`. Self-correcting: uses `MAX(issueNumber) + 1` if counter drifts.

*Sources:* `server/src/services/issues.ts` lines 2476-2482

## Issue Tree Control
The subsystem (`issueTreeControlService`) that manages subtree-level pause/hold gates. Prevents checkout and execution within a subtree when a gate is active, unless the run is a verified interaction wake.

*Sources:* `server/src/services/issue-tree-control.ts`, `server/src/services/issues.ts` lines 1413-1439

## Project
A container for issues with a `key` (company-unique), `name`, and `status`. Projects may have a default `goalId` and `executionWorkspacePolicy`. Issues belong to exactly one project (or are unprojected).

*Sources:* `AGENTS.md` §2, `packages/db/src/schema/projects.ts`

## Project Workspace
A workspace configuration scoped to a project (`projectWorkspaces`). Issues inherit the project workspace unless overridden. Distinct from `executionWorkspaces`, which are for runtime isolation.

*Sources:* `packages/db/src/schema/projectWorkspaces.ts`, `server/src/services/issues.ts` lines 2459-2468

## Recovery
The control plane's response to lost execution continuity. Three tiers: auto-recover (retry wake once), explicit recovery issue (bounded recovery owner), human escalation (board judgment). Recovery preserves ownership and does not auto-reassign.

*Sources:* `doc/execution-semantics.md` §11

## Reporting Chain
The managerial hierarchy among agents, defined by `agents.reportsTo`. Used for permission inheritance (e.g., management override for active checkouts) and org chart display.

*Sources:* `server/src/routes/issues.ts` lines 562-592

## Routine
A scheduled or triggered automation (`routines` table) that performs recurring work (e.g., scan repo, generate reports). Routines have `schedule` and `status`; their executions are `routineRuns`.

*Sources:* `AGENTS.md` §2, `packages/db/src/schema/routines.ts`

## Run Step
A granular action within a heartbeat run (`run_steps` table). Types include `tool_use`, `thinking`, `llm_call`. Steps are append-only and carry `input`, `output`, `thinking`, and timing.

*Sources:* `AGENTS.md` §3, `packages/db/src/schema/runSteps.ts`

## Run Transcript Entry
A human-readable or structured log line for a run (`run_transcript_entries`). Distinct from `runSteps`; used for UI display (stderr grouping, tool grouping). Denormalized `task_id` allows efficient queries.

*Sources:* `AGENTS.md` §5 (QoL patches), `packages/db/src/schema/runTranscriptEntries.ts`

## Silent Run Watchdog
A periodic scan that detects `running` heartbeat runs with no recent output. Classifies silence as `ok`, `suspicious`, `critical`, or `snoozed`. Creates evaluation issues and may block the source issue. Supports `snooze` (time-bounded) and `continue` (short acknowledgement) decisions.

*Sources:* `doc/execution-semantics.md` §10

## Single-Assignee Invariant
The rule that an issue has at most one assignee (`assigneeAgentId` OR `assigneeUserId`, never both). Enforced at create and update time. This is a hard design invariant of Paperclip.

*Sources:* `doc/execution-semantics.md` §2, `server/src/services/issues.ts` lines 2380-2388

## Stranded Work
An agent-assigned issue that has lost execution continuity: no active run, no queued wake, and not explicitly surfaced. The recovery service reconciles stranded `todo` and `in_progress` work on startup and periodic scans.

*Sources:* `doc/execution-semantics.md` §8

## Task (Product Terminology)
In product documentation (`SPEC.md`, `PRODUCT.md`), "task" is used interchangeably with "issue." In the V1 schema, there is no `tasks` table; `issues` fulfills this role. `AGENTS.md` notes this terminology drift as an architectural contradiction.

*Sources:* `AGENTS.md` §11 (Contradictions), `doc/SPEC.md`, `doc/PRODUCT.md`

## Thread Interaction
A structured request/response protocol between agents and humans, managed by `issueThreadInteractionService`. Supports confirmation requests, review submissions, and continuation policies. Distinct from free-form comments.

*Sources:* `server/src/services/issue-thread-interactions.ts`, `server/src/routes/issues.ts` lines 206-263

## Work Product
A deliverable artifact attached to an issue (`issue_work_products`). Represents concrete output (code, document, config) produced during execution.

*Sources:* `packages/db/src/schema/issueWorkProducts.ts` (implied from `server/src/services/issues.ts` usage)

## Wakeup Request
A queued invocation stored in `agent_wakeup_requests`. Contains `payload` (issueId, executionStage, wakeReason), `status` (`queued`, `deferred_issue_execution`), and links to a `heartbeatRun` when executed.

*Sources:* `packages/db/src/schema/agentWakeupRequests.ts`, `server/src/services/issues.ts` lines 989-1027

---

*Last Updated: 2026-07-14*
*Evidence: All cited documents and source files in this repository.*
