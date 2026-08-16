import { describe, expect, it } from "vitest";
import { decideDraft, prepareDraftDocument } from "../src/mail/drafts.js";

describe("system notification outbound boundary", () => {
  it("does not create a draft candidate", () => {
    const decision = decideDraft("system_notification", {
      fromAddress: "notifications@example.com",
      from: "System Notifications <notifications@example.com>",
      subject: "Operational notification",
    });

    expect(decision.shouldDraft).toBe(false);
    expect(decision.candidate).toBeNull();
    expect(decision.reason).toContain("system_notification");
  });

  it("does not create a reply-draft document", () => {
    const document = prepareDraftDocument("system_notification", {
      fromAddress: "notifications@example.com",
      from: "System Notifications <notifications@example.com>",
      subject: "Operational notification",
    });

    expect(document).toBeNull();
  });
});
