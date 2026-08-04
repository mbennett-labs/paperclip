import { describe, expect, it } from "vitest";
import {
  detectSource,
  extractStoreIntake,
  issueDescriptionFor,
  issueTitleFor,
  normalizeMessage,
  priorityFor,
  type NormalizedMessage,
  type StoreIntakeRecord,
} from "../src/mail/normalize.js";

function makeSubmitBody(fields: Record<string, string> = {}): string {
  const defaults: Record<string, string> = {
    "Store Name": fields["Store Name"] ?? "Sample Bin Store",
    "City": fields["City"] ?? "Nashville",
    "State": fields["State"] ?? "TN",
    "Address": fields["Address"] ?? "123 Main St",
    "Store Type": fields["Store Type"] ?? "bin-store",
    "Restock Schedule": fields["Restock Schedule"] ?? "Fridays",
    "Submitter Email": fields["Submitter Email"] ?? "owner@example.com",
  };
  const header = [
    `From: TheBinMap Submit Form <notify+xxxx@web3forms.com>`,
    `Subject: New store submission — TheBinMap`,
  ];
  const footer = [
    `---`,
    `Sent via https://thebinmap.com/`,
  ];
  const lines = header.slice();
  for (const [k, v] of Object.entries(defaults)) {
    lines.push(`${k}: ${v}`);
  }
  lines.push(...footer);
  return lines.join("\n");
}

function makeEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    messageId: overrides.messageId as string ?? "test-msg@example.com",
    from: overrides.from ?? [{ name: "Web3Forms", address: "notify@web3forms.com" }],
    to: overrides.to ?? [{ name: "TheBinMap", address: "info@thebinmap.com" }],
    subject: overrides.subject as string ?? "New store submission — TheBinMap",
    date: overrides.date as string ?? "2026-08-04T12:00:00.000Z",
    inReplyTo: overrides.inReplyTo as string | undefined,
    references: overrides.references as string[] | undefined,
    raw: overrides.raw as string | undefined,
  };
}

