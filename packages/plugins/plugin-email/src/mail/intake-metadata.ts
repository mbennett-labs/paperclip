import { createHash } from "node:crypto";

export type IntakeTransport =
  | "provider_webhook"
  | "provider_api"
  | "wordpress_event"
  | "email_notification"
  | "inferred_email";

export const TRANSPORT_PRECEDENCE: Record<IntakeTransport, number> = {
  provider_webhook: 1,
  provider_api: 2,
  wordpress_event: 3,
  email_notification: 4,
  inferred_email: 5,
};

export type RecordCompleteness =
  | "complete"
  | "partial"
  | "needs_source_verification";

export interface EvidenceSource {
  transport: IntakeTransport;
  referenceId: string;
  receivedAt: string;
  providerSubmissionId?: string;
  emailMessageId?: string;
  payloadHash: string;
  fieldCount: number;
  fieldsPresent: string[];
}

export interface IntakeMetadata {
  intakeTransport: IntakeTransport;
  recordCompleteness: RecordCompleteness;
  evidenceSources: EvidenceSource[];
  providerSubmissionId: string | null;
  emailMessageId: string | null;
  correlationFingerprint: string;
  missingFields: string[];
  conflictingFields: Array<{
    field: string;
    values: Array<{ value: string; source: IntakeTransport; precedence: number }>;
  }>;
  lastEnrichedAt: string | null;
}

const ESSENTIAL_STORE_FIELDS = [
  "storeName",
  "address",
  "city",
  "state",
] as const;

export function computeCompleteness(
  fieldsPresent: string[],
  transport: IntakeTransport,
): RecordCompleteness {
  const hasEssential = ESSENTIAL_STORE_FIELDS.every((f) =>
    fieldsPresent.includes(f),
  );

  if (transport === "inferred_email") {
    return "needs_source_verification";
  }

  if (transport === "email_notification") {
    return hasEssential ? "partial" : "needs_source_verification";
  }

  if (
    transport === "provider_webhook" ||
    transport === "provider_api" ||
    transport === "wordpress_event"
  ) {
    return hasEssential ? "complete" : "partial";
  }

  return "needs_source_verification";
}

export function buildEvidenceSource(params: {
  transport: IntakeTransport;
  referenceId: string;
  receivedAt: string;
  providerSubmissionId?: string;
  emailMessageId?: string;
  fieldsPresent: string[];
  fieldCount: number;
}): EvidenceSource {
  const payloadHash = createHash("sha1")
    .update(
      `${params.transport}:${params.referenceId}:${params.providerSubmissionId ?? ""}:${params.emailMessageId ?? ""}`,
    )
    .digest("hex");

  return {
    transport: params.transport,
    referenceId: params.referenceId,
    receivedAt: params.receivedAt,
    providerSubmissionId: params.providerSubmissionId,
    emailMessageId: params.emailMessageId,
    payloadHash,
    fieldCount: params.fieldCount,
    fieldsPresent: params.fieldsPresent,
  };
}

export function computeCorrelationFingerprint(
  providerSubmissionId: string | null,
  emailMessageId: string | null,
  formId: string | null,
  submitterId: string | null,
  payloadFingerprint: string | null,
): string {
  const parts: string[] = [];

  if (providerSubmissionId) {
    parts.push(`sid:${providerSubmissionId}`);
  } else if (formId && submitterId) {
    parts.push(`fid:${formId}:sub:${submitterId}`);
  } else if (payloadFingerprint) {
    parts.push(`fp:${payloadFingerprint}`);
  } else if (emailMessageId) {
    parts.push(`mid:${emailMessageId}`);
  }

  if (parts.length === 0) {
    return "corr:none";
  }

  return `corr:${createHash("sha1").update(parts.join("|")).digest("hex")}`;
}

export function getStrongestTransport(
  transports: IntakeTransport[],
): IntakeTransport {
  if (transports.length === 0) return "inferred_email";
  return transports.reduce((best, t) =>
    TRANSPORT_PRECEDENCE[t] < TRANSPORT_PRECEDENCE[best] ? t : best,
  );
}

