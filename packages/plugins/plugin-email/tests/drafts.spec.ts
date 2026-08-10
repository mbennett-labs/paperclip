import { describe, expect, it } from "vitest";
import {
  decideDraft,
  prepareDraftDocument,
  formatDraftDocument,
  type DraftCandidate,
} from "../src/mail/drafts.js";
import type { IntakeSortCategory } from "../src/mail/sorter.js";
import { DRAFT_FIXTURES } from "./fixtures/synthetic-messages.js";

// ---------------------------------------------------------------------------
// Draft decision fixtures
// ---------------------------------------------------------------------------

describe("decideDraft — all fixture scenarios", () => {
  it.each(DRAFT_FIXTURES)(
    "[$id] $description",
    (fixture) => {
      const decision = decideDraft(
        fixture.sortCategory,
        {
          fromAddress: fixture.fromAddress,
          from: fixture.from,
          subject: fixture.subject,
        },
      );

      expect(decision.shouldDraft).toBe(fixture.expectedShouldDraft);
      if (fixture.expectedDraftKind) {
        expect(decision.candidate?.kind).toBe(fixture.expectedDraftKind);
      } else {
        expect(decision.candidate).toBeNull();
      }

      if (decision.shouldDraft && decision.candidate) {
        expect(decision.candidate.to).toBe(fixture.fromAddress);
        for (const text of fixture.expectedContainsText) {
          expect(decision.candidate.body).toContain(text);
        }
        for (const text of fixture.expectedNotContainsText) {
          expect(decision.candidate.body).not.toContain(text);
        }
      }
    },
  );
});

describe("decideDraft — safety invariants", () => {
  it("never drafts for spam", () => {
    const decision = decideDraft("spam_irrelevant", {
      fromAddress: "spam@example.com",
      from: "Spammer",
      subject: "Buy now",
    });
    expect(decision.shouldDraft).toBe(false);
    expect(decision.candidate).toBeNull();
  });

  it("never drafts for duplicate", () => {
    const decision = decideDraft("duplicate", {
      fromAddress: "dup@example.com",
      from: "Duplicate",
      subject: "Another one",
    });
    expect(decision.shouldDraft).toBe(false);
    expect(decision.candidate).toBeNull();
  });

  it("never drafts for unknown", () => {
    const decision = decideDraft("unknown", {
      fromAddress: "mystery@example.com",
      from: "Mystery",
      subject: "???",
    });
    expect(decision.shouldDraft).toBe(false);
    expect(decision.candidate).toBeNull();
  });

  it("fails closed when fromAddress is empty", () => {
    const decision = decideDraft("general_email", {
      fromAddress: "",
      from: "",
      subject: "Test",
    });
    expect(decision.shouldDraft).toBe(false);
    expect(decision.candidate).toBeNull();
    expect(decision.reason).toContain("No recipient");
  });

  it("drafts for incomplete submission", () => {
    const decision = decideDraft("incomplete", {
      fromAddress: "submitter@example.com",
      from: "Submitter",
      subject: "New store submission — TheBinMap",
    });
    expect(decision.shouldDraft).toBe(true);
    expect(decision.candidate?.kind).toBe("clarification_request");
  });

  it("drafts acknowledgment for store submission", () => {
    const decision = decideDraft("store_submission", {
      fromAddress: "owner@store.example",
      from: "Store Owner",
      subject: "New store submission — TheBinMap",
    });
    expect(decision.shouldDraft).toBe(true);
    expect(decision.candidate?.kind).toBe("acknowledgment");
  });

  it("drafts general reply for contact/inquiry", () => {
    const decision = decideDraft("general_email", {
      fromAddress: "person@example.com",
      from: "Person",
      subject: "Question about service",
    });
    expect(decision.shouldDraft).toBe(true);
    expect(decision.candidate?.kind).toBe("general_reply");
  });

  it("drafts general reply for reply_continuation", () => {
    const decision = decideDraft("reply_continuation", {
      fromAddress: "followup@example.com",
      from: "Followup",
      subject: "Re: Previous thread",
    });
    expect(decision.shouldDraft).toBe(true);
    expect(decision.candidate?.kind).toBe("general_reply");
  });

  it("returns reason for auditability", () => {
    const decision = decideDraft("general_email", {
      fromAddress: "test@example.com",
      from: "Test",
      subject: "Hello",
    });
    expect(decision.reason).toBeTruthy();
    expect(decision.reason.length).toBeGreaterThan(0);
  });
});

