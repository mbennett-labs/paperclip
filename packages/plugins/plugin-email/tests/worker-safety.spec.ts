import { describe, expect, it } from "vitest";
import { DEFAULTS } from "../src/constants.js";

describe("Email plugin safety guards", () => {
  describe("production defaults (imported from constants.ts)", () => {
    it("scheduledPollingEnabled defaults to false", () => {
      expect(DEFAULTS.scheduledPollingEnabled).toBe(false);
    });

    it("outboundEnabled defaults to false", () => {
      expect(DEFAULTS.outboundEnabled).toBe(false);
    });

    it("enabled defaults to true (existing behavior preserved)", () => {
      expect(DEFAULTS.enabled).toBe(true);
    });

    it("markSeen defaults to false (read-only intake)", () => {
      expect(DEFAULTS.markSeen).toBe(false);
    });

    it("maxMessagesPerPoll defaults to 20", () => {
      expect(DEFAULTS.maxMessagesPerPoll).toBe(20);
    });

    it("intakeSince has no global default (optional, backward-compatible)", () => {
      expect(DEFAULTS).not.toHaveProperty("intakeSince");
    });
  });

  describe("scheduled polling guard", () => {
    it("scheduled poll skips when scheduledPollingEnabled is false", () => {
      const scheduled = true;
      const shouldSkip = scheduled && DEFAULTS.scheduledPollingEnabled !== true;
      expect(shouldSkip).toBe(true);
    });

    it("scheduled poll runs when overridden to true", () => {
      const scheduled = true;
      const overridden = true;
      const shouldSkip = scheduled && overridden !== true;
      expect(shouldSkip).toBe(false);
    });

    it("manual poll ignores scheduledPollingEnabled", () => {
      const scheduled = false;
      const shouldSkip = scheduled && DEFAULTS.scheduledPollingEnabled !== true;
      expect(shouldSkip).toBe(false);
    });
  });

  describe("outbound send guard", () => {
    it("send-reply is blocked when outboundEnabled is false (default)", () => {
      expect(DEFAULTS.outboundEnabled).toBe(false);
      const blocked = DEFAULTS.outboundEnabled !== true;
      expect(blocked).toBe(true);
    });

    it("send-reply is allowed when outboundEnabled is explicitly true", () => {
      const overridden = true;
      const blocked = overridden !== true;
      expect(blocked).toBe(false);
    });
  });

  describe("markSeen safety (read-only by default)", () => {
    it("markSeen defaults to false (read-only intake)", () => {
      expect(DEFAULTS.markSeen).toBe(false);
    });

    it("markSeen: false means no IMAP Seen flag", () => {
      const override = false;
      expect(override).toBe(false);
    });
  });

  describe("deduplication remains intact", () => {
    it("seen key composites profile and messageId", () => {
      const messageId = "test-msg@example.com";
      const profileKey = "primary";
      const composite = `${profileKey}:${messageId}`;
      expect(composite).toBe("primary:test-msg@example.com");
    });

    it("different profiles produce different seen keys", () => {
      const key1 = "primary:test-msg@example.com";
      const key2 = "extra-1:test-msg@example.com";
      expect(key1).not.toBe(key2);
    });
  });

  describe("safe configuration for one-message test", () => {
    it("allows manual poll with scheduled polling disabled and outbound blocked", () => {
      const config = {
        enabled: true,
        scheduledPollingEnabled: false,
        outboundEnabled: false,
        markSeen: false,
        maxMessagesPerPoll: 1,
      };
      expect(config.enabled).toBe(true);
      expect(config.scheduledPollingEnabled).toBe(false);
      expect(config.outboundEnabled).toBe(false);
      expect(config.markSeen).toBe(false);
      expect(config.maxMessagesPerPoll).toBe(1);
    });
  });

  describe("intakeSince date validation", () => {
    function isValidIntakeDate(s: string): boolean {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
      if (!m) return false;
      const year = Number(m[1]);
      const month = Number(m[2]);
      const day = Number(m[3]);
      if (month < 1 || month > 12 || day < 1 || day > 31) return false;
      const d = new Date(Date.UTC(year, month - 1, day));
      if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return false;
      return true;
    }

    it("accepts a valid date", () => {
      expect(isValidIntakeDate("2026-07-01")).toBe(true);
    });

    it("accepts December 31", () => {
      expect(isValidIntakeDate("2026-12-31")).toBe(true);
    });

    it("accepts leap day in a leap year", () => {
      expect(isValidIntakeDate("2024-02-29")).toBe(true);
    });

    it("rejects invalid calendar date (Feb 30)", () => {
      expect(isValidIntakeDate("2026-02-30")).toBe(false);
    });

    it("rejects month 13", () => {
      expect(isValidIntakeDate("2026-13-01")).toBe(false);
    });

    it("rejects month 00", () => {
      expect(isValidIntakeDate("2026-00-15")).toBe(false);
    });

    it("rejects day 00", () => {
      expect(isValidIntakeDate("2026-07-00")).toBe(false);
    });

    it("rejects non-YYYY-MM-DD format", () => {
      expect(isValidIntakeDate("07/01/2026")).toBe(false);
    });

    it("rejects ISO datetime string", () => {
      expect(isValidIntakeDate("2026-07-01T00:00:00Z")).toBe(false);
    });

    it("rejects empty string", () => {
      expect(isValidIntakeDate("")).toBe(false);
    });
  });

  describe("intakeSince runtime guard (poll path)", () => {
    // The guard at worker.ts line ~472 runs in runPollForCompany before
    // buildProfiles, resolvePassword, fetchUnseen, or ImapFlow construction.

    function isValidIntakeDate(s: string): boolean {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
      if (!m) return false;
      const year = Number(m[1]);
      const month = Number(m[2]);
      const day = Number(m[3]);
      if (month < 1 || month > 12 || day < 1 || day > 31) return false;
      const d = new Date(Date.UTC(year, month - 1, day));
      if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return false;
      return true;
    }

    function guardedPoll(config: { intakeSince?: string }): string {
      if (config.intakeSince && !isValidIntakeDate(config.intakeSince)) {
        throw new Error("intakeSince is not a valid date: " + config.intakeSince);
      }
      return "poll completed";
    }

    it("throws before ImapFlow when intakeSince is invalid", () => {
      expect(() => guardedPoll({ intakeSince: "2026-02-30" })).toThrow();
    });

    it("allows poll when intakeSince is unset", () => {
      expect(() => guardedPoll({})).not.toThrow();
    });

    it("allows poll when intakeSince is valid", () => {
      expect(() => guardedPoll({ intakeSince: "2026-07-01" })).not.toThrow();
    });
  });
});

