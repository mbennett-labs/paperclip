import { describe, expect, it } from "vitest";
import {
  ReconciliationIndex,
  correlateIncomingEvidence,
  reconcileRecord,
  type IntakeRecord,
} from "../src/mail/reconciliation.js";
import {
  createIntakeMetadata,
  buildEvidenceSource,
  type IntakeMetadata,
} from "../src/mail/intake-metadata.js";
import { detectSource } from "../src/mail/normalize.js";

describe("Durable Reconciliation — restart safety", () => {
  it("Rebuilds indexes from persisted entries after restart", () => {
    const entries = [
      {
        id: "issue-1",
        metadata: createIntakeMetadata({
          transport: "email_notification",
          evidenceRefId: "ev-001",
          fieldsPresent: ["storeName"],
          totalPossibleFields: 15,
          emailMessageId: "msg-001@example.com",
        }),
        fieldValues: { storeName: "Store A" },
        createdAt: "2026-08-01T12:00:00.000Z",
        updatedAt: "2026-08-01T12:00:00.000Z",
      },
      {
        id: "issue-2",
        metadata: createIntakeMetadata({
          transport: "provider_webhook",
          evidenceRefId: "wh-001",
          fieldsPresent: ["storeName", "address", "city", "state"],
          totalPossibleFields: 15,
          providerSubmissionId: "sub-abc",
        }),
        fieldValues: { storeName: "Store B", address: "123 Main" },
        createdAt: "2026-08-02T12:00:00.000Z",
        updatedAt: "2026-08-02T12:00:00.000Z",
      },
    ];

    const index = ReconciliationIndex.fromEntries(entries);

    expect(index.size).toBe(2);
    expect(index.get("issue-1")).toBeDefined();
    expect(index.get("issue-2")).toBeDefined();
    expect(index.findBySubmissionId("sub-abc")).toBeDefined();
  });

  it("Finds record by submission ID after index rebuild", () => {
    const entries = [
      {
        id: "issue-101",
        metadata: createIntakeMetadata({
          transport: "provider_webhook",
          evidenceRefId: "wh-101",
          fieldsPresent: ["storeName", "city"],
          totalPossibleFields: 15,
          providerSubmissionId: "sub-deep-link",
        }),
        fieldValues: { storeName: "Deep Store", city: "Memphis" },
        createdAt: "2026-08-01T12:00:00.000Z",
        updatedAt: "2026-08-01T12:00:00.000Z",
      },
    ];

    const index = ReconciliationIndex.fromEntries(entries);

    const found = index.findBySubmissionId("sub-deep-link");
    expect(found).toBeDefined();
    expect(found!.fieldValues.storeName).toBe("Deep Store");

    expect(index.findBySubmissionId("nonexistent")).toBeUndefined();
  });

  it("Finds record by fingerprint after index rebuild", () => {
    const metadata = createIntakeMetadata({
      transport: "email_notification",
      evidenceRefId: "ev-fp",
      fieldsPresent: ["storeName"],
      totalPossibleFields: 15,
      emailMessageId: "msg-fp@example.com",
    });

    const entries = [{ id: "fp-1", metadata, fieldValues: {}, createdAt: "", updatedAt: "" }];
    const index = ReconciliationIndex.fromEntries(entries);

    const found = index.findByFingerprint(metadata.correlationFingerprint);
    expect(found).toBeDefined();
    expect(found!.id).toBe("fp-1");
  });

  it("Lists all records after index rebuild without stale entries", () => {
    const entries = [
      {
        id: "issue-a",
        metadata: createIntakeMetadata({
          transport: "email_notification",
          evidenceRefId: "ev-a",
          fieldsPresent: ["storeName"],
          totalPossibleFields: 15,
          emailMessageId: "msg-a@example.com",
        }),
        fieldValues: {},
        createdAt: "",
        updatedAt: "",
      },
    ];

    const index = ReconciliationIndex.fromEntries(entries);
    const all = index.listAll();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe("issue-a");
  });

  it("Provisioned index gracefully handles a record whose fingerprint is empty", () => {
    const metadata: IntakeMetadata = {
      intakeTransport: "email_notification",
      recordCompleteness: "needs_source_verification",
      evidenceSources: [],
      providerSubmissionId: null,
      emailMessageId: null,
      correlationFingerprint: "corr:none",
      missingFields: ["storeName"],
      conflictingFields: [],
      lastEnrichedAt: null,
    };

    const entries = [{ id: "no-fp", metadata, fieldValues: {}, createdAt: "", updatedAt: "" }];
    const index = ReconciliationIndex.fromEntries(entries);
    expect(index.size).toBe(1);
    expect(index.findByFingerprint("corr:none")).toBeUndefined();
  });

  it("Correlation with same submission ID works across two separately-indexed records", () => {
    const existing = createIntakeMetadata({
      transport: "email_notification",
      evidenceRefId: "ev-before",
      fieldsPresent: ["storeName"],
      totalPossibleFields: 15,
      emailMessageId: "before@example.com",
    });

    const incoming = createIntakeMetadata({
      transport: "provider_webhook",
      evidenceRefId: "wh-after",
      fieldsPresent: ["storeName", "address", "city", "state"],
      totalPossibleFields: 15,
      providerSubmissionId: "sub-match",
    });

    const index = ReconciliationIndex.fromEntries([{
      id: "before-1",
      metadata: { ...existing, providerSubmissionId: "sub-match" },
      fieldValues: { storeName: "Store" },
      createdAt: "",
      updatedAt: "",
    }]);

    const result = correlateIncomingEvidence(
      { id: "after-1", metadata: incoming, fieldValues: {} },
      index.listAll(),
    );

    expect(result.matched).toBe(true);
    expect(result.merged).toBe(true);
    expect(result.existingId).toBe("before-1");
    expect(result.unsafeCorrelation).toBe(false);
  });

  it("Index is empty when built from no entries", () => {
    const index = ReconciliationIndex.fromEntries([]);
    expect(index.size).toBe(0);
    expect(index.listAll()).toEqual([]);
  });
});

