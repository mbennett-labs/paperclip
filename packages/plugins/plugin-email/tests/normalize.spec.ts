import { describe, expect, it } from "vitest";
import {
  firstAddress,
  issueDescriptionFor,
  issueTitleFor,
  normalizeMessage,
  priorityFor,
  type MessageClassHint,
  type NormalizedMessage,
} from "../src/mail/normalize.js";

function makeEnv(fromAddr?: string, toAddr?: string) {
  return {
    messageId: "test-msg-1@example.com",
    from: fromAddr ? [{ name: "Test Sender", address: fromAddr }] : [{ name: "John Doe", address: "john@example.com" }],
    to: toAddr ? [{ name: "Receiver", address: toAddr }] : [{ name: "Support", address: "support@thebinmap.com" }],
    subject: "Test Subject",
    date: "2026-07-01T12:00:00.000Z",
    inReplyTo: "orig-msg@example.com",
    references: ["ref1@example.com", "ref2@example.com"],
    raw: "From: john@example.com\r\nTo: support@thebinmap.com\r\nSubject: Test Subject\r\n\r\n",
  };
}

const baseInput = {
  uid: 42,
  folder: "INBOX",
  profileKey: "primary",
  envelope: makeEnv(),
  bodyText: "Hello, this is a test message.\r\n",
};

describe("normalizeMessage", () => {
  it("produces a stable normalized identity", () => {
    const a = normalizeMessage(baseInput);
    const b = normalizeMessage(baseInput);
    expect(a.messageId).toBe("test-msg-1@example.com");
    expect(a.messageId).toBe(b.messageId);
    expect(a.evidenceId).toBe(b.evidenceId);
    expect(a.uid).toBe(42);
    expect(a.profileKey).toBe("primary");
  });

  it("falls back to a synthetic Message-ID when envelope.messageId is missing", () => {
    const input = {
      ...baseInput,
      envelope: { ...baseInput.envelope, messageId: undefined },
    };
    const msg = normalizeMessage(input);
    expect(msg.messageId).toMatch(/^uid-42@primary$/);
  });

  it("generates a stable SHA1 evidence ID from messageId:profileKey", () => {
    const a = normalizeMessage(baseInput);
    const b = normalizeMessage(baseInput);
    expect(a.evidenceId).toMatch(/^ev-[a-f0-9]{40}$/);
    // Same inputs produce identical evidence ID
    expect(a.evidenceId).toBe(b.evidenceId);
    // Different profileKey produces different evidence ID
    const c = normalizeMessage({ ...baseInput, profileKey: "extra-1" });
    expect(c.evidenceId).not.toBe(a.evidenceId);
  });

  it("preserves raw headers", () => {
    const msg = normalizeMessage(baseInput);
    expect(msg.rawHeaders).toBe("From: john@example.com\r\nTo: support@thebinmap.com\r\nSubject: Test Subject\r\n\r\n");
  });

  it("handles empty raw headers", () => {
    const input = {
      ...baseInput,
      envelope: { ...baseInput.envelope, raw: undefined },
    };
    const msg = normalizeMessage(input);
    expect(msg.rawHeaders).toBe("");
  });

  it("normalizes sender address via firstAddress", () => {
    const msg = normalizeMessage(baseInput);
    expect(msg.fromAddress).toBe("john@example.com");
  });

  it("truncates large body text", () => {
    const bigBody = "x".repeat(25000);
    const msg = normalizeMessage({ ...baseInput, bodyText: bigBody });
    expect(msg.bodyText).toContain("[truncated]");
    expect(msg.bodyText.length).toBeLessThan(bigBody.length);
  });

  it("generates a snippet of 280 chars max", () => {
    const longBody = "A".repeat(500);
    const msg = normalizeMessage({ ...baseInput, bodyText: longBody });
    expect(msg.snippet).toBe("A".repeat(280));
  });

  it("normalizes inReplyTo to string | null", () => {
    const msg = normalizeMessage(baseInput);
    expect(msg.inReplyTo).toBe("orig-msg@example.com");
  });

  it("normalizes references to string[]", () => {
    const msg = normalizeMessage(baseInput);
    expect(msg.references).toEqual(["ref1@example.com", "ref2@example.com"]);
  });
});

