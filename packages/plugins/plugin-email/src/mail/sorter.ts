/**
 * Deterministic intake record sorter.
 *
 * Combines source detection, form completeness, duplicate status, and reply
 * characteristics into a single deterministic classification that preserves
 * every dimension as a separate field.
 *
 * This is the authoritative sorting contract for the governed intake pipeline.
 * It separates records into seven distinct categories:
 *
 *   store_submission     – legitimate store intake via recognized form
 *   general_email        – ordinary inbound message (contact, inquiry, etc.)
 *   reply_continuation   – reply or follow-up to an existing thread
 *   spam_irrelevant      – provider marketing, unsubscribe, obvious junk
 *   duplicate            – already-seen record (by Message-ID fingerprint)
 *   incomplete           – store submission with missing essential fields
 *   unknown              – cannot classify with confidence; needs human review
 */

import type { IntakeMetadata, RecordCompleteness } from "./intake-metadata.js";
import type { MessageClassHint, SourceDetection } from "./normalize.js";

// ---------------------------------------------------------------------------
// Classification result contract
// ---------------------------------------------------------------------------

export type IntakeSortCategory =
  | "store_submission"
  | "general_email"
  | "reply_continuation"
  | "spam_irrelevant"
  | "duplicate"
  | "incomplete"
  | "unknown";

export interface IntakeSortResult {
  /** Primary classification. */
  category: IntakeSortCategory;

  /** Source detection from normalize.ts (always preserved). */
  sourceType: string;
  sourceForm: string;
  sourcePage: string;
  brand: string;

  /** Classification confidence 0–1. Mirrors SourceDetection.confidence. */
  classificationConfidence: number;

  /** Form completeness from intake metadata (always preserved). */
  formCompleteness: RecordCompleteness | null;

  /** Duplicate match strength from the duplicate engine (always preserved). */
  duplicateMatchStrength: string | null;

  /** Human review verdict if one exists (always preserved). */
  humanReviewStatus: string | null;

  /** Whether a reply draft exists or is needed. */
  replyActionStatus: "none" | "draft_ready" | "draft_needed" | "draft_blocked";

  /** Human-readable explanation of the classification. */
  reason: string;

  /** Which rules were matched, for auditability. */
  rulesMatched: string[];
}

// ---------------------------------------------------------------------------
// Sorting logic
// ---------------------------------------------------------------------------

export interface SortInput {
  sourceDetection: SourceDetection | null;
  classHint: MessageClassHint | null;
  intakeMetadata: IntakeMetadata | null;
  duplicateMatchStrength: string | null;
  latestVerdict: string | null;
  hasReplyDraft: boolean;
  inReplyTo: string | null;
  hasReferences: boolean;
}

