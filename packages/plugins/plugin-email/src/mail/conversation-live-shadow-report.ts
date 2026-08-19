import type { ConversationContinuityRecord, KnownOutcomeKind, OutcomeComparisonStatus } from "./conversation-continuity.js";
import { compareShadowRecommendation } from "./conversation-continuity.js";
import type { ShadowActionKind, ShadowConversationEvaluation } from "./conversation-evaluation.js";
import type { StructuredConversationRecord } from "./conversation.js";
import type { ReviewRecord } from "./review.js";

export interface LiveShadowReportIssueInput {
  issueId: string;
  conversationRecord?: StructuredConversationRecord | null;
  shadowEvaluation?: ShadowConversationEvaluation | null;
  continuityRecord?: ConversationContinuityRecord | null;
  reviews?: ReviewRecord[] | null;
}

export interface LiveShadowReportMetrics {
  totalMessagesConsidered: number;
  classified: number;
  conversationRecordsCreated: number;
  deterministicContinuityLinks: number;
  uncertainContinuityLinks: number;
  newConversations: number;
  inheritedEntityContext: number;
  conflictingEntityEvidence: number;
  humanAttentionRequired: number;
  noHumanAttentionRequired: number;
  draftsReady: number;
  commercialOpportunities: number;
  suppressed: number;
  closedNotInterested: number;
  waitingForReply: number;
  followUpDue: number;
  recommendationAgreement: number;
  recommendationDisagreement: number;
  recommendationOutcomeUnknown: number;
  recordsLackingSufficientOutcomeEvidence: number;
}

export interface LiveShadowReport {
  mode: "read_only_live_shadow_report";
  generatedAt: string;
  metrics: LiveShadowReportMetrics;
  breakdowns: {
    byTenant: Record<string, number>;
    byIntent: Record<string, number>;
    byConversationState: Record<string, number>;
    byNextAction: Record<string, number>;
    byShadowAction: Record<string, number>;
    byLinkageStatus: Record<string, number>;
    byLinkageMethod: Record<string, number>;
    byRiskAuthorityClass: Record<string, number>;
  };
  records: Array<{
    issueId: string;
    tenant: string | null;
    intent: string | null;
    conversationState: string | null;
    nextAction: string | null;
    shadowAction: string | null;
    linkageStatus: string | null;
    linkageMethod: string | null;
    riskAuthorityClass: string | null;
    outcomeStatus: OutcomeComparisonStatus;
    outcomeEvidence: string | null;
    outcomeEvidencePolicy: "deterministic" | "insufficient";
  }>;
}

const EMPTY_METRICS: LiveShadowReportMetrics = {
  totalMessagesConsidered: 0,
  classified: 0,
  conversationRecordsCreated: 0,
  deterministicContinuityLinks: 0,
  uncertainContinuityLinks: 0,
  newConversations: 0,
  inheritedEntityContext: 0,
  conflictingEntityEvidence: 0,
  humanAttentionRequired: 0,
  noHumanAttentionRequired: 0,
  draftsReady: 0,
  commercialOpportunities: 0,
  suppressed: 0,
  closedNotInterested: 0,
  waitingForReply: 0,
  followUpDue: 0,
  recommendationAgreement: 0,
  recommendationDisagreement: 0,
  recommendationOutcomeUnknown: 0,
  recordsLackingSufficientOutcomeEvidence: 0,
};

function increment(bucket: Record<string, number>, key: string | null | undefined): void {
  if (!key) return;
  bucket[key] = (bucket[key] ?? 0) + 1;
}

function hasHumanAttention(record: LiveShadowReportIssueInput): boolean | null {
  if (record.continuityRecord) return record.continuityRecord.humanAttentionRequired;
  if (record.shadowEvaluation) return record.shadowEvaluation.humanAttentionRequired;
  if (record.conversationRecord) {
    return record.conversationRecord.nextAction.humanApprovalRequired ||
      record.conversationRecord.state === "human_review" ||
      record.conversationRecord.riskAuthorityClass === "uncertain" ||
      record.conversationRecord.extraction.missingInformation.length > 0;
  }
  return null;
}

function latestReview(reviews: ReviewRecord[] | null | undefined): ReviewRecord | null {
  if (!reviews?.length) return null;
  return reviews.reduce((latest, review) => review.reviewIndex > latest.reviewIndex ? review : latest);
}

function knownOutcomeFromReview(review: ReviewRecord | null): { kind: KnownOutcomeKind; evidence: string } | null {
  if (!review?.approvedNextAction) return null;
  const allowed: KnownOutcomeKind[] = [
    "acknowledged",
    "requested_information",
    "prepared_listing_review",
    "commercial_follow_up",
    "follow_up_prepared",
    "closed",
    "suppressed",
    "escalated",
  ];
  if (!allowed.includes(review.approvedNextAction as KnownOutcomeKind)) return null;
  return {
    kind: review.approvedNextAction as KnownOutcomeKind,
    evidence: `Human review #${review.reviewIndex} approved next action: ${review.approvedNextAction}.`,
  };
}