describe("classification (classify)", () => {
  function classifyMsg(subject: string, from: string, body: string): MessageClassHint {
    return normalizeMessage({
      ...baseInput,
      envelope: { ...makeEnv(from), subject },
      bodyText: body,
    }).classHint;
  }

  it("classifies store_submission from web3forms", () => {
    const result = classifyMsg(
      "Store Submission",
      "noreply@web3forms.com",
      "store name: Test Store\naddress: 123 Main St",
    );
    expect(result).toBe("store_submission");
  });

  it("classifies listing_claim", () => {
    const result = classifyMsg("claim this listing", "user@web3forms.com", "claim this listing and role: owner");
    expect(result).toBe("listing_claim");
  });

  it("classifies store_alert_signup", () => {
    const result = classifyMsg("Alert Signup", "user@example.com", "restock notification requested");
    expect(result).toBe("store_alert_signup");
  });

  it("classifies newsletter_signup", () => {
    const result = classifyMsg("Newsletter Signup", "user@example.com", "subscribe to stay in the loop");
    expect(result).toBe("newsletter_signup");
  });

  it("classifies intelligence_request", () => {
    const result = classifyMsg("Intelligence Report", "analyst@example.com", "intelligence request for data report");
    expect(result).toBe("intelligence_request");
  });

  it("classifies partnership_affiliate", () => {
    const result = classifyMsg("Partnership Opportunity", "partner@example.com", "wholesale supplier inquiry");
    expect(result).toBe("partnership_affiliate");
  });

  it("classifies contact_general", () => {
    const result = classifyMsg("Quick question", "friend@example.com", "hello, I have an inquiry");
    expect(result).toBe("contact_general");
  });

  it("classifies correction", () => {
    const result = classifyMsg("Correction needed", "user@example.com", "there is an error in the data");
    expect(result).toBe("correction");
  });

  it("classifies customer_inquiry", () => {
    const result = classifyMsg("Customer Question", "customer@example.com", "order #12345 status");
    expect(result).toBe("customer_inquiry");
  });

  it("classifies sales_opportunity", () => {
    const result = classifyMsg("Sales Lead", "lead@example.com", "great opportunity for partnership");
    expect(result).toBe("sales_opportunity");
  });

  it("classifies support_request", () => {
    const result = classifyMsg("Support Needed", "user@example.com", "I need help with my account");
    expect(result).toBe("support_request");
  });

  it("classifies spam_irrelevant", () => {
    const result = classifyMsg("Spam Offer", "spammer@example.com", "click here to unsubscribe");
    expect(result).toBe("spam_irrelevant");
  });

  it("falls back to unknown for unrecognized content", () => {
    const result = classifyMsg("Random Message", "rando@example.com", "just saying hi, nothing special here");
    expect(result).toBe("unknown");
  });
});

describe("venture routing (ventureOf)", () => {
  it("routes to thebinmap when To contains @thebinmap.com", () => {
    const msg = normalizeMessage({
      ...baseInput,
      envelope: makeEnv("sender@example.com", "ops@thebinmap.com"),
    });
    expect(msg.ventureHint).toBe("thebinmap");
  });

  it("routes to thebinmap when From is @thebinmap.com", () => {
    const msg = normalizeMessage({
      ...baseInput,
      envelope: makeEnv("user@thebinmap.com", "other@example.com"),
    });
    expect(msg.ventureHint).toBe("thebinmap");
  });

  it("routes to qsl when To contains @quantumshield or @qsl", () => {
    const msg = normalizeMessage({
      ...baseInput,
      envelope: makeEnv("sender@example.com", "ops@quantumshield.com"),
    });
    expect(msg.ventureHint).toBe("qsl");
  });

  it("falls back to unknown for unrecognized domains", () => {
    const msg = normalizeMessage({
      ...baseInput,
      envelope: makeEnv("sender@gmail.com", "recipient@gmail.com"),
    });
    expect(msg.ventureHint).toBe("unknown");
  });
});

