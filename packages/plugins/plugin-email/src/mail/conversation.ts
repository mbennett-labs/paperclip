import { createHash } from "node:crypto";
import type { DraftCandidate } from "./drafts.js";
import type { IntakeMetadata } from "./intake-metadata.js";
import {
  type IntakeBrand,
  type NormalizedMessage,
  type SourceDetection,
  type StoreIntakeRecord,
} from "./normalize.js";
import type { IntakeSortResult } from "./sorter.js";
import {
  decideConversationPolicy,
  type ConversationState,
  type NextActionKind,
  type RiskAuthorityClass,
} from "./conversation-policies.js";

export const CONVERSATION_RECORD_VERSION = "directory-conversation-v1";

export interface StructuredConversationRecord {
  recordVersion: typeof CONVERSATION_RECORD_VERSION;
  tenant: IntakeBrand;
  mailboxProfileKey: string;
  message: {
    messageId: string;
    subject: string;
    date: string;
    evidenceId: string;
  };
  threadContext: {
    threadKey: string;
    inReplyTo: string | null;
    references: string[];
    matchedPriorIssueId: string | null;
  };
  sender: {
    display: string;
    address: string;
    relationship: "owner_operator" | "customer" | "system" | "unknown";
  };
  entityContext: {
    entityType: "store" | "therapist_listing" | "practice" | "unknown";
    entityName: string | null;
    entityLocator: string | null;
    matchConfidence: number;
    matchReason: string;
  };
  intent: {
    category: string;
    sourceType: string;
    sourceForm: string;
    confidence: number;
  };
  extraction: {
    request: {
      kind: string;
      summary: string;
    };
    facts: Array<{ key: string; value: string; evidence: string; confidence: number }>;
    missingInformation: string[];
  };
  commercialSignal: {
    present: boolean;
    reason: string | null;
  };
  riskAuthorityClass: RiskAuthorityClass;
  state: ConversationState;
  nextAction: {
    kind: NextActionKind;
    label: string;
    reason: string;
    humanApprovalRequired: boolean;
  };
  output: {
    mode: "draft" | "no_action" | "human_gate";
    draft: Pick<DraftCandidate, "kind" | "to" | "subject" | "body" | "reason"> | null;
  };
  evidenceRefs: Array<{ kind: string; ref: string; note: string }>;
  createdAt: string;
}

export interface ConversationRecordInput {
  msg: Pick<NormalizedMessage,
    "messageId" | "profileKey" | "from" | "fromAddress" | "to" | "subject" | "date" |
    "inReplyTo" | "references" | "bodyText" | "classHint" | "evidenceId"
  >;
  detection: SourceDetection;
  sortResult: IntakeSortResult;
  intakeMetadata: IntakeMetadata | null;
  storeIntake: StoreIntakeRecord | null;
  draftCandidate: DraftCandidate | null;
  matchedPriorIssueId?: string | null;
}

const URL_RE = /\bhttps?:\/\/[^\s<>)"]+/i;

function normalizeText(value: string | null | undefined): string | null {
  const trimmed = value?.replace(/\s+/g, " ").trim();
  return trimmed ? trimmed.slice(0, 500) : null;
}

function fieldLine(body: string, labels: string[]): string | null {
  const labelPattern = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const re = new RegExp(`^(?:${labelPattern})\\s*[:\\-]\\s*(.+)$`, "im");
  return normalizeText(re.exec(body)?.[1]);
}

function inferTenant(detection: SourceDetection, msg: ConversationRecordInput["msg"]): IntakeBrand {
  if (detection.brand !== "unknown") return detection.brand;
  const haystack = `${msg.to} ${msg.subject} ${msg.bodyText.slice(0, 2000)}`.toLowerCase();
  if (haystack.includes("thebinmap")) return "thebinmap";
  if (haystack.includes("therapistindex") || haystack.includes("therapist index")) return "therapist_index";
  if (haystack.includes("quantumshield") || haystack.includes("qsl")) return "qsl";
  return "unknown";
}

function inferRelationship(body: string, fromAddress: string): StructuredConversationRecord["sender"]["relationship"] {
  const b = body.toLowerCase();
  if (fromAddress.includes("web3forms.com") || fromAddress.includes("formspree.io") || fromAddress.includes("noreply")) return "system";
  if (/\b(owner|operator|manager|i own|we own|my store|my listing|my practice|our practice)\b/i.test(b)) return "owner_operator";
  if (/\b(customer|shopper|patient|looking for|question)\b/i.test(b)) return "customer";
  return "unknown";
}

