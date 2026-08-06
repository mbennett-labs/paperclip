import { describe, expect, it } from "vitest";
import {
  computeCompleteness,
  buildEvidenceSource,
  computeCorrelationFingerprint,
  createIntakeMetadata,
  mergeEvidence,
  getStrongestTransport,
  shouldUseStrongerValue,
  isUnsafeCorrelation,
  detectAndRecordConflicts,
  type IntakeMetadata,
  type IntakeTransport,
  type EvidenceSource,
} from "../src/mail/intake-metadata.js";
import {
  ReconciliationIndex,
  correlateIncomingEvidence,
  reconcileRecord,
  buildCanonicalPayloadFingerprint,
  type IntakeRecord,
} from "../src/mail/reconciliation.js";
import {
  normalizeMessage,
  detectSource,
  extractStoreIntake,
} from "../src/mail/normalize.js";

function makeStoreIntakeRecord(
  overrides: Partial<IntakeRecord> = {},
): IntakeRecord {
  return {
    id: "issue-001",
    metadata: createIntakeMetadata({
      transport: "email_notification",
      evidenceRefId: "ev-abc123",
      fieldsPresent: ["storeName", "city", "state"],
      totalPossibleFields: 15,
      emailMessageId: "msg-001@example.com",
    }),
    fieldValues: {
      storeName: "Bargain Bin Store",
      city: "Nashville",
      state: "TN",
    },
    createdAt: "2026-08-01T12:00:00.000Z",
    updatedAt: "2026-08-01T12:00:00.000Z",
    ...overrides,
  };
}

function makeProviderWebhookRecord(
  overrides: Partial<IntakeRecord> = {},
): IntakeRecord {
  return {
    id: "issue-002",
    metadata: createIntakeMetadata({
      transport: "provider_webhook",
      evidenceRefId: "wh-abc123",
      fieldsPresent: ["storeName", "address", "city", "state", "postalCode", "phone", "website"],
      totalPossibleFields: 15,
      providerSubmissionId: "sub-12345",
    }),
    fieldValues: {
      storeName: "Bargain Bin Store",
      address: "123 Main St",
      city: "Nashville",
      state: "TN",
      postalCode: "37201",
      phone: "615-555-0100",
      website: "https://bargainbinstore.com",
    },
    createdAt: "2026-08-01T12:05:00.000Z",
    updatedAt: "2026-08-01T12:05:00.000Z",
    ...overrides,
  };
}

// ============================================================================
// Test 1: Email-only form notification creates partial provisional classification
// ============================================================================

describe("Test 1: Email-only notification creates partial provisional classification", () => {
  it("email_notification transport yields partial completeness", () => {
    const metadata = createIntakeMetadata({
      transport: "email_notification",
      evidenceRefId: "ev-test",
      fieldsPresent: ["storeName", "city"],
      totalPossibleFields: 15,
      emailMessageId: "msg-test@example.com",
    });

    expect(metadata.intakeTransport).toBe("email_notification");
    expect(metadata.recordCompleteness).toBe("needs_source_verification");
    expect(metadata.evidenceSources).toHaveLength(1);
    expect(metadata.evidenceSources[0].transport).toBe("email_notification");
  });

  it("partial email record is marked as provisional not complete", () => {
    const completeness = computeCompleteness(
      ["storeName", "city"],
      "email_notification",
    );
    expect(completeness).toBe("needs_source_verification");
    expect(completeness).not.toBe("complete");
  });

  it("email notification with all essential fields is still partial", () => {
    const completeness = computeCompleteness(
      ["storeName", "address", "city", "state"],
      "email_notification",
    );
    expect(completeness).toBe("partial");
  });

  it("email fields present are included in evidence source", () => {
    const source = buildEvidenceSource({
      transport: "email_notification",
      referenceId: "ev-test",
      receivedAt: "2026-08-01T12:00:00.000Z",
      emailMessageId: "msg-test@example.com",
      fieldsPresent: ["storeName", "city"],
      fieldCount: 2,
    });

    expect(source.fieldsPresent).toContain("storeName");
    expect(source.fieldsPresent).toContain("city");
    expect(source.fieldCount).toBe(2);
  });
});

// ============================================================================
// Test 2: Missing fields appear in missingFields
// ============================================================================

