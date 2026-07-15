# 05A — Issue Graph Liveness: Dependency Analysis and Owner Resolution

> **Scope:** How Paperclip analyzes the issue dependency graph to detect liveness violations, selects recovery owners, and creates escalation issues.
> **Status:** Read-only audit. All claims verified against implementation.

---

## 1. Classification Engine (`recovery/issue-graph-liveness.ts`)

### 1.1 Pure Function Design

`classifyIssueGraphLiveness(input: IssueGraphLivenessInput): IssueLivenessFinding[]` is a **pure, synchronous function**. It takes flat arrays of issues, relations, agents, active runs, and queued wakes; returns a list of findings. No DB access, no side effects. This makes it testable and deterministic.

### 1.2 Input Shapes

```ts
export interface IssueGraphLivenessInput {
  issues: IssueLivenessIssueInput[];
  relations: IssueLivenessRelationInput[];
  agents: IssueLivenessAgentInput[];
  activeRuns?: IssueLivenessExecutionPathInput[];
  queuedWakeRequests?: IssueLivenessExecutionPathInput[];
}
```

All inputs are plain objects with scalar fields. The caller (`recovery/service.ts` — `collectIssueGraphLivenessFindings()`) is responsible for the DB queries.

### 1.3 Liveness States

The classifier recognizes four invariant violations:

| State | Condition |
|---|---|
| `blocked_by_unassigned_issue` | Issue A is `blocked`, depends on issue B, B is not `done`, B has no assignee (agent or user), and B has no active execution path. |
| `blocked_by_uninvokable_assignee` | Issue B’s assignee is an agent that is `paused`/`terminated`/`pending_approval` or does not exist. |
| `blocked_by_cancelled_issue` | Issue B is `cancelled` but still listed as a blocker. |
| `invalid_review_participant` | Issue is `in_review` with an `executionState.currentParticipant` that is an uninvokable agent or unresolvable principal. |

### 1.4 Blocking Relation Semantics

Only `issueRelations.type === "blocks"` is considered. For each `blocked` issue, the classifier iterates its blockers:

```ts
for (const relation of relations) {
  const blocker = issuesById.get(relation.blockerIssueId);
  if (!blocker || blocker.status === "done") continue;
  // evaluate blocker state...
}
```

A blocker is **ignored** if it has an active execution path (running run or queued wake). This prevents false positives when a blocker is genuinely in progress.

---

## 2. Owner Candidate Resolution

### 2.1 Candidate Ranking (`recovery/issue-graph-liveness.ts` lines 183–244)

```ts
function ownerCandidatesForRecoveryIssue(issue, agents, agentsById, options) {
  const candidates: IssueLivenessOwnerCandidate[] = [];
  const seen = new Set<string>();

  // 1. Stalled assignee (if enabled and issue still actionable)
  if (options.includeStalledAssignee && issue.status !== "cancelled" && issue.status !== "done") {
    addOwnerCandidate(candidates, seen, agentsById, issue.companyId, issue.assigneeAgentId, "stalled_blocker_assignee", issue.id);
  }

  // 2. Assignee reporting chain
  addAgentChainCandidates(candidates, seen, issue.assigneeAgentId, agentsById, issue.companyId, "assignee_reporting_chain", issue.id);

  // 3. Creator reporting chain
  addAgentChainCandidates(candidates, seen, issue.createdByAgentId, agentsById, issue.companyId, "creator_reporting_chain", issue.id);

  // 4. Root agents (invokable agents with no manager)
  const invokableAgents = orderedInvokableAgents(agents, issue.companyId);
  for (const agent of invokableAgents) {
    if (!agent.reportsTo) {
      addOwnerCandidate(candidates, seen, agentsById, issue.companyId, agent.id, "root_agent", issue.id);
    }
  }

  // 5. Ordered fallback
  for (const agent of invokableAgents) {
    addOwnerCandidate(candidates, seen, agentsById, issue.companyId, agent.id, "ordered_invokable_fallback", issue.id);
  }

  return candidates;
}
```

### 2.2 Reporting Chain Traversal

```ts
function addAgentChainCandidates(candidates, seen, startAgentId, agentsById, companyId, reason, sourceIssueId) {
  const chainSeen = new Set<string>();
  let current = startAgentId ? agentsById.get(startAgentId) : null;
  while (current?.reportsTo) {
    if (chainSeen.has(current.reportsTo)) break; // cycle guard
    chainSeen.add(current.reportsTo);
    const manager = agentsById.get(current.reportsTo);
    if (!manager || manager.companyId !== companyId) break;
    addOwnerCandidate(candidates, seen, agentsById, companyId, manager.id, reason, sourceIssueId);
    current = manager;
  }
}
```

The cycle guard (`chainSeen`) prevents infinite loops from corrupted `reportsTo` data.

### 2.3 Candidate Reasons

| Reason | Source |
|---|---|
| `stalled_blocker_assignee` | The original assignee of the stalled blocker issue. |
| `assignee_reporting_chain` | Managers of the blocked issue’s assignee. |
| `creator_reporting_chain` | Managers of the issue’s creator. |
| `root_agent` | Invokable agents with no `reportsTo` (org roots). |
| `ordered_invokable_fallback` | All invokable agents, sorted by ID (stable but arbitrary). |

---

## 3. Incident Keying & Deduplication

### 3.1 Incident Key Format (`recovery/origins.js` — inferred from usage)

```ts
function buildIssueGraphLivenessIncidentKey(input) {
  // composed of companyId, issueId, state, optional blockerIssueId, optional participantAgentId
}
```

The incident key is a stable string used to prevent duplicate escalation issues for the same violation.

### 3.2 Leaf Fingerprint (`recovery/service.ts` lines 219–228)

