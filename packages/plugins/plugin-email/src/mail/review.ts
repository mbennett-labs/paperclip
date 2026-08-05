/**
 * Human-authoritative review controls for governed intake.
 *
 * The model and deterministic logic may PROPOSE.
 * Only the human reviewer establishes the VERDICT.
 *
 * Reviews are stored as an append-only JSON array in plugin_state
 * under key `intake-reviews`. Changing a decision appends a new
 * review record; it never erases earlier decisions.
 */

// ---------------------------------------------------------------------------
// Review verdicts
// ---------------------------------------------------------------------------

export type ReviewVerdict =
  | "genuine_external"
  | "internal_test"
  | "family_test"
  | "spam"
  | "duplicate"
  | "unsure";

export const REVIEW_VERDICTS: ReviewVerdict[] = [
  "genuine_external",
  "internal_test",
  "family_test",
  "spam",
  "duplicate",
  "unsure",
];

export const VERDICT_LABELS: Record<ReviewVerdict, string> = {
  genuine_external: "Genuine external",
  internal_test: "Internal test",
  family_test: "Family test",
  spam: "Spam",
  duplicate: "Duplicate",
  unsure: "Unsure",
};

// ---------------------------------------------------------------------------
// Operational outcomes (for genuine submissions)
// ---------------------------------------------------------------------------

export type OperationalOutcome =
  | "needs_verification"
  | "accepted"
  | "rejected"
  | "closed";

export const OPERATIONAL_OUTCOMES: OperationalOutcome[] = [
  "needs_verification",
  "accepted",
  "rejected",
  "closed",
];

export const OUTCOME_LABELS: Record<OperationalOutcome, string> = {
  needs_verification: "Needs verification",
  accepted: "Accepted",
  rejected: "Rejected",
  closed: "Closed",
};

// ---------------------------------------------------------------------------
// Review record (stored as JSON in plugin_state array)
// ---------------------------------------------------------------------------

export interface ReviewRecord {
  /** Unique review index within this issue */
  reviewIndex: number;
  /** Verdict */
  verdict: ReviewVerdict;
  /** Reviewer identity (user ID or name) */
  reviewer: string;
  /** ISO timestamp */
  reviewedAt: string;
  /** Optional notes */
  notes: string;
  /** Corrected classification (if reviewer disagrees) */
  correctedClassification?: string;
  /** Linked duplicate candidate or prior intake record */
  duplicateLink?: {
    /** Candidate store ID or prior intake record reference */
    referenceId: string;
    /** Human-readable reason */
    reason: string;
  };
  /** Approved next action */
  approvedNextAction?: string;
  /** Operational outcome */
  operationalOutcome?: OperationalOutcome;
}

// ---------------------------------------------------------------------------
// Review state helpers
// ---------------------------------------------------------------------------

export function createReviewRecord(
  reviewIndex: number,
  verdict: ReviewVerdict,
  reviewer: string,
  options: {
    notes?: string;
    correctedClassification?: string;
    duplicateLink?: ReviewRecord["duplicateLink"];
    approvedNextAction?: string;
    operationalOutcome?: OperationalOutcome;
  } = {},
): ReviewRecord {
  return {
    reviewIndex,
    verdict,
    reviewer,
    reviewedAt: new Date().toISOString(),
    notes: options.notes ?? "",
    correctedClassification: options.correctedClassification,
    duplicateLink: options.duplicateLink,
    approvedNextAction: options.approvedNextAction,
    operationalOutcome: options.operationalOutcome,
  };
}

export function getLatestReview(reviews: ReviewRecord[]): ReviewRecord | null {
  if (reviews.length === 0) return null;
  return reviews.reduce((latest, r) =>
    r.reviewIndex > latest.reviewIndex ? r : latest
  );
}

export function getLatestVerdict(reviews: ReviewRecord[]): ReviewVerdict | null {
  const latest = getLatestReview(reviews);
  return latest?.verdict ?? null;
}

export function getLatestOutcome(reviews: ReviewRecord[]): OperationalOutcome | null {
  const latest = getLatestReview(reviews);
  return latest?.operationalOutcome ?? null;
}

// ---------------------------------------------------------------------------
// Intake notification (deduplicated)
// ---------------------------------------------------------------------------

export interface IntakeNotificationRecord {
  sent: boolean;
  sentAt: string | null;
  issueId: string;
  priority: string;
  category: string;
  evidenceFingerprint: string;
}

export function shouldSendIntakeNotification(
  priority: string,
  category: string,
  existingNotification: IntakeNotificationRecord | null,
): boolean {
  if (existingNotification?.sent) return false;
  if (priority !== "high") return false;
  if (category !== "store_submission") return false;
  return true;
}

export function isPendingNotification(notif: IntakeNotificationRecord | null): boolean {
  return notif != null && !notif.sent;
}