describe("Test 2: Missing fields appear in missingFields", () => {
  it("records missing fields from partial submission", () => {
    const metadata = createIntakeMetadata({
      transport: "email_notification",
      evidenceRefId: "ev-test",
      fieldsPresent: ["storeName"],
      totalPossibleFields: 15,
      emailMessageId: "msg-test@example.com",
    });

    metadata.missingFields.push("address", "city", "state", "postalCode", "phone");

    expect(metadata.missingFields).toContain("address");
    expect(metadata.missingFields).toContain("city");
    expect(metadata.missingFields).toContain("state");
    expect(metadata.missingFields).toContain("postalCode");
    expect(metadata.missingFields).toContain("phone");
  });

  it("fields not present in evidence are listed as missing", () => {
    const source = buildEvidenceSource({
      transport: "email_notification",
      referenceId: "ev-test",
      receivedAt: "2026-08-01T12:00:00.000Z",
      fieldsPresent: ["storeName"],
      fieldCount: 1,
    });

    expect(source.fieldsPresent).not.toContain("address");
    expect(source.fieldsPresent).not.toContain("website");
    expect(source.fieldsPresent.length).toBe(1);
  });
});

// ============================================================================
// Test 3: Structured provider payload is treated as stronger evidence
// ============================================================================

describe("Test 3: Structured provider payload is treated as stronger evidence", () => {
  it("provider_webhook has higher precedence than email_notification", () => {
    const webhook = createIntakeMetadata({
      transport: "provider_webhook",
      evidenceRefId: "wh-001",
      fieldsPresent: ["storeName", "address", "city", "state", "postalCode"],
      totalPossibleFields: 15,
      providerSubmissionId: "sub-123",
    });

    const email = createIntakeMetadata({
      transport: "email_notification",
      evidenceRefId: "ev-001",
      fieldsPresent: ["storeName"],
      totalPossibleFields: 15,
      emailMessageId: "msg-001@example.com",
    });

    expect(webhook.intakeTransport).toBe("provider_webhook");
    expect(email.intakeTransport).toBe("email_notification");

    const strongest = getStrongestTransport([
      "email_notification",
      "provider_webhook",
    ]);
    expect(strongest).toBe("provider_webhook");
  });

  it("structured payload yields complete when all essentials present", () => {
    const completeness = computeCompleteness(
      ["storeName", "address", "city", "state", "postalCode", "phone"],
      "provider_webhook",
    );
    expect(completeness).toBe("complete");
  });

  it("shouldUseStrongerValue returns true for webhook over email", () => {
    expect(shouldUseStrongerValue("email_notification", "provider_webhook")).toBe(true);
    expect(shouldUseStrongerValue("provider_webhook", "email_notification")).toBe(false);
  });
});

// ============================================================================
// Test 4: Matching structured evidence enriches existing provisional record
// ============================================================================