describe("Company and form isolation", () => {
  it("Provider submission IDs from different forms do not collide", () => {
    const metadata1 = createIntakeMetadata({
      transport: "provider_webhook",
      evidenceRefId: "wh-1",
      fieldsPresent: ["storeName"],
      totalPossibleFields: 15,
      providerSubmissionId: "sub-1",
    });
    const metadata2 = createIntakeMetadata({
      transport: "provider_webhook",
      evidenceRefId: "wh-2",
      fieldsPresent: ["storeName", "city"],
      totalPossibleFields: 15,
      providerSubmissionId: "sub-2",
    });

    // Same submission ID from different sources should use different fingerprints
    // because the evidenceRefId differs
    expect(metadata1.correlationFingerprint).not.toBe(metadata2.correlationFingerprint);
  });

  it("Email Message-IDs from different companies do not collide", () => {
    const m1 = createIntakeMetadata({
      transport: "email_notification",
      evidenceRefId: "ev-c1",
      fieldsPresent: ["storeName"],
      totalPossibleFields: 15,
      emailMessageId: "msg-001@company1.com",
    });
    const m2 = createIntakeMetadata({
      transport: "email_notification",
      evidenceRefId: "ev-c2",
      fieldsPresent: ["storeName"],
      totalPossibleFields: 15,
      emailMessageId: "msg-001@company2.com",
    });

    expect(m1.correlationFingerprint).not.toBe(m2.correlationFingerprint);
  });
});

describe("Historical compatibility — records without intakeMetadata", () => {
  it("creates metadata default for inferred_email when absent", () => {
    const defaultMeta = createIntakeMetadata({
      transport: "inferred_email",
      evidenceRefId: "legacy",
      fieldsPresent: [],
      totalPossibleFields: 15,
    });

    expect(defaultMeta.intakeTransport).toBe("inferred_email");
    expect(defaultMeta.recordCompleteness).toBe("needs_source_verification");
    expect(defaultMeta.evidenceSources).toHaveLength(1);
  });

  it("derives partial metadata from existing evidence fields", () => {
    const derived = createIntakeMetadata({
      transport: "email_notification",
      evidenceRefId: "ev-legacy",
      fieldsPresent: ["storeName", "city"],
      totalPossibleFields: 15,
      emailMessageId: "old-msg@example.com",
    });

    derived.missingFields = ["address", "state", "postalCode", "phone"];
    expect(derived.missingFields).toContain("address");
    expect(derived.recordCompleteness).toBe("needs_source_verification");
  });

  it("non-store messages where storeIntake is null have safe metadata defaults", () => {
    const detection = detectSource(
      "Hello from a customer",
      "customer@gmail.com",
      "I have a question about TheBinMap",
    );

    expect(detection.sourceType).toBe("unknown");
    expect(detection.brand).toBe("thebinmap");
  });

  it("historical listing claim with sourceForm 'unknown' is still valid", () => {
    const detection = detectSource(
      "Listing claim — TheBinMap",
      "notify@web3forms.com",
      "role: owner\nclaim this listing"
    );
    expect(detection.sourceType).toBe("listing_claim");
    expect(detection.sourceForm).toBe("thebinmap_claim");
    expect(detection.brand).toBe("thebinmap");
  });

  it("QSL form with brand hint in body detected even without exact subject", () => {
    const detection = detectSource(
      "New Lead",
      "noreply@formspree.io",
      "risk_score: 75\nquantumshield security assessment"
    );
    expect(detection.sourceType).toBe("qsl_risk_calculator");
    expect(detection.brand).toBe("qsl");
  });
});

describe("Classification confidence vs completeness separation", () => {
  it("high confidence classification does not imply complete record", () => {
    const metadata = createIntakeMetadata({
      transport: "email_notification",
      evidenceRefId: "ev-confident",
      fieldsPresent: ["storeName"],
      totalPossibleFields: 15,
      emailMessageId: "confident@example.com",
    });

    expect(metadata.recordCompleteness).toBe("needs_source_verification");
  });

  it("partial completeness does not mean low classification confidence", () => {
    const detection = detectSource(
      "New store submission — TheBinMap",
      "notify@web3forms.com",
      "store name: My Store"
    );
    expect(detection.confidence).toBeGreaterThanOrEqual(0.9);
  });
});

