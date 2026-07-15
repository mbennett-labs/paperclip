# 08 — QSL Bridge & Review System: File-Based Ingestion, Fingerprint Dedup, and Review State Machine

> **Scope:** The QSL (Query Security Layer) bridge REST API, the `qsl-review.ts` persistence service, the `qslFindings` schema, and the dual-mode file/DB architecture.
> **Status:** Read-only audit. All claims verified against implementation.

---

## 1. QSL Bridge Overview

The QSL bridge is a **file-based integration point** between an external security scanning tool and Paperclip. It operates in two modes:

1. **File-only mode** (`QSL_BRIDGE_PATH` env var set, no DB) — reads/writes JSON files on disk.
2. **DB-backed mode** (DB available) — syncs bridge files into `qslFindings` table, serves from DB, falls back to files on errors.

This dual-mode design allows the QSL system to function even when the Paperclip DB is unavailable (e.g., during migrations or outages).

---

## 2. Bridge File Layout

The bridge expects a directory (`QSL_BRIDGE_PATH`) containing:

| File | Purpose |
|---|---|
| `manifest.json` | Bridge metadata |
| `state.json` | Current scan state with `rules[]` array |
| `issues.json` | Findings/issues list |
| `approvals.jsonl` | Append-only approval decisions |
| `confidence-snapshots.json` | Per-rule confidence history |

---

## 3. REST API (`server/src/routes/qsl-bridge.ts`)

### 3.1 Route Table

| Method | Path | Mode | Description |
|---|---|---|---|
| GET | `/findings` | Dual | List findings (DB preferred, bridge fallback) |
| GET | `/companies/:companyId/findings` | Dual | Company-scoped findings list |
| POST | `/findings/:id/review` | DB-only | Approve or deny a finding |
| POST | `/companies/:companyId/findings/:id/review` | DB-only | Company-scoped review |
| POST | `/findings/:id/state` | DB-only | Set review state (acknowledge, suppress, etc.) |
| POST | `/companies/:companyId/findings/:id/state` | DB-only | Company-scoped state change |
| GET | `/companies/:companyId/findings/debug` | Dual | Diagnostic endpoint |
| GET | `/manifest`, `/state`, `/issues` | File-only | Raw bridge file access |
| POST | `/approve` | File-only | Legacy approval endpoint |

### 3.2 Company ID Resolution

```ts
function resolveCompanyId(req) {
  if (req.params?.companyId) return req.params.companyId;
  if (req.actor?.companyIds?.length === 1) return req.actor.companyIds[0];
  const header = req.headers?.["x-company-id"];
  return typeof header === "string" ? header : null;
}
```

Resolution priority: URL param → actor session (single-company actors only) → `X-Company-ID` header.

### 3.3 Findings List: Sync + Serve (`handleListFindings()`)

```ts
// Step 1: Try to sync bridge issues into DB
if (bridgePath) {
  const bridgeIssues = await readBridgeIssues(bridgePath);
  if (bridgeIssues.length > 0) {
    try {
      await reviewSvc.syncFindings(companyId, bridgeIssues);
    } catch (syncErr) {
      // log and continue
    }
  }
}

// Step 2: Serve from DB
const findings = await reviewSvc.listFindings(companyId, filter);

// Step 3: On DB error, fallback to bridge files
if (bridgePath) {
  const issues = await readBridgeIssues(bridgePath);
  res.json(issues); // bridge fallback
}
```

The sync is **best-effort, non-blocking**. If DB sync fails, the endpoint still serves bridge data. This favors availability over consistency.

### 3.4 Debug Endpoint

`GET /companies/:companyId/findings/debug` returns a diagnostic object with:
- `bridgeIssueCount` and sample issues
- `dbFindingCount` and full DB findings list
- Error details if bridge or DB access failed

This is a privileged endpoint intended for operators troubleshooting QSL integration.

---

## 4. Review Persistence Service (`server/src/services/qsl-review.ts`)

### 4.1 Fingerprint Deduplication

```ts
function computeFingerprint(issue: QslBridgeIssue): string {
  const parts = [
    issue.title ?? "",
    issue.threat_category ?? "",
    issue.severity ?? "",
  ];
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 40);
}
```

