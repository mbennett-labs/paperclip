import { describe, expect, it } from "vitest";
import {
  createConversationContinuityRecord,
  type ConversationContinuityRecord,
  type KnownConversationOutcome,
  type PriorConversationContext,
} from "../src/mail/conversation-continuity.js";
import { createShadowEvaluation } from "../src/mail/conversation-evaluation.js";
import { createLiveShadowReport, type LiveShadowReportIssueInput } from "../src/mail/conversation-live-shadow-report.js";
import { createConversationRecord, type StructuredConversationRecord } from "../src/mail/conversation.js";
import { decideDraft } from "../src/mail/drafts.js";
import { detectSource, extractStoreIntake, normalizeMessage } from "../src/mail/normalize.js";
import { createReviewRecord } from "../src/mail/review.js";
import { sortIntakeRecord } from "../src/mail/sorter.js";

type MessageFixture = {
  messageId: string;
  profileKey: string;
  from: { name: string; address: string };
  to: { name: string; address: string };
  subject: string;
  bodyText: string;
  date?: string;
  inReplyTo?: string;
  references?: string[];
};

function replayMessage(input: MessageFixture) {
  const msg = normalizeMessage({
    uid: 1,
    folder: "INBOX",
    profileKey: input.profileKey,
    envelope: {
      messageId: input.messageId,
      from: [input.from],
      to: [input.to],
      subject: input.subject,
      date: input.date ?? "2026-08-18T14:00:00.000Z",
      inReplyTo: input.inReplyTo,
      references: input.references,
    },
    bodyText: input.bodyText,
  });
  const detection = detectSource(msg.subject, msg.fromAddress, msg.bodyText);
  const storeIntake = extractStoreIntake(msg, detection, "issue-replay");
  const sortResult = sortIntakeRecord({
    sourceDetection: detection,
    classHint: msg.classHint,
    intakeMetadata: storeIntake?.intakeMetadata ?? null,
    duplicateMatchStrength: null,
    latestVerdict: null,
    hasReplyDraft: false,
    inReplyTo: msg.inReplyTo,
    hasReferences: msg.references.length > 0,
  });
  const draftDecision = decideDraft(sortResult.category, {
    fromAddress: msg.fromAddress,
    from: msg.from,
    subject: msg.subject,
  });
  const conversation = createConversationRecord({
    msg,
    detection,
    sortResult,
    intakeMetadata: storeIntake?.intakeMetadata ?? null,
    storeIntake,
    draftCandidate: draftDecision.candidate,
  });
  const shadow = createShadowEvaluation(conversation);
  return { conversation, shadow };
}

function continuityFor(
  issueId: string,
  currentRecord: StructuredConversationRecord,
  priors: PriorConversationContext[] = [],
  knownOutcome?: KnownConversationOutcome | null,
) {
  const shadow = createShadowEvaluation(currentRecord);
  return createConversationContinuityRecord({
    currentIssueId: issueId,
    currentRecord,
    currentShadowRecommendation: shadow.shadowActionKind,
    priorRecords: priors,
    knownOutcome,
  });
}

function priorContext(issueId: string, record: StructuredConversationRecord, continuity?: ConversationContinuityRecord): PriorConversationContext {
  return { issueId, record, continuity: continuity ?? null };
}

function reportRecord(
  issueId: string,
  conversationRecord: StructuredConversationRecord,
  continuityRecord: ConversationContinuityRecord,
  reviews: LiveShadowReportIssueInput["reviews"] = [],
): LiveShadowReportIssueInput {
  return {
    issueId,
    conversationRecord,
    shadowEvaluation: createShadowEvaluation(conversationRecord),
    continuityRecord,
    reviews,
  };
}

function seedWaiting(continuity: ConversationContinuityRecord): ConversationContinuityRecord {
  return {
    ...continuity,
    currentState: "waiting_for_reply",
    followUp: {
      status: "waiting_for_reply",
      shadowAction: "would_wait",
      dueAt: null,
      policyRequired: true,
      reason: "Synthetic historical outreach seed; no outbound send is performed in replay.",
    },
  };
}