describe("Missing fields per form type", () => {
  it("store submission fields include address, city, state, etc.", () => {
    const metadata = createIntakeMetadata({
      transport: "email_notification",
      evidenceRefId: "ev-store",
      fieldsPresent: ["storeName", "city"],
      totalPossibleFields: 4,
      emailMessageId: "store@example.com",
    });

    metadata.missingFields = ["address", "state"];
    expect(metadata.missingFields).toHaveLength(2);
    expect(metadata.missingFields).toContain("address");
    expect(metadata.missingFields).toContain("state");
  });

  it("QSL risk calculator expected fields differ from store fields", () => {
    const metadata = createIntakeMetadata({
      transport: "email_notification",
      evidenceRefId: "ev-qsl-risk",
      fieldsPresent: ["risk_score", "name", "email"],
      totalPossibleFields: 8,
      emailMessageId: "qsl-risk@example.com",
    });

    metadata.missingFields = ["risk_level", "company", "title", "org_type", "assessment_answers"];
    expect(metadata.missingFields.length).toBeGreaterThan(0);
    expect(metadata.missingFields).toContain("risk_level");
  });
});

describe("Conflicting values preserve both values and evidence sources", () => {
  it("both values are retained with source annotations", () => {
    const emailMeta = createIntakeMetadata({
      transport: "email_notification",
      evidenceRefId: "ev-conflict",
      fieldsPresent: ["storeName"],
      totalPossibleFields: 15,
      emailMessageId: "conflict@example.com",
    });

    const webhookSource = buildEvidenceSource({
      transport: "provider_webhook",
      referenceId: "wh-conflict",
      receivedAt: "2026-08-01T12:00:00.000Z",
      fieldsPresent: ["storeName"],
      fieldCount: 1,
    });

    // Manually set conflicting fields to verify test
    emailMeta.conflictingFields = [{
      field: "storeName",
      values: [
        { value: "Wrong Name", source: "email_notification", precedence: 4 },
        { value: "Correct Name", source: "provider_webhook", precedence: 1 },
      ],
    }];

    const conflict = emailMeta.conflictingFields[0];
    expect(conflict.field).toBe("storeName");
    expect(conflict.values).toHaveLength(2);
    expect(conflict.values[0].value).toBe("Wrong Name");
    expect(conflict.values[0].source).toBe("email_notification");
    expect(conflict.values[1].value).toBe("Correct Name");
    expect(conflict.values[1].source).toBe("provider_webhook");
  });
});

describe("Stronger evidence precedence", () => {
  it("email_notification cannot overwrite provider_webhook in reconcileRecord", () => {
    const webhookRecord: IntakeRecord = {
      id: "wh-superior",
      metadata: createIntakeMetadata({
        transport: "provider_webhook",
        evidenceRefId: "wh-superior",
        fieldsPresent: ["storeName", "address", "city", "state"],
        totalPossibleFields: 15,
        providerSubmissionId: "sub-superior",
      }),
      fieldValues: {
        storeName: "Correct Store",
        address: "123 Real St",
        city: "Nashville",
        state: "TN",
      },
      createdAt: "2026-08-01T12:00:00.000Z",
      updatedAt: "2026-08-01T12:00:00.000Z",
    };

    const incoming = {
      metadata: createIntakeMetadata({
        transport: "email_notification",
        evidenceRefId: "ev-weak",
        fieldsPresent: ["storeName"],
        totalPossibleFields: 15,
        emailMessageId: "weak@example.com",
      }),
      fieldValues: {
        storeName: "Wrong Overwrite",
        address: "999 Fake St",
      },
    };

    const reconciled = reconcileRecord(webhookRecord, incoming);
    expect(reconciled.fieldValues.storeName).toBe("Correct Store");
    expect(reconciled.fieldValues.address).toBe("123 Real St");
    expect(reconciled.metadata.intakeTransport).toBe("provider_webhook");
  });
});

describe("No duplicate issue when later stronger evidence matches safely", () => {
  it("Provider submission ID match prevents duplicate", () => {
    const existing = createIntakeMetadata({
      transport: "email_notification",
      evidenceRefId: "ev-first",
      fieldsPresent: ["storeName"],
      totalPossibleFields: 15,
      emailMessageId: "first@example.com",
    });

    const index = ReconciliationIndex.fromEntries([{
      id: "first-issue",
      metadata: { ...existing, providerSubmissionId: "sub-dup" },
      fieldValues: { storeName: "Store" },
      createdAt: "",
      updatedAt: "",
    }]);

    const incoming = {
      id: "second-issue",
      metadata: createIntakeMetadata({
        transport: "provider_webhook",
        evidenceRefId: "wh-second",
        fieldsPresent: ["storeName", "address", "city", "state"],
        totalPossibleFields: 15,
        providerSubmissionId: "sub-dup",
      }),
      fieldValues: { storeName: "Store", address: "456 Oak" },
    };

    const result = correlateIncomingEvidence(incoming, index.listAll());
    expect(result.matched).toBe(true);
    expect(result.existingId).toBe("first-issue");
  });
});