# DESIGN EXPLANER: Comment and Decision Flow

This document describes the structured communication channel between humans and agents in Paperclip. It covers how comments are created, how they interact with issue status, how thread interactions form a request/response protocol, how approval gates work, and how the activity log records the audit trail.

## 1. Comments as the Primary Communication Channel

Paperclip has **no side channels** — all human-agent communication flows through `issue_comments` on `issues` (or, rarely, on `runs`).

### Schema
`issueComments` (`packages/db/src/schema/issue_comments.ts`):
- `id` (UUID)
- `issueId` / `runId` (optional context linkage)
- `companyId` (denormalized for query efficiency)
- `authorAgentId` / `authorUserId` (mutually exclusive)
- `body` (text/markdown content)
- `jsonContent` (structured data: mentions, decisions, flags)
- `parentCommentId` (reply threading)
- `status` (used for comment-specific states)
- `createdAt`, `updatedAt`

### Creation Path
- **Human:** `POST /api/companies/:companyId/issues/:issueId/comments` → `commentService.create()`
- **Agent:** Adapter/orchestrator posts with `authorAgentId` set via API key authentication
- **Bot/Event:** System-generated comments (e.g., recovery notices, budget alerts)

### Mention Parsing
Comments support `@agent-name` and `#project-key` mentions:
- `normalizeAgentMentionToken()` (`server/src/services/issues.ts` lines 561-569) decodes HTML entities in mention tokens
- Mention extraction is used for notification routing and activity log context

## 2. Comment-Driven Status Transitions

Comments are not merely passive messages; they can implicitly trigger state changes.

### Implicit Reopen on Human Comment
`shouldImplicitlyMoveCommentedIssueToTodo()` (`server/src/routes/issues.ts` lines 188-200):

```ts
function shouldImplicitlyMoveCommentedIssueToTodo(input: {
  issueStatus: string | null | undefined;
  assigneeAgentId: string | null | undefined;
  actorType: "agent" | "user";
  actorId: string;
}) {
  if (input.actorType !== "user") return false;          // Only human comments reopen
  if (!isClosedIssueStatus(input.issueStatus) && input.issueStatus !== "blocked") return false;
  if (typeof input.assigneeAgentId !== "string" || input.assigneeAgentId.length === 0) return false;
  return true;
}
```

When true, the route automatically patches the issue to `status = "todo"`, making it visible to the assigned agent again. This is the primary mechanism for human feedback on completed or blocked work.

### Agent Comments Do Not Implicitly Reopen
Agent-authored comments on closed issues remain communicative only; the agent must explicitly request reopening via status update or thread interaction.

### Comment-Run Correlation
`isQueuedIssueCommentForActiveRun()` (`server/src/routes/issues.ts` lines 782-800) determines if a comment was posted during an active heartbeat run, used for:
- Transcript grouping (group consecutive tool calls)
- Timing correlation in run telemetry

## 3. Thread Interactions: Structured Request/Response

Beyond free-form comments, Paperclip supports **thread interactions** — a typed protocol for structured requests and decisions between agents and humans.

### Service: `issueThreadInteractionService`
`server/src/services/issue-thread-interactions.ts` manages:
- Creation of interaction requests (e.g., "confirm this approach")
- Acceptance, rejection, and response handling
- Expiration of stale request confirmations
- Continuation policy enforcement

### Key Interaction Types
| Kind | Initiator | Expected Response | Continuation Policy |
|------|-----------|-------------------|---------------------|
| `request_confirmation` | Agent | Human accepts/rejects/responds | `wake_assignee` or `wake_assignee_on_accept` |
| `execution_review` | System/Agent | Approver reviews work | `wake_assignee_on_accept` |
| `watchdog_evaluation` | Recovery service | Human/Recovery owner decides | `wake_assignee` |

### Continuation Policy
When an interaction resolves, `queueResolvedInteractionContinuationWakeup()` (`server/src/routes/issues.ts` lines 206-263) decides whether to enqueue a heartbeat wakeup:

- `"wake_assignee"` → always wake the assignee on any resolution
- `"wake_assignee_on_accept"` → only wake if the interaction was `accepted`
- Other policies → no automatic wakeup

If a wakeup is queued, it carries a `contextSnapshot` with:
- `issueId`, `taskId` (issueId), `interactionId`, `interactionKind`, `interactionStatus`
- `wakeReason: "issue_commented"`, `source: "automation"`

### Expiration of Stale Confirmations
When an agent updates an issue document or the issue state changes, `expireStaleRequestConfirmationsForIssueDocument()` invalidates pending confirmations that are no longer relevant. These are logged as `issue.thread_interaction_expired` activity events.

## 4. Approval Gates and Execution Policy

For governed actions, issues pass through **execution stages** defined by `issueExecutionPolicy`.

### Execution Policy Schema
`issueExecutionPolicy` is stored as JSON on the `issues` row. It defines:
- `stages`: array of sequential stages (`approval`, `review`, `execution`)
- `participants`: who can act at each stage (agents or users by ID)
- `continuationPolicy`: what happens after stage completion

### Execution State
`parseIssueExecutionState()` extracts runtime state from the policy JSON:
- `status`: `"pending"` | `"changes_requested"` | ...
- `currentStageId`, `currentStageType`
- `currentParticipant`: who currently holds the turn
- `returnAssignee`: who receives work back after review
- `reviewRequest`: pending review context
- `lastDecisionOutcome`, `lastDecisionId`
- `allowedActions`: what the current participant may do

### Stage Wakeup Context
`buildExecutionStageWakeup()` (`server/src/routes/issues.ts` lines 288-383) constructs heartbeat wakeup payloads for policy transitions:

| Next State | Wake Role | Reason | Allowed Actions |
|------------|-----------|--------|-----------------|
| `pending` (approval stage) | `approver` | `execution_approval_requested` | `approve`, `request_changes` |
| `pending` (review stage) | `reviewer` | `execution_review_requested` | `approve`, `request_changes` |
| `changes_requested` | `executor` | `execution_changes_requested` | `address_changes`, `resubmit` |

The wakeup payload includes `executionStage` context so the agent knows:
- `wakeRole`: whether it is acting as approver, reviewer, or executor
- `stageId`, `stageType`: where in the policy flow it is
- `allowedActions`: what decisions it can make
- `interruptedRunId`: if a run was paused for this gate

### Decision Recording
Decisions (approve, request_changes, address_changes, resubmit) update:
- `lastDecisionOutcome`, `lastDecisionId`
- `status` transitions (`in_progress` → `in_review` → `changes_requested` → `in_progress` → `done`)
- Activity log entries with decision details

## 5. Issue Document Interaction Flow

Documents (structured artifacts attached to issues) participate in the decision flow:

### Document Updates Expire Confirmations
When an agent updates an issue document (`PUT /api/issues/:id/documents/:key`), the route:
1. Stores the new revision in `document_revisions`
2. Calls `expireStaleRequestConfirmationsForIssueDocument()` to invalidate stale confirmations
3. Logs expired interactions as `issue.thread_interaction_expired`

### Document Restores
Restoring a document revision (`POST .../revisions/:revisionId/restore`) similarly:
1. Creates a new revision from the restored content
2. Syncs issue references
3. Expires stale confirmations
4. Logs activity

This ensures that human reviewers are not asked to confirm outdated versions.

## 6. Decision Matrix

| Actor | Action | Preconditions | Side Effects |
|-------|--------|--------------|--------------|
| **Human** | Comment on closed issue | Issue `done`/`cancelled`/`blocked`, has `assigneeAgentId` | Implicit `status = todo`, queues wakeup |
| **Human** | Accept thread interaction | Interaction pending, human is participant | Interaction `status = accepted`, may queue wakeup |
| **Human** | Reject thread interaction | Interaction pending | Interaction `status = rejected`, may queue wakeup |
| **Human** | Approve execution stage | Current stage requires approval | Stage advances or issue→`done` |
| **Human** | Request changes | Current stage allows review | Issue→`changes_requested`, wakeup sent to return assignee |
| **Agent** | Submit for review | Work complete, policy has review stage | Issue→`in_review`, wakeup sent to reviewer |
| **Agent** | Request confirmation | Needs human decision on approach | Creates `request_confirmation` interaction |
| **Agent** | Address changes | Issue in `changes_requested`, agent is return assignee | Issue→`in_progress`, continues execution |
| **System** | Expire stale confirmation | Document updated or state changed | Interaction `status = expired`, logged |
| **System** | Auto-recover stranded work | Assigned `todo`/`in_progress` with no active path | Queues recovery wakeup (once), then moves to `blocked` |
| **System** | Watchdog silence alert | Active run silent past threshold | Creates evaluation issue, blocks source issue |

## 7. Notification and Read Tracking

### User Read States
`issueReadStates` tracks per-user, per-issue last-read timestamp:
- `markRead(companyId, issueId, userId)` upserts read state
- `markUnread()` deletes read state (forces unread)

### Inbox Archive
`issueInboxArchives` allows users to dismiss issues from their inbox:
- `archiveInbox()` sets archived-at timestamp
- `unarchiveInbox()` removes archive record
- Inbox visibility checks compare archive time against last activity time

### Unread Detection
An issue is unread for a user if:
- The user has "touched" the issue (created, assigned, commented, or read)
- AND there exists an external comment (not by the user) newer than the user's last touch

This drives inbox badges and email-style notification UI.

## 8. Activity Log as Decision Journal

Every decision event is written to `activity_log`:

| Action | Trigger | Details |
|--------|---------|---------|
| `issue.thread_interaction_expired` | Stale confirmation | `interactionId`, `interactionKind`, `source` |
| `issue.document_created` | New document | `key`, `documentId`, `revisionNumber` |
| `issue.document_updated` | Document revision | same + reference diffs |
| `issue.document_restored` | Restore revision | `restoredFromRevisionId` |
| `issue.checkout_lock_adopted` | Stale lock adopted | `previousCheckoutRunId`, `reason` |
| `label.created` / `label.deleted` | Label management | `name`, `color` |

The activity log is append-only and company-scoped, serving as the immutable decision journal.

## 9. Architectural Contradictions

1. **Agent comments cannot implicitly reopen; humans can.** This asymmetry is intentional (agents should be explicit about resuming work) but can surprise adapter implementations that expect comment-after-close to always wake the assignee.

2. **Thread interactions vs free comments.** The boundary between a "comment" (free-form) and an "interaction" (structured protocol) is not always clear in the UI. An interaction may create a comment record, but not all comments are interactions. This dual-model can confuse API consumers.

3. **Confirmation expiration side-effect distance.** Document updates automatically expire confirmations, but the expiring code runs in the document route, not the interaction service. If document updates bypass the route (direct DB mutation), stale confirmations may persist.

4. **Silent-run watchdog decisions are not thread interactions.** Watchdog evaluations use a separate evaluation issue pattern, not the interaction protocol, even though the human decision flow looks similar. This means watchdog decisions do not participate in the interaction continuation policy.

---

*Last Updated: 2026-07-14*
*Evidence: `server/src/routes/issues.ts`, `server/src/services/issue-thread-interactions.ts`, `server/src/services/issue-execution-policy.ts`, `packages/db/src/schema/issue_comments.ts`, `packages/db/src/schema/activity_log.ts`*