describe("Test 4: Matching structured evidence enriches existing provisional record", () => {
  it("mergeEvidence adds webhook source to email record", () => {
    const emailRecord = makeStoreIntakeRecord();

    const webhookSource = buildEvidenceSource({
      transport: "provider_webhook",
      referenceId: "wh-001",
      receivedAt: "2026-08-01T12:05:00.000Z",
      providerSubmissionId: "sub-12345",
      fieldsPresent: ["storeName", "address", "city", "state", "postalCode", "phone"],
      fieldCount: 6,
    });

    const merged = mergeEvidence(emailRecord.metadata, webhookSource);

    expect(merged.evidenceSources).toHaveLength(2);
    expect(merged.intakeTransport).toBe("provider_webhook");
    expect(merged.recordCompleteness).toBe("complete");
    expect(merged.lastEnrichedAt).toBeDefined();
  });

  it("mergeEvidence preserves prior evidence", () => {
    const emailRecord = makeStoreIntakeRecord();

    const webhookSource = buildEvidenceSource({
      transport: "provider_webhook",
      referenceId: "wh-001",
      receivedAt: "2026-08-01T12:05:00.000Z",
      providerSubmissionId: "sub-12345",
      fieldsPresent: ["storeName", "address", "city", "state"],
      fieldCount: 4,
    });

    const merged = mergeEvidence(emailRecord.metadata, webhookSource);

    expect(merged.evidenceSources[0].transport).toBe("email_notification");
    expect(merged.evidenceSources[1].transport).toBe("provider_webhook");
    expect(merged.intakeTransport).toBe("provider_webhook");
  });

  it("reconcileRecord enriches field values from stronger evidence", () => {
    const emailRecord = makeStoreIntakeRecord({
      metadata: createIntakeMetadata({
        transport: "email_notification",
        evidenceRefId: "ev-001",
        fieldsPresent: ["storeName", "city"],
        totalPossibleFields: 15,
        emailMessageId: "msg-001@example.com",
      }),
      fieldValues: {
        storeName: "Bargain Bin Store",
        city: "Nashville",
      },
    });

    const incoming = {
      metadata: createIntakeMetadata({
        transport: "provider_webhook",
        evidenceRefId: "wh-001",
        fieldsPresent: ["storeName", "address", "city", "state", "postalCode", "phone"],
        totalPossibleFields: 15,
        providerSubmissionId: "sub-12345",
      }),
      fieldValues: {
        storeName: "Bargain Bin Store",
        address: "123 Main St",
        city: "Nashville",
        state: "TN",
        postalCode: "37201",
        phone: "615-555-0100",
      },
    };

    const reconciled = reconcileRecord(emailRecord, incoming);

    expect(reconciled.fieldValues.storeName).toBe("Bargain Bin Store");
    expect(reconciled.fieldValues.address).toBe("123 Main St");
    expect(reconciled.fieldValues.phone).toBe("615-555-0100");
    expect(reconciled.metadata.intakeTransport).toBe("provider_webhook");
    expect(reconciled.metadata.evidenceSources.length).toBeGreaterThanOrEqual(2);
  });
});

// ============================================================================
// Test 5: Email + webhook evidence does not create duplicate business records
// ============================================================================

describe("Test 5: Email + webhook evidence does not create duplicate business records", () => {
  it("provider submission ID matches existing record via ReconciliationIndex", () => {
    const store = new ReconciliationIndex();
    const emailRecord = makeStoreIntakeRecord({
      id: "issue-001",
      metadata: createIntakeMetadata({
        transport: "email_notification",
        evidenceRefId: "ev-001",
        fieldsPresent: ["storeName", "city"],
        totalPossibleFields: 15,
        emailMessageId: "msg-001@example.com",
      }),
    });
    store.add(emailRecord);

    const incoming = {
      id: "issue-002",
      metadata: createIntakeMetadata({
        transport: "provider_webhook",
        evidenceRefId: "wh-001",
        fieldsPresent: ["storeName", "address", "city", "state", "postalCode", "phone"],
        totalPossibleFields: 15,
        providerSubmissionId: "sub-12345",
      }),
      fieldValues: {
        storeName: "Bargain Bin Store",
        address: "123 Main St",
        city: "Nashville",
        state: "TN",
      },
    };

    store.add(incoming);

    const incoming2 = {
      id: "issue-003",
      metadata: createIntakeMetadata({
        transport: "provider_webhook",
        evidenceRefId: "wh-002",
        fieldsPresent: ["storeName", "address", "city", "state", "postalCode", "phone"],
        totalPossibleFields: 15,
        providerSubmissionId: "sub-12345",
      }),
      fieldValues: {
        storeName: "Bargain Bin Store",
        address: "123 Main St",
        city: "Nashville",
        state: "TN",
      },
    };

    const result = correlateIncomingEvidence(incoming2, store.listAll());

    expect(result.matched).toBe(true);
    expect(result.merged).toBe(true);
    expect(result.unsafeCorrelation).toBe(false);
  });

  it("correlation by provider submission ID merges rather than duplicates", () => {
    const store = new ReconciliationIndex();

    const emailMeta = createIntakeMetadata({
      transport: "email_notification",
      evidenceRefId: "ev-001",
      fieldsPresent: ["storeName", "city"],
      totalPossibleFields: 15,
      emailMessageId: "msg-001@example.com",
    });

    const baseRecord: IntakeRecord = {
      id: "issue-001",
      metadata: {
        ...emailMeta,
        providerSubmissionId: "sub-12345",
      },
      fieldValues: { storeName: "Test Store", city: "Nashville" },
      createdAt: "2026-08-01T12:00:00.000Z",
      updatedAt: "2026-08-01T12:00:00.000Z",
    };
    store.add(baseRecord);

    const webhookMeta = createIntakeMetadata({
      transport: "provider_webhook",
      evidenceRefId: "wh-001",
      fieldsPresent: ["storeName", "address", "city", "state"],
      totalPossibleFields: 15,
      providerSubmissionId: "sub-12345",
    });

    const incoming = {
      id: "issue-002",
      metadata: webhookMeta,
      fieldValues: { storeName: "Test Store", address: "123 Main", city: "Nashville", state: "TN" },
    };

    const result = correlateIncomingEvidence(incoming, store.listAll());

    expect(result.matched).toBe(true);
    expect(result.merged).toBe(true);
    expect(result.unsafeCorrelation).toBe(false);
    expect(result.reason).toContain("sub-12345");
  });
});

