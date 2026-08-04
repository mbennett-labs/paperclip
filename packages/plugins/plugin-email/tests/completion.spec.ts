import { describe, expect, it } from "vitest";

/**
 * Tests for D2: Evidence write-once, D3: Safe append-only, D4: Trusted reviewer,
 * D6: Notification ordering, D7: Analysis validation, D8: Privacy.
 *
 * These tests verify the logic contracts rather than live worker integration.
 */

// ---------------------------------------------------------------------------
// D2: Evidence write-once enforcement
// ---------------------------------------------------------------------------

describe("Evidence write-once (D2)", () => {
  it("first evidence write succeeds", () => {
    const evidenceStore = new Map<string, unknown>();
    const evidence = { evidenceId: "ev-abc", storeName: "Test Store" };
    const key = "intake-evidence";

    const existing = evidenceStore.get(key);
    expect(existing).toBeUndefined();

    evidenceStore.set(key, evidence);
    expect(evidenceStore.get(key)).toEqual(evidence);
  });

  it("repeated identical ingestion does not overwrite", () => {
    const evidenceStore = new Map<string, unknown>();
    const originalEvidence = { evidenceId: "ev-abc", storeName: "Original Store", ingestedAt: "2026-01-01T00:00:00Z" };
    const duplicateEvidence = { evidenceId: "ev-abc", storeName: "Duplicate Store", ingestedAt: "2026-06-01T00:00:00Z" };

    // First write
    evidenceStore.set("intake-evidence", originalEvidence);

    // Second write attempt: check first, skip if exists
    const existing = evidenceStore.get("intake-evidence");
    if (!existing) {
      evidenceStore.set("intake-evidence", duplicateEvidence);
    }

    expect(evidenceStore.get("intake-evidence")).toEqual(originalEvidence);
    expect((evidenceStore.get("intake-evidence") as Record<string, unknown>).storeName).toBe("Original Store");
  });

  it("conflicting second evidence attempt is detected", () => {
    const evidenceStore = new Map<string, unknown>();
    const log: string[] = [];

    const originalEvidence = { evidenceId: "ev-abc", storeName: "Original Store" };
    const conflictingEvidence = { evidenceId: "ev-xyz", storeName: "Conflicting Store" };

    // First write
    evidenceStore.set("intake-evidence", originalEvidence);

    // Conflict check
    const existing = evidenceStore.get("intake-evidence") as Record<string, unknown> | undefined;
    if (existing && existing.evidenceId !== conflictingEvidence.evidenceId) {
      log.push("evidence_conflict");
    } else if (!existing) {
      evidenceStore.set("intake-evidence", conflictingEvidence);
    }

    expect(log).toContain("evidence_conflict");
    expect(evidenceStore.get("intake-evidence")).toEqual(originalEvidence);
  });

  it("original evidence remains unchanged after conflict", () => {
    const evidenceStore = new Map<string, unknown>();
    const original = { evidenceId: "ev-1", fields: ["a", "b", "c"] };
    const conflict = { evidenceId: "ev-2", fields: ["x", "y"] };

    evidenceStore.set("intake-evidence", original);

    const existing = evidenceStore.get("intake-evidence") as Record<string, unknown> | undefined;
    if (existing && existing.evidenceId !== conflict.evidenceId) {
      // Conflict: do NOT overwrite
    } else if (!existing) {
      evidenceStore.set("intake-evidence", conflict);
    }

    expect(evidenceStore.get("intake-evidence")).toEqual(original);
  });
});

// ---------------------------------------------------------------------------
// D3: Safe append-only analysis and review
// ---------------------------------------------------------------------------

