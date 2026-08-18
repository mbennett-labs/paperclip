import { describe, expect, it } from "vitest";
import { createConversationRecord } from "../src/mail/conversation.js";
import { detectSource, extractStoreIntake, normalizeMessage } from "../src/mail/normalize.js";
import { sortIntakeRecord } from "../src/mail/sorter.js";
import { decideDraft } from "../src/mail/drafts.js";

function replay(input: {
  messageId: string;
  profileKey: string;
  from: { name: string; address: string };
  to: { name: string; address: string };
  subject: string;
  bodyText: string;
  inReplyTo?: string;
  references?: string[];
}) {
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

  return { msg, detection, sortResult, draftDecision, conversation };
}

describe("Directory Conversation Operator historical replay", () => {
  it("TherapistIndex removal/correction flows through to human-gated listing-change review", () => {
    const result = replay({
      messageId: "ti-removal-2026-08-18@example.test",
      profileKey: "therapist-index-support",
      from: { name: "TherapistIndex", address: "notify@therapistindex.com" },
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
    });

    expect(result.detection.brand).toBe("therapist_index");
    expect(result.detection.sourceType).toBe("correction");
    expect(result.sortResult.category).toBe("general_email");
    expect(result.conversation.tenant).toBe("therapist_index");
    expect(result.conversation.intent.category).toBe("listing_removal");
    expect(result.conversation.entityContext.entityType).toBe("therapist_listing");
    expect(result.conversation.entityContext.entityName).toBe("Elena Morris, LMFT");
    expect(result.conversation.state).toBe("human_review");
    expect(result.conversation.riskAuthorityClass).toBe("identity_sensitive_directory_change");
    expect(result.conversation.nextAction.kind).toBe("prepare_correction_claim_removal_workflow");
    expect(result.conversation.nextAction.humanApprovalRequired).toBe(true);
    expect(result.conversation.output.mode).toBe("draft");
    expect(result.conversation.evidenceRefs.some((ref) => ref.kind === "message")).toBe(true);
    expect(result.conversation.extraction.facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "requesterEmail", value: "elena@example-clinic.test" }),
        expect.objectContaining({ key: "listingUrl", value: "https://therapistindex.com/therapists/elena-morris" }),
      ]),
    );
  });

  it("TheBinMap store submission flows through extraction, action-ready state, and draft-only acknowledgment", () => {
    const result = replay({
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
        "---",
        "Sent via https://thebinmap.com/",
      ].join("\n"),
    });

    expect(result.detection.sourceForm).toBe("thebinmap_submit");
    expect(result.sortResult.category).toBe("store_submission");
    expect(result.conversation.tenant).toBe("thebinmap");
    expect(result.conversation.intent.category).toBe("store_submission");
    expect(result.conversation.entityContext.entityName).toBe("Fred's Bargain Barn");
    expect(result.conversation.entityContext.entityLocator).toBe("Nashville, TN");
    expect(result.conversation.state).toBe("action_ready");
    expect(result.conversation.nextAction.kind).toBe("acknowledge");
    expect(result.conversation.nextAction.humanApprovalRequired).toBe(false);
    expect(result.conversation.output.mode).toBe("draft");
    expect(result.conversation.output.draft?.kind).toBe("acknowledgment");
    expect(result.conversation.extraction.facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "storeName", value: "Fred's Bargain Barn" }),
        expect.objectContaining({ key: "submitterEmail", value: "owner@fredsbargainbarn.test" }),
      ]),
    );
  });

  it("TheBinMap owner correction remains human-gated before live directory data changes", () => {
    const result = replay({
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
        "Thanks, Riley",
      ].join("\n"),
    });

    expect(result.detection.brand).toBe("thebinmap");
    expect(result.sortResult.category).toBe("general_email");
    expect(result.conversation.intent.category).toBe("correction");
    expect(result.conversation.sender.relationship).toBe("owner_operator");
    expect(result.conversation.state).toBe("human_review");
    expect(result.conversation.riskAuthorityClass).toBe("directory_change");
    expect(result.conversation.nextAction.kind).toBe("prepare_correction_claim_removal_workflow");
    expect(result.conversation.nextAction.humanApprovalRequired).toBe(true);
    expect(result.conversation.output.mode).toBe("draft");
  });
});