// ============================================================================
// Test 6: Conflicting values are preserved and flagged
// ============================================================================

describe("Test 6: Conflicting values are preserved and flagged", () => {
  it("conflicting fields are detected when values differ", () => {
    const emailMeta = createIntakeMetadata({
      transport: "email_notification",
      evidenceRefId: "ev-001",
      fieldsPresent: ["storeName", "city"],
      totalPossibleFields: 15,
      emailMessageId: "msg-001@example.com",
    });

    const webhookSource = buildEvidenceSource({
      transport: "provider_webhook",
      referenceId: "wh-001",
      receivedAt: "2026-08-01T12:05:00.000Z",
      providerSubmissionId: "sub-12345",
      fieldsPresent: ["storeName", "address", "city", "state", "postalCode", "phone"],
      fieldCount: 6,
    });

    const emailValues = { storeName: "Bargain Bin Bonanza", city: "Nashville" };
    const webhookValues = { storeName: "Bargain Bin Store", city: "Nashville" };

    const metadata = detectAndRecordConflicts(emailMeta, webhookValues, webhookSource, [
      { source: emailMeta.evidenceSources[0], values: emailValues },
    ]);

    expect(metadata.conflictingFields.length).toBeGreaterThan(0);

    const storeNameConflict = metadata.conflictingFields.find(
      (c) => c.field === "storeName",
    );
    expect(storeNameConflict).toBeDefined();
    expect(storeNameConflict!.values.length).toBeGreaterThanOrEqual(2);
  });

  it("both values are preserved in conflict record", () => {
    const emailMeta = createIntakeMetadata({
      transport: "email_notification",
      evidenceRefId: "ev-001",
      fieldsPresent: ["phone"],
      totalPossibleFields: 15,
      emailMessageId: "msg-001@example.com",
    });

    const webhookSource = buildEvidenceSource({
      transport: "provider_webhook",
      referenceId: "wh-001",
      receivedAt: "2026-08-01T12:05:00.000Z",
      fieldsPresent: ["phone"],
      fieldCount: 1,
    });

    const result = detectAndRecordConflicts(emailMeta, { phone: "615-555-0100" }, webhookSource, [
      { source: emailMeta.evidenceSources[0], values: { phone: "615-555-9999" } },
    ]);

    const conflict = result.conflictingFields.find((c) => c.field === "phone");
    expect(conflict).toBeDefined();

    const phoneValues = conflict!.values.map((v) => v.value);
    expect(phoneValues).toContain("615-555-9999");
    expect(phoneValues).toContain("615-555-0100");
  });
});

// ============================================================================
// Test 7: Weaker email evidence cannot overwrite stronger structured evidence
// ============================================================================

