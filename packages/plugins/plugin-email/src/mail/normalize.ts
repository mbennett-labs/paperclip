import { createHash } from "node:crypto";
import {
  createIntakeMetadata,
  computeCompleteness,
  type IntakeMetadata,
  type IntakeTransport,
  type RecordCompleteness,
} from "./intake-metadata.js";

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
  | "intelligence_signup"
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

export type SourceType =
  | "store_submission"
  | "listing_claim"
  | "contact"
  | "alert_signup"
  | "newsletter_signup"
  | "intelligence_signup"
  | "qsl_security_review"
  | "qsl_risk_calculator"
  | "therapist_index_message"
  | "provider_marketing"
  | "correction"
  | "unknown";

export type SourceForm =
  | "thebinmap_submit"
  | "thebinmap_claim"
  | "thebinmap_contact"
  | "thebinmap_alert"
  | "thebinmap_newsletter"
  | "thebinmap_intelligence"
  | "qsl_risk_calc"
  | "qsl_security_review_form"
  | "therapist_index"
  | "unknown";

export type IntakeBrand = "thebinmap" | "qsl" | "therapist_index" | "unknown";

export interface SourceDetection {
  sourceType: SourceType;
  sourceForm: SourceForm;
  sourcePage: string;
  brand: IntakeBrand;
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
  intakeMetadata: IntakeMetadata;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_BODY_CHARS = 20000;

const THEBINMAP_SUBMIT_SUBJECT = "New store submission — TheBinMap";
const THEBINMAP_CLAIM_SUBJECT = "Listing claim — TheBinMap";
const THEBINMAP_CONTACT_SUBJECT = "Contact form — TheBinMap";
const THEBINMAP_NEWSLETTER_SUBJECT = "Stay in the loop — TheBinMap";
const THEBINMAP_INTELLIGENCE_SUBJECT = "Intelligence waitlist signup";
const THEBINMAP_ALERT_PREFIX = "New alert signup — TheBinMap";
const THEBINMAP_FOOTER = "https://thebinmap.com/";

const QSL_SECURITY_REVIEW_SUBJECT = "QSL Security Review Request";
const QSL_RISK_CALC_SUBJECT = "QSL Risk Calculator - New Lead";

const THERAPIST_INDEX_SUBJECT_PATTERNS = [
  /^TherapistIndex\b/i,
  /^\[TherapistIndex\]/i,
  /therapistindex\.com/i,
];

const PROVIDER_MARKETING_SUBJECT_PATTERNS = [
  /^welcome/i,
  /^(get|getting) started/i,
  /^(verify|confirm) your (email|account)/i,
  /^your account/i,
  /^account (created|activated)/i,
  /\btips(?: and tricks)?\b/i,
  /pro (?:plan|trial)/i,
  /^upgrade/i,
  /^new feature/i,
  /announcement$/i,
  /^webinar/i,
  /^invitation/i,
  /^please confirm/i,
  /^subscription/i,
  /^billing/i,
];

function isProviderMarketing(subject: string, fromAddress: string): boolean {
  const f = fromAddress.toLowerCase();
  if (!f.includes("web3forms.com") && !f.includes("formspree.io")) return false;
  return PROVIDER_MARKETING_SUBJECT_PATTERNS.some((p) => p.test(subject));
}

function detectTheBinMapAlertSourcePage(body: string): string {
  const source = /\bsource\s+(homepage|city-page|store-page)\b/i.exec(body)?.[1]?.toLowerCase();
  if (source === "homepage") return "/";
  if (source === "city-page") return "/city";
  if (source === "store-page") return "/store";
  return "unknown";
}

function detectBrand(subject: string, fromAddress: string, body: string): IntakeBrand {
  const s = subject.toLowerCase();
  const b = body.slice(0, 4000).toLowerCase();

  if (s.includes("thebinmap") || b.includes("thebinmap")) return "thebinmap";
  if (s.includes("therapistindex") || b.includes("therapistindex.com")) return "therapist_index";
  if (
    s.includes("qsl") || s.includes("quantum shield") ||
    b.includes("quantumshield") || b.includes("qsl risk") ||
    b.includes("qsl security")
  ) return "qsl";

  const f = fromAddress.toLowerCase();
  if (f.endsWith("@thebinmap.com")) return "thebinmap";
  if (f.endsWith("@quantumshield.com") || f.includes("@qsl")) return "qsl";

  return "unknown";
}

export function detectSource(
  subject: string,
  fromAddress: string,
  body: string,
): SourceDetection {
  const s = subject.toLowerCase();
  const b = body.slice(0, 4000).toLowerCase();
  const f = fromAddress.toLowerCase();
  const isWeb3Forms = f.includes("web3forms.com");
  const isFormspree = f.includes("formspree.io");
  const brand = detectBrand(subject, fromAddress, body);

  const detection: SourceDetection = {
    sourceType: "unknown",
    sourceForm: "unknown",
    sourcePage: "unknown",
    brand,
    confidence: 0,
    evidence: [],
    rulesMatched: [],
    requiresHumanReview: true,
  };

  // --- Marketing exclusion (highest priority) ---
  if (isProviderMarketing(subject, fromAddress)) {
    detection.sourceType = "provider_marketing";
    detection.sourceForm = "unknown";
    detection.confidence = 0.85;
    detection.requiresHumanReview = false;
    detection.evidence.push("provider marketing detected by subject pattern");
    detection.rulesMatched.push("provider:marketing");
    return detection;
  }

  // --- TheBinMap: exact subject matches ---
  if (subject === THEBINMAP_SUBMIT_SUBJECT) {
    detection.sourceType = "store_submission";
    detection.sourceForm = "thebinmap_submit";
    detection.sourcePage = "/submit";
    detection.brand = "thebinmap";
    detection.confidence = 0.95;
    detection.evidence.push("subject-line exact match: 'New store submission — TheBinMap'");
    detection.rulesMatched.push("subject-exact:thebinmap_submit");
    detection.requiresHumanReview = false;
    return detection;
  }

  if (subject === THEBINMAP_CLAIM_SUBJECT) {
    detection.sourceType = "listing_claim";
    detection.sourceForm = "thebinmap_claim";
    detection.sourcePage = "/claim";
    detection.brand = "thebinmap";
    detection.confidence = 0.9;
    detection.evidence.push("subject-line exact match: 'Listing claim — TheBinMap'");
    detection.rulesMatched.push("subject-exact:thebinmap_claim");
    detection.requiresHumanReview = false;
    return detection;
  }

  if (subject === THEBINMAP_CONTACT_SUBJECT) {
    detection.sourceType = "contact";
    detection.sourceForm = "thebinmap_contact";
    detection.sourcePage = "/contact";
    detection.brand = "thebinmap";
    detection.confidence = 0.9;
    detection.evidence.push("subject-line exact match: 'Contact form — TheBinMap'");
    detection.rulesMatched.push("subject-exact:thebinmap_contact");
    detection.requiresHumanReview = false;
    return detection;
  }

  if (isWeb3Forms && subject === THEBINMAP_INTELLIGENCE_SUBJECT) {
    detection.sourceType = "intelligence_signup";
    detection.sourceForm = "thebinmap_intelligence";
    detection.sourcePage = "/intelligence";
    detection.brand = "thebinmap";
    detection.confidence = 0.95;
    detection.evidence.push("Web3Forms + exact Intelligence waitlist subject");
    detection.rulesMatched.push("subject-exact:thebinmap_intelligence_signup");
    detection.requiresHumanReview = false;
    return detection;
  }

  if (isWeb3Forms && s.includes("intelligence") && b.includes("intelligence page")) {
    detection.sourceType = "intelligence_signup";
    detection.sourceForm = "thebinmap_intelligence";
    detection.sourcePage = "/intelligence";
    detection.brand = "thebinmap";
    detection.confidence = 0.85;
    detection.evidence.push("Web3Forms + Intelligence Page source evidence");
    detection.rulesMatched.push("web3forms:thebinmap_intelligence_signup");
    detection.requiresHumanReview = false;
    return detection;
  }

  if (subject === THEBINMAP_NEWSLETTER_SUBJECT) {
    detection.sourceType = "newsletter_signup";
    detection.sourceForm = "thebinmap_newsletter";
    detection.sourcePage = "/";
    detection.brand = "thebinmap";
    detection.confidence = 0.9;
    detection.evidence.push("subject-line exact match: 'Stay in the loop — TheBinMap'");
    detection.rulesMatched.push("subject-exact:thebinmap_newsletter");
    detection.requiresHumanReview = false;
    return detection;
  }

  // --- TheBinMap: alert signup ---
  if (subject.startsWith(THEBINMAP_ALERT_PREFIX)) {
    detection.sourceType = "alert_signup";
    detection.sourceForm = "thebinmap_alert";
    detection.sourcePage = subject.includes("— TheBinMap") ? "/" : "/store";
    detection.brand = "thebinmap";
    detection.confidence = 0.9;
    detection.evidence.push("subject-line exact match: 'New alert signup — TheBinMap'");
    detection.rulesMatched.push("subject-exact:thebinmap_alert");
    detection.requiresHumanReview = false;
    return detection;
  }

  if (isWeb3Forms && (s.includes("alert signup") || s.startsWith("alert signup"))) {
    detection.sourceType = "alert_signup";
    detection.sourceForm = "thebinmap_alert";
    detection.sourcePage = detectTheBinMapAlertSourcePage(body);
    detection.brand = "thebinmap";
    detection.confidence = 0.8;
    detection.evidence.push("Web3Forms sender + alert signup subject pattern");
    detection.rulesMatched.push("web3forms:alert_signup");
    return detection;
  }

  // --- TheBinMap: Web3Forms generic subject matches ---
  if (isWeb3Forms && s.includes("store submission")) {
    detection.sourceType = "store_submission";
    detection.sourceForm = "thebinmap_submit";
    detection.sourcePage = "/submit";
    detection.brand = "thebinmap";
    detection.confidence = 0.8;
    detection.evidence.push("Web3Forms sender + 'store submission' in subject");
    detection.rulesMatched.push("web3forms:store_submission_subject");
    return detection;
  }
  if (isWeb3Forms && s.includes("listing claim")) {
    detection.sourceType = "listing_claim";
    detection.sourceForm = "thebinmap_claim";
    detection.sourcePage = "unknown";
    detection.brand = "thebinmap";
    detection.confidence = 0.8;
    detection.evidence.push("Web3Forms sender + listing-claim subject pattern");
    detection.rulesMatched.push("web3forms:thebinmap_claim_pattern");
    return detection;
  }

  if (
    brand === "thebinmap" &&
    (s.includes("correction") || /\b(wrong|update|change|edit|fix)\b/.test(b))
  ) {
    detection.sourceType = "correction";
    detection.sourceForm = "thebinmap_contact";
    detection.sourcePage = "unknown";
    detection.brand = "thebinmap";
    detection.confidence = 0.75;
    detection.evidence.push("TheBinMap brand + correction/update language");
    detection.rulesMatched.push("brand:thebinmap_correction");
    return detection;
  }

  if (isWeb3Forms && (s.includes("stay in the loop") || s.includes("newsletter"))) {
    detection.sourceType = "newsletter_signup";
    detection.sourceForm = "thebinmap_newsletter";
    detection.sourcePage = "/";
    detection.brand = "thebinmap";
    detection.confidence = 0.8;
    detection.evidence.push("Web3Forms sender + newsletter/loop subject");
    detection.rulesMatched.push("web3forms:newsletter");
    return detection;
  }

  // --- TheBinMap: body-based detection ---
  if (b.includes("store name") && b.includes(THEBINMAP_FOOTER)) {
    detection.sourceType = "store_submission";
    detection.sourceForm = "thebinmap_submit";
    detection.sourcePage = "/submit";
    detection.brand = "thebinmap";
    detection.confidence = 0.75;
    detection.evidence.push("body contains store-name field + TheBinMap footer URL");
    detection.rulesMatched.push("body-fields:thebinmap_submit_footer");
    return detection;
  }

  if (b.includes("store name") && b.includes("city") && b.includes("restock")) {
    detection.sourceType = "store_submission";
    detection.sourceForm = "thebinmap_submit";
    detection.sourcePage = "/submit";
    detection.brand = "thebinmap";
    detection.confidence = 0.6;
    detection.evidence.push("body contains store-name + city + restock field combination");
    detection.rulesMatched.push("body-fields:thebinmap_submit_combo");
    return detection;
  }

  // --- QSL: Formspree forms ---
  if ((isFormspree || f.includes("qsl") || b.includes("quantumshield") || b.includes("qsl ")) &&
      subject === QSL_SECURITY_REVIEW_SUBJECT) {
    detection.sourceType = "qsl_security_review";
    detection.sourceForm = "qsl_security_review_form";
    detection.sourcePage = "/security-review";
    detection.brand = "qsl";
    detection.confidence = 0.95;
    detection.evidence.push("subject-line exact match: 'QSL Security Review Request'");
    detection.rulesMatched.push("subject-exact:qsl_security_review");
    detection.requiresHumanReview = false;
    return detection;
  }

  if ((isFormspree || f.includes("qsl") || b.includes("quantumshield") || b.includes("qsl ")) &&
      (subject === QSL_RISK_CALC_SUBJECT || s.includes("risk calculator"))) {
    detection.sourceType = "qsl_risk_calculator";
    detection.sourceForm = "qsl_risk_calc";
    detection.sourcePage = "/risk-calculator";
    detection.brand = "qsl";
    detection.confidence = 0.95;
    detection.evidence.push("subject-line match: QSL Risk Calculator lead");
    detection.rulesMatched.push("subject-exact:qsl_risk_calc");
    detection.requiresHumanReview = false;
    return detection;
  }

  if (isFormspree && (s.includes("security review") || b.includes("security review"))) {
    detection.sourceType = "qsl_security_review";
    detection.sourceForm = "qsl_security_review_form";
    detection.sourcePage = "/security-review";
    detection.brand = "qsl";
    detection.confidence = 0.7;
    detection.evidence.push("Formspree sender + security review mention");
    detection.rulesMatched.push("formspree:security_review");
    return detection;
  }

  if (isFormspree && b.includes("risk_score")) {
    detection.sourceType = "qsl_risk_calculator";
    detection.sourceForm = "qsl_risk_calc";
    detection.sourcePage = "/risk-calculator";
    detection.brand = "qsl";
    detection.confidence = 0.8;
    detection.evidence.push("Formspree sender + risk_score field in body");
    detection.rulesMatched.push("formspree:risk_calc_fields");
    return detection;
  }

  // --- TherapistIndex ---
  if (THERAPIST_INDEX_SUBJECT_PATTERNS.some((p) => p.test(subject)) ||
      b.includes("therapistindex.com") ||
      b.includes("therapist index")) {
    const isModeration = s.includes("moderation") || b.includes("moderation");
    const isAccount = s.includes("account created") || s.includes("account activated") || s.includes("activation");
    const isSEO = s.includes("seo") || b.includes("seo") || s.includes("system notification") || b.includes("system notification");
    const isCorrection = s.includes("correction") || s.includes("removal") || b.includes("remove listing") || b.includes("wrong information");

    if (isCorrection) {
      detection.sourceType = "correction";
      detection.sourceForm = "therapist_index";
      detection.sourcePage = "unknown";
    } else if (isModeration) {
      detection.sourceType = "contact";
      detection.sourceForm = "therapist_index";
      detection.sourcePage = "/moderation";
    } else if (isAccount) {
      detection.sourceType = "contact";
      detection.sourceForm = "therapist_index";
      detection.sourcePage = "/account";
    } else if (isSEO || detection.brand === "therapist_index") {
      detection.sourceType = "contact";
      detection.sourceForm = "therapist_index";
      detection.sourcePage = "unknown";
    } else {
    }
    detection.brand = "therapist_index";
    detection.confidence = detection.sourceType !== "unknown" ? 0.8 : 0.7;
    detection.evidence.push("TherapistIndex brand + subject/body pattern match");
    detection.rulesMatched.push("brand:therapist_index");
    detection.requiresHumanReview = false;
    return detection;
  }

  return detection;
}

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
// Store-intake extraction
// ---------------------------------------------------------------------------

export function extractStoreIntake(
  msg: NormalizedMessage,
  detection: SourceDetection,
  sourceIssueId: string,
): StoreIntakeRecord | null {
  if (detection.sourceType !== "store_submission" || !["thebinmap_submit", "unknown"].includes(detection.sourceForm)) {
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

  // Compute fields present for intake metadata
  const fieldsPresent = STORE_INTAKE_FIELDS.filter(
    (f) => originalValues[f] && originalValues[f].trim() !== "",
  );

  const intakeMetadata = createIntakeMetadata({
    transport: "email_notification",
    evidenceRefId: msg.evidenceId,
    fieldsPresent,
    totalPossibleFields: STORE_INTAKE_FIELDS.length,
    emailMessageId: msg.messageId,
    providerSubmissionId: undefined,
  });

  intakeMetadata.missingFields = [...missingFields];

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
    intakeMetadata,
  };
}

// ---------------------------------------------------------------------------
// Classification (existing, updated with source detection)
// ---------------------------------------------------------------------------

function classify(subject: string, fromAddress: string, body: string): MessageClassHint {
  const detection = detectSource(subject, fromAddress, body);

  if (detection.sourceType === "provider_marketing") return "spam_irrelevant";
  if (detection.sourceType === "store_submission") return "store_submission";
  if (detection.sourceType === "listing_claim") return "listing_claim";
  if (detection.sourceType === "alert_signup") return "store_alert_signup";
  if (detection.sourceType === "newsletter_signup") return "newsletter_signup";
  if (detection.sourceType === "intelligence_signup") return "intelligence_signup";
  if (detection.sourceType === "qsl_security_review") return "support_request";
  if (detection.sourceType === "qsl_risk_calculator") return "sales_opportunity";
  if (detection.sourceType === "correction") return "correction";
  if (detection.sourceType === "contact") return "contact_general";

  if (detection.brand === "therapist_index") return "contact_general";

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
  if (subject.toLowerCase().includes("qsl") || body.slice(0, 2000).toLowerCase().includes("qsl")) return "qsl";
  if (subject.toLowerCase().includes("therapistindex") || body.slice(0, 2000).toLowerCase().includes("therapistindex")) return "therapist_index";
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
    : detection.sourceType === "alert_signup" ? "[Alert Signup]"
    : detection.sourceType === "newsletter_signup" ? "[Newsletter]"
    : detection.sourceType === "intelligence_signup" ? "[Intelligence Signup]"
    : detection.sourceType === "qsl_security_review" ? "[QSL Security Review]"
    : detection.sourceType === "qsl_risk_calculator" ? "[QSL Risk Lead]"
    : detection.sourceType === "provider_marketing" ? "[Marketing]"
    : detection.brand === "therapist_index" ? "[TherapistIndex]"
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
