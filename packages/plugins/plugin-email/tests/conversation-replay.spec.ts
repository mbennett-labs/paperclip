import { describe, expect, it } from "vitest";
import { createShadowEvaluation, evaluateConversationBatch } from "../src/mail/conversation-evaluation.js";
import { createConversationRecord, type StructuredConversationRecord } from "../src/mail/conversation.js";
import { decideDraft } from "../src/mail/drafts.js";
import { detectSource, extractStoreIntake, normalizeMessage } from "../src/mail/normalize.js";
import { sortIntakeRecord } from "../src/mail/sorter.js";

type ReplayCase = {
  name: string;
  messageId: string;
  profileKey: string;
  from: { name: string; address: string };
  to: { name: string; address: string };
  subject: string;
  bodyText: string;
  inReplyTo?: string;
  references?: string[];
  expected: {
    tenant: StructuredConversationRecord["tenant"];
    intent: string;
    state: StructuredConversationRecord["state"];
    nextAction: StructuredConversationRecord["nextAction"]["kind"];
    humanAttention: boolean;
    shadowAction: ReturnType<typeof createShadowEvaluation>["shadowActionKind"];
  };
};

function replay(input: ReplayCase) {
  const msg = normalizeMessage({
    uid: 1,
    folder: "INBOX",
    profileKey: input.profileKey,
    envelope: {
      messageId: input.messageId,
      from: [input.from],
      to: [input.to],
      subject: input.subject,
      date: "2026-08-18T14:00:00.000Z",
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

  return { msg, detection, sortResult, draftDecision, conversation, shadow };
}

const cases: ReplayCase[] = [
  {
    name: "TheBinMap new store submission",
    messageId: "tbm-submit-2026-08-18@example.test",
    profileKey: "thebinmap-submissions",
    from: { name: "Web3Forms", address: "notify@web3forms.com" },
    to: { name: "TheBinMap", address: "info@thebinmap.com" },
    subject: "New store submission — TheBinMap",
    bodyText: [
      "From: TheBinMap Submit Form <notify+xxxx@web3forms.com>",
      "Subject: New store submission — TheBinMap",
      "Store Name: Fred's Bargain Barn",
      "Address: 101 Outlet Way",
      "City: Nashville",
      "State: TN",
      "Your Email: owner@fredsbargainbarn.test",
      "Restock Schedule: Fridays",
      "Notes: New location, owner confirms public listing is welcome.",
      "Sent via https://thebinmap.com/",
    ].join("\n"),
    expected: {
      tenant: "thebinmap",
      intent: "store_submission",
      state: "action_ready",
      nextAction: "acknowledge",
      humanAttention: false,
      shadowAction: "would_acknowledge",
    },
  },
  {
    name: "TheBinMap owner correction",
    messageId: "tbm-correction-2026-08-18@example.test",
    profileKey: "thebinmap-info",
    from: { name: "Riley Owner", address: "riley@binowner.test" },
    to: { name: "TheBinMap", address: "info@thebinmap.com" },
    subject: "Correction for TheBinMap listing",
    bodyText: [
      "Hi, I own Fred's Bargain Barn and need to update our listing on TheBinMap.",
      "Store Name: Fred's Bargain Barn",
      "City: Nashville",
      "State: TN",
      "Requested Change: the phone number should be 615-555-0199 and restocks are now Saturdays.",
    ].join("\n"),
    expected: {
      tenant: "thebinmap",
      intent: "correction",
      state: "human_review",
      nextAction: "prepare_correction_claim_removal_workflow",
      humanAttention: true,
      shadowAction: "would_prepare_listing_review",
    },
  },
  {
    name: "TheBinMap listing claim",
    messageId: "tbm-claim-2026-08-18@example.test",
    profileKey: "thebinmap-info",
    from: { name: "Store Manager", address: "manager@claimstore.test" },
    to: { name: "TheBinMap", address: "info@thebinmap.com" },
    subject: "Listing claim — TheBinMap",
    bodyText: "I own this listing. Store Name: Claim Store. City: Austin. State: TX. Please verify ownership.",
    expected: {
      tenant: "thebinmap",
      intent: "listing_claim",
      state: "human_review",
      nextAction: "prepare_correction_claim_removal_workflow",
      humanAttention: true,
      shadowAction: "would_prepare_listing_review",
    },
  },
  {
    name: "TheBinMap general owner inquiry",
    messageId: "tbm-owner-general-2026-08-18@example.test",
    profileKey: "thebinmap-info",
    from: { name: "Jordan Operator", address: "jordan@operator.test" },
    to: { name: "TheBinMap", address: "info@thebinmap.com" },
    subject: "Contact form — TheBinMap",
    bodyText: "I operate a bin store and have a question about how TheBinMap verifies owner-submitted hours.",
    expected: {
      tenant: "thebinmap",
      intent: "contact",
      state: "response_ready",
      nextAction: "acknowledge",
      humanAttention: true,
      shadowAction: "would_acknowledge",
    },
  },
  {
    name: "TheBinMap intelligence waitlist no reply",
    messageId: "tbm-intel-2026-08-18@example.test",
    profileKey: "thebinmap-info",
    from: { name: "Web3Forms", address: "notify@web3forms.com" },
    to: { name: "TheBinMap", address: "info@thebinmap.com" },
    subject: "Intelligence waitlist signup",
    bodyText: "Email: buyer@example.test\nSource: Intelligence Page\nTheBinMap intelligence signup.",
    expected: {
      tenant: "thebinmap",
      intent: "intelligence_signup",
      state: "suppressed",
      nextAction: "no_action",
      humanAttention: false,
      shadowAction: "would_suppress",
    },
  },
  {
    name: "TheBinMap alert signup no reply",
    messageId: "tbm-alert-2026-08-18@example.test",
    profileKey: "thebinmap-info",
    from: { name: "Web3Forms", address: "notify@web3forms.com" },
    to: { name: "TheBinMap", address: "info@thebinmap.com" },
    subject: "New alert signup — TheBinMap",
    bodyText: "Email: shopper@example.test\nsource homepage\nNotify me about new stores in Memphis.",
    expected: {
      tenant: "thebinmap",
      intent: "store_alert_signup",
      state: "suppressed",
      nextAction: "no_action",
      humanAttention: false,
      shadowAction: "would_suppress",
    },
  },
  {
    name: "TheBinMap commercial supplier inquiry",
    messageId: "tbm-commercial-2026-08-18@example.test",
    profileKey: "thebinmap-info",
    from: { name: "Supplier Rep", address: "sales@supplier.test" },
    to: { name: "TheBinMap", address: "info@thebinmap.com" },
    subject: "Supplier partnership for TheBinMap",
    bodyText: "We can partner with TheBinMap on wholesale supplier pricing and paid placement packages.",
    expected: {
      tenant: "thebinmap",
      intent: "partnership_affiliate",
      state: "response_ready",
      nextAction: "prepare_commercial_response",
      humanAttention: true,
      shadowAction: "would_surface_commercial_opportunity",
    },
  },
  {
    name: "TheBinMap irrelevant provider marketing",
    messageId: "tbm-spam-2026-08-18@example.test",
    profileKey: "thebinmap-info",
    from: { name: "Web3Forms", address: "news@web3forms.com" },
    to: { name: "TheBinMap", address: "info@thebinmap.com" },
    subject: "Welcome to Web3Forms",
    bodyText: "Upgrade your plan and read these tips and tricks.",
    expected: {
      tenant: "thebinmap",
      intent: "spam_irrelevant",
      state: "closed_not_interested",
      nextAction: "suppress_close",
      humanAttention: false,
      shadowAction: "would_suppress",
    },
  },
  {
    name: "TherapistIndex listing removal",
    messageId: "ti-removal-2026-08-18@example.test",
    profileKey: "therapist-index-support",
    from: { name: "Dr. Elena Morris", address: "elena@example-clinic.test" },
    to: { name: "Support", address: "support@therapistindex.com" },
    subject: "TherapistIndex - Correction request",
    bodyText: [
      "Name: Dr. Elena Morris",
      "Email: elena@example-clinic.test",
      "Listing: Elena Morris, LMFT",
      "Listing URL: https://therapistindex.com/therapists/elena-morris",
      "Request: Please remove my listing. I am not accepting referrals and the phone number is wrong.",
      "Reason: I did not authorize this page.",
    ].join("\n"),
    expected: {
      tenant: "therapist_index",
      intent: "listing_removal",
      state: "human_review",
      nextAction: "prepare_correction_claim_removal_workflow",
      humanAttention: true,
      shadowAction: "would_prepare_listing_review",
    },
  },
  {
    name: "TherapistIndex listing correction",
    messageId: "ti-correction-2026-08-18@example.test",
    profileKey: "therapist-index-support",
    from: { name: "Practice Admin", address: "admin@practice.test" },
    to: { name: "Support", address: "support@therapistindex.com" },
    subject: "TherapistIndex correction",
    bodyText: "Listing: North River Therapy\nListing URL: https://therapistindex.com/p/north-river\nRequested Change: the address is wrong and needs to be updated.",
    expected: {
      tenant: "therapist_index",
      intent: "correction",
      state: "human_review",
      nextAction: "prepare_correction_claim_removal_workflow",
      humanAttention: true,
      shadowAction: "would_prepare_listing_review",
    },
  },
  {
    name: "TherapistIndex profile ownership claim",
    messageId: "ti-claim-2026-08-18@example.test",
    profileKey: "therapist-index-support",
    from: { name: "Mara Clinician", address: "mara@clinic.test" },
    to: { name: "Support", address: "support@therapistindex.com" },
    subject: "TherapistIndex profile ownership",
    bodyText: "Listing: Mara Quinn, LPC\nProfile URL: https://therapistindex.com/therapists/mara-quinn\nI own this profile and want to verify ownership.",
    expected: {
      tenant: "therapist_index",
      intent: "listing_claim",
      state: "human_review",
      nextAction: "prepare_correction_claim_removal_workflow",
      humanAttention: true,
      shadowAction: "would_prepare_listing_review",
    },
  },
  {
    name: "TherapistIndex practice inquiry",
    messageId: "ti-practice-inquiry-2026-08-18@example.test",
    profileKey: "therapist-index-support",
    from: { name: "Group Practice", address: "hello@grouppractice.test" },
    to: { name: "Support", address: "support@therapistindex.com" },
    subject: "TherapistIndex: New contact form submission",
    bodyText: "Our group practice is looking for information about joining TherapistIndex.",
    expected: {
      tenant: "therapist_index",
      intent: "contact",
      state: "response_ready",
      nextAction: "acknowledge",
      humanAttention: true,
      shadowAction: "would_acknowledge",
    },
  },
  {
    name: "TherapistIndex positive response to outreach",
    messageId: "ti-positive-2026-08-18@example.test",
    profileKey: "therapist-index-support",
    from: { name: "Interested Therapist", address: "yes@practice.test" },
    to: { name: "Support", address: "support@therapistindex.com" },
    subject: "Re: TherapistIndex outreach",
    inReplyTo: "prior-outreach@example.test",
    references: ["prior-outreach@example.test"],
    bodyText: "Yes, I am interested. Sounds good - please send details about TherapistIndex.",
    expected: {
      tenant: "therapist_index",
      intent: "positive_response",
      state: "response_ready",
      nextAction: "prepare_follow_up",
      humanAttention: true,
      shadowAction: "would_prepare_follow_up",
    },
  },
  {
    name: "TherapistIndex negative not interested response",
    messageId: "ti-negative-2026-08-18@example.test",
    profileKey: "therapist-index-support",
    from: { name: "No Thanks", address: "no@practice.test" },
    to: { name: "Support", address: "support@therapistindex.com" },
    subject: "Re: TherapistIndex outreach",
    inReplyTo: "prior-outreach@example.test",
    references: ["prior-outreach@example.test"],
    bodyText: "No thanks, I am not interested in TherapistIndex right now.",
    expected: {
      tenant: "therapist_index",
      intent: "negative_not_interested",
      state: "closed_not_interested",
      nextAction: "no_action",
      humanAttention: false,
      shadowAction: "would_suppress",
    },
  },
  {
    name: "TherapistIndex unsubscribe request",
    messageId: "ti-unsubscribe-2026-08-18@example.test",
    profileKey: "therapist-index-support",
    from: { name: "Unsubscribe Me", address: "stop@practice.test" },
    to: { name: "Support", address: "support@therapistindex.com" },
    subject: "Re: TherapistIndex outreach",
    bodyText: "Please unsubscribe me and remove me from your email list. Do not contact me again.",
    expected: {
      tenant: "therapist_index",
      intent: "unsubscribe",
      state: "suppressed",
      nextAction: "suppress_close",
      humanAttention: false,
      shadowAction: "would_suppress",
    },
  },
  {
    name: "TherapistIndex ambiguous high-risk listing change",
    messageId: "ti-ambiguous-2026-08-18@example.test",
    profileKey: "therapist-index-support",
    from: { name: "Concerned Clinician", address: "clinician@legal.test" },
    to: { name: "Support", address: "support@therapistindex.com" },
    subject: "TherapistIndex urgent correction",
    bodyText: "There is wrong license information on your site and this is a legal issue. Update all my data immediately.",
    expected: {
      tenant: "therapist_index",
      intent: "correction",
      state: "response_ready",
      nextAction: "request_missing_information",
      humanAttention: true,
      shadowAction: "would_request_information",
    },
  },
];

describe("Directory Conversation Operator historical replay", () => {
  it.each(cases)("$name flows through classification, extraction, policy, and shadow output", (fixture) => {
    const result = replay(fixture);

    expect(result.conversation.tenant).toBe(fixture.expected.tenant);
    expect(result.conversation.intent.category).toBe(fixture.expected.intent);
    expect(result.conversation.state).toBe(fixture.expected.state);
    expect(result.conversation.nextAction.kind).toBe(fixture.expected.nextAction);
    expect(result.shadow.humanAttentionRequired).toBe(fixture.expected.humanAttention);
    expect(result.shadow.shadowActionKind).toBe(fixture.expected.shadowAction);
    expect(result.conversation.evidenceRefs.some((ref) => ref.kind === "message")).toBe(true);
    expect(result.conversation.evidenceRefs.some((ref) => ref.kind === "evidence")).toBe(true);
  });

  it("preserves representative structured facts for the first two real case classes", () => {
    const therapistRemoval = replay(cases.find((c) => c.name === "TherapistIndex listing removal")!);
    const binMapSubmission = replay(cases.find((c) => c.name === "TheBinMap new store submission")!);

    expect(therapistRemoval.detection.brand).toBe("therapist_index");
    expect(therapistRemoval.conversation.entityContext.entityName).toBe("Elena Morris, LMFT");
    expect(therapistRemoval.conversation.extraction.facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "requesterEmail", value: "elena@example-clinic.test" }),
        expect.objectContaining({ key: "listingUrl", value: "https://therapistindex.com/therapists/elena-morris" }),
      ]),
    );

    expect(binMapSubmission.detection.sourceForm).toBe("thebinmap_submit");
    expect(binMapSubmission.sortResult.category).toBe("store_submission");
    expect(binMapSubmission.conversation.entityContext.entityName).toBe("Fred's Bargain Barn");
    expect(binMapSubmission.conversation.entityContext.entityLocator).toBe("Nashville, TN");
    expect(binMapSubmission.conversation.extraction.facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "storeName", value: "Fred's Bargain Barn" }),
        expect.objectContaining({ key: "submitterEmail", value: "owner@fredsbargainbarn.test" }),
      ]),
    );
  });

  it("reports bounded batch metrics for shadow evaluation", () => {
    const records = cases.map((fixture) => replay(fixture).conversation);
    const report = evaluateConversationBatch(records);

    expect(report.totalConversations).toBe(16);
    expect(report.byTenant.thebinmap).toBe(8);
    expect(report.byTenant.therapist_index).toBe(8);
    expect(report.byTenant.unknown ?? 0).toBe(0);
    expect(report.byShadowActionKind.would_prepare_listing_review).toBe(5);
    expect(report.byShadowActionKind.would_suppress).toBe(5);
    expect(report.byShadowActionKind.would_surface_commercial_opportunity).toBe(1);
    expect(report.humanAttentionRequired).toBe(10);
    expect(report.noHumanAttentionRequired).toBe(6);
    expect(report.commercialSignal).toBe(1);
    expect(report.missingInformation).toBe(1);
    expect(report.metrics.conversationRecordCreated).toBe(16);
    expect(report.metrics.noHumanAction).toBe(6);
    expect(report.metrics.humanReview).toBe(10);
    expect(report.metrics.draftReady).toBeGreaterThanOrEqual(4);
    expect(report.shadowActions.every((action) => action.mode === "shadow_only")).toBe(true);
  });
});