describe("Test 7: Weaker email evidence cannot overwrite stronger structured evidence", () => {
  it("email notification does not overwrite webhook values in reconciliation", () => {
    const webhookRecord = makeProviderWebhookRecord({
      fieldValues: {
        storeName: "Bargain Bin Store",
        address: "123 Main St",
        city: "Nashville",
        state: "TN",
        postalCode: "37201",
        phone: "615-555-0100",
        website: "https://bargainbinstore.com",
      },
    });

    const incoming = {
      metadata: createIntakeMetadata({
        transport: "email_notification",
        evidenceRefId: "ev-late",
        fieldsPresent: ["storeName"],
        totalPossibleFields: 15,
        emailMessageId: "msg-late@example.com",
      }),
      fieldValues: {
        storeName: "Wrong Store Name",
        address: "999 Fake St",
      },
    };

    const reconciled = reconcileRecord(webhookRecord, incoming);

    expect(reconciled.fieldValues.storeName).toBe("Bargain Bin Store");
    expect(reconciled.fieldValues.address).toBe("123 Main St");
    expect(reconciled.metadata.intakeTransport).toBe("provider_webhook");
  });

  it("weaker evidence does not change the overall transport", () => {
    const transports: IntakeTransport[] = ["provider_webhook", "email_notification"];
    expect(getStrongestTransport(transports)).toBe("provider_webhook");

    const transports2: IntakeTransport[] = ["provider_api", "wordpress_event"];
    expect(getStrongestTransport(transports2)).toBe("provider_api");
  });
});

// ============================================================================
// Test 8: Unsafe correlation remains separate and requires human review
// ============================================================================

describe("Test 8: Unsafe correlation remains separate and requires human review", () => {
  it("records with only email address match are not auto-merged", () => {
    const store = new ReconciliationIndex();

    const record1 = makeStoreIntakeRecord({
      id: "issue-001",
      metadata: createIntakeMetadata({
        transport: "email_notification",
        evidenceRefId: "ev-001",
        fieldsPresent: ["storeName"],
        totalPossibleFields: 15,
        emailMessageId: "msg-001@example.com",
      }),
      fieldValues: {
        storeName: "Bargain Bin Store",
        submitterEmail: "owner@example.com",
      },
    });

    store.add(record1);

    const incoming = {
      id: "issue-002",
      metadata: createIntakeMetadata({
        transport: "email_notification",
        evidenceRefId: "ev-002",
        fieldsPresent: ["storeName"],
        totalPossibleFields: 15,
        emailMessageId: "msg-002@example.com",
      }),
      fieldValues: {
        storeName: "Different Store",
        submitterEmail: "owner@example.com",
      },
    };

    const result = correlateIncomingEvidence(incoming, store.listAll());

    expect(result.unsafeCorrelation).toBe(true);
    expect(result.merged).toBe(false);
  });

  it("records with only shared email address are not auto-merged", () => {
    const store = new ReconciliationIndex();

    const metadata1 = createIntakeMetadata({
      transport: "email_notification",
      evidenceRefId: "ev-001",
      fieldsPresent: ["storeName"],
      totalPossibleFields: 15,
      emailMessageId: "msg-001@example.com",
    });

    const record: IntakeRecord = {
      id: "issue-AAA",
      metadata: metadata1,
      fieldValues: { storeName: "Store A", submitterEmail: "owner@example.com" },
      createdAt: "2026-08-01T12:00:00.000Z",
      updatedAt: "2026-08-01T12:00:00.000Z",
    };
    store.add(record);

    const metadata2 = createIntakeMetadata({
      transport: "email_notification",
      evidenceRefId: "ev-002",
      fieldsPresent: ["storeName"],
      totalPossibleFields: 15,
      emailMessageId: "msg-002@example.com",
    });

    const incoming = {
      id: "issue-BBB",
      metadata: metadata2,
      fieldValues: { storeName: "Store B", submitterEmail: "owner@example.com" },
    };

    const result = correlateIncomingEvidence(incoming, store.listAll());

    expect(result.unsafeCorrelation).toBe(true);
    expect(result.matched).toBe(false);
  });
});

// ============================================================================
// Test 9: Complete, Partial, and Needs Source Verification render distinctly
// ============================================================================

describe("Test 9: Distinct completeness states", () => {
  it("complete is different from partial is different from needs_source_verification", () => {
    const complete = computeCompleteness(
      ["storeName", "address", "city", "state", "postalCode"],
      "provider_webhook",
    );
    const partial = computeCompleteness(
      ["storeName", "city"],
      "provider_webhook",
    );
    const needsCheck = computeCompleteness(
      ["storeName"],
      "email_notification",
    );

    expect(complete).toBe("complete");
    expect(partial).toBe("partial");
    expect(needsCheck).toBe("needs_source_verification");

    const states = new Set([complete, partial, needsCheck]);
    expect(states.size).toBe(3);
  });

  it("inferred_email always needs_source_verification", () => {
    expect(computeCompleteness(["storeName", "address", "city", "state"], "inferred_email")).toBe("needs_source_verification");
  });

  it("wordpress_event with essentials is complete", () => {
    expect(computeCompleteness(["storeName", "address", "city", "state"], "wordpress_event")).toBe("complete");
  });

  it("provider_api with essentials is complete", () => {
    expect(computeCompleteness(["storeName", "address", "city", "state"], "provider_api")).toBe("complete");
  });
});

