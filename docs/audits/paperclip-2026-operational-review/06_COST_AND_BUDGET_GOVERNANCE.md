# 06 — Cost & Budget Governance: Tracking, Enforcement, and Hard Stops

> **Scope:** Cost event ingestion, monthly aggregation, budget policy enforcement, hard-stop behavior, and incident resolution.
> **Status:** Read-only audit. All claims verified against implementation.

---

## 1. Cost Event Schema (`costEvents`)

Source: inferred from `server/src/services/costs.ts` and `packages/db/src/schema/budget_policies.ts`

Each adapter run that reports usage triggers a cost event row:

| Field | Purpose |
|---|---|
| `companyId` | Company scope. |
| `agentId` | Agent scope (nullable for company-wide events). |
| `heartbeatRunId` | Links cost to the originating run. |
| `provider` / `biller` / `model` | Attribution for dashboards and provider-specific budgets. |
| `billingType` | `metered_api`, `subscription_included`, `subscription_overage`, `credits`, `fixed`, `unknown`. |
| `costCents` | Normalized cost in integer cents. |
| `inputTokens` / `cachedInputTokens` / `outputTokens` | Token-level telemetry. |
| `occurredAt` | Event timestamp. |
| `projectId` | Optional project-level attribution. |

---

## 2. Cost Service (`server/src/services/costs.ts`)

### 2.1 Event Creation (`createEvent()`)

```ts
async createEvent(companyId, data) {
  const agent = await db.select().from(agents).where(eq(agents.id, data.agentId)).then(rows => rows[0] ?? null);
  if (!agent) throw notFound("Agent not found");
  if (agent.companyId !== companyId) throw unprocessable("Agent does not belong to company");

  const event = await db.insert(costEvents).values({ ...data, companyId }).returning().then(rows => rows[0]);

  const [agentMonthSpend, companyMonthSpend] = await Promise.all([
    getMonthlySpendTotal(db, { companyId, agentId: event.agentId }),
    getMonthlySpendTotal(db, { companyId }),
  ]);

  await db.update(agents).set({ spentMonthlyCents: agentMonthSpend, updatedAt: new Date() }).where(eq(agents.id, event.agentId));
  await db.update(companies).set({ spentMonthlyCents: companyMonthSpend, updatedAt: new Date() }).where(eq(companies.id, companyId));

  await budgets.evaluateCostEvent(event);
  return event;
}
```

**Critical path observation:** Cost finalization is **inline and synchronous**. The heartbeat run cannot fully complete until `budgets.evaluateCostEvent()` finishes. A slow budget query or high DB load directly extends run latency.

### 2.2 Aggregation Queries

The cost service provides multiple aggregation dimensions:

- `summary(companyId, range?)` — total spend vs. company monthly budget.
- `byAgent(companyId, range?)` — per-agent spend, token counts, run counts by billing type.
- `byProvider(companyId, range?)` — per-provider/model breakdown.
- `byBiller(companyId, range?)` — per-biller rollup with provider/model counts.
- `windowSpend(companyId)` — rolling windows (5h, 24h, 7d) per provider.
- `byAgentModel(companyId, range?)` — agent × provider × model matrix.
- `byProject(companyId, range?)` — project-level spend via `activityLog` join heuristic.

### 2.3 Subscription vs. Metered Split

All aggregation queries distinguish `metered_api` runs from `subscription_included`/`subscription_overage` runs:

```ts
const METERED_BILLING_TYPE = "metered_api";
const SUBSCRIPTION_BILLING_TYPES = ["subscription_included", "subscription_overage"] as const;
```

This split appears in every `byAgent`, `byProvider`, and `byBiller` query as separate `count(distinct ...)` columns.

---

## 3. Budget Policies (`packages/db/src/schema/budget_policies.ts`)

### 3.1 Schema

| Field | Purpose |
|---|---|
| `scopeType` | `company`, `agent`, `project` |
| `scopeId` | FK to the scoped entity |
| `metric` | Currently only `billed_cents` |
| `windowKind` | `calendar_month_utc` or `lifetime` |
| `amount` | Integer cents budget limit |
| `warnPercent` | Soft threshold (default 80%) |
| `hardStopEnabled` | Default `true` |
| `notifyEnabled` | Default `true` |
| `isActive` | Policy gate |

