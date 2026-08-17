import { describe, expect, it } from "vitest";
import { detectSource, normalizeMessage } from "../src/mail/normalize.js";
import { sortIncomingEarly } from "../src/mail/sorter.js";

const INTELLIGENCE_BODY = [
  "Hello,",
  "",
  "A new form has been submitted on your website. Details below.",
  "",
  "Type",
  "",
  "Intelligence",
  "",
  "Source",
  "",
  "Intelligence Page",
  "",
  "Email",
  "",
  "reader@example.com",
  "",
  "This e-mail was sent from",
  "https://thebinmap.com/",
].join("\n");

function normalize(subject: string, bodyText: string) {
  return normalizeMessage({
    uid: 101,
    folder: "INBOX",
    profileKey: "primary",
    envelope: {
      messageId: "real-form-routing@example.com",
      from: [{ name: "Web3Forms", address: "notify+example@web3forms.com" }],
      to: [{ address: "mikebennett637@gmail.com" }],
      subject,
      date: "2026-08-12T15:47:54.000Z",
    },
    bodyText,
  });
}

describe("real portfolio form routing", () => {
  it("routes the real TheBinMap Intelligence waitlist pattern as a non-reply system notification", () => {
    const detection = detectSource(
      "Intelligence waitlist signup",
      "notify+example@web3forms.com",
      INTELLIGENCE_BODY,
    );

    expect(detection).toMatchObject({
      sourceType: "intelligence_signup",
      sourceForm: "thebinmap_intelligence",
      sourcePage: "/intelligence",
      brand: "thebinmap",
      requiresHumanReview: false,
    });

    const message = normalize("Intelligence waitlist signup", INTELLIGENCE_BODY);
    expect(message.classHint).toBe("intelligence_signup");

    const sorted = sortIncomingEarly({
      sourceDetection: detection,
      classHint: message.classHint,
      inReplyTo: null,
      hasReferences: false,
    });

    expect(sorted.category).toBe("system_notification");
    expect(sorted.replyActionStatus).toBe("none");
  });

  it.each([
    {
      label: "city alert",
      subject: "Alert signup — San Antonio, TX",
      source: "city-page",
      expectedPage: "/city",
    },
    {
      label: "store alert",
      subject: "Alert signup — TREASURE 2 HUNT, Newport News, VA",
      source: "store-page",
      expectedPage: "/store",
    },
  ])("preserves the real Web3Forms source for $label", ({ subject, source, expectedPage }) => {
    const body = [
      "Hello,",
      "",
      "A new form has been submitted on your website. Details below.",
      "",
      "Source",
      "",
      source,
      "",
      "Email",
      "",
      "reader@example.com",
      "",
      "This e-mail was sent from",
      "https://thebinmap.com/",
    ].join("\n");

    const detection = detectSource(subject, "notify+example@web3forms.com", body);
    expect(detection).toMatchObject({
      sourceType: "alert_signup",
      sourceForm: "thebinmap_alert",
      sourcePage: expectedPage,
      brand: "thebinmap",
    });

    const message = normalize(subject, body);
    const sorted = sortIncomingEarly({
      sourceDetection: detection,
      classHint: message.classHint,
      inReplyTo: null,
      hasReferences: false,
    });
    expect(sorted.category).toBe("system_notification");
    expect(sorted.replyActionStatus).toBe("none");
  });
});