function fixtureBatch() {
  const tbmSubmit = replayMessage({
    messageId: "report-tbm-submit@example.test",
    profileKey: "thebinmap-submissions",
    from: { name: "Web3Forms", address: "notify@web3forms.com" },
    to: { name: "TheBinMap", address: "info@thebinmap.com" },
    subject: "New store submission - TheBinMap",
    bodyText: [
      "Store Name: Report Bargains",
      "Address: 101 Outlet Way",
      "City: Nashville",
      "State: TN",
      "Your Email: owner@reportbargains.test",
      "Restock Schedule: Fridays",
      "Sent via https://thebinmap.com/",
    ].join("\n"),
  });
  const tbmSubmitContinuity = continuityFor("issue-submit", tbmSubmit.conversation, [], {
    kind: "acknowledged",
    evidence: "Human review confirmed an acknowledgment was prepared.",
  });

  const tbmCorrection = replayMessage({
    messageId: "report-tbm-correction@example.test",
    profileKey: "thebinmap-submissions",
    from: { name: "Owner", address: "owner@reportbargains.test" },
    to: { name: "TheBinMap", address: "info@thebinmap.com" },
    subject: "Re: New store submission - TheBinMap",
    inReplyTo: "report-tbm-submit@example.test",
    references: ["report-tbm-submit@example.test"],
    bodyText: "Correction for TheBinMap: restocks moved to Saturday.",
  });
  const tbmCorrectionContinuity = continuityFor(
    "issue-correction",
    tbmCorrection.conversation,
    [priorContext("issue-submit", tbmSubmit.conversation, tbmSubmitContinuity)],
    { kind: "closed", evidence: "Deliberate report fixture disagreement." },
  );

  const tbmCommercial = replayMessage({
    messageId: "report-tbm-commercial@example.test",
    profileKey: "thebinmap-info",
    from: { name: "Supplier Rep", address: "sales@supplier.test" },
    to: { name: "TheBinMap", address: "info@thebinmap.com" },
    subject: "Supplier partnership for TheBinMap",
    bodyText: "We can partner with TheBinMap on wholesale supplier pricing and paid placement packages.",
  });
  const tbmCommercialContinuity = continuityFor("issue-commercial", tbmCommercial.conversation);

  const tbmNegative = replayMessage({
    messageId: "report-tbm-negative@example.test",
    profileKey: "thebinmap-info",
    from: { name: "Owner", address: "owner@closed.test" },
    to: { name: "TheBinMap", address: "info@thebinmap.com" },
    subject: "Re: TheBinMap outreach",
    inReplyTo: "report-outreach@example.test",
    references: ["report-outreach@example.test"],
    bodyText: "No thanks, not interested in TheBinMap right now.",
  });
  const tbmNegativeContinuity = continuityFor("issue-negative", tbmNegative.conversation);

  const tiRemoval = replayMessage({
    messageId: "report-ti-removal@example.test",
    profileKey: "therapist-index-support",
    from: { name: "Dr. Elena Morris", address: "elena@example-clinic.test" },
    to: { name: "Support", address: "support@therapistindex.com" },
    subject: "TherapistIndex removal request",
    bodyText: "Listing: Elena Morris, LMFT\nListing URL: https://therapistindex.com/therapists/elena-morris\nRequest: Please remove my listing.",
  });
  const tiRemovalContinuity = continuityFor("issue-ti-removal", tiRemoval.conversation);

  const tiUnsubscribe = replayMessage({
    messageId: "report-ti-unsubscribe@example.test",
    profileKey: "therapist-index-support",
    from: { name: "Therapist", address: "therapist@practice.test" },
    to: { name: "TherapistIndex", address: "support@therapistindex.com" },
    subject: "Re: TherapistIndex outreach",
    bodyText: "Please unsubscribe me from TherapistIndex emails. Do not contact me again.",
  });
  const tiUnsubscribeContinuity = continuityFor("issue-ti-unsubscribe", tiUnsubscribe.conversation);

  const tiPositive = replayMessage({
    messageId: "report-ti-positive@example.test",
    profileKey: "therapist-index-support",
    from: { name: "Therapist", address: "therapist@practice.test" },
    to: { name: "TherapistIndex", address: "support@therapistindex.com" },
    subject: "Re: TherapistIndex outreach",
    inReplyTo: "report-ti-seed@example.test",
    references: ["report-ti-seed@example.test"],
    bodyText: "Yes, I am interested. Please send details about TherapistIndex.",
  });
  const tiPositiveContinuity = continuityFor("issue-ti-positive", tiPositive.conversation);

  const ambiguous = replayMessage({
    messageId: "report-ambiguous-current@example.test",
    profileKey: "thebinmap-info",
    from: { name: "Owner", address: "owner@ambiguous.test" },
    to: { name: "TheBinMap", address: "info@thebinmap.com" },
    subject: "Re: TheBinMap outreach",
    inReplyTo: "shared-report-prior@example.test",
    references: ["shared-report-prior@example.test"],
    bodyText: "Here is a correction for TheBinMap.",
  });
  const priorA = replayMessage({
    messageId: "report-prior-a@example.test",
    profileKey: "thebinmap-info",
    from: { name: "Owner A", address: "a@example.test" },
    to: { name: "TheBinMap", address: "info@thebinmap.com" },
    subject: "TheBinMap outreach",
    bodyText: "Store Name: A Store\nCity: Austin\nState: TX",
  });
  const priorB = replayMessage({
    messageId: "report-prior-b@example.test",
    profileKey: "thebinmap-info",
    from: { name: "Owner B", address: "b@example.test" },
    to: { name: "TheBinMap", address: "info@thebinmap.com" },
    subject: "TheBinMap outreach",
    bodyText: "Store Name: B Store\nCity: Boston\nState: MA",
  });
  priorA.conversation.threadContext.references.push("shared-report-prior@example.test");
  priorB.conversation.threadContext.references.push("shared-report-prior@example.test");
  const ambiguousContinuity = continuityFor("issue-ambiguous", ambiguous.conversation, [
    priorContext("issue-prior-a", priorA.conversation),
    priorContext("issue-prior-b", priorB.conversation),
  ]);

  const conflictingContinuity: ConversationContinuityRecord = {
    ...tiRemovalContinuity,
    entityContinuity: {
      ...tiRemovalContinuity.entityContinuity,
      provenance: "conflicting_new_evidence",
      reason: "Fixture conflict.",
    },
  };
  const waitingContinuity = seedWaiting(tbmSubmitContinuity);

  return [
    reportRecord("issue-submit", tbmSubmit.conversation, waitingContinuity),
    reportRecord("issue-correction", tbmCorrection.conversation, tbmCorrectionContinuity),
    reportRecord("issue-commercial", tbmCommercial.conversation, tbmCommercialContinuity, [
      createReviewRecord(0, "genuine_external", "reviewer", { approvedNextAction: "commercial_follow_up" }),
    ]),
    reportRecord("issue-negative", tbmNegative.conversation, tbmNegativeContinuity),
    reportRecord("issue-ti-removal", tiRemoval.conversation, conflictingContinuity, [
      createReviewRecord(0, "genuine_external", "reviewer", { approvedNextAction: "closed" }),
    ]),
    reportRecord("issue-ti-unsubscribe", tiUnsubscribe.conversation, tiUnsubscribeContinuity),
    reportRecord("issue-ti-positive", tiPositive.conversation, tiPositiveContinuity),
    reportRecord("issue-ambiguous", ambiguous.conversation, ambiguousContinuity),
  ];
}