The fingerprint is **not** based on `issue.id` (which may change across scans). It uses `title + threat_category + severity` — a design trade-off that:
- Survives external ID changes.
- Risks collision between semantically different issues with the same title/category/severity.

### 4.2 Rule ID Derivation

```ts
function deriveRuleId(issue: QslBridgeIssue): string | null {
  if (issue.rule_id) return issue.rule_id;
  if (issue.threat_category) {
    return issue.threat_category.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  }
  if (issue.title) {
    return issue.title.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 64);
  }
  return null;
}
}
```

`ruleId` is extracted from the bridge issue or synthesized from `threat_category` or `title`. It links findings to approval records.

### 4.3 Sync Algorithm (`syncFindings()`)

```ts
for (const issue of bridgeIssues) {
  const fingerprint = computeFingerprint(issue);
  const existing = await db.select().from(qslFindings)
    .where(and(eq(qslFindings.companyId, companyId), eq(qslFindings.fingerprint, fingerprint)))
    .then(rows => rows[0] ?? null);

  if (existing) {
    const msSinceLastSeen = now.getTime() - existing.lastSeen.getTime();
    const isNewOccurrence = msSinceLastSeen > 5 * 60 * 1000;

    const updateFields = { lastSeen: now, latestRiskScore: ..., latestPayload: issue };
    if (isNewOccurrence) {
      updateFields.occurrenceCount = sql`${qslFindings.occurrenceCount} + 1`;
      if (existing.reviewState === "new") updateFields.reviewState = "recurring";
    }
    await db.update(qslFindings).set(updateFields).where(eq(qslFindings.id, existing.id));
  } else {
    await db.insert(qslFindings).values({ companyId, fingerprint, ruleId, title, ... });
  }
}
```

Key behaviors:
- **5-minute deduplication window**: Occurrence count is only bumped if `lastSeen > 5 minutes ago`. Prevents inflation from rapid page refreshes.
- **State preservation**: Reviewed findings keep their state across syncs.
- **Rule ID backfill**: If a later scan provides a `rule_id` where the original finding had none, the DB is updated.

### 4.4 Review State Machine

```ts
type ReviewState =
  | "new"
  | "recurring"
  | "pending_review"
  | "approved"
  | "denied"
  | "accepted_risk"
  | "suppressed"
  | "escalated";
```

Transitions:
- `syncFindings()` sets initial state: `new`.
- On re-occurrence: `new` → `recurring`.
- `reviewFinding("approved")` → `approved`.
- `reviewFinding("denied")` → `denied`.
- `setReviewState("accepted_risk")` → `accepted_risk`.
- `setReviewState("suppressed")` → `suppressed`.
- `setReviewState("escalated")` → `escalated`.

Active review queue = `new` + `recurring` + `pending_review`.

### 4.5 Review History

Every state change or decision appends to `reviewHistory`:

```ts
const historyEntry = {
  action: decision, // "approved" | "denied" | "state_change:accepted_risk"
  reviewer_id: reviewerId,
  notes: notes ?? null,
  timestamp: now.toISOString(),
  previous_state: existing.reviewState,
  previous_decision: existing.reviewDecision,
};
```

History is stored as a JSONB array. There is no separate history table.

---

## 5. Database Schema (`packages/db/src/schema/qsl_findings.ts`)

```ts
export const qslFindings = pgTable("qsl_findings", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  fingerprint: text("fingerprint").notNull(),
  ruleId: text("rule_id"),
  title: text("title").notNull(),
  severity: text("severity"),
  threatCategory: text("threat_category"),
  reviewState: text("review_state").notNull().default("new"),
  reviewDecision: text("review_decision"),
  reviewerId: text("reviewer_id"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  firstSeen: timestamp("first_seen", { withTimezone: true }).notNull().defaultNow(),
  lastSeen: timestamp("last_seen", { withTimezone: true }).notNull().defaultNow(),
  occurrenceCount: integer("occurrence_count").notNull().default(1),
  latestRiskScore: integer("latest_risk_score"),
  latestPayload: jsonb("latest_payload"),
  reviewHistory: jsonb("review_history").default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  companyFingerprintIdx: uniqueIndex("qsl_findings_company_fingerprint_idx").on(table.companyId, table.fingerprint),
  companyReviewStateIdx: index("qsl_findings_company_review_state_idx").on(table.companyId, table.reviewState),
  companyLastSeenIdx: index("qsl_findings_company_last_seen_idx").on(table.companyId, table.lastSeen),
}));
```

