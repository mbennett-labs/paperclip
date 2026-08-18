import { describe, expect, it } from "vitest";
import {
  createConversationContinuityRecord,
  evaluateContinuityBatch,
  type ConversationContinuityRecord,
  type KnownConversationOutcome,
  type PriorConversationContext,
} from "../src/mail/conversation-continuity.js";
import { createShadowEvaluation } from "../src/mail/conversation-evaluation.js";
import { createConversationRecord, type StructuredConversationRecord } from "../src/mail/conversation.js";
import { decideDraft } from "../src/mail/drafts.js";
import { detectSource, extractStoreIntake, normalizeMessage } from "../src/mail/normalize.js";
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

describe("Directory Conversation Operator continuity replay", () => {
  it("links TheBinMap store submission to owner correction and inherits entity context", () => {
    const first = replayMessage({
      messageId: "tbm-submit-thread@example.test",
      profileKey: "thebinmap-submissions",
      from: { name: "Web3Forms", address: "notify@web3forms.com" },
      to: { name: "TheBinMap", address: "info@thebinmap.com" },
      subject: "New store submission — TheBinMap",
      bodyText: [
        "Store Name: Fred's Bargain Barn",
        "Address: 101 Outlet Way",
        "City: Nashville",
        "State: TN",
        "Your Email: owner@fredsbargainbarn.test",
        "Restock Schedule: Fridays",
        "Sent via https://thebinmap.com/",
      ].join("\n"),
    });
    const firstContinuity = continuityFor("issue-tbm-1", first.conversation);
    const second = replayMessage({
      messageId: "tbm-submit-reply@example.test",
      profileKey: "thebinmap-submissions",
      from: { name: "Riley Owner", address: "owner@fredsbargainbarn.test" },
      to: { name: "TheBinMap", address: "info@thebinmap.com" },
      subject: "Re: New store submission — TheBinMap",
      inReplyTo: "tbm-submit-thread@example.test",
      references: ["tbm-submit-thread@example.test"],
      bodyText: "Correction for TheBinMap: restocks moved to Saturday and the phone number should be 615-555-0199.",
    });
    const secondContinuity = continuityFor("issue-tbm-2", second.conversation, [priorContext("issue-tbm-1", first.conversation, firstContinuity)], {
      kind: "prepared_listing_review",
      evidence: "Historical review queue kept owner correction human-gated.",
    });

    expect(secondContinuity.linkage.status).toBe("deterministic");
    expect(secondContinuity.linkage.method).toBe("message_reference");
    expect(secondContinuity.linkage.priorMessageCount).toBe(1);
    expect(secondContinuity.entityContinuity.provenance).toBe("inherited_from_prior");
    expect(secondContinuity.entityContinuity.entityName).toBe("Fred's Bargain Barn");
    expect(secondContinuity.transition.kind).toBe("information_received");
    expect(secondContinuity.currentState).toBe("human_review");
    expect(secondContinuity.humanAttentionRequired).toBe(true);
    expect(secondContinuity.outcomeComparison.status).toBe("agreement");
  });

  it("moves TheBinMap positive owner reply from waiting to human follow-up", () => {
    const seed = replayMessage({
      messageId: "tbm-outreach-owner@example.test",
      profileKey: "thebinmap-info",
      from: { name: "TheBinMap", address: "info@thebinmap.com" },
      to: { name: "Owner", address: "owner@store.test" },
      subject: "TheBinMap owner verification",
      bodyText: "Store Name: Claim Store\nCity: Austin\nState: TX\nOwner verification outreach.",
    });
    const seedContinuity = seedWaiting(continuityFor("issue-tbm-outreach", seed.conversation));
    const reply = replayMessage({
      messageId: "tbm-owner-positive@example.test",
      profileKey: "thebinmap-info",
      from: { name: "Owner", address: "owner@store.test" },
      to: { name: "TheBinMap", address: "info@thebinmap.com" },
      subject: "Re: TheBinMap owner verification",
      inReplyTo: "tbm-outreach-owner@example.test",
      references: ["tbm-outreach-owner@example.test"],
      bodyText: "Yes, I am interested. Sounds good - send details about verifying my TheBinMap listing.",
    });
    const continuity = continuityFor("issue-tbm-positive", reply.conversation, [priorContext("issue-tbm-outreach", seed.conversation, seedContinuity)]);

    expect(continuity.previousState).toBe("waiting_for_reply");
    expect(continuity.transition.kind).toBe("positive_response");
    expect(continuity.currentState).toBe("response_ready");
    expect(continuity.followUp.status).toBe("follow_up_due");
    expect(continuity.followUp.policyRequired).toBe(true);
    expect(continuity.humanAttentionRequired).toBe(true);
  });

  it("closes TheBinMap no-interest reply and suppresses unsubscribe reply", () => {
    const seed = replayMessage({
      messageId: "tbm-outreach-close@example.test",
      profileKey: "thebinmap-info",
      from: { name: "TheBinMap", address: "info@thebinmap.com" },
      to: { name: "Owner", address: "owner@closed.test" },
      subject: "TheBinMap outreach",
      bodyText: "Store Name: Closed Store\nCity: Tulsa\nState: OK\nTheBinMap outreach.",
    });
    const seedContinuity = seedWaiting(continuityFor("issue-tbm-outreach-close", seed.conversation));
    const negative = replayMessage({
      messageId: "tbm-owner-negative@example.test",
      profileKey: "thebinmap-info",
      from: { name: "Owner", address: "owner@closed.test" },
      to: { name: "TheBinMap", address: "info@thebinmap.com" },
      subject: "Re: TheBinMap outreach",
      inReplyTo: "tbm-outreach-close@example.test",
      references: ["tbm-outreach-close@example.test"],
      bodyText: "No thanks, not interested in TheBinMap right now.",
    });
    const unsubscribe = replayMessage({
      messageId: "tbm-owner-unsubscribe@example.test",
      profileKey: "thebinmap-info",
      from: { name: "Owner", address: "owner@closed.test" },
      to: { name: "TheBinMap", address: "info@thebinmap.com" },
      subject: "Re: TheBinMap outreach",
      inReplyTo: "tbm-outreach-close@example.test",
      references: ["tbm-outreach-close@example.test"],
      bodyText: "Please unsubscribe me and do not contact me about TheBinMap again.",
    });

    const negativeContinuity = continuityFor("issue-tbm-negative", negative.conversation, [priorContext("issue-tbm-outreach-close", seed.conversation, seedContinuity)]);
    const unsubscribeContinuity = continuityFor("issue-tbm-unsubscribe", unsubscribe.conversation, [priorContext("issue-tbm-outreach-close", seed.conversation, seedContinuity)]);

    expect(negativeContinuity.currentState).toBe("closed_not_interested");
    expect(negativeContinuity.followUp.status).toBe("closed_not_interested");
    expect(negativeContinuity.humanAttentionRequired).toBe(false);
    expect(unsubscribeContinuity.currentState).toBe("suppressed");
    expect(unsubscribeContinuity.followUp.status).toBe("suppressed");
    expect(unsubscribeContinuity.humanAttentionRequired).toBe(false);
  });

  it("keeps TherapistIndex listing removal clarification human-gated", () => {
    const removal = replayMessage({
      messageId: "ti-removal-thread@example.test",
      profileKey: "therapist-index-support",
      from: { name: "Dr. Elena Morris", address: "elena@example-clinic.test" },
      to: { name: "Support", address: "support@therapistindex.com" },
      subject: "TherapistIndex removal request",
      bodyText: "Listing: Elena Morris, LMFT\nListing URL: https://therapistindex.com/therapists/elena-morris\nRequest: Please remove my listing.",
    });
    const removalContinuity = continuityFor("issue-ti-removal", removal.conversation);
    const clarification = replayMessage({
      messageId: "ti-removal-clarification@example.test",
      profileKey: "therapist-index-support",
      from: { name: "Dr. Elena Morris", address: "elena@example-clinic.test" },
      to: { name: "Support", address: "support@therapistindex.com" },
      subject: "Re: TherapistIndex removal request",
      inReplyTo: "ti-removal-thread@example.test",
      references: ["ti-removal-thread@example.test"],
      bodyText: "Listing: Elena Morris, LMFT\nProfile URL: https://therapistindex.com/therapists/elena-morris\nRequested Change: I confirm the listing should be removed.",
    });
    const continuity = continuityFor("issue-ti-removal-clarification", clarification.conversation, [priorContext("issue-ti-removal", removal.conversation, removalContinuity)]);

    expect(continuity.linkage.status).toBe("deterministic");
    expect(continuity.transition.kind).toBe("information_received");
    expect(continuity.currentState).toBe("human_review");
    expect(continuity.humanAttentionRequired).toBe(true);
  });

  it("makes TherapistIndex claim identity reply review-ready but not auto-approved", () => {
    const claim = replayMessage({
      messageId: "ti-claim-thread@example.test",
      profileKey: "therapist-index-support",
      from: { name: "Mara Clinician", address: "mara@clinic.test" },
      to: { name: "Support", address: "support@therapistindex.com" },
      subject: "TherapistIndex profile ownership",
      bodyText: "Listing: Mara Quinn, LPC\nProfile URL: https://therapistindex.com/therapists/mara-quinn\nI own this profile and want to verify ownership.",
    });
    const claimContinuity = continuityFor("issue-ti-claim", claim.conversation);
    const identity = replayMessage({
      messageId: "ti-claim-identity@example.test",
      profileKey: "therapist-index-support",
      from: { name: "Mara Clinician", address: "mara@clinic.test" },
      to: { name: "Support", address: "support@therapistindex.com" },
      subject: "Re: TherapistIndex profile ownership",
      inReplyTo: "ti-claim-thread@example.test",
      references: ["ti-claim-thread@example.test"],
      bodyText: "Listing: Mara Quinn, LPC\nProfile URL: https://therapistindex.com/therapists/mara-quinn\nI can provide identity information to verify ownership.",
    });
    const continuity = continuityFor("issue-ti-claim-identity", identity.conversation, [priorContext("issue-ti-claim", claim.conversation, claimContinuity)]);

    expect(continuity.currentState).toBe("human_review");
    expect(continuity.transition.kind).toBe("information_received");
    expect(continuity.humanAttentionRequired).toBe(true);
    expect(identity.conversation.nextAction.humanApprovalRequired).toBe(true);
  });

  it("moves TherapistIndex positive outreach reply to human follow-up and unsubscribe to terminal suppression", () => {
    const outreach = replayMessage({
      messageId: "ti-outreach-thread@example.test",
      profileKey: "therapist-index-support",
      from: { name: "TherapistIndex", address: "support@therapistindex.com" },
      to: { name: "Therapist", address: "therapist@practice.test" },
      subject: "TherapistIndex outreach",
      bodyText: "TherapistIndex outreach to a practice.",
    });
    const outreachContinuity = seedWaiting(continuityFor("issue-ti-outreach", outreach.conversation));
    const positive = replayMessage({
      messageId: "ti-outreach-positive@example.test",
      profileKey: "therapist-index-support",
      from: { name: "Therapist", address: "therapist@practice.test" },
      to: { name: "TherapistIndex", address: "support@therapistindex.com" },
      subject: "Re: TherapistIndex outreach",
      inReplyTo: "ti-outreach-thread@example.test",
      references: ["ti-outreach-thread@example.test"],
      bodyText: "Yes, I am interested. Please send details about TherapistIndex.",
    });
    const unsubscribe = replayMessage({
      messageId: "ti-outreach-unsubscribe@example.test",
      profileKey: "therapist-index-support",
      from: { name: "Therapist", address: "therapist@practice.test" },
      to: { name: "TherapistIndex", address: "support@therapistindex.com" },
      subject: "Re: TherapistIndex outreach",
      inReplyTo: "ti-outreach-thread@example.test",
      references: ["ti-outreach-thread@example.test"],
      bodyText: "Please unsubscribe me from TherapistIndex emails. Do not contact me again.",
    });
    const positiveContinuity = continuityFor("issue-ti-positive", positive.conversation, [priorContext("issue-ti-outreach", outreach.conversation, outreachContinuity)]);
    const unsubscribeContinuity = continuityFor("issue-ti-unsubscribe", unsubscribe.conversation, [priorContext("issue-ti-outreach", outreach.conversation, outreachContinuity)]);

    expect(positiveContinuity.transition.kind).toBe("positive_response");
    expect(positiveContinuity.followUp.status).toBe("follow_up_due");
    expect(positiveContinuity.humanAttentionRequired).toBe(true);
    expect(unsubscribeContinuity.transition.kind).toBe("unsubscribe_suppressed");
    expect(unsubscribeContinuity.followUp.status).toBe("suppressed");
    expect(unsubscribeContinuity.humanAttentionRequired).toBe(false);
  });

  it("fails closed when deterministic linkage has multiple unrelated candidates", () => {
    const current = replayMessage({
      messageId: "ambiguous-current@example.test",
      profileKey: "thebinmap-info",
      from: { name: "Owner", address: "owner@ambiguous.test" },
      to: { name: "TheBinMap", address: "info@thebinmap.com" },
      subject: "Re: TheBinMap outreach",
      inReplyTo: "shared-prior@example.test",
      references: ["shared-prior@example.test"],
      bodyText: "Here is a correction for TheBinMap.",
    });
    const priorA = replayMessage({
      messageId: "prior-a@example.test",
      profileKey: "thebinmap-info",
      from: { name: "Owner A", address: "a@example.test" },
      to: { name: "TheBinMap", address: "info@thebinmap.com" },
      subject: "TheBinMap outreach",
      bodyText: "Store Name: A Store\nCity: Austin\nState: TX",
    });
    const priorB = replayMessage({
      messageId: "prior-b@example.test",
      profileKey: "thebinmap-info",
      from: { name: "Owner B", address: "b@example.test" },
      to: { name: "TheBinMap", address: "info@thebinmap.com" },
      subject: "TheBinMap outreach",
      bodyText: "Store Name: B Store\nCity: Boston\nState: MA",
    });
    priorA.conversation.threadContext.references.push("shared-prior@example.test");
    priorB.conversation.threadContext.references.push("shared-prior@example.test");

    const continuity = continuityFor("issue-ambiguous", current.conversation, [
      priorContext("issue-prior-a", priorA.conversation),
      priorContext("issue-prior-b", priorB.conversation),
    ]);

    expect(continuity.linkage.status).toBe("uncertain");
    expect(continuity.currentState).toBe("human_review");
    expect(continuity.humanAttentionRequired).toBe(true);
    expect(continuity.uncertaintyReasons.length).toBeGreaterThan(0);
  });

  it("reports continuity and outcome comparison metrics across replayed scenarios", () => {
    const first = replayMessage({
      messageId: "metrics-submit@example.test",
      profileKey: "thebinmap-submissions",
      from: { name: "Web3Forms", address: "notify@web3forms.com" },
      to: { name: "TheBinMap", address: "info@thebinmap.com" },
      subject: "New store submission — TheBinMap",
      bodyText: "Store Name: Metrics Store\nAddress: 9 Metrics Way\nCity: Nashville\nState: TN\nYour Email: metrics@example.test\nRestock Schedule: Fridays\nSent via https://thebinmap.com/",
    });
    const firstContinuity = continuityFor("issue-metrics-1", first.conversation, [], {
      kind: "acknowledged",
      evidence: "Historical operator prepared acknowledgment.",
    });
    const reply = replayMessage({
      messageId: "metrics-reply@example.test",
      profileKey: "thebinmap-submissions",
      from: { name: "Owner", address: "metrics@example.test" },
      to: { name: "TheBinMap", address: "info@thebinmap.com" },
      subject: "Re: New store submission — TheBinMap",
      inReplyTo: "metrics-submit@example.test",
      references: ["metrics-submit@example.test"],
      bodyText: "Correction for TheBinMap: add Saturday restock.",
    });
    const replyContinuity = continuityFor("issue-metrics-2", reply.conversation, [priorContext("issue-metrics-1", first.conversation, firstContinuity)], {
      kind: "closed",
      evidence: "Deliberately mismatched fixture outcome.",
    });
    const report = evaluateContinuityBatch([firstContinuity, replyContinuity]);

    expect(report.totalConversations).toBe(2);
    expect(report.newConversations).toBe(1);
    expect(report.linkedDeterministically).toBe(1);
    expect(report.inheritedEntityContext).toBe(1);
    expect(report.recommendationAgreement).toBe(1);
    expect(report.recommendationDisagreement).toBe(1);
    expect(report.outcomeUnknown).toBe(0);
  });
});