describe("Directory Conversation Operator live shadow report", () => {
  it("counts deterministic, uncertain, and new linkage across a mixed tenant batch", () => {
    const report = createLiveShadowReport(fixtureBatch());

    expect(report.metrics.totalMessagesConsidered).toBe(8);
    expect(report.metrics.classified).toBe(8);
    expect(report.metrics.conversationRecordsCreated).toBe(8);
    expect(report.metrics.deterministicContinuityLinks).toBe(1);
    expect(report.metrics.uncertainContinuityLinks).toBe(1);
    expect(report.metrics.newConversations).toBe(6);
    expect(report.metrics.inheritedEntityContext).toBe(1);
    expect(report.metrics.conflictingEntityEvidence).toBe(1);
    expect(report.breakdowns.byTenant.thebinmap).toBe(5);
    expect(report.breakdowns.byTenant.therapist_index).toBe(3);
    expect(report.breakdowns.byLinkageStatus.deterministic).toBe(1);
    expect(report.breakdowns.byLinkageStatus.uncertain).toBe(1);
    expect(report.breakdowns.byLinkageMethod.message_reference).toBe(1);
  });

  it("counts human-attention, no-human-attention, drafts, commercial, suppression, no-interest, and follow-up states", () => {
    const report = createLiveShadowReport(fixtureBatch());

    expect(report.metrics.humanAttentionRequired).toBe(5);
    expect(report.metrics.noHumanAttentionRequired).toBe(3);
    expect(report.metrics.draftsReady).toBeGreaterThanOrEqual(4);
    expect(report.metrics.commercialOpportunities).toBe(2);
    expect(report.metrics.suppressed).toBe(1);
    expect(report.metrics.closedNotInterested).toBe(1);
    expect(report.metrics.waitingForReply).toBe(1);
    expect(report.metrics.followUpDue).toBe(2);
    expect(report.breakdowns.byRiskAuthorityClass.commercial_opportunity).toBe(2);
    expect(report.breakdowns.byShadowAction.would_suppress).toBe(2);
  });

  it("counts deterministic recommendation agreement and disagreement only when known outcome evidence exists", () => {
    const report = createLiveShadowReport(fixtureBatch());

    expect(report.metrics.recommendationAgreement).toBe(2);
    expect(report.metrics.recommendationDisagreement).toBe(2);
    expect(report.metrics.recommendationOutcomeUnknown).toBe(4);
    expect(report.metrics.recordsLackingSufficientOutcomeEvidence).toBe(4);
    expect(report.records.find((record) => record.issueId === "issue-commercial")?.outcomeEvidencePolicy).toBe("deterministic");
    expect(report.records.find((record) => record.issueId === "issue-negative")?.outcomeEvidencePolicy).toBe("insufficient");
  });

  it("treats insufficient outcome evidence as unknown instead of inventing a human result", () => {
    const [record] = fixtureBatch();
    const report = createLiveShadowReport([{
      ...record,
      reviews: [createReviewRecord(0, "genuine_external", "reviewer", { operationalOutcome: "accepted" })],
      continuityRecord: record.continuityRecord
        ? {
            ...record.continuityRecord,
            outcomeComparison: {
              status: "unknown",
              knownOutcome: null,
              shadowRecommendation: record.shadowEvaluation?.shadowActionKind ?? null,
              reason: "No known human outcome evidence is available.",
              evidence: null,
            },
          }
        : null,
    }]);

    expect(report.metrics.recommendationAgreement).toBe(0);
    expect(report.metrics.recommendationDisagreement).toBe(0);
    expect(report.metrics.recommendationOutcomeUnknown).toBe(1);
    expect(report.metrics.recordsLackingSufficientOutcomeEvidence).toBe(1);
  });

  it("does not mutate input records while generating the report", () => {
    const records = fixtureBatch();
    const before = JSON.stringify(records);

    createLiveShadowReport(records);

    expect(JSON.stringify(records)).toBe(before);
  });

  it("handles empty input safely", () => {
    const report = createLiveShadowReport([]);

    expect(report.metrics.totalMessagesConsidered).toBe(0);
    expect(report.metrics.classified).toBe(0);
    expect(report.metrics.recordsLackingSufficientOutcomeEvidence).toBe(0);
    expect(report.records).toEqual([]);
    expect(report.breakdowns.byTenant).toEqual({});
  });
});
