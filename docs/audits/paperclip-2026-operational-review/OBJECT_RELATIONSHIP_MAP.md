# DESIGN EXPLANER: Object Relationship Map

This document provides a visual and tabular reference of all primary entities in the Paperclip data model and their relationships. It is designed to be a quick lookup for understanding how tables connect.

## Entity Graph (Core Operational Loop)

```
┌─────────────┐         ┌─────────────┐         ┌─────────────┐
│   Company   │1─────<n>│   Project   │1─────<n>│    Issue    │
└──────┬──────┘         └─────────────┘         └──────┬──────┘
       │                                              │
       │ 1─────<n>                                    │ 1─────<n>
       ▼                                              ▼
┌─────────────┐                              ┌─────────────┐
│     User    │<n>─────1                      │  IssueComment│
│  (via       │   CompanyMembership           └─────────────┘
│  admins)    │                                              │
└─────────────┘                                              │
       │                                                     │
       │ 1─────<n>                                           │
       ▼                                                     ▼
┌─────────────┐                              ┌─────────────┐
│BoardAccess  │                              │ IssueRelation│
│   Token     │                              │  (blockers)  │
└─────────────┘                              └─────────────┘

┌─────────────┐         ┌─────────────┐         ┌─────────────┐
│    Issue    │1─────<n>│heartbeatRun │1─────<n>│  heartbeat  │
│             │         │             │         │  RunEvent   │
└─────────────┘         └──────┬──────┘         └─────────────┘
                               │
                               │ <n>─────1
                               ▼
                       ┌─────────────┐
                       │    Agent    │
                       │             │
                       └──────┬──────┘
                              │
                              │ 1─────<n>
                              ▼
                       ┌─────────────┐
                       │agentWakeup  │
                       │  Request    │
                       └─────────────┘

┌─────────────┐         ┌─────────────┐         ┌─────────────┐
│    Issue    │1─────<n>│  Document   │1─────<n>│DocRevision  │
│             │         │ (via        │         │             │
│             │         │issueDocuments)        │             │
└─────────────┘         └─────────────┘         └─────────────┘
```

## Full Relationship Table

### `companies`
| Relationship | Cardinality | Via | Notes |
|-------------|-------------|-----|-------|
| `users` | 1→M | `companyMemberships` | Join table `company_memberships` links users to companies |
| `projects` | 1→M | `projects.companyId` | |
| `issues` | 1→M | `issues.companyId` | |
| `agents` | 1→M | `agents.companyId` | |
| `agentApiKeys` | 1→M | `agentApiKeys.companyId` | |
| `boardAccessTokens` | 1→M | `boardAccessTokens.companyId` | |
| `budgetSnapshots` | 1→M | `budgetSnapshots.companyId` | |
| `documents` | 1→M | `documents.companyId` | |
| `routines` | 1→M | `routines.companyId` | |
| `routineRuns` | 1→M (via routines) | `routineRuns.routineId` | |
| `works` | 1→M | `works.companyId` | |
| `settingsEntries` | 1→M | `settingsEntries.companyId` | |
| `agentWorkflowSnapshots` | 1→M | `agentWorkflowSnapshots.companyId` | |
| `diagnostics` | 1→M | `diagnostics.companyId` | |
| `admins` | 1→M | `admins.companyId` | Explicit admin link table |
| `auditLogs` | 1→M | `activityLog.companyId` | Immutable activity trail |

### `users`
| Relationship | Cardinality | Via | Notes |
|-------------|-------------|-----|-------|
| `companies` | M→1 (via membership) | `companyMemberships` | Users belong to companies via membership |
| `adminRoles` | 1→M | `companyMemberships` | `principalType = "user"` |

### `projects`
| Relationship | Cardinality | Via | Notes |
|-------------|-------------|-----|-------|
| `company` | M→1 | `projects.companyId` | |
| `issues` | 1→M | `issues.projectId` | Scoped to project |
| `projectWorkspaces` | 1→M | `projectWorkspaces.projectId` | Isolated workspace configs |

### `issues`
| Relationship | Cardinality | Via | Notes |
|-------------|-------------|-----|-------|
| `company` | M→1 | `issues.companyId` | |
| `project` | M→1 | `issues.projectId` | |
| `parentIssue` | M→1 (self) | `issues.parentId` | Sub-issue hierarchy |
| `childIssues` | 1→M (self) | `issues.parentId` | |
| `blockers` | M→M | `issueRelations` | `type = "blocks"`, `issueId` blocks `relatedIssueId` |
| `blockedIssues` | M→M | `issueRelations` | Inverse of above |
| `assigneeAgent` | M→1 | `issues.assigneeAgentId` | Single agent assignee |
| `assigneeUser` | M→1 | `issues.assigneeUserId` | Single human assignee (mutually exclusive) |
| `comments` | 1→M | `issueComments.issueId` | |
| `documents` | 1→M (via join) | `issueDocuments` | |
| `labels` | M→M | `issueLabels` | |
| `attachments` | 1→M | `issueAttachments.issueId` | |
| `heartbeatRuns` | 1→M | `heartbeatRuns` via `executionRunId` / `checkoutRunId` | Denormalized run linkage |
| `activityLog` | 1→M | `activityLog.entityId` + `entityType = "issue"` | Audit trail |
| `readStates` | 1→M | `issueReadStates.issueId` | Per-user read tracking |
| `inboxArchives` | 1→M | `issueInboxArchives.issueId` | Per-user inbox dismissal |