function inferIntent(input: ConversationRecordInput, tenant: IntakeBrand): string {
  const text = `${input.msg.subject}\n${input.msg.bodyText}`.toLowerCase();
  if (tenant === "therapist_index" && /\b(remove|delete|take down|delist)\b/.test(text)) return "listing_removal";
  if (/\b(correction|correct|wrong|update|change|edit|fix)\b/.test(text)) return "correction";
  if (input.detection.sourceType === "store_submission") return "store_submission";
  if (input.detection.sourceType === "listing_claim") return "listing_claim";
  if (input.detection.sourceType === "contact") return "contact";
  return input.msg.classHint;
}

function extractFacts(input: ConversationRecordInput, tenant: IntakeBrand): StructuredConversationRecord["extraction"]["facts"] {
  const facts: StructuredConversationRecord["extraction"]["facts"] = [];

  if (input.storeIntake) {
    for (const [key, value] of Object.entries(input.storeIntake.normalizedValues)) {
      if (!value) continue;
      facts.push({
        key,
        value,
        evidence: input.storeIntake.evidenceByField[key] ?? key,
        confidence: input.storeIntake.confidenceByField[key] ?? 0.6,
      });
    }
  }

  if (tenant === "therapist_index") {
    const fields = [
      ["requesterName", ["Name", "Your Name", "Requester"]],
      ["requesterEmail", ["Email", "Your Email", "Requester Email"]],
      ["listingName", ["Listing", "Therapist", "Therapist Name", "Provider", "Practice"]],
      ["listingUrl", ["Listing URL", "Profile URL", "URL"]],
      ["requestedChange", ["Requested Change", "Correction", "Request"]],
      ["reason", ["Reason"]],
    ] as const;
    for (const [key, labels] of fields) {
      const value = fieldLine(input.msg.bodyText, [...labels]);
      if (value) {
        facts.push({ key, value, evidence: `${labels[0]} field`, confidence: 0.75 });
      }
    }
  }

  const url = URL_RE.exec(input.msg.bodyText)?.[0];
  if (url && !facts.some((fact) => fact.value === url)) {
    facts.push({ key: "url", value: url, evidence: "URL found in message body", confidence: 0.6 });
  }

  return facts;
}

function inferEntity(input: ConversationRecordInput, tenant: IntakeBrand, facts: StructuredConversationRecord["extraction"]["facts"]): StructuredConversationRecord["entityContext"] {
  if (tenant === "thebinmap") {
    const storeName = input.storeIntake?.normalizedValues.storeName ?? facts.find((fact) => fact.key === "storeName")?.value ?? null;
    const city = input.storeIntake?.normalizedValues.city;
    const state = input.storeIntake?.normalizedValues.state;
    return {
      entityType: "store",
      entityName: storeName,
      entityLocator: [city, state].filter(Boolean).join(", ") || input.storeIntake?.normalizedValues.address || null,
      matchConfidence: storeName ? 0.75 : 0.3,
      matchReason: storeName ? "Store name extracted from TheBinMap form fields." : "No store name extracted.",
    };
  }

  if (tenant === "therapist_index") {
    const name = facts.find((fact) => fact.key === "listingName")?.value ?? null;
    const locator = facts.find((fact) => fact.key === "listingUrl" || fact.key === "url")?.value ?? null;
    return {
      entityType: "therapist_listing",
      entityName: name,
      entityLocator: locator,
      matchConfidence: name || locator ? 0.65 : 0.25,
      matchReason: name || locator ? "TherapistIndex listing evidence extracted from message." : "No deterministic listing identifier extracted.",
    };
  }

  return {
    entityType: "unknown",
    entityName: null,
    entityLocator: null,
    matchConfidence: 0,
    matchReason: "No tenant entity policy matched.",
  };
}

function inferCommercialSignal(body: string): StructuredConversationRecord["commercialSignal"] {
  if (/\b(advertis|sponsor|partner|wholesale|supplier|pricing|buy|paid|contract)\b/i.test(body)) {
    return { present: true, reason: "Commercial keyword detected in message body." };
  }
  return { present: false, reason: null };
}

