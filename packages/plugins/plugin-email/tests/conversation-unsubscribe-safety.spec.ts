import { describe, expect, it } from "vitest";
import { createShadowEvaluation } from "../src/mail/conversation-evaluation.js";
import { decideConversationPolicy } from "../src/mail/conversation-policies.js";
import { createConversationRecord } from "../src/mail/conversation.js";
import { decideDraft } from "../src/mail/drafts.js";
import { detectSource, extractStoreIntake, normalizeMessage } from "../src/mail/normalize.js";
import { sortIntakeRecord } from "../src/mail/sorter.js";

type MessageFixture = {
  subject: string;
  bodyText: string;
  from?: { name: string; address: string };
  to?: { name: string; address: string };
  inReplyTo?: string;
  references?: string[];
};

function replay(input: MessageFixture) {
  const msg = normalizeMessage({
    uid: 1,
    folder: "INBOX",
    profileKey: "thebinmap-info",
    envelope: {
      messageId: `${input.subject.toLowerCase().replace(/[^a-z0-9]+/g, "-")}@example.test`,
      from: [input.from ?? { name: "Sender", address: "sender@example.test" }],
      to: [input.to ?? { name: "TheBinMap", address: "info@thebinmap.com" }],
      subject: input.subject,
      date: "2026-08-19T12:00:00.000Z",
      inReplyTo: input.inReplyTo,
      references: input.references,
    },
    bodyText: input.bodyText,
  });
  const detection = detectSource(msg.subject, msg.fromAddress, msg.bodyText);
  const storeIntake = extractStoreIntake(msg, detection, "issue-unsubscribe-safety");
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

  return { msg, detection, sortResult, conversation, shadow };
}

describe("Conversation Operator unsubscribe safety", () => {
  it("does not infer unsubscribe from a routine marketing newsletter footer", () => {
    const result = replay({
      subject: "The Best Truckload Deals of the Week!",
      from: { name: "Liquidation Deals", address: "buying@liquidation.example" },
      bodyText: [
        "This week's truckload deals are live.",
        "Shop pallets, returns, and closeouts today.",
        "",
        "You received this newsletter because you subscribed to deals.",
        "Unsubscribe: https://liquidation.example/unsubscribe?id=abc123",
      ].join("\n"),
    });

    expect(result.conversation.intent.category).not.toBe("unsubscribe");
    expect(result.conversation.intent.confidence).toBe(0);
    expect(result.conversation.state).toBe("human_review");
    expect(result.conversation.nextAction.kind).toBe("escalate_to_human");
    expect(result.shadow.humanAttentionRequired).toBe(true);
    expect(result.shadow.shadowActionKind).toBe("would_escalate");
  });

  it("preserves explicit unsubscribe requests", () => {
    const result = replay({
      subject: "Re: TheBinMap outreach",
      bodyText: "Please unsubscribe me from your emails.",
      inReplyTo: "prior-outreach@example.test",
      references: ["prior-outreach@example.test"],
    });

    expect(result.conversation.intent.category).toBe("unsubscribe");
    expect(result.conversation.state).toBe("suppressed");
    expect(result.conversation.nextAction.kind).toBe("suppress_close");
    expect(result.shadow.humanAttentionRequired).toBe(false);
  });

  it("preserves explicit do-not-contact requests", () => {
    const result = replay({
      subject: "Re: TheBinMap outreach",
      bodyText: "Do not contact me again.",
      inReplyTo: "prior-outreach@example.test",
      references: ["prior-outreach@example.test"],
    });

    expect(result.conversation.intent.category).toBe("unsubscribe");
    expect(result.conversation.state).toBe("suppressed");
    expect(result.conversation.nextAction.kind).toBe("suppress_close");
    expect(result.shadow.humanAttentionRequired).toBe(false);
  });

  it("routes ambiguous unsubscribe-like content to human review", () => {
    const result = replay({
      subject: "Question about email preferences",
      bodyText: "Where is the unsubscribe link supposed to be?",
    });

    expect(result.conversation.intent.category).not.toBe("unsubscribe");
    expect(result.conversation.state).toBe("human_review");
    expect(result.conversation.riskAuthorityClass).toBe("uncertain");
    expect(result.conversation.nextAction.kind).toBe("escalate_to_human");
    expect(result.shadow.humanAttentionRequired).toBe(true);
  });

  it("fails closed for a low-confidence general email before any autonomous policy branch", () => {
    const decision = decideConversationPolicy({
      tenant: "thebinmap",
      sourceType: "unknown",
      sortCategory: "general_email",
      intent: "unknown",
      hasEntityMatch: false,
      missingInformation: [],
      hasDraftCandidate: true,
      commercialSignal: false,
      confidence: 0,
    });

    expect(decision.state).toBe("human_review");
    expect(decision.riskAuthorityClass).toBe("uncertain");
    expect(decision.draftPolicy).toBe("human_gate");
    expect(decision.nextAction.kind).toBe("escalate_to_human");
    expect(decision.nextAction.humanApprovalRequired).toBe(true);
  });
});
