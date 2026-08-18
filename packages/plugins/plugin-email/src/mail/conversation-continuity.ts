import { createHash } from "node:crypto";
import type { StructuredConversationRecord } from "./conversation.js";
import type { ConversationState } from "./conversation-policies.js";
import type { ShadowActionKind } from "./conversation-evaluation.js";

export type ConversationLinkageStatus = "new" | "deterministic" | "uncertain";
export type FollowUpStatus =
  | "waiting_for_reply"
  | "follow_up_due"
  | "resolved"
  | "closed_not_interested"
  | "suppressed"
  | "human_policy_required";
export type FollowUpShadowAction = "would_wait" | "would_follow_up" | "would_close" | "would_escalate";
export type OutcomeComparisonStatus = "agreement" | "disagreement" | "unknown";
export type KnownOutcomeKind =
  | "acknowledged"
  | "requested_information"
  | "prepared_listing_review"
  | "commercial_follow_up"
  | "follow_up_prepared"
  | "closed"
  | "suppressed"
  | "escalated";

export interface PriorConversationContext {
  issueId: string;
  record: StructuredConversationRecord;
  continuity?: ConversationContinuityRecord | null;
}

export interface KnownConversationOutcome {
  kind: KnownOutcomeKind;
  evidence: string;
}

export interface ConversationContinuityRecord {
  recordVersion: "directory-conversation-continuity-v1";
  conversationId: string;
  currentIssueId: string;
  currentMessageId: string;
  tenant: StructuredConversationRecord["tenant"];
  mailboxProfileKey: string;
  linkage: {
    status: ConversationLinkageStatus;
    method: "message_reference" | "thread_key" | "entity_identity" | "subject_sender" | "none" | "uncertain";
    confidence: number;
    reason: string;
    priorIssueIds: string[];
    priorMessageIds: string[];
    priorMessageCount: number;
    candidates: Array<{ issueId: string; messageId: string; reason: string; confidence: number }>;
    evidenceRefs: Array<{ kind: string; ref: string; note: string }>;
  };
  entityContinuity: {
    entityType: StructuredConversationRecord["entityContext"]["entityType"];
    entityName: string | null;
    entityLocator: string | null;
    matchConfidence: number;
    provenance: "current_message" | "inherited_from_prior" | "unknown" | "conflicting_new_evidence";
    inheritedFromIssueId: string | null;
    reason: string;
  };
  previousState: ConversationState | null;
  currentState: ConversationState;
  transition: {
    kind:
      | "new_conversation"
      | "information_received"
      | "positive_response"
      | "negative_closed"
      | "unsubscribe_suppressed"
      | "human_review_required"
      | "waiting"
      | "uncertain";
    from: ConversationState | null;
    to: ConversationState;
    reason: string;
  };
  followUp: {
    status: FollowUpStatus;
    shadowAction: FollowUpShadowAction;
    dueAt: string | null;
    policyRequired: boolean;
    reason: string;
  };
  outcomeComparison: {
    status: OutcomeComparisonStatus;
    knownOutcome: KnownOutcomeKind | null;
    shadowRecommendation: ShadowActionKind | null;
    reason: string;
    evidence: string | null;
  };
  humanAttentionRequired: boolean;
  uncertaintyReasons: string[];
  createdAt: string;
}

export interface ContinuityEvaluationReport {
  evaluatedAt: string;
  totalConversations: number;
  linkedDeterministically: number;
  uncertainLinkage: number;
  newConversations: number;
  inheritedEntityContext: number;
  conflictingEntityEvidence: number;
  waitingForReply: number;
  followUpDue: number;
  resolved: number;
  closedNotInterested: number;
  suppressed: number;
  humanAttentionRequired: number;
  recommendationAgreement: number;
  recommendationDisagreement: number;
  outcomeUnknown: number;
}

const OUTCOME_BY_SHADOW: Record<ShadowActionKind, KnownOutcomeKind[]> = {
  would_acknowledge: ["acknowledged"],
  would_request_information: ["requested_information"],
  would_prepare_listing_review: ["prepared_listing_review"],
  would_surface_commercial_opportunity: ["commercial_follow_up"],
  would_prepare_follow_up: ["follow_up_prepared", "commercial_follow_up"],
  would_suppress: ["suppressed", "closed"],
  would_no_action: ["closed"],
  would_escalate: ["escalated"],
};