function makeNormalized(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    messageId: "test-msg@example.com",
    uid: 1,
    folder: "INBOX",
    profileKey: "primary",
    from: "Web3Forms <notify@web3forms.com>",
    fromAddress: "notify@web3forms.com",
    to: "TheBinMap <info@thebinmap.com>",
    subject: "New store submission — TheBinMap",
    date: "2026-08-04T12:00:00.000Z",
    inReplyTo: null,
    references: [],
    bodyText: makeSubmitBody(),
    snippet: "Sample Bin Store City: Nashville",
    classHint: "store_submission",
    ventureHint: "thebinmap",
    rawHeaders: "",
    evidenceId: "ev-test",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Source detection tests
// ---------------------------------------------------------------------------

describe("detectSource — deterministic form-source detection", () => {
  const web3 = "notify@web3forms.com";

  it("identifies TheBinMap /submit by exact subject line", () => {
    const r = detectSource("New store submission — TheBinMap", web3, makeSubmitBody());
    expect(r.sourceType).toBe("store_submission");
    expect(r.sourceForm).toBe("thebinmap_submit");
    expect(r.sourcePage).toBe("/submit");
    expect(r.confidence).toBeGreaterThanOrEqual(0.9);
    expect(r.evidence.length).toBeGreaterThan(0);
  });

  it("identifies TheBinMap /claim by exact subject line", () => {
    const r = detectSource("Listing claim — TheBinMap", web3, "role: owner\nclaim this listing");
    expect(r.sourceType).toBe("listing_claim");
    expect(r.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("identifies TheBinMap /contact by exact subject line", () => {
    const r = detectSource("Contact form — TheBinMap", web3, "hello testing");
    expect(r.sourceType).toBe("contact");
  });

  it("detects Web3Forms + store-submission subject pattern (fuzzy match)", () => {
    const r = detectSource("New store submission", web3, "store name, city");
    expect(r.sourceType).toBe("store_submission");
    expect(r.sourceForm).toBe("thebinmap_submit");
    expect(r.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it("detects by body field names + TheBinMap footer", () => {
    const body = "Store Name: Test Store\n\n---\nSent via https://thebinmap.com/";
    const r = detectSource("Form submission", "someone@gmail.com", body);
    expect(r.sourceType).toBe("store_submission");
    expect(r.sourceForm).toBe("thebinmap_submit");
    expect(r.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it("detects by body field combination (store name + city + restock)", () => {
    const body = "Store Name: Test\nCity: Nashville\nRestock Schedule: Fridays";
    const r = detectSource("Hello", "someone@gmail.com", body);
    expect(r.sourceType).toBe("store_submission");
    expect(r.sourceForm).toBe("thebinmap_submit");
  });

  it("returns unknown for ordinary email mentioning 'store'", () => {
    const r = detectSource("Nice store!", "friend@gmail.com", "I visited a store yesterday.");
    expect(r.sourceType).toBe("unknown");
    expect(r.sourceForm).toBe("unknown");
  });

  it("returns unknown for Gmail welcome email", () => {
    const r = detectSource("Three tips to get the most out of Gmail", "mail-noreply@google.com", "Welcome to Gmail");
    expect(r.sourceType).toBe("unknown");
  });

  it("returns unknown for empty subject and body", () => {
    const r = detectSource("", "test@test.com", "");
    expect(r.sourceType).toBe("unknown");
  });

  it("returns unknown for non-matching Web3Forms mail", () => {
    const r = detectSource("Some alert", "notify+xxx@web3forms.com", "restock alert for some site");
    expect(r.sourceType).toBe("unknown");
  });

  it("detects by TheBinMap sender display name + footer", () => {
    const body = "Store Name: Test\n\n---\nSent via https://thebinmap.com/";
    const r = detectSource("Hello", "notify+abc@web3forms.com", body);
    expect(r.sourceType).toBe("store_submission");
    expect(r.sourceForm).toBe("thebinmap_submit");
    expect(r.confidence).toBeGreaterThan(0.7);
  });

  // ---------------------------------------------------------------------------
  // Classifier tightening tests (Deliverable 7)
  // ---------------------------------------------------------------------------

  it("does NOT classify generic Web3Forms 'thebinmap' mention as store_submission", () => {
    const r = detectSource(
      "Thanks for your interest",
      "notify@web3forms.com",
      "Someone mentioned thebinmap.com on our website."
    );
    expect(r.sourceType).not.toBe("store_submission");
    expect(r.sourceType).toBe("unknown");
  });

  it("does NOT classify generic Web3Forms 'store' mention as store_submission", () => {
    const r = detectSource(
      "A store just applied",
      "notify@web3forms.com",
      "We found a new store near thebinmap area."
    );
    expect(r.sourceType).not.toBe("store_submission");
  });

  it("exact known store-submission subject remains correct", () => {
    const r = detectSource(
      "New store submission — TheBinMap",
      "notify@web3forms.com",
      makeSubmitBody(),
    );
    expect(r.sourceType).toBe("store_submission");
    expect(r.sourceForm).toBe("thebinmap_submit");
    expect(r.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("contact form is distinguishable from store submission", () => {
    const r = detectSource(
      "Contact form — TheBinMap",
      "notify@web3forms.com",
      "Hello, I have a question about TheBinMap."
    );
    expect(r.sourceType).toBe("contact");
    expect(r.sourceType).not.toBe("store_submission");
  });

  it("listing claim is distinguishable from store submission", () => {
    const r = detectSource(
      "Listing claim — TheBinMap",
      "notify@web3forms.com",
      "role: owner\nclaim this listing for TheBinMap store."
    );
    expect(r.sourceType).toBe("listing_claim");
    expect(r.sourceType).not.toBe("store_submission");
  });

  it("alert signup is NOT classified as store_submission", () => {
    const r = detectSource(
      "Restock Alert - TheBinMap",
      "notify@web3forms.com",
      "notify me when this item is back in stock"
    );
    expect(r.sourceType).not.toBe("store_submission");
  });

  it("waitlist signup is NOT classified as store_submission", () => {
    const r = detectSource(
      "Stay in the loop",
      "notify@web3forms.com",
      "subscribe to our newsletter about TheBinMap"
    );
    expect(r.sourceType).not.toBe("store_submission");
  });

  it("Web3Forms + explicit 'store submission' in subject IS classified correctly", () => {
    const r = detectSource(
      "store submission for new location",
      "notify@web3forms.com",
      "Store Name: Test\nAddress: 123 Main"
    );
    expect(r.sourceType).toBe("store_submission");
    expect(r.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it("generic TheBinMap mentions alone are insufficient", () => {
    const r = detectSource(
      "Hello",
      "friend@gmail.com",
      "I love shopping at TheBinMap stores"
    );
    expect(r.sourceType).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// Store-intake extraction tests
// ---------------------------------------------------------------------------

describe("extractStoreIntake", () => {
  it("returns null for non-store_submission detection", () => {
    const detection = detectSource("hello", "test@test.com", "plain body");
    const msg = makeNormalized({ subject: "hello", bodyText: "plain body" });
    expect(extractStoreIntake(msg, detection, "THE-1")).toBeNull();
  });

  it("extracts store name from submit body", () => {
    const body = makeSubmitBody({ "Store Name": "Bargain Bin Bonanza" });
    const detection = detectSource("New store submission — TheBinMap", "notify@web3forms.com", body);
    const msg = makeNormalized({ bodyText: body });
    const record = extractStoreIntake(msg, detection, "THE-1");
    expect(record).not.toBeNull();
    expect(record!.originalValues.storeName).toBe("Bargain Bin Bonanza");
  });

  it("extracts city from submit body", () => {
    const body = makeSubmitBody({ "City": "Memphis" });
    const detection = detectSource("New store submission — TheBinMap", "notify@web3forms.com", body);
    const msg = makeNormalized({ bodyText: body });
    const record = extractStoreIntake(msg, detection, "THE-1");
    expect(record!.originalValues.city).toBe("Memphis");
  });

  it("detects state abbreviation in body", () => {
    const body = makeSubmitBody({ "State": "FL" });
    const detection = detectSource("New store submission — TheBinMap", "notify@web3forms.com", body);
    const msg = makeNormalized({ bodyText: body });
    const record = extractStoreIntake(msg, detection, "THE-1");
    expect(record!.originalValues.state.toUpperCase()).toBe("FL");
  });

  it("reports missing fields", () => {
    const body = "Store Name: Test Only\n\nThat is all.";
    const detection = detectSource("New store submission — TheBinMap", "notify@web3forms.com", body);
    expect(detection.sourceType).toBe("store_submission");
    const msg = makeNormalized({ bodyText: body });
    const record = extractStoreIntake(msg, detection, "THE-1");
    expect(record!.missingFields.length).toBeGreaterThan(0);
    expect(record!.missingFields).toContain("city");
    expect(record!.missingFields).toContain("state");
  });

  it("includes original and normalized values", () => {
    const body = makeSubmitBody({ "Store Name": '"The Best" Store' });
    const detection = detectSource("New store submission — TheBinMap", "notify@web3forms.com", body);
    const msg = makeNormalized({ bodyText: body });
    const record = extractStoreIntake(msg, detection, "THE-1");
    expect(record!.originalValues.storeName).toContain('"The Best"');
    expect(record!.normalizedValues.storeName).toBe("'The Best' Store");
  });
});

// ---------------------------------------------------------------------------
// Integration: issue description includes source detection and intake
// ---------------------------------------------------------------------------

describe("issueDescriptionFor with source detection", () => {
  it("includes source detection in issue description", () => {
    const body = makeSubmitBody();
    const env = makeEnvelope({ subject: "New store submission — TheBinMap" });
    const msg = normalizeMessage({ uid: 1, folder: "INBOX", profileKey: "primary", envelope: env, bodyText: body });
    const desc = issueDescriptionFor(msg);
    expect(desc).toContain("store_submission");
    expect(desc).toContain("thebinmap_submit");
    expect(desc).toContain("/submit");
  });

  it("includes store intake record in issue description", () => {
    const body = makeSubmitBody({ "Store Name": "Test Store" });
    const env = makeEnvelope({ subject: "New store submission — TheBinMap" });
    const msg = normalizeMessage({ uid: 1, folder: "INBOX", profileKey: "primary", envelope: env, bodyText: body });
    const desc = issueDescriptionFor(msg);
    expect(desc).toContain("Store Intake Record");
    expect(desc).toContain("Test Store");
    expect(desc).toContain("needs_review");
    expect(desc).toContain("Operational summary");
    // Raw body should not appear in governed intake descriptions
    expect(desc).not.toContain("Submitted By");
    expect(desc).not.toContain("**From:**");
    expect(desc).not.toContain("**Message-ID:**");
  });

  it("does not include intake for non-store messages", () => {
    const env = makeEnvelope({ subject: "Hello", from: [{ name: "Friend", address: "friend@test.com" }] });
    const msg = normalizeMessage({ uid: 1, folder: "INBOX", profileKey: "primary", envelope: env, bodyText: "Hi there" });
    const desc = issueDescriptionFor(msg);
    expect(desc).not.toContain("Store Intake Record");
  });
});

// ---------------------------------------------------------------------------
// Title with source prefix
// ---------------------------------------------------------------------------

describe("issueTitleFor", () => {
  it("prefixes store submissions with [Store Submission]", () => {
    const body = makeSubmitBody();
    const env = makeEnvelope({ subject: "New store submission — TheBinMap" });
    const msg = normalizeMessage({ uid: 1, folder: "INBOX", profileKey: "primary", envelope: env, bodyText: body });
    const title = issueTitleFor(msg);
    expect(title).toContain("[Store Submission]");
  });

  it("prefixes listing claims with [Listing Claim]", () => {
    const env = makeEnvelope({ subject: "Listing claim — TheBinMap" });
    const msg = normalizeMessage({ uid: 1, folder: "INBOX", profileKey: "primary", envelope: env, bodyText: "claim body" });
    const title = issueTitleFor(msg);
    expect(title).toContain("[Listing Claim]");
  });
});

// ---------------------------------------------------------------------------
// Priority: store_submission gets 'high'
// ---------------------------------------------------------------------------

describe("priorityFor — store submission elevated", () => {
  it("store_submission is high priority", () => {
    expect(priorityFor("store_submission")).toBe("high");
  });

  it("listing_claim is high priority", () => {
    expect(priorityFor("listing_claim")).toBe("high");
  });

  it("unknown is medium priority", () => {
    expect(priorityFor("unknown")).toBe("medium");
  });
});