export function sortIntakeRecord(input: SortInput): IntakeSortResult {
  const {
    sourceDetection,
    classHint,
    intakeMetadata,
    duplicateMatchStrength,
    latestVerdict,
    hasReplyDraft,
    inReplyTo,
    hasReferences,
  } = input;

  const result: IntakeSortResult = {
    category: "unknown",
    sourceType: sourceDetection?.sourceType ?? "unknown",
    sourceForm: sourceDetection?.sourceForm ?? "unknown",
    sourcePage: sourceDetection?.sourcePage ?? "unknown",
    brand: sourceDetection?.brand ?? "unknown",
    classificationConfidence: sourceDetection?.confidence ?? 0,
    formCompleteness: intakeMetadata?.recordCompleteness ?? null,
    duplicateMatchStrength,
    humanReviewStatus: latestVerdict ?? null,
    replyActionStatus: "none",
    reason: "",
    rulesMatched: [],
  };

  // 1. Provider marketing — highest priority, never a real submission
  if (sourceDetection?.sourceType === "provider_marketing") {
    result.category = "spam_irrelevant";
    result.replyActionStatus = "draft_blocked";
    result.reason = "Provider marketing message; not a customer submission.";
    result.rulesMatched.push("sorter:provider_marketing");
    return result;
  }

  // 2. Duplicate — already-seen Message-ID; no action needed
  if (duplicateMatchStrength === "strong") {
    result.category = "duplicate";
    result.replyActionStatus = "draft_blocked";
    result.reason = "Duplicate record matched by deterministic fingerprint.";
    result.rulesMatched.push("sorter:duplicate_strong");
    return result;
  }

  // 3. Reply or continuation — has inReplyTo or references
  if (inReplyTo || hasReferences) {
    result.category = "reply_continuation";
    result.replyActionStatus = hasReplyDraft ? "draft_ready" : "draft_needed";
    result.reason = "Message is a reply or continuation of an existing thread.";
    result.rulesMatched.push("sorter:reply_thread");
    return result;
  }

  // 4. Store submission — recognized form with essential fields present.
  //    A store submission is "incomplete" only if the expected form fields
  //    are actually missing from the message; "partial" completeness from
  //    email_notification transport does not by itself indicate an incomplete
  //    form — it means the source is less authoritative than a webhook.
  if (
    sourceDetection?.sourceType === "store_submission" &&
    sourceDetection.sourceForm !== "unknown"
  ) {
    const essentialMissing =
      intakeMetadata?.missingFields &&
      ["storeName", "address", "city", "state"].some(
        (f) => intakeMetadata.missingFields.includes(f),
      );

    if (
      essentialMissing ||
      intakeMetadata?.recordCompleteness === "needs_source_verification"
    ) {
      result.category = "incomplete";
      result.replyActionStatus = "draft_needed";
      result.reason =
        "Store submission from recognized form but missing essential fields or needs source verification.";
      result.rulesMatched.push("sorter:store_incomplete");
      return result;
    }

    result.category = "store_submission";
    result.replyActionStatus = "none";
    result.reason =
      "Store submission from recognized form with all essential fields.";
    result.rulesMatched.push("sorter:store_complete");
    return result;
  }

  // 5. General email — contact, inquiry, support, claim, alert, newsletter, etc.
  if (
    classHint === "contact_general" ||
    classHint === "customer_inquiry" ||
    classHint === "support_request" ||
    classHint === "sales_opportunity" ||
    classHint === "partnership_affiliate" ||
    classHint === "correction" ||
    classHint === "listing_claim" ||
    classHint === "intelligence_request" ||
    classHint === "store_alert_signup" ||
    classHint === "newsletter_signup"
  ) {
    result.category = "general_email";
    result.replyActionStatus = hasReplyDraft ? "draft_ready" : "draft_needed";
    result.reason = "General inbound email not matching any submission form.";
    result.rulesMatched.push("sorter:general_email");
    return result;
  }

  // 6. Spam — obvious junk via classHint (already handled by step 2 for
  //    duplicateMatchStrength, but catch remaining spam classHints here)
  if (classHint === "spam_irrelevant") {
    result.category = "spam_irrelevant";
    result.replyActionStatus = "draft_blocked";
    result.reason = "Message classified as spam or irrelevant by heuristic.";
    result.rulesMatched.push("sorter:spam_heuristic");
    return result;
  }

  // 7. Unknown — cannot determine; requires human review
  result.category = "unknown";
  result.replyActionStatus = "draft_blocked";
  result.reason =
    "Cannot determine message category with confidence; human review required.";
  result.rulesMatched.push("sorter:unknown_fallback");
  return result;
}

/**
 * Sort a normalized message before evidence/intake metadata is fully populated.
 * Used for early routing decisions during ingestion.
 */
export interface EarlySortInput {
  sourceDetection: SourceDetection | null;
  classHint: MessageClassHint;
  inReplyTo: string | null;
  hasReferences: boolean;
}

export function sortIncomingEarly(input: EarlySortInput): IntakeSortResult {
  return sortIntakeRecord({
    sourceDetection: input.sourceDetection,
    classHint: input.classHint,
    intakeMetadata: null,
    duplicateMatchStrength: null,
    latestVerdict: null,
    hasReplyDraft: false,
    inReplyTo: input.inReplyTo,
    hasReferences: input.hasReferences,
  });
}

export const ALL_INTAKE_CATEGORIES: IntakeSortCategory[] = [
  "store_submission",
  "general_email",
  "reply_continuation",
  "spam_irrelevant",
  "duplicate",
  "incomplete",
  "unknown",
];

export const CATEGORY_LABELS: Record<IntakeSortCategory, string> = {
  store_submission: "Store Submission",
  general_email: "General Email",
  reply_continuation: "Reply / Continuation",
  spam_irrelevant: "Spam / Irrelevant",
  duplicate: "Duplicate",
  incomplete: "Incomplete Submission",
  unknown: "Unknown / Needs Review",
};
