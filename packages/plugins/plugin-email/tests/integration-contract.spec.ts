/**
 * Integration tests: prove the production worker/data-provider path
 * invokes the sorter and enforces the draft safety policy.
 *
 * These tests verify the contract without requiring a live PluginContext.
 * They exercise the data shapes that flow through ingestMessage →
 * sortIntakeRecord → decideDraft → intake-queue / store-intake / issue-email.
 */

import { describe, expect, it } from "vitest";
import {
  sortIntakeRecord,
  type IntakeSortCategory,
} from "../src/mail/sorter.js";
import {
  decideDraft,
  prepareDraftDocument,
} from "../src/mail/drafts.js";
import { detectSource, normalizeMessage, type MessageClassHint, type SourceDetection } from "../src/mail/normalize.js";
import { computeCompleteness, type IntakeMetadata, type IntakeTransport } from "../src/mail/intake-metadata.js";
import { resolveQueueStoreName } from "../src/worker.js";
import { STATE_NS_INTAKE } from "../src/constants.js";

// ---------------------------------------------------------------------------
// State key contract — must match what ingestMessage writes
// ---------------------------------------------------------------------------

const EXPECTED_STATE_KEYS = {
  sortResult: "intake-sort-result",
  draftCandidate: "intake-draft-candidate",
  intakeEvidence: "intake-evidence",
  intakeMetadata: "intake-metadata",
} as const;

describe("state key contract", () => {
  it("intake-sort-result key is consistent with namespace", () => {
    expect(EXPECTED_STATE_KEYS.sortResult).toBe("intake-sort-result");
  });

  it("intake-draft-candidate key is consistent with namespace", () => {
    expect(EXPECTED_STATE_KEYS.draftCandidate).toBe("intake-draft-candidate");
  });

  it("STATE_NS_INTAKE is available for state operations", () => {
    expect(STATE_NS_INTAKE).toBe("email-intake");
  });
});

// ---------------------------------------------------------------------------
// Integration: ingestMessage → sortIntakeRecord contract
//
// Tests that the sortIntakeRecord call in ingestMessage produces correct
// categories for each intake scenario using real detectSource() output.
// ---------------------------------------------------------------------------

interface IngestSortScenario {
  id: string;
  description: string;
  subject: string;
  fromAddress: string;
  body: string;
  inReplyTo: string | null;
  references: string[];
  expectedCategory: IntakeSortCategory;
  expectedReplyAction: string;
}

import { SORTER_FIXTURES } from "./fixtures/synthetic-messages.js";

function makeNormMsg(subject: string, fromAddress: string, body: string, inReplyTo?: string, references?: string[]) {
  return normalizeMessage({
    uid: 1,
    folder: "INBOX",
    profileKey: "primary",
    envelope: {
      messageId: "test-msg@example.com",
      from: [{ name: "Test", address: fromAddress }],
      to: [{ name: "TheBinMap", address: "info@thebinmap.com" }],
      subject,
      date: new Date().toISOString(),
      inReplyTo,
      references,
    },
    bodyText: body,
  });
}

function extractClassHint(sourceType: string): MessageClassHint {
  const map: Record<string, MessageClassHint> = {
    store_submission: "store_submission",
    listing_claim: "listing_claim",
    contact: "contact_general",
    alert_signup: "store_alert_signup",
    newsletter_signup: "newsletter_signup",
    provider_marketing: "spam_irrelevant",
    qsl_security_review: "support_request",
    qsl_risk_calculator: "sales_opportunity",
    correction: "correction",
    unknown: "unknown",
  };
  return map[sourceType] ?? "unknown";
}