```ts
function livenessRecoveryLeafFingerprint(finding) {
  return buildIssueGraphLivenessLeafKey({
    companyId: finding.companyId,
    state: finding.state,
    leafIssueId: livenessRecoveryLeafIssueId(finding),
  });
}
```

The leaf fingerprint is stored as `originFingerprint` on escalation issues. It allows finding existing recoveries even when the incident key format changes.

### 3.3 Unique Constraint Handling

Escalation creation is wrapped in a try/catch for PostgreSQL unique-violation (`code === "23505"`):

```ts
if (!isUniqueLivenessRecoveryConflict(error)) throw error;
const raced = await findOpenLivenessEscalation(...) ?? await findOpenLivenessRecoveryIssueForLeaf(...);
```

Raced creations are handled gracefully by returning the existing issue.

---

## 4. Escalation Creation Flow (`recovery/service.ts` lines 1981–2145)

### 4.1 Preconditions

1. Source issue exists and belongs to the company.
2. No automatic-recovery pause hold is active.
3. Recovery issue (the blocker) exists.
4. No open escalation for this incident key or leaf fingerprint.

### 4.2 Owner Selection with Budget Check

```ts
const ownerSelection = await resolveEscalationOwnerAgentId(finding, recoveryIssue);
```

This iterates `finding.recommendedOwnerCandidates` (or falls back to `recommendedOwnerCandidateAgentIds`), calling `budgets.getInvocationBlock()` for each. The first candidate with no budget block wins. Budget-blocked candidates are tracked in `budgetBlockedCandidateAgentIds` for diagnostics.

### 4.3 Workspace Inheritance

```ts
function shouldReuseRecoveryExecutionWorkspace(input) {
  if (input.finding.recoveryIssueId === input.finding.issueId) return false;
  return input.recoveryIssue.assigneeAgentId === input.ownerAgentId;
}
```

If the escalation owner is already the assignee of the recovery issue, the escalation inherits the recovery issue’s execution workspace. Otherwise, workspace fields are nulled (fresh workspace).

### 4.4 Source Issue Blocked

The source issue is moved to `blocked` and the escalation issue is appended to its `blockedByIssueIds`:

```ts
const nextBlockerIds = [...new Set([...blockerIds, escalationIssueId])];
await issuesSvc.update(sourceIssue.id, {
  ...(sourceIssue.status !== "blocked" ? { status: "blocked" } : {}),
  blockedByIssueIds: nextBlockerIds,
});
```

### 4.5 Activity & Wakeup

- Activity log entry: `action: "issue.harness_liveness_escalation_created"`
- Wakeup enqueued for owner agent with `source: "assignment"`, `wakeReason: "issue_assigned"`

---

## 5. Staleness Thresholds & Auto-Recovery

### 5.1 Warning vs. Action

```ts
const ISSUE_GRAPH_LIVENESS_WARNING_MIN_STALE_MS = 4 * 60 * 60 * 1000;   // 4 hours
const ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_MIN_STALE_MS = 12 * 60 * 60 * 1000; // 12 hours
```

- After 4 hours: log a warning and an activity event.
- After 12 hours: eligible for auto-recovery escalation (if `enableIssueGraphLivenessAutoRecovery` instance setting is true).

### 5.2 Staleness Calculation

```ts
async function getIssueDependencyPathStalenessMs(finding, now) {
  const issueIds = [...new Set(finding.dependencyPath.map(e => e.issueId))];
  const rows = await db.select({ id: issues.id, updatedAt: issues.updatedAt })
    .from(issues)
    .where(and(eq(issues.companyId, finding.companyId), inArray(issues.id, issueIds)));
  const latestUpdatedAt = rows.reduce((latest, row) => row.updatedAt > latest ? row.updatedAt : latest, rows[0]!.updatedAt);
  return now.getTime() - latestUpdatedAt.getTime();
}
```

Staleness is the time since the **most recently updated** issue in the dependency path. This means activity on any issue in the chain resets the timer.

---

## 6. Obsolete Recovery Retirement

### 6.1 Reconciliation (`recovery/service.ts` lines 1809–1861)

`retireObsoleteLivenessRecoveryIssues()` runs after classification:

1. Collect `currentIncidentKeys` and `currentLeafKeys` from all findings.
2. Query all open escalation issues.
3. For each open recovery:
   - If its `originId` is in `currentIncidentKeys` → keep.
   - If its parsed leaf key is in `currentLeafKeys` → keep.
   - Otherwise, remove its blocker relation from the source issue.
   - If the recovery issue has no active run → cancel it.

This prevents stale escalations from permanently blocking source issues after the root cause is resolved.

---

## 7. Architectural Contradictions

1. **Classification is O(n·m) in the worst case.** For each blocked issue, the classifier iterates all blockers. In a dense dependency graph, this is quadratic. There is no adjacency-list precomputation.

2. **`orderedInvokableFallback` sorts by agent ID, not relevance.** If no manager or creator chain yields a candidate, the fallback is alphabetical by UUID — arbitrary and possibly non-sensical.

3. **Staleness uses `updatedAt`, not `createdAt` or last-run time.** If a human edits a blocker issue title, the staleness timer resets. This can delay auto-recovery indefinitely with trivial activity.

4. **Auto-recovery is gated by a global instance setting.** `enableIssueGraphLivenessAutoRecovery` is binary. There is no per-company or per-project toggle.

5. **Escalation issues inherit priority from the recovery issue, not the source issue.** A low-priority blocker can generate a `high` priority escalation if the recovery issue happens to be high priority, which may be surprising.

6. **`activeRuns` and `queuedWakeRequests` are passed as flat arrays.** The classifier does O(n) scans to check execution paths for each blocker. A Map index would eliminate this redundancy.
