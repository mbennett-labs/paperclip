/**
 * Synthetic intake message fixtures for regression testing.
 *
 * Covers all 11 required scenarios per the governed intake contract.
 * All data is synthetic — no real customer email addresses, credentials,
 * provider IDs, or private message bodies.
 */

import type { NormalizedMessage, SourceDetection } from "../../src/mail/normalize.js";
import type { IntakeMetadata } from "../../src/mail/intake-metadata.js";
import type { IntakeSortCategory } from "../../src/mail/sorter.js";
import type { DraftDecision } from "../../src/mail/drafts.js";

// ---------------------------------------------------------------------------
// Fixture result contract
// ---------------------------------------------------------------------------

export interface SorterFixture {
  id: string;
  description: string;
  msg: Partial<NormalizedMessage>;
  detection: SourceDetection | null;
  metadata: IntakeMetadata | null;
  duplicateMatchStrength: string | null;
  latestVerdict: string | null;
  hasReplyDraft: boolean;
  expectedCategory: IntakeSortCategory;
  expectedReplyActionStatus: string;
  expectedDraftShouldGenerate: boolean;
}

export interface DraftFixture {
  id: string;
  description: string;
  sortCategory: IntakeSortCategory;
  fromAddress: string;
  from: string;
  subject: string;
  expectedShouldDraft: boolean;
  expectedDraftKind: string | null;
  expectedContainsText: string[];
  expectedNotContainsText: string[];
}

// ---------------------------------------------------------------------------
// Helper: build a base message object
// ---------------------------------------------------------------------------

