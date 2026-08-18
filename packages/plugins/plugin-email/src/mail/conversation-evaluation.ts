import type { StructuredConversationRecord } from "./conversation.js";

export type ShadowActionKind =
  | "would_acknowledge"
  | "would_request_information"
  | "would_prepare_listing_review"
  | "would_surface_commercial_opportunity"
  | "would_prepare_follow_up"
  | "would_suppress"
  | "would_no_action"
  | "would_escalate";

export interface ShadowConversationEvaluation {
  mode: "shadow_only";
  recordVersion: StructuredConversationRecord["recordVersion"];
  tenant: StructuredConversationRecord["tenant"];
  messageId: string;
  intent: string;
  conversationState: StructuredConversationRecord["state"];
  nextActionKind: StructuredConversationRecord["nextAction"]["kind"];
  shadowActionKind: ShadowActionKind;
  humanAttentionRequired: boolean;
  humanApprovalRequired: boolean;
  outputMode: StructuredConversationRecord["output"]["mode"];
  confidence: number;
  entityMatched: boolean;
  evidenceRef: string;
  reason: string;
  evaluatedAt: string;
}

export interface ConversationEvaluationReport {
  evaluatedAt: string;
  totalConversations: number;
  byTenant: Record<string, number>;
  byIntent: Record<string, number>;
  byConversationState: Record<string, number>;
  byNextActionKind: Record<string, number>;
  byShadowActionKind: Record<string, number>;
  entityMatched: number;
  entityUnmatched: number;
  draftCandidate: number;
  noAction: number;
  humanReview: number;
  suppressed: number;
  commercialSignal: number;
  lowConfidenceUncertain: number;
  missingInformation: number;
  unresolvedCases: number;
  humanAttentionRequired: number;
  noHumanAttentionRequired: number;
  metrics: {
    received: number;
    classified: number;
    conversationRecordCreated: number;
    noHumanAction: number;
    humanReview: number;
    draftReady: number;
    commercialOpportunity: number;
    uncertain: number;
  };
  shadowActions: ShadowConversationEvaluation[];
}

function increment(bucket: Record<string, number>, key: string): void {
  bucket[key] = (bucket[key] ?? 0) + 1;
}

function hasHumanAttention(record: StructuredConversationRecord): boolean {
  return record.nextAction.humanApprovalRequired ||
    record.state === "human_review" ||
    record.riskAuthorityClass === "uncertain" ||
    record.extraction.missingInformation.length > 0;
}

export function createShadowEvaluation(record: StructuredConversationRecord): ShadowConversationEvaluation {
  const shadowActionKind: ShadowActionKind = (() => {
    switch (record.nextAction.kind) {
      case "acknowledge":
        return "would_acknowledge";
      case "request_missing_information":
        return "would_request_information";
      case "prepare_correction_claim_removal_workflow":
        return "would_prepare_listing_review";
      case "prepare_commercial_response":
        return "would_surface_commercial_opportunity";
      case "prepare_follow_up":
        return "would_prepare_follow_up";
      case "escalate_to_human":
        return "would_escalate";
      case "suppress_close":
        return "would_suppress";
      case "no_action":
        return record.state === "suppressed" || record.state === "closed_not_interested"
          ? "would_suppress"
          : "would_no_action";
    }
  })();

  return {
    mode: "shadow_only",
    recordVersion: record.recordVersion,
    tenant: record.tenant,
    messageId: record.message.messageId,
    intent: record.intent.category,
    conversationState: record.state,
    nextActionKind: record.nextAction.kind,
    shadowActionKind,
    humanAttentionRequired: hasHumanAttention(record),
    humanApprovalRequired: record.nextAction.humanApprovalRequired,
    outputMode: record.output.mode,
    confidence: record.intent.confidence,
    entityMatched: record.entityContext.matchConfidence >= 0.6,
    evidenceRef: record.message.evidenceId,
    reason: record.nextAction.reason,
    evaluatedAt: new Date().toISOString(),
  };
}

export function evaluateConversationBatch(records: StructuredConversationRecord[]): ConversationEvaluationReport {
  const report: ConversationEvaluationReport = {
    evaluatedAt: new Date().toISOString(),
    totalConversations: records.length,
    byTenant: {},
    byIntent: {},
    byConversationState: {},
    byNextActionKind: {},
    byShadowActionKind: {},
    entityMatched: 0,
    entityUnmatched: 0,
    draftCandidate: 0,
    noAction: 0,
    humanReview: 0,
    suppressed: 0,
    commercialSignal: 0,
    lowConfidenceUncertain: 0,
    missingInformation: 0,
    unresolvedCases: 0,
    humanAttentionRequired: 0,
    noHumanAttentionRequired: 0,
    metrics: {
      received: records.length,
      classified: records.length,
      conversationRecordCreated: records.length,
      noHumanAction: 0,
      humanReview: 0,
      draftReady: 0,
      commercialOpportunity: 0,
      uncertain: 0,
    },
    shadowActions: [],
  };

  for (const record of records) {
    const shadow = createShadowEvaluation(record);
    report.shadowActions.push(shadow);

    increment(report.byTenant, record.tenant);
    increment(report.byIntent, record.intent.category);
    increment(report.byConversationState, record.state);
    increment(report.byNextActionKind, record.nextAction.kind);
    increment(report.byShadowActionKind, shadow.shadowActionKind);

    if (shadow.entityMatched) report.entityMatched += 1;
    else report.entityUnmatched += 1;

    if (record.output.mode === "draft" && record.output.draft) report.draftCandidate += 1;
    if (record.output.mode === "no_action") report.noAction += 1;
    if (record.state === "human_review") report.humanReview += 1;
    if (record.state === "suppressed" || record.state === "closed_not_interested") report.suppressed += 1;
    if (record.commercialSignal.present) report.commercialSignal += 1;
    if (record.riskAuthorityClass === "uncertain" || record.intent.confidence < 0.5) report.lowConfidenceUncertain += 1;
    if (record.extraction.missingInformation.length > 0) report.missingInformation += 1;
    if (!["resolved", "suppressed", "closed_not_interested"].includes(record.state)) report.unresolvedCases += 1;

    if (shadow.humanAttentionRequired) {
      report.humanAttentionRequired += 1;
      report.metrics.humanReview += 1;
    } else {
      report.noHumanAttentionRequired += 1;
      report.metrics.noHumanAction += 1;
    }
    if (record.output.mode === "draft" && record.output.draft) report.metrics.draftReady += 1;
    if (record.riskAuthorityClass === "commercial_opportunity") report.metrics.commercialOpportunity += 1;
    if (record.riskAuthorityClass === "uncertain") report.metrics.uncertain += 1;
  }

  return report;
}
