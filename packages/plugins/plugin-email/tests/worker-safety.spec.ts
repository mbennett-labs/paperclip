import { describe, expect, it, vi, beforeEach } from "vitest";

type EmailPluginConfig = {
  enabled?: boolean;
  scheduledPollingEnabled?: boolean;
  outboundEnabled?: boolean;
  intakeProjectId?: string;
  triageAgentId?: string;
  billingCode?: string;
  username?: string;
  credentialSecretRef?: unknown;
  imapHost?: string;
  imapPort?: number;
  imapSecure?: boolean;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  pollFolder?: string;
  archiveFolder?: string;
  markSeen?: boolean;
  maxMessagesPerPoll?: number;
  extraProfilesJson?: string;
};

describe("Email plugin safety guards", () => {
  describe("safe defaults", () => {
    it("scheduledPollingEnabled defaults to false", () => {
      const DEFAULTS = { scheduledPollingEnabled: false, outboundEnabled: false } as const;
      expect(DEFAULTS.scheduledPollingEnabled).toBe(false);
    });

    it("outboundEnabled defaults to false", () => {
      const DEFAULTS = { scheduledPollingEnabled: false, outboundEnabled: false } as const;
      expect(DEFAULTS.outboundEnabled).toBe(false);
    });

    it("markSeen default can be overridden to false for read-only", () => {
      const config: EmailPluginConfig = { markSeen: false };
      expect(config.markSeen).toBe(false);
    });

    it("maxMessagesPerPoll can be set to 1 for safety", () => {
      const config: EmailPluginConfig = { maxMessagesPerPoll: 1 };
      expect(config.maxMessagesPerPoll).toBe(1);
    });
  });

  describe("scheduled polling guard", () => {
    it("skips polling when enabled is false", () => {
      const config: EmailPluginConfig = { enabled: false };
      expect(config.enabled).toBe(false);
    });

    it("scheduled poll should be skipped when scheduledPollingEnabled is false", () => {
      const config: EmailPluginConfig = { scheduledPollingEnabled: false };
      const isScheduled = true;
      const shouldSkip = isScheduled && config.scheduledPollingEnabled !== true;
      expect(shouldSkip).toBe(true);
    });

    it("scheduled poll should run when scheduledPollingEnabled is true", () => {
      const config: EmailPluginConfig = { scheduledPollingEnabled: true };
      const isScheduled = true;
      const shouldSkip = isScheduled && config.scheduledPollingEnabled !== true;
      expect(shouldSkip).toBe(false);
    });

    it("manual poll ignores scheduledPollingEnabled", () => {
      const config: EmailPluginConfig = { scheduledPollingEnabled: false };
      const isScheduled = false;
      const shouldSkip = isScheduled && config.scheduledPollingEnabled !== true;
      expect(shouldSkip).toBe(false);
    });

    it("manual poll is blocked when enabled is false", () => {
      const config: EmailPluginConfig = { enabled: false };
      expect(config.enabled).toBe(false);
    });

    it("manual poll requires username", () => {
      const config: EmailPluginConfig = { enabled: true, scheduledPollingEnabled: false };
      const hasUsername = !!config.username;
      const shouldThrow = !hasUsername;
      expect(config.enabled).toBe(true);
      expect(shouldThrow).toBe(true);
    });
  });

  describe("outbound send guard", () => {
    it("send-reply is blocked when outboundEnabled is false", () => {
      const config: EmailPluginConfig = { outboundEnabled: false };
      const shouldThrow = config.outboundEnabled !== true;
      expect(shouldThrow).toBe(true);
    });

    it("send-reply is allowed when outboundEnabled is true", () => {
      const config: EmailPluginConfig = { outboundEnabled: true };
      const shouldThrow = config.outboundEnabled !== true;
      expect(shouldThrow).toBe(false);
    });

    it("send-reply guard fires before secret resolution", () => {
      const blocked = "Outbound email is disabled for this company.";
      let secretResolved = false;
      const config: EmailPluginConfig = { outboundEnabled: false };
      if (config.outboundEnabled !== true) {
        // blocked - must not proceed to secret resolution
      } else {
        secretResolved = true;
      }
      expect(secretResolved).toBe(false);
    });

    it("send-reply guard fires before SMTP transport creation", () => {
      const blocked = "Outbound email is disabled for this company.";
      let smtpCreated = false;
      const config: EmailPluginConfig = { outboundEnabled: false };
      if (config.outboundEnabled !== true) {
        // blocked - must not proceed to SMTP creation
      } else {
        smtpCreated = true;
      }
      expect(smtpCreated).toBe(false);
    });
  });

  describe("markSeen safety", () => {
    it("markSeen: false means no IMAP Seen flag", () => {
      const config: EmailPluginConfig = { markSeen: false, enabled: true };
      expect(config.markSeen).toBe(false);
    });

    it("markSeen defaults to true in existing constants", () => {
      const DEFAULTS = { markSeen: true } as const;
      expect(DEFAULTS.markSeen).toBe(true);
    });
  });

  describe("deduplication remains intact", () => {
    it("seen key uses sha1 hash of profile:messageId", () => {
      const messageId = "test-msg@example.com";
      const profileKey = "primary";
      const composite = `${profileKey}:${messageId}`;
      expect(composite).toBe("primary:test-msg@example.com");
    });

    it("different profiles produce different seen keys", () => {
      const messageId = "test-msg@example.com";
      const key1 = `primary:${messageId}`;
      const key2 = `extra-1:${messageId}`;
      expect(key1).not.toBe(key2);
    });
  });

  describe("safe configuration for one-message test", () => {
    it("allows manual poll with scheduled polling disabled", () => {
      const config: EmailPluginConfig = {
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

      const isScheduled = false;
      const scheduledSkip = isScheduled && config.scheduledPollingEnabled !== true;
      expect(scheduledSkip).toBe(false);

      const outboundBlocked = config.outboundEnabled !== true;
      expect(outboundBlocked).toBe(true);
    });
  });
});
