import { describe, expect, it } from "vitest";
import { detectSource } from "../src/mail/normalize.js";
import { sortIntakeRecord } from "../src/mail/sorter.js";

function sortTherapistIndex(subject: string, body: string) {
  const detection = detectSource(subject, "notify@therapistindex.com", body);
  const classHint = detection.sourceType === "correction" ? "correction" : "contact_general";
  return {
    detection,
    result: sortIntakeRecord({
      sourceDetection: detection,
      classHint,
      intakeMetadata: null,
      duplicateMatchStrength: null,
      latestVerdict: null,
      hasReplyDraft: false,
      inReplyTo: null,
      hasReferences: false,
    }),
  };
}

describe("TherapistIndex WordPress routing boundary", () => {
  it("keeps a generic contact-form message actionable", () => {
    const { detection, result } = sortTherapistIndex(
      "TherapistIndex: New contact form submission",
      "A user has submitted a contact request",
    );

    expect(detection.sourceForm).toBe("therapist_index");
    expect(detection.sourcePage).toBe("unknown");
    expect(result.category).toBe("general_email");
    expect(result.replyActionStatus).toBe("draft_needed");
  });

  it("routes a known account notification without reply work", () => {
    const { detection, result } = sortTherapistIndex(
      "TherapistIndex - Account activated",
      "Your account has been activated",
    );

    expect(detection.sourcePage).toBe("/account");
    expect(result.category).toBe("system_notification");
    expect(result.replyActionStatus).toBe("none");
  });

  it("routes a known moderation notification without reply work", () => {
    const { detection, result } = sortTherapistIndex(
      "TherapistIndex moderation notification",
      "A new listing requires moderation",
    );

    expect(detection.sourcePage).toBe("/moderation");
    expect(result.category).toBe("system_notification");
    expect(result.replyActionStatus).toBe("none");
  });

  it("keeps correction/removal requests actionable", () => {
    const { detection, result } = sortTherapistIndex(
      "TherapistIndex - Correction request",
      "Please remove my listing, the information is wrong",
    );

    expect(detection.sourceType).toBe("correction");
    expect(result.category).toBe("general_email");
    expect(result.replyActionStatus).toBe("draft_needed");
  });
});
