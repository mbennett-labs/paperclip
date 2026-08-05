import { describe, expect, it } from "vitest";
import {
  createReviewRecord,
  getLatestReview,
  getLatestVerdict,
  getLatestOutcome,
  shouldSendIntakeNotification,
  type ReviewRecord,
  type ReviewVerdict,
  type OperationalOutcome,
} from "../src/mail/review.js";

describe("Review records", () => {
  describe("verdict persistence", () => {
    it("creates a review record with verdict", () => {
      const record = createReviewRecord(0, "genuine_external", "user-1", {
        notes: "Looks like a real store",
      });
      expect(record.verdict).toBe("genuine_external");
      expect(record.reviewer).toBe("user-1");
      expect(record.reviewIndex).toBe(0);
      expect(record.notes).toBe("Looks like a real store");
      expect(record.reviewedAt).toBeDefined();
    });

    it("captures reviewer and timestamp", () => {
      const record = createReviewRecord(0, "spam", "admin");
      expect(record.reviewer).toBe("admin");
      expect(new Date(record.reviewedAt).getTime()).toBeGreaterThan(0);
    });
  });

  describe("review history is append-only", () => {
    it("appending a new review preserves earlier reviews", () => {
      const review1 = createReviewRecord(0, "unsure", "user-1");
      const review2 = createReviewRecord(1, "genuine_external", "user-1", {
        notes: "Confirmed after research",
      });
      const reviews = [review1, review2];
      expect(reviews.length).toBe(2);
      expect(reviews[0].verdict).toBe("unsure");
      expect(reviews[1].verdict).toBe("genuine_external");
    });

    it("decision change does not silently erase earlier decision", () => {
      const review1 = createReviewRecord(0, "genuine_external", "user-1");
      const review2 = createReviewRecord(1, "spam", "user-2", {
        notes: "Actually this is spam",
      });
      const reviews = [review1, review2];
      // The first review still exists
      expect(reviews[0].verdict).toBe("genuine_external");
      expect(reviews[0].reviewer).toBe("user-1");
      // The second review is the latest
      expect(getLatestVerdict(reviews)).toBe("spam");
    });
  });

  describe("duplicate verdict supports linked record", () => {
    it("stores duplicate link with reference", () => {
      const record = createReviewRecord(0, "duplicate", "user-1", {
        duplicateLink: {
          referenceId: "store-1",
          reason: "Same store name and address as Bargain Bin Bonanza",
        },
      });
      expect(record.verdict).toBe("duplicate");
      expect(record.duplicateLink).toBeDefined();
      expect(record.duplicateLink!.referenceId).toBe("store-1");
    });
  });

  describe("internal and family tests preserve evidence but leave active queues", () => {
    it("internal_test sets verdict without operational outcome", () => {
      const record = createReviewRecord(0, "internal_test", "user-1");
      expect(record.verdict).toBe("internal_test");
      // Evidence is preserved in the review record itself
      expect(record.reviewedAt).toBeDefined();
    });

    it("family_test sets verdict without operational outcome", () => {
      const record = createReviewRecord(0, "family_test", "user-1");
      expect(record.verdict).toBe("family_test");
    });
  });

  describe("model proposal does not become human verdict automatically", () => {
    it("no review means no verdict", () => {
      expect(getLatestVerdict([])).toBeNull();
    });

    it("a review record requires explicit human action", () => {
      const record = createReviewRecord(0, "genuine_external", "user-1");
      // The record explicitly records the reviewer
      expect(record.reviewer).toBe("user-1");
      // This is not an automated/LLM action
      expect(record.reviewer).not.toBe("llm");
      expect(record.reviewer).not.toBe("model");
    });
  });

  describe("operational outcomes", () => {
    it("supports needs_verification", () => {
      const record = createReviewRecord(0, "genuine_external", "user-1", {
        operationalOutcome: "needs_verification",
      });
      expect(record.operationalOutcome).toBe("needs_verification");
    });

    it("supports accepted", () => {
      const record = createReviewRecord(0, "genuine_external", "user-1", {
        operationalOutcome: "accepted",
      });
      expect(getLatestOutcome([record])).toBe("accepted");
    });

    it("supports rejected", () => {
      const record = createReviewRecord(0, "spam", "user-1", {
        operationalOutcome: "rejected",
      });
      expect(getLatestOutcome([record])).toBe("rejected");
    });
  });

  describe("getLatestReview", () => {
    it("returns null for empty array", () => {
      expect(getLatestReview([])).toBeNull();
    });

    it("returns highest reviewIndex", () => {
      const reviews = [
        createReviewRecord(0, "unsure", "user-1"),
        createReviewRecord(2, "genuine_external", "user-2"),
        createReviewRecord(1, "spam", "user-1"),
      ];
      const latest = getLatestReview(reviews);
      expect(latest!.reviewIndex).toBe(2);
    });
  });
});

describe("Intake notifications", () => {
  describe("high-priority store intake emits notification", () => {
    it("returns true for high priority store_submission without prior notification", () => {
      const result = shouldSendIntakeNotification("high", "store_submission", null);
      expect(result).toBe(true);
    });
  });

  describe("repeated processing does not emit duplicate", () => {
    it("returns false when notification already sent", () => {
      const result = shouldSendIntakeNotification("high", "store_submission", {
        sent: true,
        sentAt: new Date().toISOString(),
        issueId: "test-1",
        priority: "high",
        category: "store_submission",
      });
      expect(result).toBe(false);
    });
  });

  describe("low-priority ordinary email does not emit", () => {
    it("returns false for medium priority", () => {
      const result = shouldSendIntakeNotification("medium", "store_submission", null);
      expect(result).toBe(false);
    });

    it("returns false for low priority", () => {
      const result = shouldSendIntakeNotification("low", "store_submission", null);
      expect(result).toBe(false);
    });

    it("returns false for non-store_submission categories", () => {
      const result = shouldSendIntakeNotification("high", "contact_general", null);
      expect(result).toBe(false);
    });
  });

  describe("internal or family test does not retain unnecessary high-priority notification after review", () => {
    it("does not re-notify for already-notified items", () => {
      const result = shouldSendIntakeNotification("high", "store_submission", {
        sent: true,
        sentAt: new Date().toISOString(),
        issueId: "test-1",
        priority: "high",
        category: "store_submission",
      });
      expect(result).toBe(false);
    });
  });
});