describe("decideDraft — draft content safety", () => {
  function draftFor(category: IntakeSortCategory): DraftCandidate | null {
    const decision = decideDraft(category, {
      fromAddress: "test@example.com",
      from: "Test User <test@example.com>",
      subject: "Test Subject",
    });
    return decision.candidate;
  }

  it("drafts identify intended recipient (To field)", () => {
    const c = draftFor("incomplete");
    expect(c).not.toBeNull();
    expect(c!.to).toBe("test@example.com");
  });

  it("drafts do not expose source-message internals", () => {
    const c = draftFor("general_email");
    expect(c).not.toBeNull();
    expect(c!.body).not.toContain("evidenceId");
    expect(c!.body).not.toContain("classHint");
    expect(c!.body).not.toContain("sourceDetection");
    expect(c!.body).not.toContain("messageId");
  });

  it("drafts never contain password or credential patterns", () => {
    for (const category of ["incomplete", "general_email", "store_submission", "reply_continuation"] as IntakeSortCategory[]) {
      const c = draftFor(category);
      if (c) {
        expect(c.body).not.toMatch(/password/i);
        expect(c.body).not.toMatch(/secret/i);
        expect(c.body).not.toMatch(/credential/i);
        expect(c.body).not.toMatch(/api.key/i);
        expect(c.body).not.toMatch(/token/i);
        expect(c.body).not.toMatch(/bearer/i);
      }
    }
  });

  it("drafts do not contain raw headers", () => {
    const c = draftFor("general_email");
    expect(c).not.toBeNull();
    expect(c!.body).not.toContain("Received:");
    expect(c!.body).not.toContain("X-");
    expect(c!.body).not.toContain("Message-ID:");
  });
});

describe("formatDraftDocument", () => {
  it("formats To and Subject headers followed by blank line and body", () => {
    const candidate: DraftCandidate = {
      kind: "acknowledgment",
      to: "owner@store.example",
      subject: "Re: New store submission — TheBinMap",
      body: "Thank you for your submission.",
      reason: "test",
    };
    const formatted = formatDraftDocument(candidate);
    expect(formatted).toContain("To: owner@store.example");
    expect(formatted).toContain("Subject: Re: New store submission — TheBinMap");
    expect(formatted).toContain("\n\nThank you");
  });
});

describe("prepareDraftDocument", () => {
  it("returns null for blocked categories", () => {
    const doc = prepareDraftDocument("spam_irrelevant", {
      fromAddress: "spam@example.com",
      from: "Spam",
      subject: "Buy!",
    });
    expect(doc).toBeNull();
  });

  it("returns a formatted string for needed categories", () => {
    const doc = prepareDraftDocument("incomplete", {
      fromAddress: "submitter@example.com",
      from: "Submitter",
      subject: "New store submission — TheBinMap",
    });
    expect(doc).not.toBeNull();
    expect(doc).toContain("To: submitter@example.com");
    expect(doc).toContain("Subject: Re: New store submission — TheBinMap");
    expect(doc).toContain("incomplete");
  });

  it("returns a formatted string for general email", () => {
    const doc = prepareDraftDocument("general_email", {
      fromAddress: "user@example.com",
      from: "User",
      subject: "Quick question",
    });
    expect(doc).not.toBeNull();
    expect(doc).toContain("To: user@example.com");
    expect(doc).toContain("Subject: Re: Quick question");
  });

  it("returns a formatted string for store submission", () => {
    const doc = prepareDraftDocument("store_submission", {
      fromAddress: "owner@store.example",
      from: "Owner",
      subject: "New store submission — TheBinMap",
    });
    expect(doc).not.toBeNull();
    expect(doc).toContain("Thank you for your store submission");
  });

  it("returns null for unknown", () => {
    const doc = prepareDraftDocument("unknown", {
      fromAddress: "?@example.com",
      from: "?",
      subject: "?",
    });
    expect(doc).toBeNull();
  });

  it("returns null for duplicate", () => {
    const doc = prepareDraftDocument("duplicate", {
      fromAddress: "dup@example.com",
      from: "Dup",
      subject: "Again",
    });
    expect(doc).toBeNull();
  });
});

describe("draft decision — reply must remain Board action only", () => {
  it("decideDraft does not send or enqueue; it only returns a decision", () => {
    // A decision object is a pure function return; it has no side effects.
    const decision = decideDraft("general_email", {
      fromAddress: "test@example.com",
      from: "Test",
      subject: "Hello",
    });
    expect(decision).toHaveProperty("shouldDraft");
    expect(decision).toHaveProperty("candidate");
    expect(decision).toHaveProperty("reason");
    expect(typeof decision.shouldDraft).toBe("boolean");
  });

  it("prepareDraftDocument only returns text; never sends", () => {
    const doc = prepareDraftDocument("general_email", {
      fromAddress: "test@example.com",
      from: "Test",
      subject: "Hello",
    });
    expect(doc).not.toBeNull();
    expect(typeof doc).toBe("string");
    // No side effects from a pure string return
  });
});

describe("draft subject handling", () => {
  it("strips existing Re: prefix before adding", () => {
    const decision = decideDraft("general_email", {
      fromAddress: "test@example.com",
      from: "Test",
      subject: "Re: Already a reply",
    });
    expect(decision.candidate?.subject).toBe("Re: Already a reply");
  });
});