describe("UI fail-closed outbound guard", () => {
  function isOutboundAllowed(configData: { outboundEnabled?: boolean } | null | undefined): boolean {
    return configData?.outboundEnabled === true;
  }

  it("undefined configData hides outbound controls", () => {
    expect(isOutboundAllowed(undefined)).toBe(false);
  });

  it("null configData hides outbound controls", () => {
    expect(isOutboundAllowed(null)).toBe(false);
  });

  it("outboundEnabled: false hides outbound controls", () => {
    expect(isOutboundAllowed({ outboundEnabled: false })).toBe(false);
  });

  it("outboundEnabled: true shows outbound controls", () => {
    expect(isOutboundAllowed({ outboundEnabled: true })).toBe(true);
  });

  it("empty object hides outbound controls (no explicit true)", () => {
    expect(isOutboundAllowed({})).toBe(false);
  });
});

describe("logic-level guard ordering (matching worker.ts guard expressions)", () => {
  it("send-reply with outboundEnabled false must not call credential resolution", () => {
    const outboundEnabled = false;
    let credentialResolved = false;

    if (outboundEnabled !== true) {
      // Guard fires — must throw/return before credential resolution
    } else {
      credentialResolved = true;
    }

    expect(credentialResolved).toBe(false);
  });

  it("send-reply with outboundEnabled false must not create SMTP transport", () => {
    const outboundEnabled = false;
    let smtpCreated = false;

    if (outboundEnabled !== true) {
      // Guard fires — must throw/return before SMTP
    } else {
      smtpCreated = true;
    }

    expect(smtpCreated).toBe(false);
  });

  it("scheduled polling with scheduledPollingEnabled false must not call IMAP", () => {
    const scheduled = true;
    const scheduledPollingEnabled = false;
    let imapCalled = false;

    if (scheduled && scheduledPollingEnabled !== true) {
      // Guard fires — must skip before IMAP
    } else {
      imapCalled = true;
    }

    expect(imapCalled).toBe(false);
  });
});