describe("priorityFor", () => {
  it("returns high for intelligence_request", () => {
    expect(priorityFor("intelligence_request")).toBe("high");
  });

  it("returns high for listing_claim", () => {
    expect(priorityFor("listing_claim")).toBe("high");
  });

  it("returns low for spam_irrelevant", () => {
    expect(priorityFor("spam_irrelevant")).toBe("low");
  });

  it("returns medium for all other types", () => {
    expect(priorityFor("unknown")).toBe("medium");
    expect(priorityFor("store_submission")).toBe("high");
    expect(priorityFor("contact_general")).toBe("medium");
    expect(priorityFor("correction")).toBe("medium");
    expect(priorityFor("customer_inquiry")).toBe("medium");
    expect(priorityFor("sales_opportunity")).toBe("medium");
    expect(priorityFor("support_request")).toBe("medium");
    expect(priorityFor("partnership_affiliate")).toBe("medium");
    expect(priorityFor("store_alert_signup")).toBe("medium");
    expect(priorityFor("newsletter_signup")).toBe("medium");
  });
});

describe("issueTitleFor", () => {
  it("formats a standard title", () => {
    const msg = normalizeMessage(baseInput);
    const title = issueTitleFor(msg);
    expect(title).toContain("[Email:thebinmap]");
    expect(title).toContain("Test Subject");
    expect(title).toContain("John Doe <john@example.com>");
  });

  it("shortens long from name to address only", () => {
    const longFrom = "A".repeat(80) + " <long@example.com>";
    const msg: NormalizedMessage = {
      ...normalizeMessage(baseInput),
      from: longFrom,
      fromAddress: "long@example.com",
    };
    const title = issueTitleFor(msg);
    expect(title).toContain("long@example.com");
    // Should use address only, not the 80-char name
    expect(title).not.toContain("A".repeat(80));
  });
});

describe("issueDescriptionFor", () => {
  it("includes sender, subject, date, message-id, classHint, ventureHint", () => {
    const msg = normalizeMessage(baseInput);
    const desc = issueDescriptionFor(msg);
    expect(desc).toContain("**Subject:** Test Subject");
    expect(desc).toContain("**Date:** 2026-07-01T12:00:00.000Z");
    expect(desc).toContain("**Class hint:** `unknown`");
    expect(desc).toContain("**Venture hint:** `thebinmap`");
    expect(desc).toContain("**Evidence ref:**");
    // From and Message-ID are intentionally omitted from governed descriptions
    expect(desc).not.toContain("**From:**");
    expect(desc).not.toContain("**Message-ID:**");
  });

  it("includes body text for non-store messages", () => {
    const msg = normalizeMessage(baseInput);
    const desc = issueDescriptionFor(msg);
    expect(desc).toContain("Hello, this is a test message.");
  });

  it("includes triage SOP reference", () => {
    const msg = normalizeMessage(baseInput);
    const desc = issueDescriptionFor(msg);
    expect(desc).toContain("Triage per **email-triage-sop**");
  });

  it("does not instruct the agent to draft or send email", () => {
    const msg = normalizeMessage(baseInput);
    const desc = issueDescriptionFor(msg);
    expect(desc).not.toMatch(/draft.*reply/i);
    expect(desc).not.toMatch(/send.*email/i);
    expect(desc).toContain("Communications Drafter");
    expect(desc).toContain("only the Board sends");
  });
});

describe("firstAddress", () => {
  it("extracts email from simple address", () => {
    expect(firstAddress("john@example.com")).toBe("john@example.com");
  });

  it("extracts email from display-name format", () => {
    expect(firstAddress("John Doe <john@example.com>")).toBe("john@example.com");
  });

  it("returns empty string for invalid input", () => {
    expect(firstAddress("")).toBe("");
    expect(firstAddress("not an email")).toBe("");
  });

  it("lowercases the result", () => {
    expect(firstAddress("JOHN@EXAMPLE.COM")).toBe("john@example.com");
  });
});

describe("no outbound send in v1 flow", () => {
  it("normalizeMessage description has no send instructions", () => {
    const msg = normalizeMessage(baseInput);
    const desc = issueDescriptionFor(msg);
    // The description should route to Communications Drafter, not auto-send
    expect(desc).toContain("Never reply to the sender from this issue");
    expect(desc).not.toMatch(/\b(draft|compose|send)\s+(a|the)\s+(reply|email)\b/i);
  });

  it("sends are gated by Board action only", () => {
    const msg = normalizeMessage(baseInput);
    const desc = issueDescriptionFor(msg);
    expect(desc).toContain("only the Board sends");
  });
});