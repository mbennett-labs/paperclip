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

  // --- Alert signup detection ---

  it("identifies alert signup by exact subject line", () => {
    const r = detectSource(
      "New alert signup — TheBinMap",
      "notify@web3forms.com",
      "notify me when restocked"
    );
    expect(r.sourceType).toBe("alert_signup");
    expect(r.sourceForm).toBe("thebinmap_alert");
    expect(r.brand).toBe("thebinmap");
    expect(r.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("identifies alert signup with store-specific subject", () => {
    const r = detectSource(
      "Alert signup — Nashville Bin Store",
      "notify@web3forms.com",
      "I want to be notified"
    );
    expect(r.sourceType).toBe("alert_signup");
    expect(r.sourceForm).toBe("thebinmap_alert");
  });

  // --- Newsletter detection ---

  it("identifies newsletter signup by exact subject line", () => {
    const r = detectSource(
      "Stay in the loop — TheBinMap",
      "notify@web3forms.com",
      "subscribe me to the newsletter"
    );
    expect(r.sourceType).toBe("newsletter_signup");
    expect(r.brand).toBe("thebinmap");
  });

  // --- Marketing exclusion ---

  it("classifies Web3Forms 'Welcome' as provider_marketing", () => {
    const r = detectSource(
      "Welcome to Web3Forms",
      "noreply@web3forms.com",
      "Thanks for signing up for Web3Forms"
    );
    expect(r.sourceType).toBe("provider_marketing");
  });

  it("classifies Formspree 'Get Started' as provider_marketing", () => {
    const r = detectSource(
      "Getting started with Formspree",
      "noreply@formspree.io",
      "Here are some tips for using Formspree"
    );
    expect(r.sourceType).toBe("provider_marketing");
  });

  it("classifies Web3Forms 'Verify Email' as provider_marketing", () => {
    const r = detectSource(
      "Verify your email",
      "no-reply@web3forms.com",
      "Please confirm your email address"
    );
    expect(r.sourceType).toBe("provider_marketing");
  });

  it("classifies Web3Forms 'Upgrade' as provider_marketing", () => {
    const r = detectSource(
      "Upgrade to Pro",
      "noreply@web3forms.com",
      "Upgrade your Web3Forms account"
    );
    expect(r.sourceType).toBe("provider_marketing");
  });

  it("Web3Forms non-marketing email without form-submission signals stays unknown", () => {
    const r = detectSource(
      "Some alert",
      "notify+xxx@web3forms.com",
      "restock alert for some site"
    );
    expect(r.sourceType).toBe("unknown");
    expect(r.sourceType).not.toBe("store_submission");
    expect(r.sourceType).not.toBe("provider_marketing");
  });

  // --- QSL Security Review Request ---

  it("identifies QSL Security Review Request", () => {
    const r = detectSource(
      "QSL Security Review Request",
      "submissions@formspree.io",
      "name: John Doe\ncompany: Acme Inc\nmessage: Please review our security posture"
    );
    expect(r.sourceType).toBe("qsl_security_review");
    expect(r.sourceForm).toBe("qsl_security_review_form");
    expect(r.brand).toBe("qsl");
    expect(r.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("identifies QSL Security Review from body mention with Formspree sender", () => {
    const r = detectSource(
      "New submission",
      "noreply@formspree.io",
      "security review requested for company XYZ"
    );
    expect(r.sourceType).toBe("qsl_security_review");
  });

  // --- QSL Risk Calculator ---

  it("identifies QSL Risk Calculator Lead by exact subject", () => {
    const r = detectSource(
      "QSL Risk Calculator - New Lead",
      "submissions@formspree.io",
      "risk_score: 78\nrisk_level: high\nname: Jane Smith\nemail: jane@example.com\ncompany: Corp Inc\ntitle: CTO\norg_type: enterprise"
    );
    expect(r.sourceType).toBe("qsl_risk_calculator");
    expect(r.sourceForm).toBe("qsl_risk_calc");
    expect(r.brand).toBe("qsl");
    expect(r.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("identifies QSL Risk Calculator from body risk_score field", () => {
    const r = detectSource(
      "New Lead Notification",
      "noreply@formspree.io",
      "risk_score: 45\nassessment_answers: [yes, no, yes]\nname: Test User"
    );
    expect(r.sourceType).toBe("qsl_risk_calculator");
  });

  // --- Formspree marketing exclusion ---

  it("Formspree 'Tips' email is provider_marketing not QSL lead", () => {
    const r = detectSource(
      "Tips and tricks for your forms",
      "noreply@formspree.io",
      "Learn how to make the most of your Formspree forms"
    );
    expect(r.sourceType).toBe("provider_marketing");
    expect(r.sourceType).not.toBe("qsl_risk_calculator");
  });

  it("Formspree 'Account Created' is provider_marketing not a lead", () => {
    const r = detectSource(
      "Your account has been created",
      "noreply@formspree.io",
      "Welcome to Formspree"
    );
    expect(r.sourceType).toBe("provider_marketing");
  });

  // --- TherapistIndex ---

  it("identifies TherapistIndex brand from subject prefix", () => {
    const r = detectSource(
      "TherapistIndex: New contact form submission",
      "notify@therapistindex.com",
      "A user has submitted a contact request"
    );
    expect(r.brand).toBe("therapist_index");
    expect(r.sourceForm).toBe("therapist_index");
  });

  it("identifies TherapistIndex correction/removal request", () => {
    const r = detectSource(
      "TherapistIndex - Correction request",
      "provider@therapistindex.com",
      "Please remove my listing, the information is wrong"
    );
    expect(r.brand).toBe("therapist_index");
    expect(r.sourceForm).toBe("therapist_index");
  });

  it("identifies TherapistIndex account activation", () => {
    const r = detectSource(
      "TherapistIndex - Account activated",
      "noreply@therapistindex.com",
      "Your account has been activated"
    );
    expect(r.brand).toBe("therapist_index");
  });

  it("identifies TherapistIndex moderation notification", () => {
    const r = detectSource(
      "TherapistIndex moderation notification",
      "noreply@therapistindex.com",
      "A new listing requires moderation"
    );
    expect(r.brand).toBe("therapist_index");
  });

  it("identifies TherapistIndex SEO notification", () => {
    const r = detectSource(
      "TherapistIndex SEO update",
      "noreply@therapistindex.com",
      "Your SEO settings have been updated"
    );
    expect(r.brand).toBe("therapist_index");
  });

  it("TherapistIndex is not classified as Formspree or Web3Forms", () => {
    const r = detectSource(
      "TherapistIndex - New message",
      "notify@wordpress.com",
      "A therapist has sent you a message"
    );
    expect(r.brand).toBe("therapist_index");
    expect(r.sourceForm).not.toBe("qsl_risk_calc");
    expect(r.sourceForm).not.toBe("qsl_security_review_form");
  });

  // --- Brand detection ---

  it("brand is correctly assigned for TheBinMap", () => {
    const r = detectSource(
      "New store submission — TheBinMap",
      "notify@web3forms.com",
      "store name: Test\ncity: Nashville"
    );
    expect(r.brand).toBe("thebinmap");
  });

  it("brand is correctly assigned for QSL", () => {
    const r = detectSource(
      "QSL Risk Calculator - New Lead",
      "submissions@formspree.io",
      "risk_score: 50"
    );
    expect(r.brand).toBe("qsl");
  });

  it("brand is correctly assigned for TherapistIndex", () => {
    const r = detectSource(
      "[TherapistIndex] Account notification",
      "noreply@therapistindex.com",
      "Your account settings have changed"
    );
    expect(r.brand).toBe("therapist_index");
  });

  it("brand is unknown for ordinary email without brand signals", () => {
    const r = detectSource(
      "Hello",
      "someone@gmail.com",
      "Just saying hello"
    );
    expect(r.brand).toBe("unknown");
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
