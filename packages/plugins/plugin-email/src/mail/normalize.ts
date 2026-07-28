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

const MAX_BODY_CHARS = 20000;

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

function classify(subject: string, fromAddress: string, body: string): MessageClassHint {
  const s = subject.toLowerCase();
  const b = body.slice(0, 4000).toLowerCase();
  const f = fromAddress.toLowerCase();

  const isWeb3Forms = f.includes("web3forms.com");
  if (isWeb3Forms || s.includes("store submission") || (b.includes("store name") && b.includes("address"))) {
    if (s.includes("claim") || b.includes("claim this listing") || b.includes("role:")) return "listing_claim";
    return "store_submission";
  }
  if (s.includes("claim")) return "listing_claim";
  if (s.includes("alert") || b.includes("restock") || b.includes("notify me")) return "store_alert_signup";
  if (isWeb3Forms && (s.includes("stay in the loop") || s.includes("newsletter"))) return "newsletter_signup";
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
  if (classHint === "intelligence_request" || classHint === "listing_claim") return "high";
  if (classHint === "spam_irrelevant") return "low";
  return "medium";
}

export function issueTitleFor(msg: NormalizedMessage): string {
  const who = msg.from.length > 60 ? msg.fromAddress || msg.from.slice(0, 60) : msg.from;
  return `[Email:${msg.ventureHint}] ${msg.subject} — ${who}`;
}

export function issueDescriptionFor(msg: NormalizedMessage): string {
  return [
    `## Inbound email (connector: ${msg.profileKey})`,
    "",
    `- **From:** ${msg.from}`,
    `- **To:** ${msg.to}`,
    `- **Date:** ${msg.date}`,
    `- **Subject:** ${msg.subject}`,
    `- **Message-ID:** \`${msg.messageId}\``,
    msg.inReplyTo ? `- **In-Reply-To:** \`${msg.inReplyTo}\`` : null,
    `- **Class hint:** \`${msg.classHint}\` (connector heuristic — assign the authoritative class per email-triage-sop)`,
    `- **Venture hint:** \`${msg.ventureHint}\``,
    "",
    "---",
    "",
    msg.bodyText || "_(no text body extracted)_",
    "",
    "---",
    "",
    "Triage per **email-triage-sop**: one class label, one venture label, triage note, route or escalate. Never reply to the sender from this issue — drafts go to the Communications Drafter; only the Board sends.",
  ]
    .filter((line) => line !== null)
    .join("\n");
}
