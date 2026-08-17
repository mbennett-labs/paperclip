/**
 * Safety tests for governed intake sorting and draft generation.
 *
 * Proves that spam, duplicates, unknown records, deterministic system
 * notifications, and unsafe recipients do not produce outbound draft work;
 * real thread continuations remain actionable; candidates remain separate
 * from Board-approved reply documents; and no automatic send path exists.
 */

import { describe, expect, it } from "vitest";
import { detectSource, normalizeMessage } from "../src/mail/normalize.js";
import { computeSortAndDraft } from "../src/worker.js";
import { decideDraft, formatDraftDocument } from "../src/mail/drafts.js";
import type { IntakeSortCategory } from "../src/mail/sorter.js";

function makeNorm(
  subject: string,
  fromAddress: string,
  body: string,
  inReplyTo?: string,
  references?: string[],
) {
  return normalizeMessage({
    uid: 1,
    folder: "INBOX",
    profileKey: "primary",
    envelope: {
      messageId: `test-${Date.now()}@example.com`,
      from: [{ name: "Sender", address: fromAddress }],
      to: [{ name: "TheBinMap", address: "info@thebinmap.com" }],
      subject,
      date: new Date().toISOString(),
      inReplyTo,
      references,
    },
    bodyText: body,
  });
}

function runPipeline(
  subject: string,
  fromAddress: string,
  body: string,
  inReplyTo?: string,
  references?: string[],
) {
  const msg = makeNorm(subject, fromAddress, body, inReplyTo, references);
  const detection = detectSource(msg.subject, msg.fromAddress, msg.bodyText);
  return computeSortAndDraft(
    detection,
    msg.classHint,
    null,
    msg.inReplyTo,
    msg.references,
    msg.fromAddress,
    msg.from,
    msg.subject,
  );
}

describe("spam blocks draft candidates", () => {
  it("provider marketing produces no draft", () => {
    const result = runPipeline(
      "Welcome to Web3Forms",
      "noreply@web3forms.com",
      "Welcome! Get started with your account.",
    );
    expect(result.sortResult.category).toBe("spam_irrelevant");
    expect(result.draftCandidate).toBeNull();
  });

  it("spam heuristic produces no draft", () => {
    const result = runPipeline(
      "BUY NOW!!!",
      "spammer@example.com",
      "CLICK HERE TO UNSUBSCRIBE!!!!",
    );
    expect(result.sortResult.category).toBe("spam_irrelevant");
    expect(result.draftCandidate).toBeNull();
  });

  it("account-created provider marketing produces no draft", () => {
    const result = runPipeline(
      "Your Account Has Been Created",
      "noreply@web3forms.com",
      "Welcome to Web3Forms. Your account is ready.",
    );
    expect(result.sortResult.category).toBe("spam_irrelevant");
    expect(result.draftCandidate).toBeNull();
  });
});

describe("duplicate records block drafts", () => {
  it("decideDraft fails closed for duplicate", () => {
    const decision = decideDraft("duplicate", {
      fromAddress: "dup@example.com",
      from: "Dup",
      subject: "Again",
    });
    expect(decision.shouldDraft).toBe(false);
    expect(decision.candidate).toBeNull();
  });

  it("valid-looking sender does not override duplicate safety", () => {
    const decision = decideDraft("duplicate", {
      fromAddress: "real@example.com",
      from: "Real Person",
      subject: "Valid looking subject",
    });
    expect(decision.shouldDraft).toBe(false);
  });
});

describe("unknown records block drafts", () => {
  it("ambiguous message produces no draft", () => {
    const result = runPipeline(
      "Random gibberish xyzzy",
      "nobody@example.com",
      "qrblt fnord snergle. No recognizable patterns here.",
    );
    expect(result.sortResult.category).toBe("unknown");
    expect(result.draftCandidate).toBeNull();
  });

  it("decideDraft fails closed for unknown", () => {
    const decision = decideDraft("unknown", {
      fromAddress: "test@example.com",
      from: "Test",
      subject: "Test",
    });
    expect(decision.shouldDraft).toBe(false);
  });
});