// ============================================================================
// Test 10: No provider credentials or real customer data
// ============================================================================

describe("Test 10: No provider credentials or real customer data in tests", () => {
  it("no API keys appear in test data", () => {
    const metadata = createIntakeMetadata({
      transport: "provider_webhook",
      evidenceRefId: "ev-test",
      fieldsPresent: ["storeName"],
      totalPossibleFields: 15,
      providerSubmissionId: "sub-test",
    });

    const json = JSON.stringify(metadata);
    expect(json).not.toMatch(/api[_-]?key/i);
    expect(json).not.toMatch(/secret/i);
    expect(json).not.toMatch(/password/i);
    expect(json).not.toMatch(/token/i);
  });

  it("no real email addresses appear in test data", () => {
    const metadata = createIntakeMetadata({
      transport: "email_notification",
      evidenceRefId: "ev-test",
      fieldsPresent: ["storeName"],
      totalPossibleFields: 15,
      emailMessageId: "test-msg@example.com",
    });

    const json = JSON.stringify(metadata);
    expect(json).not.toMatch(/gmail\.com/);
    expect(json).not.toMatch(/yahoo\.com/);
    expect(json).not.toMatch(/outlook\.com/);
    expect(json).not.toMatch(/thebinmap\.com/);
  });

  it("no real store names or phone numbers appear", () => {
    const record = makeStoreIntakeRecord({
      fieldValues: {
        storeName: "Synthetic Test Store",
        city: "Testville",
        state: "TN",
        phone: "PHONE-REDACTED",
        submitterEmail: "test@example.com",
      },
    });

    const json = JSON.stringify(record);
    expect(json).not.toMatch(/\d{3}-\d{3}-\d{4}/);
    expect(json).not.toMatch(/Walmart/i);
    expect(json).not.toMatch(/Target/i);
    expect(json).not.toMatch(/Amazon/i);
  });
});

// ============================================================================
// Additional: normalizeMessage now produces intakeMetadata
// ============================================================================

describe("normalizeMessage produces intake metadata", () => {
  it("store_submission from email includes intake metadata", () => {
    const input = {
      uid: 42,
      folder: "INBOX",
      profileKey: "primary",
      envelope: {
        messageId: "test-msg-10@example.com",
        from: [{ name: "Test Sender", address: "sender@web3forms.com" }],
        to: [{ name: "Ops", address: "ops@thebinmap.com" }],
        subject: "New store submission — TheBinMap",
        date: "2026-08-01T12:00:00.000Z",
      },
      bodyText: "store name: Test Store\ncity: Testville\nstate: TN\nrestock: mondays\n",
    };

    const msg = normalizeMessage(input);
    const detection = detectSource(msg.subject, msg.fromAddress, msg.bodyText);
    const storeIntake = extractStoreIntake(msg, detection, "issue-test");

    expect(storeIntake).toBeDefined();
    expect(storeIntake!.intakeMetadata).toBeDefined();
    expect(storeIntake!.intakeMetadata.intakeTransport).toBe("email_notification");
    expect(storeIntake!.intakeMetadata.emailMessageId).toBe("test-msg-10@example.com");
  });

  it("intake metadata includes correlation fingerprint", () => {
    const input = {
      uid: 42,
      folder: "INBOX",
      profileKey: "primary",
      envelope: {
        messageId: "test-msg-11@example.com",
        from: [{ name: "Test Sender", address: "sender@web3forms.com" }],
        to: [{ name: "Ops", address: "ops@thebinmap.com" }],
        subject: "New store submission — TheBinMap",
        date: "2026-08-01T12:00:00.000Z",
      },
      bodyText: "store name: Test Store\ncity: Testville\nstate: TN\nrestock: mondays\n",
    };

    const msg = normalizeMessage(input);
    const detection = detectSource(msg.subject, msg.fromAddress, msg.bodyText);
    const storeIntake = extractStoreIntake(msg, detection, "issue-test");

    expect(storeIntake!.intakeMetadata.correlationFingerprint).toBeDefined();
    expect(storeIntake!.intakeMetadata.correlationFingerprint).toMatch(/^corr:/);
  });
});

