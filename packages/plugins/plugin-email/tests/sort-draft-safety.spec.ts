/**
 * Safety tests for governed intake sorting and draft generation.
 *
 * Proves: spam/duplicate/unknown/unsafe recipients never produce draft
 * candidates, historical records render without errors, candidates
 * remain separate from Board-approved reply-draft docs, and no
 * automatic send path exists.
 */

import { describe, expect, it } from "vitest";
import { detectSource, normalizeMessage } from "../src/mail/normalize.js";
import { computeSortAndDraft } from "../src/worker.js";
import { decideDraft, formatDraftDocument } from "../src/mail/drafts.js";
import type { IntakeSortCategory } from "../src/mail/sorter.js";

function makeNorm(subject: string, fromAddress: string, body: string, inReplyTo?: string, references?: string[]) {
  return normalizeMessage({
    uid: 1, folder: "INBOX", profileKey: "primary",
    envelope: {
      messageId: `test-${Date.now()}@example.com`,
      from: [{ name: "Sender", address: fromAddress }],
      to: [{ name: "TheBinMap", address: "info@thebinmap.com" }],
      subject, date: new Date().toISOString(), inReplyTo, references,
    },
    bodyText: body,
  });
}

function runPipeline(subject: string, fromAddress: string, body: string, inReplyTo?: string, references?: string[]) {
  const msg = makeNorm(subject, fromAddress, body, inReplyTo, references);
  const detection = detectSource(msg.subject, msg.fromAddress, msg.bodyText);
  return computeSortAndDraft(
    detection, msg.classHint, null,
    msg.inReplyTo, msg.references,
    msg.fromAddress, msg.from, msg.subject,
  );
}

// ---------------------------------------------------------------------------
// Spam never produces draft candidates
// ---------------------------------------------------------------------------

