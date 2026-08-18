import type { IntakeBrand, SourceType } from "./normalize.js";
import type { IntakeSortCategory } from "./sorter.js";

export type ConversationState =
  | "received"
  | "identified"
  | "needs_info"
  | "action_ready"
  | "response_ready"
  | "waiting_for_reply"
  | "follow_up_due"
  | "human_review"
  | "resolved"
  | "closed_not_interested"
  | "suppressed";

export type NextActionKind =
  | "no_action"
  | "acknowledge"
  | "request_missing_information"
  | "prepare_correction_claim_removal_workflow"
  | "prepare_commercial_response"
  | "prepare_follow_up"
  | "escalate_to_human"
  | "suppress_close";

export type RiskAuthorityClass =
  | "low_risk_transactional"
  | "directory_change"
  | "identity_sensitive_directory_change"
  | "commercial_opportunity"
  | "spam_or_system"
  | "uncertain";

export interface ConversationPolicyInput {
  tenant: IntakeBrand;
  sourceType: SourceType;
  sortCategory: IntakeSortCategory;
  intent: string;
  hasEntityMatch: boolean;
  missingInformation: string[];
  hasDraftCandidate: boolean;
  commercialSignal: boolean;
  confidence: number;
}

export interface ConversationPolicyDecision {
  state: ConversationState;
  nextAction: {
    kind: NextActionKind;
    label: string;
    reason: string;
    humanApprovalRequired: boolean;
  };
  riskAuthorityClass: RiskAuthorityClass;
  draftPolicy: "draft_only" | "no_reply" | "human_gate";
}

export function decideConversationPolicy(input: ConversationPolicyInput): ConversationPolicyDecision {
  if (input.sortCategory === "system_notification" || input.sortCategory === "duplicate") {
    return {
      state: "suppressed",
      riskAuthorityClass: "spam_or_system",
      draftPolicy: "no_reply",
      nextAction: {
        kind: "no_action",
        label: "Preserve as evidence; no reply expected",
        reason: `Sorted as ${input.sortCategory}.`,
        humanApprovalRequired: false,
      },
    };
  }

  if (input.sortCategory === "spam_irrelevant") {
    return {
      state: "closed_not_interested",
      riskAuthorityClass: "spam_or_system",
      draftPolicy: "no_reply",
      nextAction: {
        kind: "suppress_close",
        label: "Suppress and close",
        reason: "Message was classified as spam or irrelevant.",
        humanApprovalRequired: false,
      },
    };
  }

  if (input.intent === "unsubscribe") {
    return {
      state: "suppressed",
      riskAuthorityClass: "spam_or_system",
      draftPolicy: "no_reply",
      nextAction: {
        kind: "suppress_close",
        label: "Suppress unsubscribe / do-not-contact",
        reason: "Sender asked not to receive further outbound contact.",
        humanApprovalRequired: false,
      },
    };
  }

  if (input.commercialSignal) {
    return {
      state: "response_ready",
      riskAuthorityClass: "commercial_opportunity",
      draftPolicy: input.hasDraftCandidate ? "draft_only" : "human_gate",
      nextAction: {
        kind: "prepare_commercial_response",
        label: "Prepare commercial response",
        reason: "Commercial signal detected; pricing and commitments remain human-gated.",
        humanApprovalRequired: true,
      },
    };
  }

  if (input.intent === "negative_not_interested") {
    return {
      state: "closed_not_interested",
      riskAuthorityClass: "low_risk_transactional",
      draftPolicy: "no_reply",
      nextAction: {
        kind: "no_action",
        label: "Close without follow-up",
        reason: "Sender declined or expressed no interest; no reply is required.",
        humanApprovalRequired: false,
      },
    };
  }

  if (input.intent === "positive_response") {
    return {
      state: "response_ready",
      riskAuthorityClass: "commercial_opportunity",
      draftPolicy: input.hasDraftCandidate ? "draft_only" : "human_gate",
      nextAction: {
        kind: "prepare_follow_up",
        label: "Prepare human-reviewed follow-up",
        reason: "Positive response to prior outreach can create commitments and remains human-gated.",
        humanApprovalRequired: true,
      },
    };
  }

  if (input.sortCategory === "unknown" || input.confidence < 0.5) {
    return {
      state: "human_review",
      riskAuthorityClass: "uncertain",
      draftPolicy: "human_gate",
      nextAction: {
        kind: "escalate_to_human",
        label: "Human review required",
        reason: "Classification or tenant/entity evidence is too weak for deterministic handling.",
        humanApprovalRequired: true,
      },
    };
  }

  if (input.missingInformation.length > 0) {
    return {
      state: input.hasDraftCandidate ? "response_ready" : "needs_info",
      riskAuthorityClass: input.tenant === "therapist_index"
        ? "identity_sensitive_directory_change"
        : "directory_change",
      draftPolicy: input.hasDraftCandidate ? "draft_only" : "human_gate",
      nextAction: {
        kind: "request_missing_information",
        label: "Request missing information",
        reason: `Missing required information: ${input.missingInformation.join(", ")}.`,
        humanApprovalRequired: true,
      },
    };
  }

  if (input.tenant === "therapist_index" && (input.intent === "listing_removal" || input.intent === "correction" || input.intent === "listing_claim")) {
    return {
      state: "human_review",
      riskAuthorityClass: "identity_sensitive_directory_change",
      draftPolicy: input.hasDraftCandidate ? "draft_only" : "human_gate",
      nextAction: {
        kind: "prepare_correction_claim_removal_workflow",
        label: "Prepare TherapistIndex listing change review",
        reason: "TherapistIndex removals/corrections/claims require stronger identity and evidence review before profile changes.",
        humanApprovalRequired: true,
      },
    };
  }

  if (input.tenant === "thebinmap" && (input.intent === "store_submission" || input.intent === "correction" || input.intent === "listing_claim")) {
    return {
      state: input.intent === "store_submission" ? "action_ready" : "human_review",
      riskAuthorityClass: "directory_change",
      draftPolicy: input.hasDraftCandidate ? "draft_only" : "human_gate",
      nextAction: {
        kind: input.intent === "store_submission" ? "acknowledge" : "prepare_correction_claim_removal_workflow",
        label: input.intent === "store_submission" ? "Prepare store submission acknowledgment" : "Prepare TheBinMap listing change review",
        reason: input.intent === "store_submission"
          ? "Recognized TheBinMap store submission with enough structured fields for review workflow."
          : "Directory correction/claim requires human review before changing live listing data.",
        humanApprovalRequired: input.intent !== "store_submission",
      },
    };
  }

  return {
    state: input.hasDraftCandidate ? "response_ready" : "identified",
    riskAuthorityClass: "low_risk_transactional",
    draftPolicy: input.hasDraftCandidate ? "draft_only" : "no_reply",
    nextAction: {
      kind: input.hasDraftCandidate ? "acknowledge" : "no_action",
      label: input.hasDraftCandidate ? "Prepare acknowledgment draft" : "No deterministic action",
      reason: "No tenant-specific higher-risk policy matched.",
      humanApprovalRequired: input.hasDraftCandidate,
    },
  };
}