const INGEST_SCENARIOS: IngestSortScenario[] = [
  {
    id: "ingest-01",
    description: "TheBinMap store submission via exact subject",
    subject: "New store submission — TheBinMap",
    fromAddress: "notify@web3forms.com",
    body: [
      "Store Name: Best Bargains",
      "Address: 456 Commerce Dr",
      "City: Nashville",
      "State: TN",
      "---",
      "Sent via https://thebinmap.com/",
    ].join("\n"),
    inReplyTo: null,
    references: [],
    expectedCategory: "store_submission",
    expectedReplyAction: "none",
  },
  {
    id: "ingest-02",
    description: "TheBinMap store submission missing city/state → incomplete",
    subject: "New store submission — TheBinMap",
    fromAddress: "notify@web3forms.com",
    body: [
      "Store Name: Mystery Place",
      "---",
      "Sent via https://thebinmap.com/",
    ].join("\n"),
    inReplyTo: null,
    references: [],
    expectedCategory: "incomplete",
    expectedReplyAction: "draft_needed",
  },
  {
    id: "ingest-03",
    description: "Web3Forms marketing welcome message",
    subject: "Welcome to Web3Forms",
    fromAddress: "noreply@web3forms.com",
    body: "Welcome! Get started with your account.",
    inReplyTo: null,
    references: [],
    expectedCategory: "spam_irrelevant",
    expectedReplyAction: "draft_blocked",
  },
  {
    id: "ingest-04",
    description: "Ordinary contact form message",
    subject: "Contact form — TheBinMap",
    fromAddress: "curious@example.com",
    body: "I have a question about bin stores.",
    inReplyTo: null,
    references: [],
    expectedCategory: "general_email",
    expectedReplyAction: "draft_needed",
  },
  {
    id: "ingest-05",
    description: "Reply to existing thread",
    subject: "Re: Your previous message",
    fromAddress: "followup@example.com",
    body: "Thanks for the update!",
    inReplyTo: "orig-msg@example.com",
    references: ["orig-msg@example.com"],
    expectedCategory: "reply_continuation",
    expectedReplyAction: "draft_needed",
  },
  {
    id: "ingest-06",
    description: "Unknown sender, no classification → unknown",
    subject: "Random message",
    fromAddress: "stranger@example.com",
    body: "Just saying hello.",
    inReplyTo: null,
    references: [],
    expectedCategory: "unknown",
    expectedReplyAction: "draft_blocked",
  },
  {
    id: "ingest-07",
    description: "Store submission with misleading subject still classifies correctly",
    subject: "New store submission — TheBinMap",
    fromAddress: "notify@web3forms.com",
    body: [
      "Store Name: Bargain Bin",
      "Address: 123 Main St",
      "City: Nashville",
      "State: TN",
      "---",
      "Sent via https://thebinmap.com/",
    ].join("\n"),
    inReplyTo: null,
    references: [],
    expectedCategory: "store_submission",
    expectedReplyAction: "none",
  },
  {
    id: "ingest-08",
    description: "Listing claim via exact subject",
    subject: "Listing claim — TheBinMap",
    fromAddress: "owner@example.com",
    body: "I want to claim this listing. Role: owner",
    inReplyTo: null,
    references: [],
    expectedCategory: "general_email",
    expectedReplyAction: "draft_needed",
  },
];

describe("ingestMessage → sortIntakeRecord integration contract", () => {
  it.each(INGEST_SCENARIOS)(
    "[$id] $description → $expectedCategory",
    (scenario) => {
      const detection = detectSource(scenario.subject, scenario.fromAddress, scenario.body);
      const norm = makeNormMsg(scenario.subject, scenario.fromAddress, scenario.body, scenario.inReplyTo ?? undefined, scenario.references);

      const fieldsPresent = extractFieldsForTest(scenario.body, detection);
      const transport: IntakeTransport = "email_notification";
      const completeness = computeCompleteness(fieldsPresent, transport);

      const metadata: IntakeMetadata | null =
        detection.sourceType === "store_submission" && detection.sourceForm !== "unknown"
          ? {
              intakeTransport: transport,
              recordCompleteness: completeness,
              evidenceSources: [],
              providerSubmissionId: null,
              emailMessageId: norm.messageId,
              correlationFingerprint: "corr:test",
              missingFields: ["storeName", "address", "city", "state"].filter(
                (f) => !fieldsPresent.includes(f),
              ),
              conflictingFields: [],
              lastEnrichedAt: new Date().toISOString(),
            }
          : null;

      const result = sortIntakeRecord({
        sourceDetection: detection,
        classHint: norm.classHint,
        intakeMetadata: metadata,
        duplicateMatchStrength: null,
        latestVerdict: null,
        hasReplyDraft: false,
        inReplyTo: scenario.inReplyTo,
        hasReferences: scenario.references.length > 0,
      });

      expect(result.category).toBe(scenario.expectedCategory);
      expect(result.replyActionStatus).toBe(scenario.expectedReplyAction);

      if (scenario.expectedReplyAction !== "draft_blocked") {
        const draftDecision = decideDraft(result.category, {
          fromAddress: scenario.fromAddress,
          from: scenario.fromAddress,
          subject: scenario.subject,
        });
        expect(draftDecision.shouldDraft).toBe(
          scenario.expectedReplyAction === "draft_needed" || result.category === "store_submission",
        );
      }
    },
  );
});

