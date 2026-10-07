import { simpleParser } from "mailparser";

function htmlToPlainText(html: string): string {
  return html
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/**
 * Parse an RFC822/MIME message and return the human-readable body.
 *
 * Prefer text/plain. HTML-only messages receive a conservative plain-text
 * fallback. MIME boundaries, part headers, transfer encoding, and attachments
 * are never passed downstream as the email body.
 */
export async function extractMimeText(source: Buffer): Promise<string> {
  const parsed = await simpleParser(source);

  if (typeof parsed.text === "string" && parsed.text.trim()) {
    return parsed.text.trim();
  }

  if (typeof parsed.html === "string" && parsed.html.trim()) {
    return htmlToPlainText(parsed.html);
  }

  return "";
}