function requestSummary(intent: string, entityName: string | null): string {
  if (intent === "store_submission") return `Review submitted store${entityName ? `: ${entityName}` : ""}.`;
  if (intent === "listing_removal") return `Review listing removal request${entityName ? ` for ${entityName}` : ""}.`;
  if (intent === "correction") return `Review requested directory correction${entityName ? ` for ${entityName}` : ""}.`;
  if (intent === "listing_claim") return `Review listing claim${entityName ? ` for ${entityName}` : ""}.`;
  return "Review inbound conversation.";
}

function buildEvidenceRefs(input: ConversationRecordInput, facts: StructuredConversationRecord["extraction"]["facts"]): StructuredConversationRecord["evidenceRefs"] {
  const refs = [
    { kind: "message", ref: input.msg.messageId, note: "Inbound email Message-ID." },
    { kind: "evidence", ref: input.msg.evidenceId, note: "Normalized evidence fingerprint." },
    { kind: "source_detection", ref: input.detection.rulesMatched.join(",") || "none", note: input.detection.evidence.join("; ") || "No source-detection rule evidence." },
  ];
  for (const fact of facts.slice(0, 12)) {
    refs.push({ kind: "fact", ref: `${fact.key}:${createHash("sha1").update(fact.value).digest("hex").slice(0, 12)}`, note: fact.evidence });
  }
  return refs;
}

export function createConversationRecord(input: ConversationRecordInput): StructuredConversationRecord {
  const tenant = inferTenant(input.detection, input.msg);
  const intent = inferIntent(input, tenant);
  const facts = extractFacts(input, tenant);
  const entity = inferEntity(input, tenant, facts);
  const missingInformation = [...new Set([
    ...(input.sortResult.category === "incomplete" ? input.intakeMetadata?.missingFields ?? [] : []),
    ...(tenant === "therapist_index" && !entity.entityName && !entity.entityLocator ? ["listing_identity"] : []),
  ])];
  const commercialSignal = inferCommercialSignal(input.msg.bodyText);
  const policy = decideConversationPolicy({
    tenant,
    sourceType: input.detection.sourceType,
    sortCategory: input.sortResult.category,
    intent,
    hasEntityMatch: entity.matchConfidence >= 0.6,
    missingInformation,
    hasDraftCandidate: input.draftCandidate != null,
    commercialSignal: commercialSignal.present,
    confidence: input.sortResult.classificationConfidence,
  });

  const outputMode = policy.draftPolicy === "no_reply"
    ? "no_action"
    : policy.draftPolicy === "human_gate" && !input.draftCandidate
      ? "human_gate"
      : "draft";

  return {
    recordVersion: CONVERSATION_RECORD_VERSION,
    tenant,
    mailboxProfileKey: input.msg.profileKey,
    message: {
      messageId: input.msg.messageId,
      subject: input.msg.subject,
      date: input.msg.date,
      evidenceId: input.msg.evidenceId,
    },
    threadContext: {
      threadKey: input.msg.inReplyTo ?? input.msg.references[0] ?? input.msg.messageId,
      inReplyTo: input.msg.inReplyTo,
      references: input.msg.references,
      matchedPriorIssueId: input.matchedPriorIssueId ?? null,
    },
    sender: {
      display: input.msg.from,
      address: input.msg.fromAddress,
      relationship: inferRelationship(input.msg.bodyText, input.msg.fromAddress),
    },
    entityContext: entity,
    intent: {
      category: intent,
      sourceType: input.detection.sourceType,
      sourceForm: input.detection.sourceForm,
      confidence: input.sortResult.classificationConfidence,
    },
    extraction: {
      request: {
        kind: intent,
        summary: requestSummary(intent, entity.entityName),
      },
      facts,
      missingInformation,
    },
    commercialSignal,
    riskAuthorityClass: policy.riskAuthorityClass,
    state: policy.state,
    nextAction: policy.nextAction,
    output: {
      mode: outputMode,
      draft: input.draftCandidate
        ? {
            kind: input.draftCandidate.kind,
            to: input.draftCandidate.to,
            subject: input.draftCandidate.subject,
            body: input.draftCandidate.body,
            reason: input.draftCandidate.reason,
          }
        : null,
    },
    evidenceRefs: buildEvidenceRefs(input, facts),
    createdAt: new Date().toISOString(),
  };
}