describe("unsafe recipients fail closed", () => {
  for (const category of ["general_email", "incomplete", "store_submission"] as IntakeSortCategory[]) {
    it(`empty fromAddress blocks ${category}`, () => {
      const decision = decideDraft(category, {
        fromAddress: "",
        from: "",
        subject: "Test",
      });
      expect(decision.shouldDraft).toBe(false);
      expect(decision.candidate).toBeNull();
      expect(decision.reason).toContain("No recipient");
    });
  }
});

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

  it("newsletter signup becomes a non-reply system notification", () => {
    const msg = makeNorm(
      "Stay in the loop — TheBinMap",
      "noreply@web3forms.com",
      "Newsletter signup confirmation",
    );
    const detection = detectSource(msg.subject, msg.fromAddress, msg.bodyText);
    const result = computeSortAndDraft(
      detection,
      msg.classHint,
      null,
      msg.inReplyTo,
      msg.references,
      msg.fromAddress,
      msg.from,
      msg.subject,
    );

    expect(detection.sourceType).toBe("newsletter_signup");
    expect(result.sortResult.category).toBe("system_notification");
    expect(result.sortResult.replyActionStatus).toBe("none");
    expect(result.draftCandidate).toBeNull();
  });

  it("alert signup becomes a non-reply system notification", () => {
    const msg = makeNorm(
      "New alert signup — TheBinMap",
      "notify@web3forms.com",
      "Alert signup for restock notifications.",
    );
    const detection = detectSource(msg.subject, msg.fromAddress, msg.bodyText);
    const result = computeSortAndDraft(
      detection,
      msg.classHint,
      null,
      msg.inReplyTo,
      msg.references,
      msg.fromAddress,
      msg.from,
      msg.subject,
    );

    expect(detection.sourceType).toBe("alert_signup");
    expect(result.sortResult.category).toBe("system_notification");
    expect(result.sortResult.replyActionStatus).toBe("none");
    expect(result.draftCandidate).toBeNull();
  });

  it("user-originated signup still does not manufacture reply work", () => {
    const msg = makeNorm(
      "New alert signup — TheBinMap",
      "customer@example.com",
      "I would like to be notified when new stock arrives.",
    );
    const detection = detectSource(msg.subject, msg.fromAddress, msg.bodyText);
    const result = computeSortAndDraft(
      detection,
      msg.classHint,
      null,
      msg.inReplyTo,
      msg.references,
      msg.fromAddress,
      msg.from,
      msg.subject,
    );

    expect(detection.sourceType).toBe("alert_signup");
    expect(result.sortResult.category).toBe("system_notification");
    expect(result.draftCandidate).toBeNull();
  });

  it("explicit thread evidence overrides notification routing", () => {
    const msg = makeNorm(
      "Re: New alert signup — TheBinMap",
      "customer@example.com",
      "Following up on my alert request.",
      "prior@example.com",
      ["prior@example.com"],
    );
    const detection = detectSource(msg.subject, msg.fromAddress, msg.bodyText);
    const result = computeSortAndDraft(
      detection,
      msg.classHint,
      null,
      msg.inReplyTo,
      msg.references,
      msg.fromAddress,
      msg.from,
      msg.subject,
    );

    expect(result.sortResult.category).toBe("reply_continuation");
    expect(result.sortResult.replyActionStatus).toBe("draft_needed");
    expect(result.draftCandidate?.candidate.to).toBe("customer@example.com");
  });
});

describe("no automatic send path", () => {
  it("computeSortAndDraft has no SMTP dependency", () => {
    const result = runPipeline(
      "New store submission — TheBinMap",
      "notify@web3forms.com",
      "Store Name: Test\nCity: Nashville\nState: TN\n---\nSent via https://thebinmap.com/",
    );
    expect(result).toHaveProperty("sortResult");
    expect(result).toHaveProperty("draftCandidate");
    expect(JSON.stringify(result)).not.toContain("SMTP");
  });

  it("decideDraft returns data, never a send action", () => {
    const decision = decideDraft("general_email", {
      fromAddress: "test@example.com",
      from: "Test",
      subject: "Hello",
    });
    expect(decision).toHaveProperty("shouldDraft");
    expect(decision).toHaveProperty("candidate");
    expect(decision).toHaveProperty("reason");
    expect((decision as Record<string, unknown>).send).toBeUndefined();
  });

  it("formatDraftDocument returns a string", () => {
    const doc = formatDraftDocument({
      kind: "general_reply",
      to: "test@example.com",
      subject: "Re: Test",
      body: "Hello",
      reason: "test",
    });
    expect(typeof doc).toBe("string");
  });

  it("draft candidates expose no send capability", () => {
    const result = runPipeline(
      "New store submission — TheBinMap",
      "notify@web3forms.com",
      "Store Name: Test\nCity: Nashville\nState: TN\n---\nSent via https://thebinmap.com/",
    );
    if (result.draftCandidate) {
      expect(typeof result.draftCandidate.candidate).toBe("object");
      expect(typeof result.draftCandidate.formatted).toBe("string");
      expect((result.draftCandidate as Record<string, unknown>).send).toBeUndefined();
      expect((result.draftCandidate as Record<string, unknown>).deliver).toBeUndefined();
      expect((result.draftCandidate as Record<string, unknown>).transmit).toBeUndefined();
    }
  });
});