### `agents`
| Relationship | Cardinality | Via | Notes |
|-------------|-------------|-----|-------|
| `company` | M→1 | `agents.companyId` | |
| `assignedIssues` | 1→M | `issues.assigneeAgentId` | Issues owned by this agent |
| `heartbeatRuns` | 1→M | `heartbeatRuns.agentId` | Execution runs for this agent |
| `comments` | 1→M | `issueComments.authorAgentId` | |
| `apiKeys` | 1→M | `agentApiKeys` (implied) | Authentication keys |
| `wakeupRequests` | 1→M | `agentWakeupRequests` (implied) | Queued invocations |

### `heartbeatRuns`
| Relationship | Cardinality | Via | Notes |
|-------------|-------------|-----|-------|
| `agent` | M→1 | `heartbeatRuns.agentId` | |
| `company` | M→1 | `heartbeatRuns.companyId` | |
| `issue` | M→1 | Via `contextSnapshot.issueId` + `executionRunId` / `checkoutRunId` on issues | Denormalized |
| `wakeupRequest` | M→1 | `heartbeatRuns.wakeupRequestId` | Originating wakeup |
| `runEvents` | 1→M | `heartbeatRunEvents.heartbeatRunId` | Execution events |

### `agentWakeupRequests`
| Relationship | Cardinality | Via | Notes |
|-------------|-------------|-----|-------|
| `company` | M→1 | `agentWakeupRequests.companyId` | |
| `agent` | M→1 | Via `payload` JSON (agentId) or run linkage | |
| `heartbeatRun` | 1→1 (optional) | `heartbeatRuns.wakeupRequestId` | |

### `issueComments`
| Relationship | Cardinality | Via | Notes |
|-------------|-------------|-----|-------|
| `issue` | M→1 | `issueComments.issueId` | |
| `authorAgent` | M→1 | `issueComments.authorAgentId` | Mutually exclusive with user |
| `authorUser` | M→1 | `issueComments.authorUserId` | |
| `parentComment` | M→1 (self) | `issueComments.parentCommentId` | Reply threading |
| `childComments` | 1→M (self) | `issueComments.parentCommentId` | |

### `documents`
| Relationship | Cardinality | Via | Notes |
|-------------|-------------|-----|-------|
| `company` | M→1 | `documents.companyId` | |
| `issues` | M→M | `issueDocuments` | Many documents per issue |
| `revisions` | 1→M | `documentRevisions.documentId` | Immutable version history |

### `routines`
| Relationship | Cardinality | Via | Notes |
|-------------|-------------|-----|-------|
| `company` | M→1 | `routines.companyId` | |
| `routineRuns` | 1→M | `routineRuns.routineId` | Execution history |

### `activityLog`
| Relationship | Cardinality | Via | Notes |
|-------------|-------------|-----|-------|
| `company` | M→1 | `activityLog.companyId` | |
| `actorAgent` | M→1 | `activityLog.agentId` | |
| `entity` | Polymorphic | `entityType` + `entityId` | Points to issues, labels, documents, etc. |

## Key Join Paths

### "Full Issue with Context" Query Path
```
issues
  → projects (projectId)
  → goals (goalId or project.goalId)
  → companyMemberships / agents (assigneeAgentId / assigneeUserId)
  → issueLabels → labels
  → issueRelations (blockers + blocked)
  → issueComments
  → issueDocuments → documents → documentRevisions (latest)
  → heartbeatRuns (executionRunId)
  → activityLog (entityType='issue', entityId)
```

### "Agent Workload" Query Path
```
agents
  → issues (assigneeAgentId, status IN ('todo', 'in_progress', 'blocked'))
  → heartbeatRuns (agentId, status IN ('queued', 'running'))
  → agentWakeupRequests (payload->>'agentId', status='queued')
  → activityLog (agentId, recent)
```

### "Audit Trail for an Issue" Query Path
```
issues
  → activityLog (entityType='issue', entityId=issue.id)
  → issueComments (issueId)
  → heartbeatRuns (via executionRunId / checkoutRunId)
  → heartbeatRunEvents (heartbeatRunId)
```

## Normalization Notes

1. **Denormalized `companyId` on child tables.** `issueComments`, `issueReadStates`, `issueInboxArchives`, `activityLog`, and `runTranscriptEntries` all store `companyId` directly. This enables company-scoped queries without 3-4 table joins, at the cost of potential drift if referential integrity is not maintained.

2. **No `tasks` table.** The conceptual "task" is the `issues` row. This means what would be a `task_id` in other schemas is `issue_id` here. `run_transcript_entries.task_id` actually refers to an issue ID.

3. **Polymorphic actors.** `issues` and `issueComments` use mutually exclusive `assigneeAgentId`/`assigneeUserId` and `authorAgentId`/`authorUserId` rather than a single `actorId` with a type discriminator. This is space-efficient but requires careful query construction.

4. **Self-referential issues.** `issues.parentId` creates a tree structure. Combined with `issueRelations` (blockers), this gives two overlapping graph structures on the same table. Queries that traverse both (e.g., blocker attention computation) are complex and depth-limited.

---

*Last Updated: 2026-07-14*
*Evidence: `packages/db/src/schema/*.ts`, `server/src/services/issues.ts`, `doc/execution-semantics.md`*