function hashId(parts: string[]): string {
  return createHash("sha1").update(parts.filter(Boolean).join("\n")).digest("hex").slice(0, 16);
}

function normalizeComparable(value: string | null | undefined): string {
  return (value ?? "").toLowerCase().replace(/https?:\/\//g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

function normalizeSubject(subject: string): string {
  return subject
    .toLowerCase()
    .replace(/^\s*(re|fw|fwd)\s*:\s*/g, "")
    .replace(/\[[^\]]+\]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function entityKey(record: StructuredConversationRecord): string | null {
  const entity = record.entityContext;
  if (entity.matchConfidence < 0.6) return null;
  const value = normalizeComparable(entity.entityName || entity.entityLocator);
  return value ? `${record.tenant}:${entity.entityType}:${value}` : null;
}

function messageReferenceMatches(current: StructuredConversationRecord, prior: StructuredConversationRecord): boolean {
  const refs = new Set([current.threadContext.inReplyTo, ...current.threadContext.references].filter((v): v is string => Boolean(v)));
  return refs.has(prior.message.messageId) ||
    prior.threadContext.references.some((ref) => refs.has(ref)) ||
    (current.threadContext.inReplyTo != null && current.threadContext.inReplyTo === prior.threadContext.threadKey);
}

function currentHasContradictoryEntity(current: StructuredConversationRecord, prior: StructuredConversationRecord): boolean {
  const currentKey = entityKey(current);
  const priorKey = entityKey(prior);
  return currentKey != null && priorKey != null && currentKey !== priorKey;
}

function conversationIdFor(record: StructuredConversationRecord): string {
  const reference = record.threadContext.inReplyTo ?? record.threadContext.references[0];
  if (reference) return `thread:${hashId([record.mailboxProfileKey, reference])}`;
  const entity = entityKey(record);
  if (entity) return `entity:${hashId([record.mailboxProfileKey, entity])}`;
  return `message:${hashId([record.mailboxProfileKey, record.message.messageId])}`;
}

function latestPrior(priors: PriorConversationContext[]): PriorConversationContext | null {
  if (priors.length === 0) return null;
  return priors.slice().sort((a, b) => a.record.message.date.localeCompare(b.record.message.date))[priors.length - 1] ?? null;
}

function selectDeterministicPrior(
  current: StructuredConversationRecord,
  priorContexts: PriorConversationContext[],
): {
  match: PriorConversationContext | null;
  status: ConversationLinkageStatus;
  method: ConversationContinuityRecord["linkage"]["method"];
  reason: string;
  confidence: number;
  candidates: ConversationContinuityRecord["linkage"]["candidates"];
} {
  const candidates: ConversationContinuityRecord["linkage"]["candidates"] = [];
  const compatible = priorContexts.filter((prior) =>
    prior.record.tenant === current.tenant &&
    prior.record.mailboxProfileKey === current.mailboxProfileKey,
  );

  const referenceMatches = compatible.filter((prior) => {
    const matched = messageReferenceMatches(current, prior.record);
    if (matched) {
      candidates.push({
        issueId: prior.issueId,
        messageId: prior.record.message.messageId,
        reason: "In-Reply-To/References matched prior Message-ID or thread key.",
        confidence: 0.98,
      });
    }
    return matched;
  });
  if (referenceMatches.length === 1) {
    return { match: referenceMatches[0], status: "deterministic", method: "message_reference", reason: "Header references matched exactly one prior message.", confidence: 0.98, candidates };
  }
  if (referenceMatches.length > 1) {
    return { match: null, status: "uncertain", method: "uncertain", reason: "Header references matched multiple prior candidates.", confidence: 0.4, candidates };
  }

  const sameThread = compatible.filter((prior) => current.threadContext.threadKey === prior.record.threadContext.threadKey);
  if (sameThread.length === 1) {
    candidates.push({ issueId: sameThread[0].issueId, messageId: sameThread[0].record.message.messageId, reason: "Thread key matched exactly.", confidence: 0.9 });
    return { match: sameThread[0], status: "deterministic", method: "thread_key", reason: "Thread key matched exactly one prior record.", confidence: 0.9, candidates };
  }
  if (sameThread.length > 1) {
    return { match: null, status: "uncertain", method: "uncertain", reason: "Thread key matched multiple prior candidates.", confidence: 0.4, candidates };
  }

  const currentEntity = entityKey(current);
  if (currentEntity) {
    const entityMatches = compatible.filter((prior) => entityKey(prior.record) === currentEntity);
    for (const prior of entityMatches) {
      candidates.push({ issueId: prior.issueId, messageId: prior.record.message.messageId, reason: "Tenant/mailbox/entity identity matched.", confidence: 0.75 });
    }
    if (entityMatches.length === 1) {
      return { match: entityMatches[0], status: "deterministic", method: "entity_identity", reason: "Entity identity matched exactly one prior record.", confidence: 0.75, candidates };
    }
    if (entityMatches.length > 1) {
      const uniqueConversationIds = new Set(entityMatches.map((prior) => prior.continuity?.conversationId).filter(Boolean));
      if (uniqueConversationIds.size === 1) {
        const latest = latestPrior(entityMatches);
        return { match: latest, status: "deterministic", method: "entity_identity", reason: "Entity identity matched one existing conversation.", confidence: 0.75, candidates };
      }
      return { match: null, status: "uncertain", method: "uncertain", reason: "Entity identity matched multiple prior conversations.", confidence: 0.45, candidates };
    }
  }

  const normalizedSubject = normalizeSubject(current.message.subject);
  const subjectSenderMatches = normalizedSubject
    ? compatible.filter((prior) =>
        normalizeSubject(prior.record.message.subject) === normalizedSubject &&
        prior.record.sender.address === current.sender.address,
      )
    : [];
  for (const prior of subjectSenderMatches) {
    candidates.push({ issueId: prior.issueId, messageId: prior.record.message.messageId, reason: "Normalized subject and sender matched.", confidence: 0.65 });
  }
  if (subjectSenderMatches.length === 1) {
    return { match: subjectSenderMatches[0], status: "deterministic", method: "subject_sender", reason: "Normalized subject and sender matched exactly one prior record.", confidence: 0.65, candidates };
  }
  if (subjectSenderMatches.length > 1) {
    return { match: null, status: "uncertain", method: "uncertain", reason: "Normalized subject and sender matched multiple candidates.", confidence: 0.4, candidates };
  }

  return { match: null, status: "new", method: "none", reason: "No deterministic prior conversation evidence matched.", confidence: 1, candidates };
}

function inheritedEntity(
  current: StructuredConversationRecord,
  prior: PriorConversationContext | null,
): ConversationContinuityRecord["entityContinuity"] {
  if (current.entityContext.matchConfidence >= 0.6) {
    if (prior && currentHasContradictoryEntity(current, prior.record)) {
      return {
        ...current.entityContext,
        provenance: "conflicting_new_evidence",
        inheritedFromIssueId: null,
        reason: "Current message provided entity evidence that conflicts with the linked prior entity.",
      };
    }
    return {
      ...current.entityContext,
      provenance: "current_message",
      inheritedFromIssueId: null,
      reason: current.entityContext.matchReason,
    };
  }

  if (prior && prior.record.entityContext.matchConfidence >= 0.6) {
    return {
      ...prior.record.entityContext,
      provenance: "inherited_from_prior",
      inheritedFromIssueId: prior.issueId,
      reason: "Current message was deterministically linked and did not provide stronger contradictory entity evidence.",
    };
  }

  return {
    ...current.entityContext,
    provenance: "unknown",
    inheritedFromIssueId: null,
    reason: current.entityContext.matchReason,
  };
}

function transitionFor(
  current: StructuredConversationRecord,
  previousState: ConversationState | null,
  linkageStatus: ConversationLinkageStatus,
): ConversationContinuityRecord["transition"] {
  if (linkageStatus === "uncertain") {
    return { kind: "uncertain", from: previousState, to: "human_review", reason: "Conversation linkage is uncertain and must fail closed." };
  }
  if (!previousState) {
    return { kind: "new_conversation", from: null, to: current.state, reason: "No deterministic prior conversation matched." };
  }
  if (current.intent.category === "unsubscribe") {
    return { kind: "unsubscribe_suppressed", from: previousState, to: "suppressed", reason: "Unsubscribe/do-not-contact reply terminates future follow-up." };
  }
  if (current.intent.category === "negative_not_interested") {
    return { kind: "negative_closed", from: previousState, to: "closed_not_interested", reason: "Negative reply closes the conversation without follow-up." };
  }
  if (current.intent.category === "positive_response") {
    return { kind: "positive_response", from: previousState, to: "response_ready", reason: "Positive reply requires human-reviewed follow-up." };
  }
  if (current.nextAction.kind === "request_missing_information" || current.intent.category === "correction" || current.intent.category === "listing_claim") {
    return { kind: "information_received", from: previousState, to: current.state, reason: "Linked reply supplied or changed business facts; human review remains required when consequential." };
  }
  if (current.state === "human_review") {
    return { kind: "human_review_required", from: previousState, to: current.state, reason: current.nextAction.reason };
  }
  return { kind: "waiting", from: previousState, to: current.state, reason: "Linked message did not close or resolve the conversation." };
}

function followUpFor(
  current: StructuredConversationRecord,
  transition: ConversationContinuityRecord["transition"],
): ConversationContinuityRecord["followUp"] {
  if (transition.kind === "unsubscribe_suppressed" || current.state === "suppressed") {
    return { status: "suppressed", shadowAction: "would_close", dueAt: null, policyRequired: false, reason: "Suppressed conversations must not receive follow-up." };
  }
  if (transition.kind === "negative_closed" || current.state === "closed_not_interested") {
    return { status: "closed_not_interested", shadowAction: "would_close", dueAt: null, policyRequired: false, reason: "No-interest reply closes the conversation." };
  }
  if (current.state === "resolved") {
    return { status: "resolved", shadowAction: "would_close", dueAt: null, policyRequired: false, reason: "Conversation is resolved." };
  }
  if (current.nextAction.kind === "prepare_follow_up" || current.riskAuthorityClass === "commercial_opportunity") {
    return { status: "follow_up_due", shadowAction: "would_follow_up", dueAt: null, policyRequired: true, reason: "Human follow-up is due, but timing/business policy is not established." };
  }
  if (current.state === "waiting_for_reply" || current.nextAction.kind === "acknowledge") {
    return { status: "waiting_for_reply", shadowAction: "would_wait", dueAt: null, policyRequired: true, reason: "Follow-up timing policy is not established; wait state is recorded only." };
  }
  return { status: "human_policy_required", shadowAction: "would_escalate", dueAt: null, policyRequired: true, reason: "No deterministic follow-up policy exists for this state/action." };
}

export function compareShadowRecommendation(
  shadowRecommendation: ShadowActionKind | null,
  knownOutcome?: KnownConversationOutcome | null,
): ConversationContinuityRecord["outcomeComparison"] {
  if (!shadowRecommendation || !knownOutcome) {
    return {
      status: "unknown",
      knownOutcome: knownOutcome?.kind ?? null,
      shadowRecommendation,
      reason: "No known human outcome evidence is available.",
      evidence: knownOutcome?.evidence ?? null,
    };
  }
  const expected = OUTCOME_BY_SHADOW[shadowRecommendation] ?? [];
  const status: OutcomeComparisonStatus = expected.includes(knownOutcome.kind) ? "agreement" : "disagreement";
  return {
    status,
    knownOutcome: knownOutcome.kind,
    shadowRecommendation,
    reason: status === "agreement"
      ? "Known human outcome agrees with the shadow recommendation class."
      : "Known human outcome differs from the shadow recommendation class.",
    evidence: knownOutcome.evidence,
  };
}

export function createConversationContinuityRecord(input: {
  currentIssueId: string;
  currentRecord: StructuredConversationRecord;
  currentShadowRecommendation?: ShadowActionKind | null;
  priorRecords?: PriorConversationContext[];
  knownOutcome?: KnownConversationOutcome | null;
}): ConversationContinuityRecord {
  const current = input.currentRecord;
  const selection = selectDeterministicPrior(current, input.priorRecords ?? []);
  const prior = selection.match;
  const priorContinuity = prior?.continuity ?? null;
  const conversationId = selection.status === "deterministic" && prior
    ? priorContinuity?.conversationId ?? conversationIdFor(prior.record)
    : conversationIdFor(current);
  const previousState = priorContinuity?.currentState ?? prior?.record.state ?? null;
  const transition = transitionFor(current, previousState, selection.status);
  const entityContinuity = inheritedEntity(current, prior);
  const uncertaintyReasons = [
    ...(selection.status === "uncertain" ? [selection.reason] : []),
    ...(entityContinuity.provenance === "conflicting_new_evidence" ? [entityContinuity.reason] : []),
  ];
  const humanAttentionRequired = current.nextAction.humanApprovalRequired ||
    transition.to === "human_review" ||
    selection.status === "uncertain" ||
    entityContinuity.provenance === "conflicting_new_evidence" ||
    current.extraction.missingInformation.length > 0;

  return {
    recordVersion: "directory-conversation-continuity-v1",
    conversationId,
    currentIssueId: input.currentIssueId,
    currentMessageId: current.message.messageId,
    tenant: current.tenant,
    mailboxProfileKey: current.mailboxProfileKey,
    linkage: {
      status: selection.status,
      method: selection.method,
      confidence: selection.confidence,
      reason: selection.reason,
      priorIssueIds: prior ? [prior.issueId] : [],
      priorMessageIds: prior ? [prior.record.message.messageId] : [],
      priorMessageCount: prior ? (priorContinuity?.linkage.priorMessageCount ?? 0) + 1 : 0,
      candidates: selection.candidates,
      evidenceRefs: [
        { kind: "message", ref: current.message.messageId, note: "Current inbound message." },
        ...(prior ? [{ kind: "prior_message", ref: prior.record.message.messageId, note: "Deterministically linked prior message." }] : []),
      ],
    },
    entityContinuity,
    previousState,
    currentState: transition.to,
    transition,
    followUp: followUpFor(current, transition),
    outcomeComparison: compareShadowRecommendation(input.currentShadowRecommendation ?? null, input.knownOutcome ?? null),
    humanAttentionRequired,
    uncertaintyReasons,
    createdAt: new Date().toISOString(),
  };
}

export function evaluateContinuityBatch(records: ConversationContinuityRecord[]): ContinuityEvaluationReport {
  return records.reduce<ContinuityEvaluationReport>((report, record) => {
    report.totalConversations += 1;
    if (record.linkage.status === "deterministic") report.linkedDeterministically += 1;
    if (record.linkage.status === "uncertain") report.uncertainLinkage += 1;
    if (record.linkage.status === "new") report.newConversations += 1;
    if (record.entityContinuity.provenance === "inherited_from_prior") report.inheritedEntityContext += 1;
    if (record.entityContinuity.provenance === "conflicting_new_evidence") report.conflictingEntityEvidence += 1;
    if (record.followUp.status === "waiting_for_reply") report.waitingForReply += 1;
    if (record.followUp.status === "follow_up_due") report.followUpDue += 1;
    if (record.followUp.status === "resolved") report.resolved += 1;
    if (record.followUp.status === "closed_not_interested") report.closedNotInterested += 1;
    if (record.followUp.status === "suppressed") report.suppressed += 1;
    if (record.humanAttentionRequired) report.humanAttentionRequired += 1;
    if (record.outcomeComparison.status === "agreement") report.recommendationAgreement += 1;
    if (record.outcomeComparison.status === "disagreement") report.recommendationDisagreement += 1;
    if (record.outcomeComparison.status === "unknown") report.outcomeUnknown += 1;
    return report;
  }, {
    evaluatedAt: new Date().toISOString(),
    totalConversations: 0,
    linkedDeterministically: 0,
    uncertainLinkage: 0,
    newConversations: 0,
    inheritedEntityContext: 0,
    conflictingEntityEvidence: 0,
    waitingForReply: 0,
    followUpDue: 0,
    resolved: 0,
    closedNotInterested: 0,
    suppressed: 0,
    humanAttentionRequired: 0,
    recommendationAgreement: 0,
    recommendationDisagreement: 0,
    outcomeUnknown: 0,
  });
}