function outcomeFor(record: LiveShadowReportIssueInput): {
  status: OutcomeComparisonStatus;
  evidence: string | null;
  policy: "deterministic" | "insufficient";
} {
  const existing = record.continuityRecord?.outcomeComparison;
  if (existing?.status && existing.status !== "unknown" && existing.knownOutcome && existing.evidence) {
    return { status: existing.status, evidence: existing.evidence, policy: "deterministic" };
  }

  const shadowAction = record.shadowEvaluation?.shadowActionKind ??
    record.continuityRecord?.outcomeComparison.shadowRecommendation ??
    null;
  const knownOutcome = knownOutcomeFromReview(latestReview(record.reviews));
  if (shadowAction && knownOutcome) {
    const comparison = compareShadowRecommendation(shadowAction as ShadowActionKind, knownOutcome);
    return { status: comparison.status, evidence: comparison.evidence, policy: "deterministic" };
  }

  return { status: "unknown", evidence: null, policy: "insufficient" };
}

export function createLiveShadowReport(records: LiveShadowReportIssueInput[]): LiveShadowReport {
  const report: LiveShadowReport = {
    mode: "read_only_live_shadow_report",
    generatedAt: new Date().toISOString(),
    metrics: { ...EMPTY_METRICS, totalMessagesConsidered: records.length },
    breakdowns: {
      byTenant: {},
      byIntent: {},
      byConversationState: {},
      byNextAction: {},
      byShadowAction: {},
      byLinkageStatus: {},
      byLinkageMethod: {},
      byRiskAuthorityClass: {},
    },
    records: [],
  };

  for (const item of records) {
    const conversation = item.conversationRecord;
    const shadow = item.shadowEvaluation;
    const continuity = item.continuityRecord;
    const attention = hasHumanAttention(item);
    const outcome = outcomeFor(item);

    if (conversation || shadow) report.metrics.classified += 1;
    if (conversation) report.metrics.conversationRecordsCreated += 1;
    if (continuity?.linkage.status === "deterministic") report.metrics.deterministicContinuityLinks += 1;
    if (continuity?.linkage.status === "uncertain") report.metrics.uncertainContinuityLinks += 1;
    if (continuity?.linkage.status === "new") report.metrics.newConversations += 1;
    if (continuity?.entityContinuity.provenance === "inherited_from_prior") report.metrics.inheritedEntityContext += 1;
    if (continuity?.entityContinuity.provenance === "conflicting_new_evidence") report.metrics.conflictingEntityEvidence += 1;
    if (attention === true) report.metrics.humanAttentionRequired += 1;
    if (attention === false) report.metrics.noHumanAttentionRequired += 1;
    if (conversation?.output.mode === "draft" && conversation.output.draft) report.metrics.draftsReady += 1;
    if (conversation?.riskAuthorityClass === "commercial_opportunity") report.metrics.commercialOpportunities += 1;
    if (conversation?.state === "suppressed" || continuity?.followUp.status === "suppressed") report.metrics.suppressed += 1;
    if (conversation?.state === "closed_not_interested" || continuity?.followUp.status === "closed_not_interested") {
      report.metrics.closedNotInterested += 1;
    }
    if (conversation?.state === "waiting_for_reply" || continuity?.followUp.status === "waiting_for_reply") {
      report.metrics.waitingForReply += 1;
    }
    if (continuity?.followUp.status === "follow_up_due") report.metrics.followUpDue += 1;
    if (outcome.status === "agreement") report.metrics.recommendationAgreement += 1;
    if (outcome.status === "disagreement") report.metrics.recommendationDisagreement += 1;
    if (outcome.status === "unknown") report.metrics.recommendationOutcomeUnknown += 1;
    if (outcome.policy === "insufficient") report.metrics.recordsLackingSufficientOutcomeEvidence += 1;

    increment(report.breakdowns.byTenant, conversation?.tenant ?? shadow?.tenant ?? continuity?.tenant);
    increment(report.breakdowns.byIntent, conversation?.intent.category ?? shadow?.intent);
    increment(report.breakdowns.byConversationState, conversation?.state ?? shadow?.conversationState ?? continuity?.currentState);
    increment(report.breakdowns.byNextAction, conversation?.nextAction.kind ?? shadow?.nextActionKind);
    increment(report.breakdowns.byShadowAction, shadow?.shadowActionKind ?? continuity?.outcomeComparison.shadowRecommendation);
    increment(report.breakdowns.byLinkageStatus, continuity?.linkage.status);
    increment(report.breakdowns.byLinkageMethod, continuity?.linkage.method);
    increment(report.breakdowns.byRiskAuthorityClass, conversation?.riskAuthorityClass);

    report.records.push({
      issueId: item.issueId,
      tenant: conversation?.tenant ?? shadow?.tenant ?? continuity?.tenant ?? null,
      intent: conversation?.intent.category ?? shadow?.intent ?? null,
      conversationState: conversation?.state ?? shadow?.conversationState ?? continuity?.currentState ?? null,
      nextAction: conversation?.nextAction.kind ?? shadow?.nextActionKind ?? null,
      shadowAction: shadow?.shadowActionKind ?? continuity?.outcomeComparison.shadowRecommendation ?? null,
      linkageStatus: continuity?.linkage.status ?? null,
      linkageMethod: continuity?.linkage.method ?? null,
      riskAuthorityClass: conversation?.riskAuthorityClass ?? null,
      outcomeStatus: outcome.status,
      outcomeEvidence: outcome.evidence,
      outcomeEvidencePolicy: outcome.policy,
    });
  }

  return report;
}