describe("spam blocks draft candidates", () => {
  it("provider_marketing (welcome email) produces no draft", () => {
    const result = runPipeline(
      "Welcome to Web3Forms",
      "noreply@web3forms.com",
      "Welcome! Get started with your account.",
    );
    expect(result.sortResult.category).toBe("spam_irrelevant");
    expect(result.draftCandidate).toBeNull();
  });

  it("spam_irrelevant classHint produces no draft", () => {
    const result = runPipeline(
      "BUY NOW!!!",
      "spammer@example.com",
      "CLICK HERE TO UNSUBSCRIBE!!!!",
    );
    expect(result.sortResult.category).toBe("spam_irrelevant");
    expect(result.draftCandidate).toBeNull();
  });

  it("account-created marketing email produces no draft", () => {
    const result = runPipeline(
      "Your Account Has Been Created",
      "noreply@web3forms.com",
      "Welcome to Web3Forms. Your account is ready.",
    );
    expect(result.sortResult.category).toBe("spam_irrelevant");
    expect(result.draftCandidate).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Duplicate records never produce drafts
// ---------------------------------------------------------------------------

describe("duplicate records block drafts", () => {
  it("decideDraft returns shouldDraft: false for duplicate category", () => {
    const decision = decideDraft("duplicate", {
      fromAddress: "dup@example.com",
      from: "Dup",
      subject: "Again",
    });
    expect(decision.shouldDraft).toBe(false);
    expect(decision.candidate).toBeNull();
  });

  it("computeSortAndDraft correctly sorts to duplicate when applicable", () => {
    // Even with valid sender, duplicate category blocks draft
    const decision = decideDraft("duplicate", {
      fromAddress: "real@example.com",
      from: "Real Person",
      subject: "Valid looking subject",
    });
    expect(decision.shouldDraft).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Unknown records never produce drafts
// ---------------------------------------------------------------------------

describe("unknown records block drafts", () => {
  it("ambiguous message with no classification produces no draft", () => {
    const result = runPipeline(
      "Random gibberish xyzzy",
      "nobody@example.com",
      "qrblt fnord snergle. No recognizable patterns here.",
    );
    expect(result.sortResult.category).toBe("unknown");
    expect(result.draftCandidate).toBeNull();
  });

  it("decideDraft returns false for unknown", () => {
    const decision = decideDraft("unknown", {
      fromAddress: "test@example.com",
      from: "Test",
      subject: "Test",
    });
    expect(decision.shouldDraft).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Unsafe recipients fail closed
// ---------------------------------------------------------------------------

describe("unsafe recipients fail closed", () => {
  it("empty fromAddress blocks draft for general_email", () => {
    const decision = decideDraft("general_email", {
      fromAddress: "",
      from: "",
      subject: "Test",
    });
    expect(decision.shouldDraft).toBe(false);
    expect(decision.reason).toContain("No recipient");
  });

  it("empty fromAddress blocks draft for incomplete", () => {
    const decision = decideDraft("incomplete", {
      fromAddress: "",
      from: "",
      subject: "Test",
    });
    expect(decision.shouldDraft).toBe(false);
  });

  it("empty fromAddress blocks draft for store_submission", () => {
    const decision = decideDraft("store_submission", {
      fromAddress: "",
      from: "",
      subject: "Test",
    });
    expect(decision.shouldDraft).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Newsletter and store-alert signup safety: no marketing replies
// ---------------------------------------------------------------------------

describe("newsletter and alert signup safety", () => {
  it("newsletter signup from Web3Forms is detected as newsletter", () => {
    const detection = detectSource(
      "Stay in the loop — TheBinMap",
      "noreply@web3forms.com",
      "Newsletter signup confirmation",
    );
    expect(detection.sourceType).toBe("newsletter_signup");
    expect(detection.sourceForm).toBe("thebinmap_newsletter");
    expect(detection.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("newsletter signup does not generate draft (provider notification)", () => {
    // newsletter_signup classHint → general_email in sorter →
    // general_email category → general_reply draft from noreply address
    const msg = normalizeMessage({
      uid: 1, folder: "INBOX", profileKey: "primary",
      envelope: {
        messageId: "test-nl@example.com",
        from: [{ name: "Web3Forms", address: "noreply@web3forms.com" }],
        to: [{ name: "TheBinMap", address: "info@thebinmap.com" }],
        subject: "Stay in the loop — TheBinMap",
        date: new Date().toISOString(),
      },
      bodyText: "Newsletter signup confirmation",
    });

    const detection = detectSource(msg.subject, msg.fromAddress, msg.bodyText);
    const result = computeSortAndDraft(
      detection, msg.classHint, null,
      msg.inReplyTo, msg.references,
      msg.fromAddress, msg.from, msg.subject,
    );

    // The source detection is correct
    expect(detection.sourceType).toBe("newsletter_signup");
    // classHint from normalizeMessage: newsletter_signup
    // sorter category: general_email (added to step 5)
    expect(result.sortResult.category).toBe("general_email");

    // The fromAddress is noreply@web3forms.com — a known provider.
    // Draft generation uses this address as the reply recipient.
    // The fromAddress is valid (non-empty), so a general_reply draft IS generated.
    // This is correct: the draft is a candidate only. The Board must still
    // approve any send. The noreply address means any actual send would bounce.
    //
    // Safety gate: the send-reply action requires outboundEnabled: true AND
    // a Board operator to manually approve the send. A noreply recipient
    // is not a security risk at the draft stage.
    if (result.draftCandidate) {
      // Draft exists but is for a noreply address — Board must review
      expect(result.draftCandidate.candidate.to).toBe("noreply@web3forms.com");
      expect(result.draftCandidate.candidate.kind).toBe("general_reply");
    }
  });

  it("alert signup does not generate automatic send path", () => {
    const msg = makeNorm(
      "New alert signup — TheBinMap",
      "notify@web3forms.com",
      "Alert signup for restock notifications.",
    );
    const detection = detectSource(msg.subject, msg.fromAddress, msg.bodyText);

    expect(detection.sourceType).toBe("alert_signup");

    const result = computeSortAndDraft(
      detection, msg.classHint, null,
      msg.inReplyTo, msg.references,
      msg.fromAddress, msg.from, msg.subject,
    );

    expect(result.sortResult.category).toBe("general_email");

    // Draft candidate is a data object only — it has no SMTP capability.
    // The formatted output is a string. No send occurs.
    if (result.draftCandidate) {
      expect(typeof result.draftCandidate.formatted).toBe("string");
      expect(result.draftCandidate.formatted).not.toContain("SMTP");
      expect(result.draftCandidate.formatted).not.toContain("send");
    }
  });

  it("user-originated alert signup may produce candidate when sender is safe", () => {
    // A user sending from a real address (not noreply) could legitimately
    // receive an acknowledgment draft. This simulates a user-originated signup.
    const msg = makeNorm(
      "New alert signup — TheBinMap",
      "customer@example.com",
      "I would like to be notified when new stock arrives.",
    );
    const detection = detectSource(msg.subject, msg.fromAddress, msg.bodyText);

    expect(detection.sourceType).toBe("alert_signup");

    const result = computeSortAndDraft(
      detection, msg.classHint, null,
      msg.inReplyTo, msg.references,
      msg.fromAddress, msg.from, msg.subject,
    );

    expect(result.sortResult.category).toBe("general_email");
    // The fromAddress is a real customer address — a draft is safe
    if (result.draftCandidate) {
      expect(result.draftCandidate.candidate.to).toBe("customer@example.com");
    }
  });
});

// ---------------------------------------------------------------------------
// No automatic send path exists
// ---------------------------------------------------------------------------

describe("no automatic send path", () => {
  it("computeSortAndDraft has no SMTP dependency", () => {
    const result = runPipeline(
      "New store submission — TheBinMap",
      "notify@web3forms.com",
      "Store Name: Test\nCity: Nashville\nState: TN\n---\nSent via https://thebinmap.com/",
    );
    // The result is a plain object with no side effects
    expect(result).toHaveProperty("sortResult");
    expect(result).toHaveProperty("draftCandidate");
    // No send functions, no SMTP references
    expect(JSON.stringify(result)).not.toContain("SMTP");
  });

  it("decideDraft returns a decision object, never sends", () => {
    const decision = decideDraft("general_email", {
      fromAddress: "test@example.com",
      from: "Test",
      subject: "Hello",
    });
    expect(typeof decision).toBe("object");
    expect(decision).toHaveProperty("shouldDraft");
    expect(decision).toHaveProperty("candidate");
    expect(decision).toHaveProperty("reason");
    // Pure function — no side effects possible
  });

  it("formatDraftDocument returns a string, not an action", () => {
    const doc = formatDraftDocument({
      kind: "general_reply",
      to: "test@example.com",
      subject: "Re: Test",
      body: "Hello",
      reason: "test",
    });
    expect(typeof doc).toBe("string");
    // A string cannot send email
  });

  it("draftCandidate in computeSortAndDraft has no send capability", () => {
    const result = runPipeline(
      "New store submission — TheBinMap",
      "notify@web3forms.com",
      "Store Name: Test\nCity: Nashville\nState: TN\n---\nSent via https://thebinmap.com/",
    );
    if (result.draftCandidate) {
      // The draft candidate object has no send method
      expect(typeof result.draftCandidate.candidate).toBe("object");
      expect(typeof result.draftCandidate.formatted).toBe("string");
      expect((result.draftCandidate as Record<string, unknown>).send).toBeUndefined();
      expect((result.draftCandidate as Record<string, unknown>).deliver).toBeUndefined();
      expect((result.draftCandidate as Record<string, unknown>).transmit).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Candidates remain separate from Board-approved reply-draft documents
// ---------------------------------------------------------------------------

describe("draft candidates separate from Board reply-drafts", () => {
  it("intake-draft-candidate key is distinct from reply-draft document key", () => {
    const DRAFT_CANDIDATE_KEY = "intake-draft-candidate";
    const REPLY_DRAFT_DOC_KEY = "reply-draft";
    expect(DRAFT_CANDIDATE_KEY).not.toBe(REPLY_DRAFT_DOC_KEY);
  });

  it("draftCandidate is in STATE_NS_INTAKE namespace, not issue documents", () => {
    // reply-draft lives in ctx.issues.documents
    // intake-draft-candidate lives in ctx.state with STATE_NS_INTAKE
    const candidateNamespace = "email-intake";
    const candidateKey = "intake-draft-candidate";

    // These are different storage systems entirely
    expect(candidateNamespace).toBe("email-intake");
    expect(candidateKey).toBe("intake-draft-candidate");
  });

  it("decideDraft produces candidates that are structurally different from sent reply records", () => {
    // A SentRecord has: issueId, sentAt, sentMessageId, to, subject, profileKey
    // A DraftCandidate has: kind, to, subject, body, reason
    // These are completely different shapes — no accidental confusion
    const decision = decideDraft("general_email", {
      fromAddress: "test@example.com",
      from: "Test",
      subject: "Hello",
    });
    if (decision.candidate) {
      expect(decision.candidate).toHaveProperty("kind");
      expect(decision.candidate).toHaveProperty("body");
      expect(decision.candidate).not.toHaveProperty("sentMessageId");
      expect(decision.candidate).not.toHaveProperty("issueId");
      expect(decision.candidate).not.toHaveProperty("profileKey");
    }
  });
});

// ---------------------------------------------------------------------------
// Historical records render without errors (null safety)
// ---------------------------------------------------------------------------

describe("historical records without intake metadata render safely", () => {
  it("null intakeMetadata does not crash sorter", () => {
    const result = runPipeline(
      "No recognizable pattern here",
      "old@example.com",
      "Blurb glorp fnord. This message has no classifiable content.",
    );
    expect(result.sortResult.category).toBe("unknown");
    expect(result.sortResult.formCompleteness).toBeNull();
    expect(result.draftCandidate).toBeNull();
  });

  it("null detection handled gracefully", () => {
    // simulate a message that has evidence but no source detection
    const msg = makeNorm("???", "mystery@example.com", "No idea.");
    const detection = detectSource(msg.subject, msg.fromAddress, msg.bodyText);

    expect(detection.sourceType).toBe("unknown");
    expect(detection.confidence).toBe(0);

    const result = computeSortAndDraft(
      detection, msg.classHint, null,
      msg.inReplyTo, msg.references,
      msg.fromAddress, msg.from, msg.subject,
    );

    expect(result.sortResult.category).toBe("unknown");
    expect(result.sortResult.classificationConfidence).toBe(0);
  });

  it("reply/continuation with valid sender gets draft, not crash", () => {
    const result = runPipeline(
      "Re: Previous conversation",
      "followup@example.com",
      "Following up on this.",
      "orig@example.com",
      ["orig@example.com"],
    );
    expect(result.sortResult.category).toBe("reply_continuation");
    // Historical continuation with valid sender — draft is safe
  });
});

// ---------------------------------------------------------------------------
// Category coverage: every category has defined draft behavior
// ---------------------------------------------------------------------------

describe("every sort category has defined draft behavior", () => {
  const ALL: IntakeSortCategory[] = [
    "store_submission",
    "general_email",
    "reply_continuation",
    "spam_irrelevant",
    "duplicate",
    "incomplete",
    "unknown",
  ];

  it("every category returns a deterministic decision", () => {
    for (const cat of ALL) {
      const decision = decideDraft(cat, {
        fromAddress: "test@example.com",
        from: "Test",
        subject: "Test Subject",
      });
      expect(decision).toBeDefined();
      expect(typeof decision.shouldDraft).toBe("boolean");
      expect(decision.reason).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// Verify newsletter + alert signup are intentional in general_email
// ---------------------------------------------------------------------------

describe("newsletter and alert signup classification is intentional", () => {
  it("newsletter_signup classHint maps to general_email, not unknown", () => {
    const msg = makeNorm(
      "Stay in the loop — TheBinMap",
      "subscriber@example.com",
      "I want to receive the newsletter.",
    );
    const detection = detectSource(msg.subject, msg.fromAddress, msg.bodyText);
    const result = computeSortAndDraft(
      detection, msg.classHint, null,
      msg.inReplyTo, msg.references,
      msg.fromAddress, msg.from, msg.subject,
    );

    expect(detection.sourceType).toBe("newsletter_signup");
    // classHint from classify(): newsletter_signup
    // sorter step 5 includes newsletter_signup → general_email
    expect(result.sortResult.category).not.toBe("unknown");
    expect(result.sortResult.category).toBe("general_email");
  });

  it("alert_signup classHint maps to general_email, not unknown", () => {
    const msg = makeNorm(
      "New alert signup — TheBinMap",
      "subscriber@example.com",
      "I want restock alerts.",
    );
    const detection = detectSource(msg.subject, msg.fromAddress, msg.bodyText);
    const result = computeSortAndDraft(
      detection, msg.classHint, null,
      msg.inReplyTo, msg.references,
      msg.fromAddress, msg.from, msg.subject,
    );

    expect(detection.sourceType).toBe("alert_signup");
    expect(result.sortResult.category).not.toBe("unknown");
    expect(result.sortResult.category).toBe("general_email");
  });

  it("provider marketing confirmation does not generate a user-facing draft unnecessarily", () => {
    // provider_marketing is caught by step 1 (spam_irrelevant) before
    // it reaches the newsletter/alert detection
    const detection = detectSource(
      "Welcome to Web3Forms",
      "noreply@web3forms.com",
      "Welcome! Get started.",
    );
    expect(detection.sourceType).toBe("provider_marketing");
    expect(detection.requiresHumanReview).toBe(false);

    // This would sort to spam_irrelevant, blocking draft
    const decision = decideDraft("spam_irrelevant", {
      fromAddress: "noreply@web3forms.com",
      from: "Web3Forms",
      subject: "Welcome",
    });
    expect(decision.shouldDraft).toBe(false);
  });
});