### 3.2 Unique Constraint

```ts
uniqueIndex("budget_policies_company_scope_metric_unique_idx")
  .on(table.companyId, table.scopeType, table.scopeId, table.metric, table.windowKind)
```

Only one active policy per `(company, scope, metric, window)` tuple.

---

## 4. Budget Service (`server/src/services/budgets.ts`)

### 4.1 Scope Resolution

```ts
async function resolveScopeRecord(db, scopeType, scopeId): Promise<ScopeRecord> {
  if (scopeType === "company") { ... }
  if (scopeType === "agent") { ... }
  // else project
}
```

Returns `{ companyId, name, paused, pauseReason }`. This is used to surface scope status in policy summaries.

### 4.2 Observed Amount Computation

```ts
async function computeObservedAmount(db, policy) {
  if (policy.metric !== "billed_cents") return 0;
  const conditions = [eq(costEvents.companyId, policy.companyId)];
  if (policy.scopeType === "agent") conditions.push(eq(costEvents.agentId, policy.scopeId));
  if (policy.scopeType === "project") conditions.push(eq(costEvents.projectId, policy.scopeId));
  const { start, end } = resolveWindow(policy.windowKind);
  if (policy.windowKind === "calendar_month_utc") {
    conditions.push(gte(costEvents.occurredAt, start));
    conditions.push(lt(costEvents.occurredAt, end));
  }
  const [row] = await db.select({ total: sql`coalesce(sum(${costEvents.costCents}), 0)::double precision` })
    .from(costEvents).where(and(...conditions));
  return Number(row?.total ?? 0);
}
```

**Window resolution:**
- `calendar_month_utc` → current UTC month boundaries.
- `lifetime` → `1970-01-01` to `9999-01-01`.

### 4.3 Policy Upsert & Immediate Enforcement

```ts
async upsertPolicy(companyId, input, actorUserId) {
  // ... resolve or create policy row ...

  if (amount > 0) {
    const observedAmount = await computeObservedAmount(db, row);
    if (observedAmount < amount) {
      await resumeScopeFromBudget(row);
      await resolveOpenIncidentsForPolicy(row.id, actorUserId ? "approved" : null, actorUserId);
    } else {
      const softThreshold = Math.ceil((row.amount * row.warnPercent) / 100);
      if (row.notifyEnabled && observedAmount >= softThreshold) {
        await createIncidentIfNeeded(row, "soft", observedAmount);
      }
      if (row.hardStopEnabled && observedAmount >= row.amount) {
        await resolveOpenSoftIncidents(row.id);
        await createIncidentIfNeeded(row, "hard", observedAmount);
        await pauseAndCancelScopeForBudget(row);
      }
    }
  } else {
    await resumeScopeFromBudget(row);
    await resolveOpenIncidentsForPolicy(...);
  }
}
```

Upserting a policy immediately evaluates it. If the scope is already over budget, it is paused and cancelled inline.

### 4.4 Hard-Stop Behavior (`pauseAndCancelScopeForBudget`)

```ts
async function pauseAndCancelScopeForBudget(policy) {
  await pauseScopeForBudget(policy);
  await hooks.cancelWorkForScope?.({
    companyId: policy.companyId,
    scopeType: policy.scopeType as BudgetScopeType,
    scopeId: policy.scopeId,
  });
}
```

The `cancelWorkForScope` hook is injected by the heartbeat service:

```ts
const budgetHooks = {
  cancelWorkForScope: cancelBudgetScopeWork,
};
```

`cancelBudgetScopeWork` cancels all cancellable runs and queued wakes for the scope.

### 4.5 Scope Pause/Resume

| Scope Type | Pause Action | Resume Action |
|---|---|---|
| `agent` | `status = "paused"`, `pauseReason = "budget"` | `status = "idle"`, `pauseReason = null` |
| `project` | `pausedAt = now`, `pauseReason = "budget"` | `pausedAt = null`, `pauseReason = null` |
| `company` | `status = "paused"`, `pauseReason = "budget"` | `status = "active"`, `pauseReason = null` |

Resume is conditional on `pauseReason === "budget"`. If an agent is paused for `"manual"` or `"system"`, a budget increase does **not** auto-resume it.

---

## 5. Incident Lifecycle (`packages/db/src/schema/budget_incidents.ts`)

