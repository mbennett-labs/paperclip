import { createHash } from "node:crypto";

/**
 * Message normalization and heuristic classification for the QSL Email Company.
 *
 * Hints only. The Intake Triage agent assigns the authoritative class and
 * venture on the issue; these hints pre-label for routing and metrics.
 */

export type NormalizedMessage = {
  messageId: string;
  uid: number;
  folder: string;
  profileKey: string;
  from: string;
  fromAddress: string;
  to: string;
  subject: string;
  date: string;
  inReplyTo: string | null;
  references: string[];
  bodyText: string;
  snippet: string;
  classHint: MessageClassHint;
  ventureHint: string;
  rawHeaders: string;
  evidenceId: string;
};

export type MessageClassHint =
  | "store_submission"
  | "listing_claim"
  | "store_alert_signup"
  | "newsletter_signup"
  | "intelligence_request"
  | "contact_general"
  | "partnership_affiliate"
  | "spam_irrelevant"
  | "correction"
  | "customer_inquiry"
  | "sales_opportunity"
  | "support_request"
  | "unknown";

// ---------------------------------------------------------------------------
// Form-source detection types
// ---------------------------------------------------------------------------

export type SourceType = "store_submission" | "listing_claim" | "contact" | "unknown";

export type SourceForm = "thebinmap_submit" | "unknown";

export interface SourceDetection {
  sourceType: SourceType;
  sourceForm: SourceForm;
  sourcePage: string;
  confidence: number;
  evidence: string[];
  rulesMatched: string[];
  requiresHumanReview: boolean;
}

// ---------------------------------------------------------------------------
// Store-intake record types
// ---------------------------------------------------------------------------