function msg(overrides: Partial<NormalizedMessage> = {}): Partial<NormalizedMessage> {
  return {
    messageId: "test-msg@example.com",
    uid: 1,
    folder: "INBOX",
    profileKey: "primary",
    from: "Test Sender <sender@example.com>",
    fromAddress: "sender@example.com",
    to: "TheBinMap <info@thebinmap.com>",
    subject: "Test Subject",
    date: "2026-08-10T12:00:00.000Z",
    inReplyTo: null,
    references: [],
    bodyText: "Test body content.",
    snippet: "Test body content.",
    classHint: "unknown",
    ventureHint: "thebinmap",
    rawHeaders: "",
    evidenceId: "ev-test",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Source detection fixtures
// ---------------------------------------------------------------------------

function storeSubmitDetection(): SourceDetection {
  return {
    sourceType: "store_submission",
    sourceForm: "thebinmap_submit",
    sourcePage: "/submit",
    brand: "thebinmap",
    confidence: 0.95,
    evidence: ["subject-line exact match: 'New store submission — TheBinMap'"],
    rulesMatched: ["subject-exact:thebinmap_submit"],
    requiresHumanReview: false,
  };
}

function contactDetection(): SourceDetection {
  return {
    sourceType: "contact",
    sourceForm: "thebinmap_contact",
    sourcePage: "/contact",
    brand: "thebinmap",
    confidence: 0.9,
    evidence: ["subject-line exact match: 'Contact form — TheBinMap'"],
    rulesMatched: ["subject-exact:thebinmap_contact"],
    requiresHumanReview: false,
  };
}

function unknownDetection(): SourceDetection {
  return {
    sourceType: "unknown",
    sourceForm: "unknown",
    sourcePage: "unknown",
    brand: "unknown",
    confidence: 0,
    evidence: [],
    rulesMatched: [],
    requiresHumanReview: true,
  };
}

function marketingDetection(): SourceDetection {
  return {
    sourceType: "provider_marketing",
    sourceForm: "unknown",
    sourcePage: "unknown",
    brand: "unknown",
    confidence: 0.85,
    evidence: ["provider marketing detected by subject pattern"],
    rulesMatched: ["provider:marketing"],
    requiresHumanReview: false,
  };
}

// ---------------------------------------------------------------------------
// Intake metadata fixtures
// ---------------------------------------------------------------------------

function completeMetadata(): IntakeMetadata {
  return {
    intakeTransport: "email_notification",
    recordCompleteness: "complete",
    evidenceSources: [],
    providerSubmissionId: "sub-001",
    emailMessageId: "test-msg@example.com",
    correlationFingerprint: "corr:abc123",
    missingFields: [],
    conflictingFields: [],
    lastEnrichedAt: "2026-08-10T12:00:00.000Z",
  };
}

function partialMetadata(): IntakeMetadata {
  return {
    ...completeMetadata(),
    recordCompleteness: "partial",
    missingFields: ["phone", "website"],
  };
}

function needsSourceVerificationMetadata(): IntakeMetadata {
  return {
    ...partialMetadata(),
    recordCompleteness: "needs_source_verification",
    missingFields: ["storeName", "address", "city", "state"],
  };
}

// -- thebinmap_submit detection for Web3Forms fuzzy match --
function web3FormsStoreDetection(): SourceDetection {
  return {
    sourceType: "store_submission",
    sourceForm: "thebinmap_submit",
    sourcePage: "/submit",
    brand: "thebinmap",
    confidence: 0.8,
    evidence: ["Web3Forms sender + 'store submission' in subject"],
    rulesMatched: ["web3forms:store_submission_subject"],
    requiresHumanReview: false,
  };
}

function bodyBasedStoreDetection(): SourceDetection {
  return {
    sourceType: "store_submission",
    sourceForm: "thebinmap_submit",
    sourcePage: "/submit",
    brand: "thebinmap",
    confidence: 0.75,
    evidence: ["body contains store-name field + TheBinMap footer URL"],
    rulesMatched: ["body-fields:thebinmap_submit_footer"],
    requiresHumanReview: false,
  };
}

// -- QSL / Formspree detection --
function qslSecurityReviewDetection(): SourceDetection {
  return {
    sourceType: "qsl_security_review",
    sourceForm: "qsl_security_review_form",
    sourcePage: "/security-review",
    brand: "qsl",
    confidence: 0.95,
    evidence: ["subject-line exact match: 'QSL Security Review Request'"],
    rulesMatched: ["subject-exact:qsl_security_review"],
    requiresHumanReview: false,
  };
}

function therapistIndexDetection(): SourceDetection {
  return {
    sourceType: "contact",
    sourceForm: "therapist_index",
    sourcePage: "unknown",
    brand: "therapist_index",
    confidence: 0.8,
    evidence: ["TherapistIndex brand + subject/body pattern match"],
    rulesMatched: ["brand:therapist_index"],
    requiresHumanReview: false,
  };
}

// ---------------------------------------------------------------------------
// 11 Scenario Fixtures
// ---------------------------------------------------------------------------

export const SORTER_FIXTURES: SorterFixture[] = [
  // 1. Complete store submission
  {
    id: "fixture-01",
    description: "complete store submission",
    msg: msg({
      subject: "New store submission — TheBinMap",
      bodyText: [
        "From: TheBinMap Submit Form <notify+xxxx@web3forms.com>",
        "Subject: New store submission — TheBinMap",
        "Store Name: Sample Bin Store",
        "Address: 123 Main St",
        "City: Nashville",
        "State: TN",
        "---",
        "Sent via https://thebinmap.com/",
      ].join("\n"),
      classHint: "store_submission",
      inReplyTo: null,
      references: [],
    }),
    detection: storeSubmitDetection(),
    metadata: completeMetadata(),
    duplicateMatchStrength: null,
    latestVerdict: null,
    hasReplyDraft: false,
    expectedCategory: "store_submission",
    expectedReplyActionStatus: "none",
    expectedDraftShouldGenerate: true,
  },

  // 2. Incomplete store submission
  {
    id: "fixture-02",
    description: "incomplete store submission",
    msg: msg({
      subject: "New store submission — TheBinMap",
      bodyText: [
        "From: TheBinMap Submit Form <notify+xxxx@web3forms.com>",
        "Subject: New store submission — TheBinMap",
        "Store Name: Partial Store",
        "---",
        "Sent via https://thebinmap.com/",
      ].join("\n"),
      classHint: "store_submission",
    }),
    detection: storeSubmitDetection(),
    metadata: partialMetadata(),
    duplicateMatchStrength: null,
    latestVerdict: null,
    hasReplyDraft: false,
    expectedCategory: "incomplete",
    expectedReplyActionStatus: "draft_needed",
    expectedDraftShouldGenerate: true,
  },

  // 3. Duplicate submission
  {
    id: "fixture-03",
    description: "duplicate submission",
    msg: msg({
      subject: "New store submission — TheBinMap",
      classHint: "spam_irrelevant",
    }),
    detection: storeSubmitDetection(),
    metadata: completeMetadata(),
    duplicateMatchStrength: "strong",
    latestVerdict: "duplicate",
    hasReplyDraft: false,
    expectedCategory: "duplicate",
    expectedReplyActionStatus: "draft_blocked",
    expectedDraftShouldGenerate: false,
  },

  // 4. Ordinary inquiry
  {
    id: "fixture-04",
    description: "ordinary inquiry",
    msg: msg({
      subject: "Contact form — TheBinMap",
      bodyText: "I have a question about bin store locations.",
      classHint: "contact_general",
      fromAddress: "curious@example.com",
    }),
    detection: contactDetection(),
    metadata: null,
    duplicateMatchStrength: null,
    latestVerdict: null,
    hasReplyDraft: false,
    expectedCategory: "general_email",
    expectedReplyActionStatus: "draft_needed",
    expectedDraftShouldGenerate: true,
  },

  // 5. Reply / continuation
  {
    id: "fixture-05",
    description: "reply or continuation",
    msg: msg({
      subject: "Re: Your previous message",
      bodyText: "Thanks for the update!",
      classHint: "contact_general",
      inReplyTo: "orig-msg@example.com",
      references: ["orig-msg@example.com"],
    }),
    detection: unknownDetection(),
    metadata: null,
    duplicateMatchStrength: null,
    latestVerdict: null,
    hasReplyDraft: false,
    expectedCategory: "reply_continuation",
    expectedReplyActionStatus: "draft_needed",
    expectedDraftShouldGenerate: true,
  },

  // 6. Spam / irrelevant
  {
    id: "fixture-06",
    description: "spam or irrelevant message",
    msg: msg({
      subject: "Welcome to Web3Forms",
      bodyText: "Welcome! Get started with our platform.",
      classHint: "spam_irrelevant",
      fromAddress: "noreply@web3forms.com",
    }),
    detection: marketingDetection(),
    metadata: null,
    duplicateMatchStrength: null,
    latestVerdict: null,
    hasReplyDraft: false,
    expectedCategory: "spam_irrelevant",
    expectedReplyActionStatus: "draft_blocked",
    expectedDraftShouldGenerate: false,
  },

  // 7. Historical message without intakeMetadata
  {
    id: "fixture-07",
    description: "historical message without intakeMetadata",
    msg: msg({
      subject: "Old inquiry from last year",
      bodyText: "I was wondering about your services.",
      classHint: "contact_general",
    }),
    detection: unknownDetection(),
    metadata: null,
    duplicateMatchStrength: null,
    latestVerdict: null,
    hasReplyDraft: false,
    expectedCategory: "general_email",
    expectedReplyActionStatus: "draft_needed",
    expectedDraftShouldGenerate: true,
  },

  // 8. Ambiguous message
  {
    id: "fixture-08",
    description: "ambiguous message",
    msg: msg({
      subject: "Hello from a friend",
      bodyText: "Hey, just checking in. How are things?",
      classHint: "unknown",
    }),
    detection: unknownDetection(),
    metadata: null,
    duplicateMatchStrength: null,
    latestVerdict: null,
    hasReplyDraft: false,
    expectedCategory: "unknown",
    expectedReplyActionStatus: "draft_blocked",
    expectedDraftShouldGenerate: false,
  },

  // 9. Message with misleading business vocabulary
  {
    id: "fixture-09",
    description: "message with misleading business vocabulary",
    msg: msg({
      subject: "Sales opportunity to discuss your store submissions",
      bodyText: "I have a great sales opportunity regarding store submissions and new stores in your area.",
      classHint: "sales_opportunity",
      fromAddress: "salesperson@thirdparty.com",
    }),
    detection: unknownDetection(),
    metadata: null,
    duplicateMatchStrength: null,
    latestVerdict: null,
    hasReplyDraft: false,
    expectedCategory: "general_email",
    expectedReplyActionStatus: "draft_needed",
    expectedDraftShouldGenerate: true,
  },

  // 10. Submission needing clarification
  {
    id: "fixture-10",
    description: "submission needing clarification",
    msg: msg({
      subject: "New store submission — TheBinMap",
      bodyText: [
        "From: TheBinMap Submit Form <notify+xxxx@web3forms.com>",
        "Subject: New store submission — TheBinMap",
        "Store Name: Mystery Store",
        "---",
        "Sent via https://thebinmap.com/",
      ].join("\n"),
      classHint: "store_submission",
    }),
    detection: storeSubmitDetection(),
    metadata: needsSourceVerificationMetadata(),
    duplicateMatchStrength: null,
    latestVerdict: "unsure",
    hasReplyDraft: false,
    expectedCategory: "incomplete",
    expectedReplyActionStatus: "draft_needed",
    expectedDraftShouldGenerate: true,
  },

  // 11. Record that must not receive a reply draft
  {
    id: "fixture-11",
    description: "record that must not receive a reply draft",
    msg: msg({
      subject: "Your Account Has Been Created",
      bodyText: "Welcome to Web3Forms. Your account is ready.",
      classHint: "spam_irrelevant",
      fromAddress: "no-reply@web3forms.com",
    }),
    detection: marketingDetection(),
    metadata: null,
    duplicateMatchStrength: null,
    latestVerdict: null,
    hasReplyDraft: false,
    expectedCategory: "spam_irrelevant",
    expectedReplyActionStatus: "draft_blocked",
    expectedDraftShouldGenerate: false,
  },
];

// ---------------------------------------------------------------------------
// Draft decision fixtures
// ---------------------------------------------------------------------------

export const DRAFT_FIXTURES: DraftFixture[] = [
  {
    id: "draft-01",
    description: "acknowledgment draft for complete store submission",
    sortCategory: "store_submission",
    fromAddress: "owner@store.example",
    from: "Store Owner <owner@store.example>",
    subject: "New store submission — TheBinMap",
    expectedShouldDraft: true,
    expectedDraftKind: "acknowledgment",
    expectedContainsText: [
      "Thank you for your store submission",
      "our team will review it",
    ],
    expectedNotContainsText: [
      "incomplete",
      "missing",
      "clarification",
    ],
  },
  {
    id: "draft-02",
    description: "clarification draft for incomplete submission",
    sortCategory: "incomplete",
    fromAddress: "partial@store.example",
    from: "Partial Owner <partial@store.example>",
    subject: "New store submission — TheBinMap",
    expectedShouldDraft: true,
    expectedDraftKind: "clarification_request",
    expectedContainsText: [
      "some information appears to be incomplete",
      "Could you please provide",
    ],
    expectedNotContainsText: [
      "received your information",
      "has been processed",
    ],
  },
  {
    id: "draft-03",
    description: "general reply for ordinary inquiry",
    sortCategory: "general_email",
    fromAddress: "question@example.com",
    from: "Curious Person <question@example.com>",
    subject: "Question about stores",
    expectedShouldDraft: true,
    expectedDraftKind: "general_reply",
    expectedContainsText: [
      "Thank you for reaching out",
      "get back to you",
    ],
    expectedNotContainsText: [
      "store submission",
    ],
  },
  {
    id: "draft-04",
    description: "no draft for spam",
    sortCategory: "spam_irrelevant",
    fromAddress: "spam@example.com",
    from: "Spammer <spam@example.com>",
    subject: "Buy now!",
    expectedShouldDraft: false,
    expectedDraftKind: null,
    expectedContainsText: [],
    expectedNotContainsText: [],
  },
  {
    id: "draft-05",
    description: "no draft for duplicate",
    sortCategory: "duplicate",
    fromAddress: "dup@example.com",
    from: "Duplicate <dup@example.com>",
    subject: "Another submission",
    expectedShouldDraft: false,
    expectedDraftKind: null,
    expectedContainsText: [],
    expectedNotContainsText: [],
  },
  {
    id: "draft-06",
    description: "no draft for unknown category",
    sortCategory: "unknown",
    fromAddress: "mystery@example.com",
    from: "Mystery <mystery@example.com>",
    subject: "???",
    expectedShouldDraft: false,
    expectedDraftKind: null,
    expectedContainsText: [],
    expectedNotContainsText: [],
  },
  {
    id: "draft-07",
    description: "no draft when fromAddress is empty",
    sortCategory: "general_email",
    fromAddress: "",
    from: "",
    subject: "Some subject",
    expectedShouldDraft: false,
    expectedDraftKind: null,
    expectedContainsText: [],
    expectedNotContainsText: [],
  },
  {
    id: "draft-08",
    description: "reply draft for continuation",
    sortCategory: "reply_continuation",
    fromAddress: "followup@example.com",
    from: "Follow Up <followup@example.com>",
    subject: "Re: Previous conversation",
    expectedShouldDraft: true,
    expectedDraftKind: "general_reply",
    expectedContainsText: [
      "Thank you for reaching out",
    ],
    expectedNotContainsText: [
      "store submission",
    ],
  },
];

// ---------------------------------------------------------------------------
// Message body fixtures for normalize + extract integration tests
// ---------------------------------------------------------------------------

export const NORMALIZE_FIXTURES = [
  {
    id: "norm-01",
    description: "complete store submission via Web3Forms with all fields",
    rawBody: "store name: Best Bargains\naddress: 456 Commerce Dr\ncity: Nashville\nstate: TN\nphone: 615-555-0100\nwebsite: https://bestbargains.example\nrestock schedule: Saturdays\nyour email: owner@bestbargains.example\n\n---\nSent via https://thebinmap.com/",
    expectedClass: "store_submission",
    expectedVenture: "thebinmap",
    expectedSourceType: "store_submission",
    minimumExtractedFields: ["storeName", "address", "city", "state", "phone", "website", "submitterEmail"],
  },
  {
    id: "norm-02",
    description: "incomplete submission missing city and state",
    rawBody: "store name: Mystery Place\naddress: somewhere\nphone: 615-555-0200\n---\nSent via https://thebinmap.com/",
    expectedClass: "store_submission",
    expectedVenture: "thebinmap",
    expectedSourceType: "store_submission",
    minimumExtractedFields: ["storeName", "address", "phone"],
    missingFieldsExpected: ["city", "state"],
  },
  {
    id: "norm-03",
    description: "ordinary contact form message",
    rawBody: "Hi, I wanted to ask about listing my store on thebinmap. Can someone help?",
    expectedClass: "contact_general",
    expectedVenture: "thebinmap",
    expectedSourceType: "contact",
    minimumExtractedFields: [],
  },
  {
    id: "norm-04",
    description: "spam with opt-out language",
    rawBody: "SPECIAL OFFER!!! Click here for amazing deals! Unsubscribe instantly by clicking below.",
    expectedClass: "spam_irrelevant",
    expectedVenture: "unknown",
    expectedSourceType: "unknown",
    minimumExtractedFields: [],
  },
  {
    id: "norm-05",
    description: "reply to existing thread",
    rawBody: "Thanks for the update. I appreciate the quick response.",
    expectedClass: "unknown",
    expectedVenture: "unknown",
    expectedSourceType: "unknown",
    minimumExtractedFields: [],
  },
];