export function createIntakeMetadata(params: {
  transport: IntakeTransport;
  evidenceRefId: string;
  fieldsPresent: string[];
  totalPossibleFields: number;
  providerSubmissionId?: string;
  emailMessageId?: string;
  formId?: string;
  submitterId?: string;
  payloadFingerprint?: string;
}): IntakeMetadata {
  const now = new Date().toISOString();
  const source = buildEvidenceSource({
    transport: params.transport,
    referenceId: params.evidenceRefId,
    receivedAt: now,
    providerSubmissionId: params.providerSubmissionId,
    emailMessageId: params.emailMessageId,
    fieldsPresent: params.fieldsPresent,
    fieldCount: params.fieldsPresent.length,
  });

  const completeness = computeCompleteness(
    params.fieldsPresent,
    params.transport,
  );

  const fingerprint = computeCorrelationFingerprint(
    params.providerSubmissionId ?? null,
    params.emailMessageId ?? null,
    params.formId ?? null,
    params.submitterId ?? null,
    params.payloadFingerprint ?? null,
  );

  return {
    intakeTransport: params.transport,
    recordCompleteness: completeness,
    evidenceSources: [source],
    providerSubmissionId: params.providerSubmissionId ?? null,
    emailMessageId: params.emailMessageId ?? null,
    correlationFingerprint: fingerprint,
    missingFields: [],
    conflictingFields: [],
    lastEnrichedAt: null,
  };
}

export function mergeEvidence(
  existing: IntakeMetadata,
  incoming: EvidenceSource,
): IntakeMetadata {
  const existingTransportPrecedence = TRANSPORT_PRECEDENCE[existing.intakeTransport];
  const incomingTransportPrecedence = TRANSPORT_PRECEDENCE[incoming.transport];

  const updatedSources = [...existing.evidenceSources];

  const duplicateByHash = updatedSources.some(
    (s) => s.payloadHash === incoming.payloadHash,
  );
  if (!duplicateByHash) {
    updatedSources.push(incoming);
  }

  const allTransports = updatedSources.map((s) => s.transport);
  const strongestTransport = getStrongestTransport(allTransports);

  const allFieldsPresent = new Set<string>();
  for (const s of updatedSources) {
    for (const f of s.fieldsPresent) {
      allFieldsPresent.add(f);
    }
  }

  const newCompleteness = computeCompleteness(
    [...allFieldsPresent],
    strongestTransport,
  );

  const newMissingFields = existing.missingFields.filter(
    (f) => !allFieldsPresent.has(f),
  );

  const providerSubmissionId =
    incoming.providerSubmissionId ?? existing.providerSubmissionId;
  const emailMessageId =
    incoming.emailMessageId ?? existing.emailMessageId;

  return {
    ...existing,
    intakeTransport: strongestTransport,
    recordCompleteness: newCompleteness,
    evidenceSources: updatedSources,
    providerSubmissionId,
    emailMessageId,
    missingFields: newMissingFields,
    lastEnrichedAt: new Date().toISOString(),
  };
}

export function detectAndRecordConflicts(
  existing: IntakeMetadata,
  fieldValues: Record<string, string>,
  source: EvidenceSource,
  allEvidence: Array<{
    source: EvidenceSource;
    values: Record<string, string>;
  }>,
): IntakeMetadata {
  const conflictingFields: IntakeMetadata["conflictingFields"] = [
    ...existing.conflictingFields,
  ];

  for (const priorEvidence of allEvidence) {
    for (const [field, priorValue] of Object.entries(priorEvidence.values)) {
      const incomingValue = fieldValues[field];
      if (
        incomingValue !== undefined &&
        priorValue !== "" &&
        incomingValue !== "" &&
        incomingValue.toLowerCase().trim() !== priorValue.toLowerCase().trim()
      ) {
        const existingConflict = conflictingFields.find(
          (c) => c.field === field,
        );
        if (existingConflict) {
          if (
            !existingConflict.values.some(
              (v) => v.value === incomingValue,
            )
          ) {
            existingConflict.values.push({
              value: incomingValue,
              source: source.transport,
              precedence: TRANSPORT_PRECEDENCE[source.transport],
            });
          }
        } else {
          conflictingFields.push({
            field,
            values: [
              {
                value: priorValue,
                source: priorEvidence.source.transport,
                precedence:
                  TRANSPORT_PRECEDENCE[priorEvidence.source.transport],
              },
              {
                value: incomingValue,
                source: source.transport,
                precedence: TRANSPORT_PRECEDENCE[source.transport],
              },
            ],
          });
        }
      }
    }
  }

  return {
    ...existing,
    conflictingFields,
  };
}

export function shouldUseStrongerValue(
  existingTransport: IntakeTransport,
  incomingTransport: IntakeTransport,
): boolean {
  return (
    TRANSPORT_PRECEDENCE[incomingTransport] <
    TRANSPORT_PRECEDENCE[existingTransport]
  );
}

export function isUnsafeCorrelation(
  a: IntakeMetadata,
  b: IntakeMetadata,
): boolean {
  if (a.providerSubmissionId && b.providerSubmissionId) {
    return a.providerSubmissionId !== b.providerSubmissionId;
  }

  if (
    a.correlationFingerprint === "corr:none" ||
    b.correlationFingerprint === "corr:none"
  ) {
    return true;
  }

  if (a.correlationFingerprint !== b.correlationFingerprint) {
    return true;
  }

  return false;
}