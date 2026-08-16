import { describe, expect, it } from "vitest";
import {
  sortIntakeRecord,
  sortIncomingEarly,
  ALL_INTAKE_CATEGORIES,
  CATEGORY_LABELS,
  type IntakeSortCategory,
} from "../src/mail/sorter.js";
import type { SourceDetection } from "../src/mail/normalize.js";
import type { IntakeMetadata } from "../src/mail/intake-metadata.js";
import { SORTER_FIXTURES } from "./fixtures/synthetic-messages.js";

function detection(overrides: Partial<SourceDetection> = {}): SourceDetection {
  return {
    sourceType: "unknown",
    sourceForm: "unknown",
    sourcePage: "unknown",
    brand: "unknown",
    confidence: 0,
    evidence: [],
    rulesMatched: [],
    requiresHumanReview: true,
    ...overrides,
  };
}

function metadata(overrides: Partial<IntakeMetadata> = {}): IntakeMetadata {
  return {
    intakeTransport: "email_notification",
    recordCompleteness: "partial",
    evidenceSources: [],
    providerSubmissionId: null,
    emailMessageId: null,
    correlationFingerprint: "corr:none",
    missingFields: [],
    conflictingFields: [],
    lastEnrichedAt: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Existing fixture scenarios + dedicated system-notification coverage
// ---------------------------------------------------------------------------

describe("sortIntakeRecord — classification contract", () => {
  it.each(SORTER_FIXTURES)(
    "[$id] $description -> $expectedCategory",
    (fixture) => {
      const result = sortIntakeRecord({
        sourceDetection: fixture.detection,
        classHint: fixture.msg.classHint ?? "unknown",
        intakeMetadata: fixture.metadata,
        duplicateMatchStrength: fixture.duplicateMatchStrength,
        latestVerdict: fixture.latestVerdict,
        hasReplyDraft: fixture.hasReplyDraft,
        inReplyTo: fixture.msg.inReplyTo ?? null,
        hasReferences: (fixture.msg.references?.length ?? 0) > 0,
      });

      expect(result.category).toBe(fixture.expectedCategory);
      expect(result.replyActionStatus).toBe(fixture.expectedReplyActionStatus);
      expect(result.reason).toBeTruthy();
      expect(result.rulesMatched.length).toBeGreaterThan(0);
    },
  );

  // System notifications have dedicated cases below rather than changing the
  // historical synthetic fixture file solely to satisfy category enumeration.
  const categoriesCovered = new Set<IntakeSortCategory>(["system_notification"]);
  SORTER_FIXTURES.forEach((f) => categoriesCovered.add(f.expectedCategory));
  for (const cat of ALL_INTAKE_CATEGORIES) {
    it(`category "${cat}" has classification coverage`, () => {
      expect(categoriesCovered.has(cat)).toBe(true);
    });
  }

  it("every category has a label", () => {
    for (const cat of ALL_INTAKE_CATEGORIES) {
      expect(CATEGORY_LABELS[cat]).toBeTruthy();
    }
  });
});

describe("sortIntakeRecord — separate dimensions preserved", () => {
  it("preserves sourceType independently from category", () => {
    const result = sortIntakeRecord({
      sourceDetection: detection({ sourceType: "store_submission", sourceForm: "thebinmap_submit", confidence: 0.95 }),
      classHint: "store_submission",
      intakeMetadata: metadata({ recordCompleteness: "complete" }),
      duplicateMatchStrength: null,
      latestVerdict: null,
      hasReplyDraft: false,
      inReplyTo: null,
      hasReferences: false,
    });

    expect(result.category).toBe("store_submission");
    expect(result.sourceType).toBe("store_submission");
    expect(result.sourceForm).toBe("thebinmap_submit");
    expect(result.classificationConfidence).toBe(0.95);
    expect(result.formCompleteness).toBe("complete");
    expect(result.duplicateMatchStrength).toBeNull();
    expect(result.humanReviewStatus).toBeNull();
    expect(result.replyActionStatus).toBe("none");
  });

  it("does not collapse completeness into classification", () => {
    const completeResult = sortIntakeRecord({
      sourceDetection: detection({ sourceType: "store_submission", sourceForm: "thebinmap_submit", confidence: 0.95 }),
      classHint: "store_submission",
      intakeMetadata: metadata({ recordCompleteness: "complete" }),
      duplicateMatchStrength: null,
      latestVerdict: null,
      hasReplyDraft: false,
      inReplyTo: null,
      hasReferences: false,
    });

    const partialResult = sortIntakeRecord({
      sourceDetection: detection({ sourceType: "store_submission", sourceForm: "thebinmap_submit", confidence: 0.95 }),
      classHint: "store_submission",
      intakeMetadata: metadata({ recordCompleteness: "partial", missingFields: ["phone"] }),
      duplicateMatchStrength: null,
      latestVerdict: null,
      hasReplyDraft: false,
      inReplyTo: null,
      hasReferences: false,
    });

    expect(completeResult.formCompleteness).toBe("complete");
    expect(partialResult.formCompleteness).toBe("partial");
  });

  it("does not collapse duplicate strength into category for non-duplicates", () => {
    const result = sortIntakeRecord({
      sourceDetection: detection({ sourceType: "contact", sourceForm: "thebinmap_contact", confidence: 0.9 }),
      classHint: "contact_general",
      intakeMetadata: null,
      duplicateMatchStrength: "possible",
      latestVerdict: null,
      hasReplyDraft: false,
      inReplyTo: null,
      hasReferences: false,
    });

    expect(result.category).toBe("general_email");
    expect(result.duplicateMatchStrength).toBe("possible");
  });

  it("preserves human review status independently", () => {
    const result = sortIntakeRecord({
      sourceDetection: detection({ sourceType: "store_submission", sourceForm: "thebinmap_submit", confidence: 0.95 }),
      classHint: "store_submission",
      intakeMetadata: metadata({ recordCompleteness: "complete" }),
      duplicateMatchStrength: null,
      latestVerdict: "genuine_external",
      hasReplyDraft: true,
      inReplyTo: null,
      hasReferences: false,
    });

    expect(result.category).toBe("store_submission");
    expect(result.humanReviewStatus).toBe("genuine_external");
    expect(result.replyActionStatus).toBe("none");
  });
});

describe("sortIntakeRecord — system notification boundary", () => {
  it("keeps TherapistIndex operational notifications out of reply work", () => {
    const result = sortIntakeRecord({
      sourceDetection: detection({
        sourceType: "contact",
        sourceForm: "therapist_index",
        sourcePage: "/moderation",
        brand: "therapist_index",
        confidence: 0.8,
      }),
      classHint: "contact_general",
      intakeMetadata: null,
      duplicateMatchStrength: null,
      latestVerdict: null,
      hasReplyDraft: false,
      inReplyTo: null,
      hasReferences: false,
    });

    expect(result.category).toBe("system_notification");
    expect(result.replyActionStatus).toBe("none");
    expect(result.rulesMatched).toContain("sorter:system_notification");
  });

  it("keeps alert and newsletter signups out of reply work", () => {
    for (const sourceType of ["alert_signup", "newsletter_signup"] as const) {
      const result = sortIntakeRecord({
        sourceDetection: detection({ sourceType, brand: "thebinmap", confidence: 0.9 }),
        classHint: sourceType === "alert_signup" ? "store_alert_signup" : "newsletter_signup",
        intakeMetadata: null,
        duplicateMatchStrength: null,
        latestVerdict: null,
        hasReplyDraft: false,
        inReplyTo: null,
        hasReferences: false,
      });
      expect(result.category).toBe("system_notification");
      expect(result.replyActionStatus).toBe("none");
    }
  });

  it("keeps TherapistIndex correction/removal work actionable", () => {
    const result = sortIntakeRecord({
      sourceDetection: detection({
        sourceType: "correction",
        sourceForm: "therapist_index",
        brand: "therapist_index",
        confidence: 0.8,
      }),
      classHint: "correction",
      intakeMetadata: null,
      duplicateMatchStrength: null,
      latestVerdict: null,
      hasReplyDraft: false,
      inReplyTo: null,
      hasReferences: false,
    });

    expect(result.category).toBe("general_email");
    expect(result.replyActionStatus).toBe("draft_needed");
  });

  it("explicit reply headers override system-notification routing", () => {
    const result = sortIntakeRecord({
      sourceDetection: detection({
        sourceType: "contact",
        sourceForm: "therapist_index",
        brand: "therapist_index",
        confidence: 0.8,
      }),
      classHint: "contact_general",
      intakeMetadata: null,
      duplicateMatchStrength: null,
      latestVerdict: null,
      hasReplyDraft: false,
      inReplyTo: "prior@example.com",
      hasReferences: true,
    });

    expect(result.category).toBe("reply_continuation");
    expect(result.replyActionStatus).toBe("draft_needed");
  });
});

describe("sortIntakeRecord — edge cases", () => {
  it("provider_marketing always sorts to spam_irrelevant", () => {
    const result = sortIntakeRecord({
      sourceDetection: detection({ sourceType: "provider_marketing", confidence: 0.85 }),
      classHint: "store_submission",
      intakeMetadata: metadata({ recordCompleteness: "complete" }),
      duplicateMatchStrength: null,
      latestVerdict: null,
      hasReplyDraft: false,
      inReplyTo: null,
      hasReferences: false,
    });
    expect(result.category).toBe("spam_irrelevant");
  });

  it("reply takes priority over general email classification", () => {
    const result = sortIntakeRecord({
      sourceDetection: detection({ sourceType: "contact" }),
      classHint: "contact_general",
      intakeMetadata: null,
      duplicateMatchStrength: null,
      latestVerdict: null,
      hasReplyDraft: false,
      inReplyTo: "previous-msg@example.com",
      hasReferences: true,
    });
    expect(result.category).toBe("reply_continuation");
  });

  it("reply takes priority over store submission detection", () => {
    const result = sortIntakeRecord({
      sourceDetection: detection({ sourceType: "store_submission", sourceForm: "thebinmap_submit", confidence: 0.95 }),
      classHint: "store_submission",
      intakeMetadata: metadata({ recordCompleteness: "complete" }),
      duplicateMatchStrength: null,
      latestVerdict: null,
      hasReplyDraft: false,
      inReplyTo: "previous-msg@example.com",
      hasReferences: true,
    });
    expect(result.category).toBe("reply_continuation");
  });

  it("incomplete store submission with needs_source_verification", () => {
    const result = sortIntakeRecord({
      sourceDetection: detection({ sourceType: "store_submission", sourceForm: "thebinmap_submit", confidence: 0.95 }),
      classHint: "store_submission",
      intakeMetadata: metadata({ recordCompleteness: "needs_source_verification", missingFields: ["storeName", "address"] }),
      duplicateMatchStrength: null,
      latestVerdict: null,
      hasReplyDraft: false,
      inReplyTo: null,
      hasReferences: false,
    });
    expect(result.category).toBe("incomplete");
    expect(result.formCompleteness).toBe("needs_source_verification");
  });

  it("unknown source becomes unknown category", () => {
    const result = sortIntakeRecord({
      sourceDetection: detection({ sourceType: "unknown" }),
      classHint: "unknown",
      intakeMetadata: null,
      duplicateMatchStrength: null,
      latestVerdict: null,
      hasReplyDraft: false,
      inReplyTo: null,
      hasReferences: false,
    });
    expect(result.category).toBe("unknown");
    expect(result.classificationConfidence).toBe(0);
  });

  it("general email with missing detection falls back correctly", () => {
    const result = sortIntakeRecord({
      sourceDetection: null,
      classHint: "contact_general",
      intakeMetadata: null,
      duplicateMatchStrength: null,
      latestVerdict: null,
      hasReplyDraft: false,
      inReplyTo: null,
      hasReferences: false,
    });
    expect(result.category).toBe("general_email");
    expect(result.sourceType).toBe("unknown");
  });

  it("null detection is handled gracefully", () => {
    const result = sortIntakeRecord({
      sourceDetection: null,
      classHint: "unknown",
      intakeMetadata: null,
      duplicateMatchStrength: null,
      latestVerdict: null,
      hasReplyDraft: false,
      inReplyTo: null,
      hasReferences: false,
    });
    expect(result.category).toBe("unknown");
    expect(result.sourceType).toBe("unknown");
  });

  it("does not infer store submission from business-like language alone", () => {
    const result = sortIntakeRecord({
      sourceDetection: detection({ sourceType: "unknown" }),
      classHint: "sales_opportunity",
      intakeMetadata: null,
      duplicateMatchStrength: null,
      latestVerdict: null,
      hasReplyDraft: false,
      inReplyTo: null,
      hasReferences: false,
    });
    expect(result.category).toBe("general_email");
  });

  it("spam blocks reply drafts", () => {
    const result = sortIntakeRecord({
      sourceDetection: detection({ sourceType: "provider_marketing" }),
      classHint: "spam_irrelevant",
      intakeMetadata: null,
      duplicateMatchStrength: null,
      latestVerdict: null,
      hasReplyDraft: false,
      inReplyTo: null,
      hasReferences: false,
    });
    expect(result.replyActionStatus).toBe("draft_blocked");
  });

  it("unknown blocks reply drafts", () => {
    const result = sortIntakeRecord({
      sourceDetection: detection({ sourceType: "unknown" }),
      classHint: "unknown",
      intakeMetadata: null,
      duplicateMatchStrength: null,
      latestVerdict: null,
      hasReplyDraft: false,
      inReplyTo: null,
      hasReferences: false,
    });
    expect(result.replyActionStatus).toBe("draft_blocked");
  });

  it("duplicate blocks reply drafts", () => {
    const result = sortIntakeRecord({
      sourceDetection: detection({ sourceType: "store_submission", sourceForm: "thebinmap_submit", confidence: 0.95 }),
      classHint: "spam_irrelevant",
      intakeMetadata: null,
      duplicateMatchStrength: "strong",
      latestVerdict: null,
      hasReplyDraft: false,
      inReplyTo: null,
      hasReferences: false,
    });
    expect(result.replyActionStatus).toBe("draft_blocked");
  });
});

describe("sortIncomingEarly", () => {
  it("works with early-stage minimal input for store submission", () => {
    const result = sortIncomingEarly({
      sourceDetection: detection({ sourceType: "store_submission", sourceForm: "thebinmap_submit", confidence: 0.95 }),
      classHint: "store_submission",
      inReplyTo: null,
      hasReferences: false,
    });
    expect(result.category).toBe("store_submission");
  });

  it("correctly detects reply for early input", () => {
    const result = sortIncomingEarly({
      sourceDetection: null,
      classHint: "unknown",
      inReplyTo: "orig@example.com",
      hasReferences: true,
    });
    expect(result.category).toBe("reply_continuation");
  });

  it("defaults null detection gracefully", () => {
    const result = sortIncomingEarly({
      sourceDetection: null,
      classHint: "unknown",
      inReplyTo: null,
      hasReferences: false,
    });
    expect(result.category).toBe("unknown");
  });
});