### 5.1 Schema

| Field | Purpose |
|---|---|
| `policyId` | FK to `budgetPolicies` |
| `scopeType` / `scopeId` | Denormalized for fast querying |
| `thresholdType` | `soft` or `hard` |
| `amountLimit` / `amountObserved` | Snapshot at incident creation |
| `status` | `open`, `resolved`, `dismissed` |
| `approvalId` | FK to `approvals` (hard incidents only) |

### 5.2 Unique Constraint

```ts
uniqueIndex("budget_incidents_policy_window_threshold_idx")
  .on(table.policyId, table.windowStart, table.thresholdType)
  .where(sql`${table.status} <> 'dismissed'`)
```

Only one non-dismissed incident per `(policy, window, threshold)`.

### 5.3 Soft Incident Creation

When observed spend crosses `warnPercent`:
- Creates an `approval` row with `type: "budget_override_required"`.
- Does **not** pause the scope.
- Notifies operators (via activity log).

### 5.4 Hard Incident Creation

When observed spend crosses `amount`:
- Creates an `approval` row if one does not exist.
- Resolves any open soft incidents for the policy.
- Pauses the scope.
- Calls `cancelWorkForScope`.

### 5.5 Incident Resolution (`resolveIncident()`)

Two resolution paths:

**Raise budget and resume:**
```ts
if (input.action === "raise_budget_and_resume") {
  const nextAmount = Math.max(0, Math.floor(input.amount ?? 0));
  const currentObserved = await computeObservedAmount(db, policy);
  if (nextAmount <= currentObserved) throw unprocessable("New budget must exceed current observed spend");
  await db.update(budgetPolicies).set({ amount: nextAmount, isActive: true }).where(eq(budgetPolicies.id, policy.id));
  await resumeScopeFromBudget(policy);
  await markApprovalStatus(db, incident.approvalId, "approved", ...);
}
```

**Dismiss:**
```ts
await db.update(budgetIncidents).set({ status: "dismissed", resolvedAt: new Date() }).where(eq(budgetIncidents.id, incident.id));
await markApprovalStatus(db, incident.approvalId, "rejected", ...);
```

---

## 6. Budget Invocation Block (`getInvocationBlock()`)

### 6.1 Pre-Run Check

Before a heartbeat run starts, `budgets.getInvocationBlock()` is called to check if the agent/company/project is paused or over budget:

```ts
async getInvocationBlock(companyId, agentId, context?) {
  // 1. Check company paused
  // 2. Check company hard-stop
  // 3. Check agent paused (budget reason)
  // 4. Check agent hard-stop
  // 5. Check project paused (budget reason)
  // 6. Check project hard-stop
}
```

If any check returns a block, the heartbeat run is aborted **before** the adapter is invoked.

### 6.2 Hierarchical Precedence

The check order is **company → agent → project**. A company-level hard-stop blocks all agents regardless of their individual budgets. An agent-level hard-stop blocks that agent even if the company has headroom.

---

## 7. Architectural Contradictions

1. **Cost finalization is inline with run completion.** `costService.createEvent()` is called synchronously during heartbeat run finalization. A slow `sum(costCents)` query blocks the run status transition and the agent’s next wakeup.

2. **`spentMonthlyCents` on `agents` and `companies` is denormalized and recomputed on every event.** This is O(n) aggregate work on the hot path. There is no batching or deferred update.

3. **Budget incident approval is separate from the approval system used by issue execution gates.** Budget approvals use `approvals` rows with `type: "budget_override_required"`, while execution approvals use `type: "execution_review"`. The two approval subsystems share a table but have different resolution semantics and UI expectations.

4. **`cancelWorkForScope` is a hook, not a transaction participant.** If `pauseScopeForBudget()` succeeds but `cancelWorkForScope()` fails (e.g., run cancellation throws), the scope is paused but work may still be running.

5. **Project budget scopes rely on `costEvents.projectId`, which is optional.** If a run does not have a linked project, project-level budgets undercount. The `byProject` query uses an `activityLog` heuristic to backfill missing `projectId`, but this is approximate.

6. **Budget windows are UTC calendar months only (or lifetime).** There is no weekly, daily, or rolling-window policy. A spike on the 31st and the 1st are in different windows with independent limits.