### 5.1 Indexes

- `companyFingerprintIdx` (unique) — deduplication key.
- `companyReviewStateIdx` — active queue filtering.
- `companyLastSeenIdx` — recency sorting.

---

## 6. Backward Compatibility: Legacy Bridge Endpoints

### 6.1 Raw File Access

```ts
for (const name of ["manifest", "state", "issues", "approvals"]) {
  router.get(`/${name}`, async (req, res) => {
    const raw = await readFile(path.join(bridgePath, `${name}.json`), "utf-8");
    const data = JSON.parse(raw);
    // For state.json, merge previous_confidence snapshots
    res.json(data);
  });
}
```

The `state.json` endpoint enriches each rule with `previous_confidence` from `confidence-snapshots.json`.

### 6.2 Legacy Approval Endpoint

```ts
router.post("/approve", async (req, res) => {
  const approval = {
    id: randomUUID(),
    created_at: new Date().toISOString(),
    source: "paperclip",
    rule_id: body.rule_id,
    approved: body.approved,
    decision: body.approved ? "approve" : "deny",
    // ...
  };
  await appendFile(approvalsPath, JSON.stringify(approval) + "\n", "utf-8");
});
```

This writes to `approvals.jsonl` in the bridge directory for external tools to consume.

### 6.3 DB Review → Bridge Approval Mirror

When a finding is reviewed in DB mode, the service also appends to the legacy `approvals.jsonl`:

```ts
if (bridgePath && finding.ruleId) {
  const approvalsPath = path.join(bridgePath, "..", "..", "approvals.jsonl");
  // path traversal guard: resolved.startsWith(resolvedBridge)
  await appendFile(resolved, JSON.stringify(approval) + "\n", "utf-8").catch(() => {});
}
```

This ensures external tools reading `approvals.jsonl` see decisions made through the Paperclip UI.

### 6.4 Confidence Snapshots

Before writing an approval, the bridge snapshots the rule’s current confidence:

```ts
const state = JSON.parse(await readFile(path.join(bridgePath, "state.json"), "utf-8"));
const rule = state.rules.find(r => r.id === ruleId);
if (rule && typeof rule.confidence === "number") {
  const snapshots = await readSnapshots(bridgePath);
  snapshots[ruleId] = rule.confidence;
  await writeSnapshots(bridgePath, snapshots);
}
```

This allows trend analysis of how confidence changes as approvals are recorded.

---

## 7. Architectural Contradictions

1. **Fingerprint collision risk.** `computeFingerprint()` uses only `title + threat_category + severity`. Two distinct issues with the same title and severity will share a fingerprint, causing one to suppress the other.

2. **Dual write without transactionality.** The DB review and the `approvals.jsonl` append are separate, uncoordinated writes. If the DB commit succeeds but the file append fails (or vice versa), the systems diverge.

3. **5-minute dedup window is a magic number.** There is no configurability. A scan that runs every 3 minutes will never increment `occurrenceCount`, while a scan that runs every 6 minutes will increment on every sync.

4. **No cleanup of old bridge files.** `issues.json` and `state.json` are overwritten by the external tool, but `approvals.jsonl` is append-only. It grows indefinitely unless manually rotated.

5. **DB fallback to bridge files loses review state.** If the DB is unavailable, the API returns raw bridge issues without any review history, decisions, or occurrence counts. A board operator reviewing findings during a DB outage sees unreviewed issues even if they were previously processed.

6. **Rule ID derivation is lossy and non-deterministic across languages.** `threat_category.toLowerCase().replace(/[^a-z0-9]+/g, "_")` strips non-ASCII characters. A category named `"Sicherheitslücke"` becomes `"sicherheitsl_cke"`, which may collide with other derived IDs.

7. **No RBAC on QSL bridge endpoints.** The debug endpoint and legacy file endpoints do not check company access beyond `resolveCompanyId`. A multi-company actor could theoretically access bridge data for any company by setting the `X-Company-ID` header.