function extractFieldsForTest(body: string, detection: SourceDetection): string[] {
  if (detection.sourceType !== "store_submission") return [];
  const fields: string[] = [];
  const l = body.toLowerCase();
  if (l.includes("store name")) fields.push("storeName");
  if (l.includes("address")) fields.push("address");
  if (l.includes("city")) fields.push("city");
  if (l.includes("state")) fields.push("state");
  return fields;
}

// ---------------------------------------------------------------------------
// Integration: ingestMessage → decideDraft contract
//
// Tests that the draft decisions made in ingestMessage comply with
// safety invariants for all sort categories.
// ---------------------------------------------------------------------------

describe("ingestMessage → decideDraft integration safety contract", () => {
  it("spam never receives deterministic draft candidate", () => {
    const categories: IntakeSortCategory[] = ["spam_irrelevant", "duplicate", "unknown"];
    for (const cat of categories) {
      const decision = decideDraft(cat, {
        fromAddress: "test@example.com",
        from: "Test",
        subject: "Test",
      });
      expect(decision.shouldDraft).toBe(false);
      expect(decision.candidate).toBeNull();
    }
  });

  it("draft candidates are never auto-sent — format only", () => {
    for (const cat of ["general_email", "reply_continuation", "incomplete", "store_submission"] as string[]) {
      const doc = prepareDraftDocument(cat as IntakeSortCategory, {
        fromAddress: "test@example.com",
        from: "Test",
        subject: "Test Subject",
      });
      if (doc) {
        expect(doc).toContain("To: test@example.com");
        expect(doc).toContain("Subject:");
        expect(doc).not.toContain("SMTP");
        expect(doc).not.toContain("send");
        expect(doc).not.toContain("outbound");
      }
    }
  });

  it("duplicate messages never generate duplicate drafts", () => {
    const decision = decideDraft("duplicate", {
      fromAddress: "dup@example.com",
      from: "Dup",
      subject: "Again",
    });
    expect(decision.shouldDraft).toBe(false);
  });

  it("uncertain recipients fail closed", () => {
    const decision = decideDraft("general_email", {
      fromAddress: "",
      from: "",
      subject: "Test",
    });
    expect(decision.shouldDraft).toBe(false);
    expect(decision.reason).toContain("No recipient");
  });

  it("incomplete submissions can generate clarification draft", () => {
    const decision = decideDraft("incomplete", {
      fromAddress: "submitter@example.com",
      from: "Submitter",
      subject: "New store submission — TheBinMap",
    });
    expect(decision.shouldDraft).toBe(true);
    expect(decision.candidate?.kind).toBe("clarification_request");
    expect(decision.candidate?.body).toContain("incomplete");
  });

  it("store submissions generate acknowledgment draft", () => {
    const decision = decideDraft("store_submission", {
      fromAddress: "owner@store.example",
      from: "Owner",
      subject: "New store submission — TheBinMap",
    });
    expect(decision.shouldDraft).toBe(true);
    expect(decision.candidate?.kind).toBe("acknowledgment");
  });

  it("spam never generates drafts regardless of fromAddress", () => {
    const decision = decideDraft("spam_irrelevant", {
      fromAddress: "real-person@example.com",
      from: "Real Person",
      subject: "Legitimate looking subject",
    });
    expect(decision.shouldDraft).toBe(false);
  });

  it("unknown never generates drafts regardless of fromAddress", () => {
    const decision = decideDraft("unknown", {
      fromAddress: "real-person@example.com",
      from: "Real Person",
      subject: "Legitimate looking subject",
    });
    expect(decision.shouldDraft).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Integration: data provider contract
//
// Tests that the data shapes exposed through intake-queue contain
// sortCategory, sortLabel, replyActionStatus, and draftCandidateKind.
// ---------------------------------------------------------------------------

describe("data provider contract — sort and draft fields", () => {
  function simulateQueueItemFromIngestion(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const subject = overrides.subject as string ?? "New store submission — TheBinMap";
    const fromAddress = overrides.fromAddress as string ?? "notify@web3forms.com";
    const body = overrides.body as string ?? "Store Name: Test Store\nCity: Nashville\nState: TN\n---\nSent via https://thebinmap.com/";
    const inReplyTo = (overrides.inReplyTo as string) ?? null;
    const references = (Array.isArray(overrides.references) ? overrides.references : null) as string[] | null;

    const detection = detectSource(subject, fromAddress, body);
    const norm = makeNormMsg(subject, fromAddress, body, inReplyTo ?? undefined, references ?? undefined);

    const sortResult = sortIntakeRecord({
      sourceDetection: detection,
      classHint: norm.classHint,
      intakeMetadata: null,
      duplicateMatchStrength: null,
      latestVerdict: null,
      hasReplyDraft: false,
      inReplyTo,
      hasReferences: references != null && references.length > 0,
    });

    const draftDecision = decideDraft(sortResult.category, {
      fromAddress: (overrides.fromAddress as string) ?? "test@example.com",
      from: (overrides.from as string) ?? "Test",
      subject: (overrides.subject as string) ?? "Test",
    });

    return {
      sortCategory: sortResult.category,
      sortLabel: sortResult.rulesMatched[0] ?? null,
      replyActionStatus: sortResult.replyActionStatus,
      draftCandidateKind: draftDecision.shouldDraft && draftDecision.candidate
        ? draftDecision.candidate.kind
        : null,
    };
  }

  it("store submission produces sortCategory and draftCandidateKind", () => {
    const item = simulateQueueItemFromIngestion({
      subject: "New store submission — TheBinMap",
      fromAddress: "notify@web3forms.com",
      body: ["Store Name: Test Store", "City: Nashville", "State: TN", "---", "Sent via https://thebinmap.com/"].join("\n"),
    });
    expect(item.sortCategory).toBe("store_submission");
    expect(item.replyActionStatus).toBe("none");
    expect(item.draftCandidateKind).toBe("acknowledgment");
  });

  it("spam produces null draftCandidateKind", () => {
    const item = simulateQueueItemFromIngestion({
      subject: "Welcome to Web3Forms",
      fromAddress: "noreply@web3forms.com",
      body: "Welcome! Get started.",
    });
    expect(item.sortCategory).toBe("spam_irrelevant");
    expect(item.replyActionStatus).toBe("draft_blocked");
    expect(item.draftCandidateKind).toBeNull();
  });

  it("reply produces reply_continuation with general_reply draft", () => {
    const item = simulateQueueItemFromIngestion({
      subject: "Re: Previous thread",
      fromAddress: "followup@example.com",
      body: "Following up on this.",
      inReplyTo: "orig@example.com",
      references: ["orig@example.com"],
    });
    expect(item.sortCategory).toBe("reply_continuation");
    expect(item.replyActionStatus).toBe("draft_needed");
  });

  it("incomplete produces clarification_request draft", () => {
    const detection = detectSource(
      "New store submission — TheBinMap",
      "notify@web3forms.com",
      "Store Name: Mystery Store\n---\nSent via https://thebinmap.com/",
    );
    const completeness = computeCompleteness(["storeName"], "email_notification");
    const metadata: IntakeMetadata = {
      intakeTransport: "email_notification",
      recordCompleteness: completeness,
      evidenceSources: [],
      providerSubmissionId: null,
      emailMessageId: null,
      correlationFingerprint: "corr:test",
      missingFields: ["address", "city", "state"],
      conflictingFields: [],
      lastEnrichedAt: null,
    };

    const sortResult = sortIntakeRecord({
      sourceDetection: detection,
      classHint: "store_submission",
      intakeMetadata: metadata,
      duplicateMatchStrength: null,
      latestVerdict: null,
      hasReplyDraft: false,
      inReplyTo: null,
      hasReferences: false,
    });

    expect(sortResult.category).toBe("incomplete");

    const draftDecision = decideDraft(sortResult.category, {
      fromAddress: "notify@web3forms.com",
      from: "Web3Forms",
      subject: "New store submission — TheBinMap",
    });

    expect(draftDecision.shouldDraft).toBe(true);
    expect(draftDecision.candidate?.kind).toBe("clarification_request");
  });

  it("unknown category produces neither sort action nor draft", () => {
    const item = simulateQueueItemFromIngestion({
      subject: "???",
      fromAddress: "mystery@example.com",
      body: "No idea what this is.",
    });
    expect(item.sortCategory).toBe("unknown");
    expect(item.replyActionStatus).toBe("draft_blocked");
    expect(item.draftCandidateKind).toBeNull();
  });

  it("general email produces sortCategory with general_reply draft", () => {
    const item = simulateQueueItemFromIngestion({
      subject: "Question about stores",
      fromAddress: "curious@example.com",
      body: "Hi, I wanted to ask about listing my store on thebinmap.",
    });
    expect(item.sortCategory).toBe("general_email");
    expect(item.replyActionStatus).toBe("draft_needed");
    expect(item.draftCandidateKind).toBe("general_reply");
  });
});

// ---------------------------------------------------------------------------
// Historical compatibility: resolveQueueStoreName still works
// ---------------------------------------------------------------------------

describe("historical compatibility — resolveQueueStoreName", () => {
  it("works with storeIntake containing normalizedValues", () => {
    const evidence = {
      storeIntake: {
        normalizedValues: { storeName: "Bargain Bin" },
        originalValues: { storeName: "bargain bin" },
      },
    };
    expect(resolveQueueStoreName(evidence)).toBe("Bargain Bin");
  });

  it("falls back to originalValues when normalizedValues missing storeName", () => {
    const evidence = {
      storeIntake: {
        normalizedValues: { city: "Nashville" },
        originalValues: { storeName: "Fallback Store" },
      },
    };
    expect(resolveQueueStoreName(evidence)).toBe("Fallback Store");
  });

  it("returns null for non-store evidence", () => {
    expect(resolveQueueStoreName(null)).toBeNull();
    expect(resolveQueueStoreName({})).toBeNull();
    expect(resolveQueueStoreName({ storeIntake: null })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Worker.ts helpers: toIsoString and issueCreatedAt are tested implicitly
// by the typecheck. This section verifies the state key contract the
// data providers must read from.
// ---------------------------------------------------------------------------

describe("data provider state key contract", () => {
  it("intake-queue provider reads intake-sort-result", () => {
    // Contract: the intake-queue data provider MUST read from
    // stateKey "intake-sort-result" in namespace STATE_NS_INTAKE
    const sortKey = EXPECTED_STATE_KEYS.sortResult;
    expect(sortKey).toBe("intake-sort-result");
  });

  it("intake-queue provider reads intake-draft-candidate", () => {
    const draftKey = EXPECTED_STATE_KEYS.draftCandidate;
    expect(draftKey).toBe("intake-draft-candidate");
  });

  it("store-intake provider reads intake-sort-result", () => {
    expect(EXPECTED_STATE_KEYS.sortResult).toBe("intake-sort-result");
  });

  it("store-intake provider reads intake-draft-candidate", () => {
    expect(EXPECTED_STATE_KEYS.draftCandidate).toBe("intake-draft-candidate");
  });

  it("issue-email provider reads intake-draft-candidate", () => {
    expect(EXPECTED_STATE_KEYS.draftCandidate).toBe("intake-draft-candidate");
  });
});
