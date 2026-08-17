/**
 * Deterministic intake record sorter.
 *
 * Combines source detection, form completeness, duplicate status, and reply
 * characteristics into a single deterministic classification that preserves
 * every dimension as a separate field.
 *
 * This is the authoritative sorting contract for the governed intake pipeline.
 * It separates records into eight distinct categories:
 *
 *   store_submission     – legitimate store intake via recognized form
 *   general_email        – ordinary inbound message (contact, inquiry, etc.)
 *   reply_continuation   – reply or follow-up to an existing thread
 *   system_notification  – deterministic operational event; no reply expected
 *   spam_irrelevant      – provider marketing, unsubscribe, obvious junk
 *   duplicate            – already-seen record (by Message-ID fingerprint)
 *   incomplete           – store submission with missing essential fields
 *   unknown              – cannot classify with confidence; needs human review
 */

import type { IntakeMetadata, RecordCompleteness } from "./intake-metadata.js";
import type { MessageClassHint, SourceDetection } from "./normalize.js";

export type IntakeSortCategory =
  | "store_submission"
  | "general_email"
  | "reply_continuation"
  | "system_notification"
  | "spam_irrelevant"
  | "duplicate"
  | "incomplete"
  | "unknown";

export interface IntakeSortResult {
  category: IntakeSortCategory;
  sourceType: string;
  sourceForm: string;
  sourcePage: string;
  brand: string;
  classificationConfidence: number;
  formCompleteness: RecordCompleteness | null;
  duplicateMatchStrength: string | null;
  humanReviewStatus: string | null;
  replyActionStatus: "none" | "draft_ready" | "draft_needed" | "draft_blocked";
  reason: string;
  rulesMatched: string[];
}

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

function isKnownTherapistIndexOperationalNotification(
  sourceDetection: SourceDetection | null,
): boolean {
  if (
    sourceDetection?.sourceForm !== "therapist_index" ||
    sourceDetection.sourceType !== "contact"
  ) {
    return false;
  }

  // These pages are assigned by normalize.ts only when a message matches
  // known operational/account patterns. Generic TherapistIndex contact keeps
  // sourcePage="unknown" and must remain actionable until a more specific
  // WordPress event contract is proven from representative messages.
  return sourceDetection.sourcePage === "/moderation" ||
    sourceDetection.sourcePage === "/account";
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

  // 1. Provider marketing — highest priority, never a real submission.
  if (sourceDetection?.sourceType === "provider_marketing") {
    result.category = "spam_irrelevant";
    result.replyActionStatus = "draft_blocked";
    result.reason = "Provider marketing message; not a customer submission.";
    result.rulesMatched.push("sorter:provider_marketing");
    return result;
  }

  // 2. Duplicate — already-seen Message-ID; no action needed.
  if (duplicateMatchStrength === "strong") {
    result.category = "duplicate";
    result.replyActionStatus = "draft_blocked";
    result.reason = "Duplicate record matched by deterministic fingerprint.";
    result.rulesMatched.push("sorter:duplicate_strong");
    return result;
  }

  // 3. Reply or continuation — explicit thread evidence always wins over
  // notification routing because a real human may reply to an automated event.
  if (inReplyTo || hasReferences) {
    result.category = "reply_continuation";
    result.replyActionStatus = hasReplyDraft ? "draft_ready" : "draft_needed";
    result.reason = "Message is a reply or continuation of an existing thread.";
    result.rulesMatched.push("sorter:reply_thread");
    return result;
  }

  // 4. Deterministic system / operational notifications — preserve as evidence
  // and operational signal, but do not manufacture reply work.
  //
  // TherapistIndex is intentionally conservative: only normalize.ts patterns
  // that resolve to a known account/moderation page are notification-safe.
  // Generic TherapistIndex contact remains general_email until representative
  // WordPress registration/office-event messages prove a narrower rule.
  if (
    sourceDetection?.sourceType === "alert_signup" ||
    sourceDetection?.sourceType === "newsletter_signup" ||
    sourceDetection?.sourceType === "intelligence_signup" ||
    isKnownTherapistIndexOperationalNotification(sourceDetection)
  ) {
    result.category = "system_notification";
    result.replyActionStatus = "none";
    result.reason = "Deterministic operational/system notification; no reply expected.";
    result.rulesMatched.push("sorter:system_notification");
    return result;
  }

  // 5. Store submission — recognized form with essential fields present.
  // A store submission is incomplete only when expected fields are actually
  // missing or the evidence requires source verification.
  if (
    sourceDetection?.sourceType === "store_submission" &&
    sourceDetection.sourceForm !== "unknown"
  ) {
    const essentialMissing =
      intakeMetadata?.missingFields &&
      ["storeName", "address", "city", "state"].some((field) =>
        intakeMetadata.missingFields.includes(field),
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
    result.reason = "Store submission from recognized form with all essential fields.";
    result.rulesMatched.push("sorter:store_complete");
    return result;
  }

  // 6. General email — correspondence or work that may need a reply.
  if (
    classHint === "contact_general" ||
    classHint === "customer_inquiry" ||
    classHint === "support_request" ||
    classHint === "sales_opportunity" ||
    classHint === "partnership_affiliate" ||
    classHint === "correction" ||
    classHint === "listing_claim" ||
    classHint === "intelligence_request"
  ) {
    result.category = "general_email";
    result.replyActionStatus = hasReplyDraft ? "draft_ready" : "draft_needed";
    result.reason = "General inbound correspondence requiring operational review.";
    result.rulesMatched.push("sorter:general_email");
    return result;
  }

  // Legacy/fallback signup hints without a recognized source still remain
  // non-reply notifications. This prevents a source-template change from
  // silently turning a subscription event into reply work.
  if (
    classHint === "store_alert_signup" ||
    classHint === "newsletter_signup" ||
    classHint === "intelligence_signup"
  ) {
    result.category = "system_notification";
    result.replyActionStatus = "none";
    result.reason = "Subscription/alert event; retain as operational evidence without reply work.";
    result.rulesMatched.push("sorter:system_notification_hint");
    return result;
  }

  // 7. Spam heuristic fallback.
  if (classHint === "spam_irrelevant") {
    result.category = "spam_irrelevant";
    result.replyActionStatus = "draft_blocked";
    result.reason = "Message classified as spam or irrelevant by heuristic.";
    result.rulesMatched.push("sorter:spam_heuristic");
    return result;
  }

  // 8. Unknown — cannot determine; requires human review.
  result.category = "unknown";
  result.replyActionStatus = "draft_blocked";
  result.reason = "Cannot determine message category with confidence; human review required.";
  result.rulesMatched.push("sorter:unknown_fallback");
  return result;
}

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
  "system_notification",
  "spam_irrelevant",
  "duplicate",
  "incomplete",
  "unknown",
];

export const CATEGORY_LABELS: Record<IntakeSortCategory, string> = {
  store_submission: "Store Submission",
  general_email: "General Email",
  reply_continuation: "Reply / Continuation",
  system_notification: "System Notification",
  spam_irrelevant: "Spam / Irrelevant",
  duplicate: "Duplicate",
  incomplete: "Incomplete Submission",
  unknown: "Unknown / Needs Review",
};