export interface StoreIntakeRecord {
  recordType: "store_intake";
  sourceIssueId: string;
  sourceType: SourceType;
  sourceForm: SourceForm;
  sourcePage: string;
  category: string;
  priority: string;
  status: string;
  originalValues: Record<string, string>;
  normalizedValues: Record<string, string>;
  confidenceByField: Record<string, number>;
  evidenceByField: Record<string, string>;
  missingFields: string[];
  duplicateCandidates: Array<{ name: string; reason: string }>;
  requiresHumanReview: boolean;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_BODY_CHARS = 20000;

const THEBINMAP_SUBMIT_SUBJECT = "New store submission — TheBinMap";
const THEBINMAP_CLAIM_SUBJECT = "Listing claim — TheBinMap";
const THEBINMAP_CONTACT_SUBJECT = "Contact form — TheBinMap";
const THEBINMAP_SUBMIT_SENDER = "TheBinMap Submit Form";
const THEBINMAP_FOOTER = "https://thebinmap.com/";

const STORE_INTAKE_FIELDS = [
  "storeName",
  "address",
  "city",
  "state",
  "postalCode",
  "phone",
  "website",
  "facebookUrl",
  "otherSocialUrl",
  "submitterName",
  "submitterEmail",
  "submitterRelationship",
  "restockDays",
  "pricingSchedule",
  "description",
] as const;

type StoreIntakeField = (typeof STORE_INTAKE_FIELDS)[number];

interface BodyFieldPattern {
  key: StoreIntakeField;
  patterns: RegExp[];
}

const FIELD_EXTRACTORS: BodyFieldPattern[] = [
  { key: "storeName", patterns: [/store name[:\s]+(.+)/i, /^(.+ store|.+ bin.*store)$/im] },
  { key: "address", patterns: [/address[:\s]+(.+)/i, /^(address\s*\n)(.+)$/im] },
  { key: "city", patterns: [/city[:\s]+(.+)/i] },
  { key: "state", patterns: [/state[:\s]+(.+)/i, /\b(TN|FL|CA|TX|NY|OH|PA|IL|GA|NC|MI|NJ|VA|WA|AZ|MA|IN|MO|MD|WI|CO|MN|SC|AL|LA|KY|OR|OK|CT|IA|MS|AR|KS|UT|NV|NM|NE|WV|ID|HI|NH|ME|MT|RI|DE|SD|AK|ND|VT|WY|DC)\b/i] },
  { key: "restockDays", patterns: [/restock.*?[:\s]+(.+)/i, /restock schedule[:\s]+(.+)/i] },
  { key: "submitterEmail", patterns: [/your email[:\s]+(.+)/i, /submitter email[:\s]+(.+)/i, /([\w.+-]+@[\w-]+\.[\w.-]+)/i] },
];

function decodeAddrList(input: unknown): string {
  if (!input) return "";
  if (Array.isArray(input)) {
    return input
      .map((a) => {
        const rec = a as { name?: string; address?: string; mailbox?: string; host?: string };
        const addr = rec.address ?? (rec.mailbox && rec.host ? `${rec.mailbox}@${rec.host}` : "");
        return rec.name ? `${rec.name} <${addr}>` : addr;
      })
      .filter(Boolean)
      .join(", ");
  }
  return String(input);
}

export function firstAddress(input: string): string {
  const match = input.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  return match ? match[0].toLowerCase() : "";
}

// ---------------------------------------------------------------------------
// Deterministic form-source detection
// ---------------------------------------------------------------------------

export function detectSource(
  subject: string,
  fromAddress: string,
  body: string,
): SourceDetection {
  const s = subject.toLowerCase();
  const b = body.slice(0, 4000).toLowerCase();
  const f = fromAddress.toLowerCase();
  const isWeb3Forms = f.includes("web3forms.com");

  const detection: SourceDetection = {
    sourceType: "unknown",
    sourceForm: "unknown",
    sourcePage: "unknown",
    confidence: 0,
    evidence: [],
    rulesMatched: [],
    requiresHumanReview: true,
  };

  // Rule 1: Exact subject-line match (strongest signal)
  if (subject === THEBINMAP_SUBMIT_SUBJECT) {
    detection.sourceType = "store_submission";
    detection.sourceForm = "thebinmap_submit";
    detection.sourcePage = "/submit";
    detection.confidence = 0.95;
    detection.evidence.push("subject-line exact match: 'New store submission — TheBinMap'");
    detection.rulesMatched.push("subject-exact:thebinmap_submit");
    detection.requiresHumanReview = false;
    return detection;
  }

  // Rule 2: Subject + body field-name combination
  if (subject === THEBINMAP_CLAIM_SUBJECT) {
    detection.sourceType = "listing_claim";
    detection.sourceForm = "unknown";
    detection.sourcePage = "unknown";
    detection.confidence = 0.9;
    detection.evidence.push("subject-line exact match: 'Listing claim — TheBinMap'");
    detection.rulesMatched.push("subject-exact:thebinmap_claim");
    detection.requiresHumanReview = false;
    return detection;
  }

  if (subject === THEBINMAP_CONTACT_SUBJECT) {
    detection.sourceType = "contact";
    detection.sourceForm = "unknown";
    detection.sourcePage = "unknown";
    detection.confidence = 0.9;
    detection.evidence.push("subject-line exact match: 'Contact form — TheBinMap'");
    detection.rulesMatched.push("subject-exact:thebinmap_contact");
    detection.requiresHumanReview = false;
    return detection;
  }

  // Rule 3: Web3Forms sender + explicit "store submission" in subject (strong signal only)
  if (isWeb3Forms && s.includes("store submission")) {
    detection.sourceType = "store_submission";
    detection.sourceForm = "thebinmap_submit";
    detection.sourcePage = "/submit";
    detection.confidence = 0.8;
    detection.evidence.push("Web3Forms sender + 'store submission' in subject");
    detection.rulesMatched.push("web3forms:store_submission_subject");
    return detection;
  }
  if (isWeb3Forms && s.includes("listing claim")) {
    detection.sourceType = "listing_claim";
    detection.sourceForm = "unknown";
    detection.sourcePage = "unknown";
    detection.confidence = 0.8;
    detection.evidence.push("Web3Forms sender + listing-claim subject pattern");
    detection.rulesMatched.push("web3forms:thebinmap_claim_pattern");
    return detection;
  }

  // Rule 4: Body contains known submit-form field names + TheBinMap footer
  if (b.includes("store name") && b.includes(THEBINMAP_FOOTER)) {
    detection.sourceType = "store_submission";
    detection.sourceForm = "thebinmap_submit";
    detection.sourcePage = "/submit";
    detection.confidence = 0.75;
    detection.evidence.push("body contains store-name field + TheBinMap footer URL");
    detection.rulesMatched.push("body-fields:thebinmap_submit_footer");
    return detection;
  }

  // Rule 5: Body contains known submit-form field combination
  if (b.includes("store name") && b.includes("city") && b.includes("restock")) {
    detection.sourceType = "store_submission";
    detection.sourceForm = "thebinmap_submit";
    detection.sourcePage = "/submit";
    detection.confidence = 0.6;
    detection.evidence.push("body contains store-name + city + restock field combination");
    detection.rulesMatched.push("body-fields:thebinmap_submit_combo");
    return detection;
  }

  return detection;
}

// ---------------------------------------------------------------------------
// Store-intake extraction
// ---------------------------------------------------------------------------

export function extractStoreIntake(
  msg: NormalizedMessage,
  detection: SourceDetection,
  sourceIssueId: string,
): StoreIntakeRecord | null {
  if (detection.sourceType !== "store_submission" || detection.sourceForm !== "thebinmap_submit") {
    return null;
  }

  const now = new Date().toISOString();
  const originalValues: Record<string, string> = {};
  const normalizedValues: Record<string, string> = {};
  const confidenceByField: Record<string, number> = {};
  const evidenceByField: Record<string, string> = {};
  const missingFields: string[] = [];
  const duplicateCandidates: Array<{ name: string; reason: string }> = [];

  const lines = msg.bodyText.split("\n");

  for (const field of FIELD_EXTRACTORS) {
    let found = false;
    for (const pattern of field.patterns) {
      for (const line of lines) {
        const match = line.match(pattern);
        if (match && match[1]?.trim()) {
          const value = match[1].trim();
          originalValues[field.key] = value;
          normalizedValues[field.key] = value
            .replace(/"/g, "'")
            .replace(/[\n\r]+/g, ", ")
            .trim()
            .slice(0, 500);
          confidenceByField[field.key] = 0.7;
          evidenceByField[field.key] = line.trim().slice(0, 200);
          found = true;
          break;
        }
      }
      if (found) break;
    }
    if (!found) {
      originalValues[field.key] = "";
      missingFields.push(field.key);
    }
  }

  // Check for state abbreviation in body
  if (!originalValues.state) {
    const stateMatch = msg.bodyText.match(/\b(TN|FL|CA|TX|NY|OH|PA|IL|GA|NC|MI|NJ|VA|WA|AZ|MA|IN|MO|MD|WI|CO|MN|SC|AL|LA|KY|OR|OK|CT|IA|MS|AR|KS|UT|NV|NM|NE|WV|ID|HI|NH|ME|MT|RI|DE|SD|AK|ND|VT|WY|DC)\b/i);
    if (stateMatch) {
      originalValues.state = stateMatch[1].toUpperCase();
      normalizedValues.state = stateMatch[1].toUpperCase();
      confidenceByField.state = 0.5;
      evidenceByField.state = `found in body: ${stateMatch[0]}`;
    }
  }

  // Classify store type if present
  const b = msg.bodyText.toLowerCase();
  if (b.includes("bin store") || b.includes("bin-store")) {
    normalizedValues.storeType = "bin-store";
  } else if (b.includes("liquidation")) {
    normalizedValues.storeType = "liquidation";
  } else if (b.includes("discount")) {
    normalizedValues.storeType = "discount";
  } else if (b.includes("amazon returns")) {
    normalizedValues.storeType = "amazon-returns";
  }

  return {
    recordType: "store_intake",
    sourceIssueId,
    sourceType: detection.sourceType,
    sourceForm: detection.sourceForm,
    sourcePage: detection.sourcePage,
    category: "store_submission",
    priority: "high",
    status: "needs_review",
    originalValues,
    normalizedValues,
    confidenceByField,
    evidenceByField,
    missingFields,
    duplicateCandidates,
    requiresHumanReview: false,
    createdAt: now,
    updatedAt: now,
  };
}

// ---------------------------------------------------------------------------
// Classification (existing, updated with source detection)
// ---------------------------------------------------------------------------

function classify(subject: string, fromAddress: string, body: string): MessageClassHint {
  const detection = detectSource(subject, fromAddress, body);

  if (detection.sourceType === "store_submission") return "store_submission";
  if (detection.sourceType === "listing_claim") return "listing_claim";
  if (detection.sourceType === "contact") return "contact_general";

  const s = subject.toLowerCase();
  const b = body.slice(0, 4000).toLowerCase();
  const f = fromAddress.toLowerCase();

  const isWeb3Forms = f.includes("web3forms.com");
  if (s.includes("store submission") && (b.includes("store name") && b.includes("address"))) {
    if (s.includes("claim") || b.includes("claim this listing") || b.includes("role:")) return "listing_claim";
    return "store_submission";
  }
  if (isWeb3Forms && (s.includes("stay in the loop") || s.includes("newsletter"))) return "newsletter_signup";
  if (s.includes("claim")) return "listing_claim";
  if (s.includes("alert") || b.includes("restock") || b.includes("notify me")) return "store_alert_signup";
  if (s.includes("newsletter") || s.includes("subscribe") || s.includes("stay in the loop")) return "newsletter_signup";
  if (s.includes("intelligence") || b.includes("intelligence request") || s.includes("data report")) return "intelligence_request";
  if (s.includes("affiliate") || s.includes("partner") || s.includes("wholesale") || s.includes("supplier")) return "partnership_affiliate";
  if (s.includes("correction") || b.includes("wrong") || b.includes("error")) return "correction";
  if (s.includes("customer") || b.includes("order")) return "customer_inquiry";
  if (s.includes("sales") || b.includes("opportunity")) return "sales_opportunity";
  if (s.includes("support") || b.includes("help")) return "support_request";
  if (s.includes("spam") || b.includes("unsubscribe")) return "spam_irrelevant";
  if (s.includes("contact") || s.includes("question") || s.includes("inquiry") || s.includes("hello")) return "contact_general";
  return "unknown";
}

function ventureOf(to: string, fromAddress: string, subject: string, body: string): string {
  const t = to.toLowerCase();
  if (t.includes("@thebinmap.com")) return "thebinmap";
  if (fromAddress.endsWith("@thebinmap.com")) return "thebinmap";
  if (subject.toLowerCase().includes("thebinmap") || body.slice(0, 2000).toLowerCase().includes("thebinmap")) return "thebinmap";
  if (t.includes("@quantumshield") || t.includes("@qsl")) return "qsl";
  return "unknown";
}

export function normalizeMessage(input: {
  uid: number;
  folder: string;
  profileKey: string;
  envelope: {
    messageId?: string;
    from?: unknown;
    to?: unknown;
    subject?: string;
    date?: Date | string;
    inReplyTo?: string;
    references?: string[] | string;
    raw?: string;
  };
  bodyText: string;
}): NormalizedMessage {
  const { envelope } = input;
  const from = decodeAddrList(envelope.from);
  const to = decodeAddrList(envelope.to);
  const subject = (envelope.subject ?? "(no subject)").trim() || "(no subject)";
  const body = input.bodyText.replace(/\r\n/g, "\n").trim();
  const truncated = body.length > MAX_BODY_CHARS ? `${body.slice(0, MAX_BODY_CHARS)}\n\n[truncated]` : body;
  const references = Array.isArray(envelope.references)
    ? envelope.references
    : typeof envelope.references === "string"
      ? envelope.references.split(/\s+/).filter(Boolean)
      : [];
  const messageId = envelope.messageId?.trim() || `uid-${input.uid}@${input.profileKey}`;
  const fromAddress = firstAddress(from);
  const evidenceId = `ev-${createHash("sha1").update(`${messageId}:${input.profileKey}`).digest("hex")}`;

  return {
    messageId,
    uid: input.uid,
    folder: input.folder,
    profileKey: input.profileKey,
    from,
    fromAddress,
    to,
    subject,
    date: envelope.date ? new Date(envelope.date).toISOString() : new Date().toISOString(),
    inReplyTo: envelope.inReplyTo?.trim() || null,
    references,
    bodyText: truncated,
    snippet: body.slice(0, 280),
    classHint: classify(subject, fromAddress, body),
    ventureHint: ventureOf(to, fromAddress, subject, body),
    rawHeaders: envelope.raw || "",
    evidenceId,
  };
}

export function priorityFor(classHint: MessageClassHint): "low" | "medium" | "high" {
  if (classHint === "intelligence_request" || classHint === "listing_claim" || classHint === "store_submission") return "high";
  if (classHint === "spam_irrelevant") return "low";
  return "medium";
}

export function issueTitleFor(msg: NormalizedMessage): string {
  const detection = detectSource(msg.subject, msg.fromAddress, msg.bodyText);
  const who = msg.from.length > 60 ? msg.fromAddress || msg.from.slice(0, 60) : msg.from;
  const prefix = detection.sourceType === "store_submission" ? "[Store Submission]"
    : detection.sourceType === "listing_claim" ? "[Listing Claim]"
    : `[Email:${msg.ventureHint}]`;
  return `${prefix} ${msg.subject} — ${who}`;
}

export function issueDescriptionFor(msg: NormalizedMessage): string {
  const detection = detectSource(msg.subject, msg.fromAddress, msg.bodyText);
  const intake = detection.sourceType === "store_submission" ? extractStoreIntake(msg, detection, "") : null;

  const lines: (string | null)[] = [
    `## Inbound email (connector: ${msg.profileKey})`,
    "",
    `- **Date:** ${msg.date}`,
    `- **Subject:** ${msg.subject}`,
    `- **Class hint:** \`${msg.classHint}\` (connector heuristic — assign the authoritative class per email-triage-sop)`,
    `- **Venture hint:** \`${msg.ventureHint}\``,
    `- **Evidence ref:** \`${msg.evidenceId}\``,
  ];

  if (detection.sourceType !== "unknown") {
    lines.push("", "## Source Detection", "");
    lines.push(`- **Source Type:** \`${detection.sourceType}\``);
    lines.push(`- **Source Form:** \`${detection.sourceForm}\``);
    lines.push(`- **Source Page:** \`${detection.sourcePage}\``);
    lines.push(`- **Confidence:** ${detection.confidence}`);
    lines.push(`- **Evidence:** ${detection.evidence.join("; ")}`);
  }

  if (intake) {
    lines.push("", "## Store Intake Record", "");
    lines.push(`- **Status:** \`${intake.status}\``);
    lines.push(`- **Priority:** \`${intake.priority}\``);
    lines.push(`- **Category:** \`${intake.category}\``);
    lines.push("", "### Extracted Fields", "");
    const safeFields = ["storeName", "address", "city", "state", "postalCode", "website", "facebookUrl", "otherSocialUrl", "restockDays", "pricingSchedule"];
    for (const f of safeFields) {
      if (intake.originalValues[f]) {
        lines.push(`- **${f}:** ${intake.originalValues[f]}${intake.confidenceByField[f] ? ` (confidence: ${intake.confidenceByField[f]})` : ""}`);
      }
    }
    if (intake.missingFields.length > 0) {
      lines.push("", "### Missing Fields", "");
      for (const f of intake.missingFields) {
        if (safeFields.includes(f)) {
          lines.push(`- ${f}`);
        }
      }
    }
    lines.push("", "> **Operational summary:** Store submission from " + detection.sourceForm + " (" + detection.sourcePage + "). Use the governed Store Intake tab for full review, duplicate matching, and human verdict. Do not expose raw message body, submitter contact, or provider identifiers in this description.");
  } else {
    lines.push("", "---", "", msg.snippet + (msg.bodyText.length > msg.snippet.length ? "..." : ""), "", "---", "",
      "Triage per **email-triage-sop**: one class label, one venture label, triage note, route or escalate. Never reply to the sender from this issue — drafts go to the Communications Drafter; only the Board sends.");
  }

  return lines.filter((line) => line !== null).join("\n");
}