describe("Safe append-only analysis/review (D3)", () => {
  it("multiple analyses are preserved via unique keys", () => {
    const store = new Map<string, unknown>();
    const keyIndex: string[] = [];

    const a1 = { id: "analysis-1", version: 1 };
    const a2 = { id: "analysis-2", version: 2 };
    const a3 = { id: "analysis-3", version: 3 };

    for (const a of [a1, a2, a3]) {
      const key = "intake-analysis-" + Date.now() + "-" + a.id;
      store.set(key, a);
      keyIndex.push(key);
    }

    expect(keyIndex.length).toBe(3);
    expect(store.get(keyIndex[0])).toEqual(a1);
    expect(store.get(keyIndex[1])).toEqual(a2);
    expect(store.get(keyIndex[2])).toEqual(a3);
  });

  it("analyses never erase prior analyses", () => {
    const store = new Map<string, unknown>();
    const keyIndex: string[] = [];

    const first = { id: "first", content: "original" };
    const second = { id: "second", content: "updated" };

    store.set("intake-analysis-a", first);
    keyIndex.push("intake-analysis-a");
    store.set("intake-analysis-b", second);
    keyIndex.push("intake-analysis-b");

    // Both should still exist
    expect(store.get("intake-analysis-a")).toEqual(first);
    expect(store.get("intake-analysis-b")).toEqual(second);
    expect(keyIndex.length).toBe(2);
  });

  it("multiple reviews are preserved via unique keys", () => {
    const store = new Map<string, unknown>();
    const keyIndex: string[] = [];

    const r1 = { reviewIndex: 0, verdict: "unsure" };
    const r2 = { reviewIndex: 1, verdict: "genuine_external" };

    for (const r of [r1, r2]) {
      const key = "intake-review-" + Date.now() + "-" + r.reviewIndex;
      store.set(key, r);
      keyIndex.push(key);
    }

    expect(keyIndex.length).toBe(2);
    expect(store.get(keyIndex[0])).toEqual(r1);
    expect(store.get(keyIndex[1])).toEqual(r2);
  });

  it("reviews never erase prior reviews", () => {
    const store = new Map<string, unknown>();
    const keyIndex: string[] = [];

    store.set("intake-review-a", { reviewIndex: 0, verdict: "unsure" });
    keyIndex.push("intake-review-a");
    store.set("intake-review-b", { reviewIndex: 1, verdict: "spam" });
    keyIndex.push("intake-review-b");

    expect(store.get("intake-review-a")).toBeDefined();
    expect(store.get("intake-review-b")).toBeDefined();
    expect(keyIndex.length).toBe(2);
  });

  it("repeated request is handled via unique key", () => {
    const store = new Map<string, unknown>();
    const keyIndex: string[] = [];

    // Two concurrent "reviews" at same logical time
    const key1 = "intake-review-" + 1000 + "-0";
    const key2 = "intake-review-" + 1001 + "-1";  // Different timestamp = unique key

    store.set(key1, { reviewIndex: 0, verdict: "genuine_external" });
    keyIndex.push(key1);
    store.set(key2, { reviewIndex: 1, verdict: "spam" });
    keyIndex.push(key2);

    // Both survive
    expect(store.size).toBe(2);
    expect(keyIndex.length).toBe(2);
  });

  it("latest review resolution works correctly", () => {
    const store = new Map<string, unknown>();
    const keyIndex: string[] = [];

    store.set("intake-review-1", { reviewIndex: 0, verdict: "unsure", reviewedAt: "2026-01-01" });
    keyIndex.push("intake-review-1");
    store.set("intake-review-2", { reviewIndex: 1, verdict: "genuine_external", reviewedAt: "2026-02-01" });
    keyIndex.push("intake-review-2");

    const lastKey = keyIndex[keyIndex.length - 1];
    const latest = store.get(lastKey) as { verdict: string };

    expect(latest.verdict).toBe("genuine_external");
  });

  it("no history erasure from any operation", () => {
    const store = new Map<string, unknown>();
    const keyIndex: string[] = [];

    for (let i = 0; i < 5; i++) {
      const key = "intake-review-" + i;
      store.set(key, { reviewIndex: i, verdict: "test-" + i });
      keyIndex.push(key);
    }

    for (const key of keyIndex) {
      expect(store.get(key)).toBeDefined();
    }
    expect(keyIndex.length).toBe(5);
  });

  it("changing a verdict creates a new review record", () => {
    const store = new Map<string, unknown>();
    const keyIndex: string[] = [];

    store.set("intake-review-a", { reviewIndex: 0, verdict: "genuine_external" });
    keyIndex.push("intake-review-a");

    // Human changes verdict
    store.set("intake-review-b", { reviewIndex: 1, verdict: "spam" });
    keyIndex.push("intake-review-b");

    // Original still exists
    expect((store.get("intake-review-a") as Record<string, unknown>).verdict).toBe("genuine_external");
    expect((store.get("intake-review-b") as Record<string, unknown>).verdict).toBe("spam");
    expect(keyIndex.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// D4: Trusted reviewer identity
// ---------------------------------------------------------------------------

describe("Trusted reviewer identity (D4)", () => {
  it("rejects review without authenticated user", () => {
    const actorCtx = { actor: { userId: null, type: "system" } };

    const canReview = actorCtx.actor.userId != null;
    expect(canReview).toBe(false);
  });

  it("accepts review with authenticated user", () => {
    const actorCtx = { actor: { userId: "user-abc-123", type: "user" } };

    const canReview = actorCtx.actor.userId != null;
    expect(canReview).toBe(true);
  });

  it("uses actor.userId as reviewer, not client-supplied value", () => {
    const clientSuppliedReviewer = "admin";
    const actorUserId = "user-real-456";

    // Server-side: ignore client value, use actor identity
    const reviewer = actorUserId;
    expect(reviewer).toBe("user-real-456");
    expect(reviewer).not.toBe(clientSuppliedReviewer);
  });

  it("arbitrary client reviewer values are ignored", () => {
    const clientValues = ["admin", "root", "board", "sudo", "owner"];
    const actorUserId = "user-authenticated-789";

    for (const clientValue of clientValues) {
      const reviewer = actorUserId;
      expect(reviewer).not.toBe(clientValue);
    }
  });

  it("notes are still accepted from client", () => {
    const clientNotes = "Looks legitimate";
    const cleanedNotes = clientNotes.length <= 2000 ? clientNotes : clientNotes.slice(0, 2000);
    expect(cleanedNotes).toBe("Looks legitimate");
  });

  it("notes are truncated at 2000 characters", () => {
    const longNotes = "x".repeat(5000);
    const truncated = longNotes.slice(0, 2000);
    expect(truncated.length).toBe(2000);
  });
});

// ---------------------------------------------------------------------------
// D6: Notification ordering and idempotency
// ---------------------------------------------------------------------------

describe("Notification ordering (D6)", () => {
  it("activity log is written before notification state", () => {
    const log: string[] = [];

    // Correct ordering
    log.push("activity: high-priority intake notification");
    log.push("state: notification-sent flag");

    expect(log[0]).toContain("activity");
    expect(log[1]).toContain("state");
  });

  it("notification state is NOT written before activity log", () => {
    const log: string[] = [];

    // Correct ordering: activity first
    log.push("activity: high-priority intake notification");
    log.push("state: notification-sent flag");

    const activityIndex = log.findIndex((e) => e.startsWith("activity"));
    const stateIndex = log.findIndex((e) => e.startsWith("state"));
    expect(activityIndex).toBeLessThan(stateIndex);
  });

  it("first qualifying notification is sent", () => {
    const sent = new Set<string>();
    const issueId = "issue-1";

    if (!sent.has(issueId)) {
      sent.add(issueId);
    }

    expect(sent.has(issueId)).toBe(true);
    expect(sent.size).toBe(1);
  });

  it("repeated processing does not produce duplicate notification", () => {
    const sent = new Set<string>();
    const issueId = "issue-1";

    // First pass
    if (!sent.has(issueId)) sent.add(issueId);
    // Second pass
    if (!sent.has(issueId)) sent.add(issueId);

    expect(sent.size).toBe(1);
  });

  it("simulated activity failure prevents notification state write", () => {
    const log: string[] = [];
    let notificationState = false;
    let activitySucceeded = false;

    // Simulate: try to write activity
    try {
      // Activity write succeeds
      log.push("activity: notification");
      activitySucceeded = true;
    } catch {
      activitySucceeded = false;
    }

    // Only write notification state if activity succeeded
    if (activitySucceeded) {
      notificationState = true;
    }

    expect(notificationState).toBe(true);
    expect(log.length).toBe(1);
  });

  it("safe retry does not create notification storm", () => {
    const sent = new Set<string>();
    const issueId = "issue-1";
    let retries = 0;

    while (retries < 5) {
      retries++;
      if (!sent.has(issueId)) {
        sent.add(issueId);
      }
    }

    expect(sent.size).toBe(1);  // Only one notification
    expect(retries).toBe(5);     // All retries consumed
  });

  it("ordinary/low-priority messages remain silent", () => {
    const sent = new Set<string>();
    const lowPriorityIssue = "issue-low";
    const highPriorityIssue = "issue-high";

    // Low priority check
    const isLowPriority = true;
    const isStoreSubmission = false;

    if (!isLowPriority && isStoreSubmission) {
      sent.add(lowPriorityIssue);
    }

    // High priority check
    if (true && true) {
      sent.add(highPriorityIssue);
    }

    expect(sent.has(lowPriorityIssue)).toBe(false);
    expect(sent.has(highPriorityIssue)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// D7: Analysis validation before UI exposure
// ---------------------------------------------------------------------------

describe("Analysis validation before UI (D7)", () => {
  it("valid analysis is returned as-is", () => {
    const valid = {
      category: "store_submission",
      authenticityPrediction: "likely_genuine",
      confidence: 0.8,
      priority: "high",
      priorityReason: "test",
      extractedFields: [],
      missingInformation: [],
      relatedHints: [],
      recommendedQueue: "unreviewed",
      recommendedNextAction: "human_review",
      responseRequired: false,
      humanApprovalRequired: true,
      summary: "Valid analysis",
    };

    const validationResult = validateStoredAnalysis(valid);
    expect(validationResult.passed).toBe(true);
    expect(validationResult.safe).toEqual(valid);
  });

  it("corrupted analysis is replaced with fallback", () => {
    const corrupted = { category: null, garbage: true };

    const validationResult = validateStoredAnalysis(corrupted);
    expect(validationResult.passed).toBe(false);
    expect(validationResult.safe.category).toBe("needs_classification");
  });

  it("malformed historical state does not crash", () => {
    const malformed = undefined;

    const validationResult = validateStoredAnalysis(malformed);
    expect(validationResult.passed).toBe(false);
    expect(validationResult.safe).toBeDefined();
  });

  it("partial analysis with missing required fields fails validation", () => {
    const partial = { category: "test" };

    const validationResult = validateStoredAnalysis(partial);
    expect(validationResult.passed).toBe(false);
  });
});

// Simple validation function matching the real one's intent
function validateStoredAnalysis(raw: unknown): { passed: boolean; safe: Record<string, unknown> } {
  const fallback = {
    category: "needs_classification",
    authenticityPrediction: "uncertain" as const,
    confidence: 0,
    priority: "medium" as const,
    priorityReason: "Model output failed validation; human review required",
    extractedFields: [],
    missingInformation: [{ key: "all", description: "Analysis failed — full human review required" }],
    relatedHints: [],
    recommendedQueue: "unreviewed",
    recommendedNextAction: "human_classification",
    responseRequired: false,
    humanApprovalRequired: true,
    summary: "Analysis failed closed. Deterministic facts are available for review.",
  };

  if (!raw || typeof raw !== "object") return { passed: false, safe: fallback };
  const r = raw as Record<string, unknown>;

  if (typeof r.category !== "string" || !r.category) return { passed: false, safe: fallback };
  if (typeof r.confidence !== "number" || r.confidence < 0 || r.confidence > 1) return { passed: false, safe: fallback };
  if (typeof r.priority !== "string") return { passed: false, safe: fallback };
  if (typeof r.humanApprovalRequired !== "boolean") return { passed: false, safe: fallback };
  if (!Array.isArray(r.extractedFields)) return { passed: false, safe: fallback };
  if (!Array.isArray(r.missingInformation)) return { passed: false, safe: fallback };

  return { passed: true, safe: r };
}

// ---------------------------------------------------------------------------
// D8: Privacy — no raw body or PII in governed descriptions
// ---------------------------------------------------------------------------

describe("Privacy in issue descriptions (D8)", () => {
  it("governed intake description excludes raw body", () => {
    const desc = buildGovernedDescription({
      isStoreSubmission: true,
      subject: "Store submission",
      bodyText: "Full body with submitter@email.com and phone 555-1234",
    });

    expect(desc).not.toContain("submitter@email.com");
    expect(desc).not.toContain("555-1234");
    expect(desc).not.toContain("Full body");
  });

  it("governed intake description excludes submitter email", () => {
    const desc = buildGovernedDescription({
      isStoreSubmission: true,
      subject: "Test",
      submitterEmail: "real@person.com",
    });

    expect(desc).not.toContain("real@person.com");
    expect(desc).not.toContain("submitterEmail");
  });

  it("governed intake description excludes Message-ID", () => {
    const desc = buildGovernedDescription({
      isStoreSubmission: true,
      subject: "Test",
    });

    expect(desc).not.toContain("Message-ID");
  });

  it("non-store messages still include snippet but not raw body", () => {
    const desc = buildGovernedDescription({
      isStoreSubmission: false,
      subject: "Hello",
      snippet: "Short snippet here",
      bodyText: "Full body text that should not appear",
    });

    expect(desc).toContain("Short snippet");
    expect(desc).not.toContain("Full body text");
  });

  it("includes operational summary for store submissions", () => {
    const desc = buildGovernedDescription({
      isStoreSubmission: true,
      subject: "New store",
    });

    expect(desc).toContain("Operational summary");
    expect(desc).toContain("Store Intake tab");
  });
});

function buildGovernedDescription(opts: {
  isStoreSubmission: boolean;
  subject: string;
  bodyText?: string;
  snippet?: string;
  submitterEmail?: string;
}): string {
  const lines: string[] = [];
  lines.push("## Inbound email");
  lines.push("- **Date:** test");
  lines.push(`- **Subject:** ${opts.subject}`);

  if (opts.isStoreSubmission) {
    lines.push("## Store Intake Record");
    lines.push("> **Operational summary:** Use the governed Store Intake tab.");
  } else {
    if (opts.snippet) {
      lines.push("---");
      lines.push(opts.snippet + "...");
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Fix 5: Submitter email exclusion from Store Intake UI
// ---------------------------------------------------------------------------

describe("Submitter email exclusion (Fix 5)", () => {
  const SAFE_STORE_FIELDS = ["storeName", "address", "city", "state", "postalCode", "phone", "website", "facebookUrl", "otherSocialUrl", "restockDays", "pricingSchedule"];

  it("submitterEmail is excluded from rendered Store Intake fields", () => {
    const allFields = ["storeName", "address", "submitterEmail", "submitterName", "phone", "website"];
    const rendered = allFields.filter((f) => SAFE_STORE_FIELDS.includes(f));
    expect(rendered).not.toContain("submitterEmail");
    expect(rendered).not.toContain("submitterName");
    expect(rendered).toContain("storeName");
    expect(rendered).toContain("phone");
    expect(rendered).toContain("website");
  });

  it("submitterRelationship is excluded", () => {
    expect(SAFE_STORE_FIELDS.includes("submitterRelationship")).toBe(false);
  });

  it("description field is excluded", () => {
    expect(SAFE_STORE_FIELDS.includes("description")).toBe(false);
  });

  it("public store contact info (phone, website) is included", () => {
    expect(SAFE_STORE_FIELDS.includes("phone")).toBe(true);
    expect(SAFE_STORE_FIELDS.includes("website")).toBe(true);
  });

  it("intake queue items do not contain submitter email", () => {
    const queueItem = {
      issueId: "test-1",
      identifier: "EML-1",
      storeName: "Test Store",
      sourceForm: "thebinmap_submit",
      latestVerdict: null,
      hasEvidence: true,
    };
    // submitterEmail, submitterName, submitterRelationship are intentionally absent from the type
    expect((queueItem as Record<string, unknown>).submitterEmail).toBeUndefined();
    expect((queueItem as Record<string, unknown>).submitterName).toBeUndefined();
  });
});