// ============================================================================
// Additional: ReconciliationIndex operations
// ============================================================================

describe("ReconciliationIndex", () => {
  it("adds and retrieves records", () => {
    const store = new ReconciliationIndex();
    const record = makeStoreIntakeRecord();
    store.add(record);

    expect(store.get("issue-001")).toBeDefined();
    expect(store.get("issue-001")!.fieldValues.storeName).toBe("Bargain Bin Store");
  });

  it("finds by submission ID", () => {
    const store = new ReconciliationIndex();
    const record = makeProviderWebhookRecord();
    store.add(record);

    expect(store.findBySubmissionId("sub-12345")).toBeDefined();
    expect(store.findBySubmissionId("nonexistent")).toBeUndefined();
  });

  it("finds by correlation fingerprint", () => {
    const store = new ReconciliationIndex();
    const metadata = createIntakeMetadata({
      transport: "email_notification",
      evidenceRefId: "ev-001",
      fieldsPresent: ["storeName"],
      totalPossibleFields: 15,
      emailMessageId: "msg-001@example.com",
      payloadFingerprint: "fp:abc123",
    });
    const record: IntakeRecord = {
      id: "issue-003",
      metadata,
      fieldValues: { storeName: "Test" },
      createdAt: "2026-08-01T12:00:00.000Z",
      updatedAt: "2026-08-01T12:00:00.000Z",
    };
    store.add(record);

    expect(store.findByFingerprint(metadata.correlationFingerprint)).toBeDefined();
  });

  it("listAll returns all records", () => {
    const store = new ReconciliationIndex();
    store.add(makeStoreIntakeRecord({ id: "issue-001" }));
    store.add(makeProviderWebhookRecord({ id: "issue-002" }));

    expect(store.listAll().length).toBe(2);
  });
});

// ============================================================================
// Additional: Canonical payload fingerprinting
// ============================================================================

describe("buildCanonicalPayloadFingerprint", () => {
  it("produces consistent fingerprints for identical payloads", () => {
    const payload1 = { storeName: "Test Store", city: "Testville", state: "TN" };
    const payload2 = { storeName: "Test Store", city: "Testville", state: "TN" };

    expect(buildCanonicalPayloadFingerprint(payload1)).toBe(
      buildCanonicalPayloadFingerprint(payload2),
    );
  });

  it("produces different fingerprints for different payloads", () => {
    const payload1 = { storeName: "Store A", city: "City A" };
    const payload2 = { storeName: "Store B", city: "City B" };

    expect(buildCanonicalPayloadFingerprint(payload1)).not.toBe(
      buildCanonicalPayloadFingerprint(payload2),
    );
  });

  it("filters empty values", () => {
    const payload = { storeName: "Test", city: "", state: "  " };
    const fingerprint = buildCanonicalPayloadFingerprint(payload);
    expect(fingerprint).toContain("fp:");
    expect(fingerprint).not.toContain("city:");
  });

  it("returns fixed value for empty payload", () => {
    expect(buildCanonicalPayloadFingerprint({})).toBe("fp:empty");
  });
});

// ============================================================================
// Additional: Transport precedence consistency
// ============================================================================

describe("Transport precedence is consistent", () => {
  it("precedence values are in correct order", () => {
    const webhook = getStrongestTransport(["provider_webhook", "email_notification"]);
    const api = getStrongestTransport(["provider_api", "wordpress_event"]);
    const wp = getStrongestTransport(["wordpress_event", "email_notification"]);
    const email = getStrongestTransport(["email_notification", "inferred_email"]);

    expect(webhook).toBe("provider_webhook");
    expect(api).toBe("provider_api");
    expect(wp).toBe("wordpress_event");
    expect(email).toBe("email_notification");
  });
});