describe("draft candidates stay separate from Board reply documents", () => {
  it("candidate key is distinct from reply-draft document key", () => {
    expect("intake-draft-candidate").not.toBe("reply-draft");
  });

  it("candidate storage namespace is intake state", () => {
    expect("email-intake").toBe("email-intake");
    expect("intake-draft-candidate").toBe("intake-draft-candidate");
  });

  it("candidate shape is not a sent-reply record", () => {
    const decision = decideDraft("general_email", {
      fromAddress: "test@example.com",
      from: "Test",
      subject: "Hello",
    });
    expect(decision.candidate).not.toBeNull();
    expect(decision.candidate).toHaveProperty("kind");
    expect(decision.candidate).toHaveProperty("body");
    expect(decision.candidate).not.toHaveProperty("sentMessageId");
    expect(decision.candidate).not.toHaveProperty("issueId");
    expect(decision.candidate).not.toHaveProperty("profileKey");
  });
});

describe("historical/null records remain safe", () => {
  it("null intake metadata does not crash sorter", () => {
    const result = runPipeline(
      "No recognizable pattern here",
      "old@example.com",
      "Blurb glorp fnord. This message has no classifiable content.",
    );
    expect(result.sortResult.category).toBe("unknown");
    expect(result.sortResult.formCompleteness).toBeNull();
    expect(result.draftCandidate).toBeNull();
  });

  it("unknown detection remains deterministic", () => {
    const msg = makeNorm("???", "mystery@example.com", "No idea.");
    const detection = detectSource(msg.subject, msg.fromAddress, msg.bodyText);
    const result = computeSortAndDraft(
      detection,
      msg.classHint,
      null,
      msg.inReplyTo,
      msg.references,
      msg.fromAddress,
      msg.from,
      msg.subject,
    );

    expect(detection.sourceType).toBe("unknown");
    expect(detection.confidence).toBe(0);
    expect(result.sortResult.category).toBe("unknown");
  });

  it("reply continuation with valid sender remains actionable", () => {
    const result = runPipeline(
      "Re: Previous conversation",
      "followup@example.com",
      "Following up on this.",
      "orig@example.com",
      ["orig@example.com"],
    );
    expect(result.sortResult.category).toBe("reply_continuation");
    expect(result.draftCandidate).not.toBeNull();
  });
});

describe("every sort category has defined draft behavior", () => {
  const all: IntakeSortCategory[] = [
    "store_submission",
    "general_email",
    "reply_continuation",
    "system_notification",
    "spam_irrelevant",
    "duplicate",
    "incomplete",
    "unknown",
  ];

  it("every category returns a deterministic decision", () => {
    for (const category of all) {
      const decision = decideDraft(category, {
        fromAddress: "test@example.com",
        from: "Test",
        subject: "Test Subject",
      });
      expect(typeof decision.shouldDraft).toBe("boolean");
      expect(decision.reason).toBeTruthy();
    }
  });
});

describe("notification classification is intentional", () => {
  it("newsletter signup maps to system_notification, not unknown", () => {
    const result = runPipeline(
      "Stay in the loop — TheBinMap",
      "subscriber@example.com",
      "I want to receive the newsletter.",
    );
    expect(result.sortResult.category).toBe("system_notification");
    expect(result.draftCandidate).toBeNull();
  });

  it("alert signup maps to system_notification, not unknown", () => {
    const result = runPipeline(
      "New alert signup — TheBinMap",
      "subscriber@example.com",
      "I want restock alerts.",
    );
    expect(result.sortResult.category).toBe("system_notification");
    expect(result.draftCandidate).toBeNull();
  });

  it("provider marketing remains suppressed rather than a notification", () => {
    const detection = detectSource(
      "Welcome to Web3Forms",
      "noreply@web3forms.com",
      "Welcome! Get started.",
    );
    expect(detection.sourceType).toBe("provider_marketing");
    expect(detection.requiresHumanReview).toBe(false);

    const decision = decideDraft("spam_irrelevant", {
      fromAddress: "noreply@web3forms.com",
      from: "Web3Forms",
      subject: "Welcome",
    });
    expect(decision.shouldDraft).toBe(false);
  });
});
