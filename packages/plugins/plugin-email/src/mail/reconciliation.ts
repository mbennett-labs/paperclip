import { createHash } from "node:crypto";
import {
  TRANSPORT_PRECEDENCE,
  type EvidenceSource,
  type IntakeMetadata,
  type IntakeTransport,
} from "./intake-metadata.js";

export interface CorrelationAttempt {
  matched: boolean;
  merged: boolean;
  existingId: string | null;
  existingFingerprint: string | null;
  reason: string;
  unsafeCorrelation: boolean;
}

export interface IntakeRecord {
  id: string;
  metadata: IntakeMetadata;
  fieldValues: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export interface IntakeRecordEntry {
  id: string;
  metadata: IntakeMetadata;
  fieldValues: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export class ReconciliationIndex {
  private byFingerprint = new Map<string, string>();
  private bySubmissionId = new Map<string, string>();
  private records = new Map<string, IntakeRecord>();

  static fromEntries(entries: IntakeRecordEntry[]): ReconciliationIndex {
    const index = new ReconciliationIndex();
    for (const entry of entries) {
      index.add({
        id: entry.id,
        metadata: entry.metadata,
        fieldValues: entry.fieldValues,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
      });
    }
    return index;
  }

  add(record: IntakeRecord): void {
    this.records.set(record.id, record);

    const fp = record.metadata.correlationFingerprint;
    if (fp && fp !== "corr:none") {
      this.byFingerprint.set(fp, record.id);
    }

    if (record.metadata.providerSubmissionId) {
      this.bySubmissionId.set(record.metadata.providerSubmissionId, record.id);
    }
  }

  get(id: string): IntakeRecord | undefined {
    return this.records.get(id);
  }

  findBySubmissionId(submissionId: string): IntakeRecord | undefined {
    const id = this.bySubmissionId.get(submissionId);
    return id ? this.records.get(id) : undefined;
  }

  findByFingerprint(fingerprint: string): IntakeRecord | undefined {
    const id = this.byFingerprint.get(fingerprint);
    return id ? this.records.get(id) : undefined;
  }

  listAll(): IntakeRecord[] {
    return [...this.records.values()];
  }

  /** Number of indexed records. */
  get size(): number {
    return this.records.size;
  }

  /** Serialise to a plain-object array suitable for plugin_state persistence. */
  toEntries(): IntakeRecordEntry[] {
    return this.listAll().map((r) => ({
      id: r.id,
      metadata: r.metadata,
      fieldValues: r.fieldValues,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
  }
}

const MARKETING_SENDERS = new Set([
  "noreply@web3forms.com",
  "no-reply@web3forms.com",
  "noreply@formspree.io",
  "no-reply@formspree.io",
]);

const MARKETING_SUBJECT_PATTERNS = [
  /welcome/i,
  /getting started/i,
  /verify your email/i,
  /confirm your (?:email|account)/i,
  /^your account/i,
  /^account (?:created|activated)/i,
  /tips(?: and tricks)?$/i,
  /pro (?:plan|trial)/i,
  /upgrade/i,
  /new feature/i,
  /announcement/i,
  /webinar/i,
  /invitation/i,
  /please confirm/i,
];

export function isProviderMarketing(fromAddress: string, subject: string): boolean {
  const f = fromAddress.toLowerCase();
  if (f.includes("web3forms.com") || f.includes("formspree.io")) {
    if (MARKETING_SUBJECT_PATTERNS.some((p) => p.test(subject))) {
      return true;
    }
  }
  return false;
}

export function correlateIncomingEvidence(
  incoming: {
    id: string;
    metadata: IntakeMetadata;
    fieldValues: Record<string, string>;
  },
  existingRecords: IntakeRecord[],
): CorrelationAttempt {
  if (incoming.metadata.providerSubmissionId) {
    const match = existingRecords.find(
      (r) =>
        r.metadata.providerSubmissionId ===
        incoming.metadata.providerSubmissionId,
    );
    if (match) {
      return {
        matched: true,
        merged: true,
        existingId: match.id,
        existingFingerprint: match.metadata.correlationFingerprint,
        reason: "Provider submission ID matched: " + incoming.metadata.providerSubmissionId,
        unsafeCorrelation: false,
      };
    }
  }

  if (
    incoming.metadata.correlationFingerprint &&
    incoming.metadata.correlationFingerprint !== "corr:none"
  ) {
    const fingerprint = incoming.metadata.correlationFingerprint;
    if (fingerprint.startsWith("corr:fid:")) {
      const match = existingRecords.find(
        (r) => r.metadata.correlationFingerprint === fingerprint,
      );
      if (match) {
        return {
          matched: true,
          merged: true,
          existingId: match.id,
          existingFingerprint: match.metadata.correlationFingerprint,
          reason: "Form ID + submitter + timestamp fingerprint matched",
          unsafeCorrelation: false,
        };
      }
    }
  }

  if (
    incoming.metadata.correlationFingerprint &&
    incoming.metadata.correlationFingerprint !== "corr:none" &&
    incoming.metadata.correlationFingerprint.startsWith("corr:fp:")
  ) {
    const match = existingRecords.find(
      (r) =>
        r.metadata.correlationFingerprint ===
        incoming.metadata.correlationFingerprint,
    );
    if (match) {
      return {
        matched: true,
        merged: true,
        existingId: match.id,
        existingFingerprint: match.metadata.correlationFingerprint,
        reason: "Payload fingerprint matched",
        unsafeCorrelation: false,
      };
    }
  }

  if (
    incoming.metadata.emailMessageId &&
    incoming.metadata.correlationFingerprint !== "corr:none" &&
    incoming.metadata.correlationFingerprint.startsWith("corr:mid:")
  ) {
    const match = existingRecords.find(
      (r) =>
        r.metadata.emailMessageId === incoming.metadata.emailMessageId ||
        r.metadata.correlationFingerprint === incoming.metadata.correlationFingerprint,
    );
    if (match) {
      return {
        matched: true,
        merged: true,
        existingId: match.id,
        existingFingerprint: match.metadata.correlationFingerprint,
        reason: "Email Message-ID matched",
        unsafeCorrelation: false,
      };
    }
  }

  const { wouldBeUnsafe } = checkUnsafeMerge(incoming, existingRecords);
  if (wouldBeUnsafe) {
    return {
      matched: false,
      merged: false,
      existingId: null,
      existingFingerprint: null,
      reason: "No deterministic correlation found; requires human review to merge",
      unsafeCorrelation: true,
    };
  }

  return {
    matched: false,
    merged: false,
    existingId: null,
    existingFingerprint: null,
    reason: "No existing record found for correlation",
    unsafeCorrelation: false,
  };
}

function checkUnsafeMerge(
  incoming: {
    metadata: IntakeMetadata;
    fieldValues: Record<string, string>;
  },
  existingRecords: IntakeRecord[],
): { wouldBeUnsafe: boolean } {
  const incomingEmail = incoming.fieldValues.submitterEmail;
  if (incomingEmail) {
    const emailMatches = existingRecords.filter(
      (r) => r.fieldValues.submitterEmail?.toLowerCase() === incomingEmail.toLowerCase(),
    );
    if (emailMatches.length > 0) {
      if (
        emailMatches.some(
          (m) =>
            m.metadata.correlationFingerprint !==
            incoming.metadata.correlationFingerprint,
        )
      ) {
        return { wouldBeUnsafe: true };
      }
    }
  }

  return { wouldBeUnsafe: false };
}

export function reconcileRecord(
  existing: IntakeRecord,
  incoming: {
    metadata: IntakeMetadata;
    fieldValues: Record<string, string>;
  },
): IntakeRecord {
  const hasStrongerEvidence = incoming.metadata.intakeTransport !== existing.metadata.intakeTransport &&
    TRANSPORT_PRECEDENCE[incoming.metadata.intakeTransport] <
    TRANSPORT_PRECEDENCE[existing.metadata.intakeTransport];

  const incomingSource = incoming.metadata.evidenceSources[incoming.metadata.evidenceSources.length - 1];

  const updatedSources = [...existing.metadata.evidenceSources];
  const duplicateByHash = updatedSources.some(
    (s) => s.payloadHash === incomingSource.payloadHash,
  );
  if (!duplicateByHash) {
    updatedSources.push(incomingSource);
  }

  const allTransports = updatedSources.map((s) => s.transport);
  let strongestTransport = existing.metadata.intakeTransport;
  for (const t of allTransports) {
    if (TRANSPORT_PRECEDENCE[t] < TRANSPORT_PRECEDENCE[strongestTransport]) {
      strongestTransport = t;
    }
  }

  const allFieldsPresent = new Set<string>();
  for (const s of updatedSources) {
    for (const f of s.fieldsPresent) {
      allFieldsPresent.add(f);
    }
  }

  let newCompleteness = existing.metadata.recordCompleteness;
  if (existing.metadata.recordCompleteness !== "complete") {
    newCompleteness = computeReconciledCompleteness(
      [...allFieldsPresent],
      strongestTransport,
    );
  }

  const newMissingFields = existing.metadata.missingFields.filter(
    (f) => !allFieldsPresent.has(f),
  );

  const providerSubmissionId =
    incomingSource.providerSubmissionId ?? existing.metadata.providerSubmissionId;
  const emailMessageId =
    incomingSource.emailMessageId ?? existing.metadata.emailMessageId;

  const updatedFieldValues: Record<string, string> = {
    ...existing.fieldValues,
  };

  if (hasStrongerEvidence) {
    for (const [field, value] of Object.entries(incoming.fieldValues)) {
      if (value && value.trim()) {
        const existingValue = existing.fieldValues[field];
        if (!existingValue || existingValue.trim() === "") {
          updatedFieldValues[field] = value;
        } else if (existingValue.toLowerCase().trim() !== value.toLowerCase().trim()) {
          updatedFieldValues[field] = value;
        }
      }
    }
  } else {
    for (const [field, value] of Object.entries(incoming.fieldValues)) {
      if (value && value.trim() && !updatedFieldValues[field]) {
        updatedFieldValues[field] = value;
      }
    }
  }

  return {
    ...existing,
    metadata: {
      ...existing.metadata,
      intakeTransport: strongestTransport,
      recordCompleteness: newCompleteness,
      evidenceSources: updatedSources,
      providerSubmissionId,
      emailMessageId,
      missingFields: newMissingFields,
      lastEnrichedAt: new Date().toISOString(),
    },
    fieldValues: updatedFieldValues,
    updatedAt: new Date().toISOString(),
  };
}

function computeReconciledCompleteness(
  fieldsPresent: string[],
  transport: IntakeTransport,
): string {
  const ESSENTIAL_STORE_FIELDS = ["storeName", "address", "city", "state"];
  const hasEssential = ESSENTIAL_STORE_FIELDS.every((f) => fieldsPresent.includes(f));

  if (transport === "inferred_email") return "needs_source_verification";
  if (transport === "email_notification") return hasEssential ? "partial" : "needs_source_verification";
  if (transport === "provider_webhook" || transport === "provider_api" || transport === "wordpress_event") {
    return hasEssential ? "complete" : "partial";
  }
  return "needs_source_verification";
}

export function buildCanonicalPayloadFingerprint(
  fieldValues: Record<string, string>,
): string {
  const canonical = Object.entries(fieldValues)
    .filter(([, v]) => v && v.trim())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}:${v.toLowerCase().trim()}`)
    .join("|");

  if (!canonical) return "fp:empty";
  return "fp:" + createHash("sha1").update(canonical).digest("hex");
}