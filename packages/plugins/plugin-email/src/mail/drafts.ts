/**
 * Governed reply-draft candidate generation.
 *
 * Drafts are NEVER sent automatically. They are prepared as structured
 * candidates that the Communications Drafter agent or Board operator
 * must explicitly approve before any outbound action.
 *
 * Safety invariants:
 * - Duplicate messages do not generate duplicate reply drafts.
 * - Spam does not generate reply drafts.
 * - Uncertain recipient/thread relationships fail closed (no draft).
 * - Incomplete submissions can generate a clarification-draft candidate.
 * - Final send remains a separate Board/human-approved action.
 */

import type { IntakeSortCategory } from "./sorter.js";
import type { NormalizedMessage } from "./normalize.js";

// ---------------------------------------------------------------------------
// Draft candidate types
// ---------------------------------------------------------------------------

export type DraftKind =
  | "clarification_request"
  | "general_reply"
  | "acknowledgment"
  | "none";

export interface DraftCandidate {
  kind: DraftKind;
  to: string;
  subject: string;
  body: string;
  reason: string;
}

export interface DraftDecision {
  /** Whether a draft should be generated. */
  shouldDraft: boolean;
  /** The draft candidate, if shouldDraft is true. */
  candidate: DraftCandidate | null;
  /** Reason for the decision (auditability). */
  reason: string;
}

// ---------------------------------------------------------------------------
// Draft generation guards
// ---------------------------------------------------------------------------

const DRAFT_BLOCKED_CATEGORIES: Set<IntakeSortCategory> = new Set([
  "spam_irrelevant",
  "duplicate",
  "unknown",
]);

const DRAFT_NEEDED_CATEGORIES: Set<IntakeSortCategory> = new Set([
  "general_email",
  "reply_continuation",
  "incomplete",
]);

/**
 * Determine if a reply draft should be prepared for a sorted intake record.
 * Returns a DraftDecision, never sends.
 */
export function decideDraft(
  sortCategory: IntakeSortCategory,
  msg: Pick<NormalizedMessage, "fromAddress" | "from" | "subject">,
): DraftDecision {
  if (DRAFT_BLOCKED_CATEGORIES.has(sortCategory)) {
    return {
      shouldDraft: false,
      candidate: null,
      reason: `Draft blocked for category "${sortCategory}".`,
    };
  }

  if (!msg.fromAddress) {
    return {
      shouldDraft: false,
      candidate: null,
      reason: "No recipient address available; draft blocked.",
    };
  }

  if (DRAFT_NEEDED_CATEGORIES.has(sortCategory)) {
    const kind =
      sortCategory === "incomplete"
        ? "clarification_request"
        : "general_reply";

    return {
      shouldDraft: true,
      candidate: buildDraftCandidate(kind, msg),
      reason: `Draft needed for category "${sortCategory}".`,
    };
  }

  if (sortCategory === "store_submission") {
    return {
      shouldDraft: true,
      candidate: buildDraftCandidate("acknowledgment", msg),
      reason: "Store submission acknowledged; acknowledgment draft prepared.",
    };
  }

  return {
    shouldDraft: false,
    candidate: null,
    reason: `No draft policy for category "${sortCategory}".`,
  };
}

// ---------------------------------------------------------------------------
// Draft body builders
// ---------------------------------------------------------------------------

function buildDraftCandidate(
  kind: DraftKind,
  msg: Pick<NormalizedMessage, "fromAddress" | "from" | "subject">,
): DraftCandidate {
  const to = msg.fromAddress || msg.from || "";
  const refSubject = msg.subject || "(no subject)";
  const subject = `Re: ${refSubject.replace(/^Re:\s*/i, "")}`;

  switch (kind) {
    case "clarification_request": {
      const body = [
        `Hi,`,
        ``,
        `Thank you for your submission. We received your form but some information appears to be incomplete.`,
        ``,
        `Could you please provide the missing details so we can process your submission? A team member will follow up shortly.`,
        ``,
        `Best,`,
        `TheBinMap Team`,
      ].join("\n");

      return {
        kind,
        to,
        subject,
        body,
        reason: "Incomplete submission requires clarification from submitter.",
      };
    }

    case "acknowledgment": {
      const body = [
        `Hi,`,
        ``,
        `Thank you for your store submission. We have received your information and our team will review it shortly.`,
        ``,
        `If we need any additional information, we will reach out.`,
        ``,
        `Best,`,
        `TheBinMap Team`,
      ].join("\n");

      return {
        kind,
        to,
        subject,
        body,
        reason: "Store submission received; acknowledgment draft prepared.",
      };
    }

    case "general_reply": {
      const body = [
        `Hi,`,
        ``,
        `Thank you for reaching out to TheBinMap. We have received your message and a team member will get back to you as soon as possible.`,
        ``,
        `If this is urgent, please let us know.`,
        ``,
        `Best,`,
        `TheBinMap Team`,
      ].join("\n");

      return {
        kind,
        to,
        subject,
        body,
        reason: "General inquiry acknowledged; reply draft prepared.",
      };
    }

    default:
      return {
        kind: "none",
        to: "",
        subject: "",
        body: "",
        reason: "No draft type specified.",
      };
  }
}

/**
 * Format a DraftCandidate as a reply-draft document body suitable for
 * storage via the plugin document system. The body contains To:/Subject:
 * headers followed by a blank line and the draft text, matching the format
 * expected by parseReplyDraft() in worker.ts.
 */
export function formatDraftDocument(candidate: DraftCandidate): string {
  return `To: ${candidate.to}\nSubject: ${candidate.subject}\n\n${candidate.body}`;
}

/**
 * Determine whether a reply-draft document should be created for a given
 * intake sort result. This is the safe-gate function for the ingestion
 * pipeline: it decides in a single place whether to proceed with draft
 * creation, and returns the formatted draft text.
 */
export function prepareDraftDocument(
  sortCategory: IntakeSortCategory,
  msg: Pick<NormalizedMessage, "fromAddress" | "from" | "subject">,
): string | null {
  const decision = decideDraft(sortCategory, msg);
  if (!decision.shouldDraft || !decision.candidate) return null;
  return formatDraftDocument(decision.candidate);
}
