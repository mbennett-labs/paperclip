import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ConnectorProfile } from "../src/mail/imap.js";

let capturedSearchCriteria: Record<string, unknown> | null = null;

vi.mock("imapflow", () => ({
  ImapFlow: vi.fn(function () {
    return {
      connect: vi.fn().mockResolvedValue(undefined),
      logout: vi.fn().mockResolvedValue(undefined),
      getMailboxLock: vi.fn().mockResolvedValue({
        release: vi.fn(),
      }),
      search: vi.fn().mockImplementation((criteria: Record<string, unknown>) => {
        capturedSearchCriteria = criteria;
        return Promise.resolve([1]);
      }),
      fetchOne: vi.fn().mockResolvedValue({
        envelope: { messageId: "<test@example.com>", subject: "test", date: new Date() },
        bodyParts: new Map([["text", Buffer.from("test body")]]),
      }),
    };
  }),
}));

async function fetchUnseenForTest(
  profile: ConnectorProfile,
  afterUid: number,
): Promise<Record<string, unknown> | null> {
  const { fetchUnseen } = await import("../src/mail/imap.js");
  capturedSearchCriteria = null;
  await fetchUnseen(profile, "secret", afterUid);
  return capturedSearchCriteria;
}

function baseProfile(): ConnectorProfile {
  return {
    key: "primary",
    imapHost: "imap.example.com",
    imapPort: 993,
    imapSecure: true,
    smtpHost: "smtp.example.com",
    smtpPort: 465,
    smtpSecure: true,
    username: "test@example.com",
    pollFolder: "INBOX",
    archiveFolder: "",
    markSeen: false,
    maxMessagesPerPoll: 5,
  };
}

describe("fetchUnseen IMAP search criteria", () => {
  beforeEach(() => {
    capturedSearchCriteria = null;
    vi.clearAllMocks();
  });

  describe("intakeSince set", () => {
    it("adds a SINCE criterion as a Date object", async () => {
      const profile = { ...baseProfile(), intakeSince: "2026-07-01" };
      const criteria = await fetchUnseenForTest(profile, 0);

      expect(criteria).not.toBeNull();
      expect(criteria!.since).toBeInstanceOf(Date);
      expect((criteria!.since as Date).toISOString().slice(0, 10)).toBe("2026-07-01");
    });

    it("combines SINCE with UID criterion when afterUid > 0", async () => {
      const profile = { ...baseProfile(), intakeSince: "2026-07-01" };
      const criteria = await fetchUnseenForTest(profile, 5);

      expect(criteria!.uid).toBe("6:*");
      expect(criteria!.since).toBeInstanceOf(Date);
    });

    it("passes valid date strings without timezone shift", async () => {
      const profile = { ...baseProfile(), intakeSince: "2026-12-31" };
      const criteria = await fetchUnseenForTest(profile, 0);

      const d = criteria!.since as Date;
      expect(d.getUTCFullYear()).toBe(2026);
      expect(d.getUTCMonth()).toBe(11); // December = 11
      expect(d.getUTCDate()).toBe(31);
    });
  });

  describe("intakeSince unset", () => {
    it("omits the SINCE criterion when intakeSince is not set", async () => {
      const profile = baseProfile();
      const criteria = await fetchUnseenForTest(profile, 0);

      expect(criteria).not.toBeNull();
      expect(criteria!.since).toBeUndefined();
    });

    it("preserves existing UID-only behavior", async () => {
      const profile = baseProfile();
      const criteria = await fetchUnseenForTest(profile, 10);

      expect(criteria!.seen).toBe(false);
      expect(criteria!.uid).toBe("11:*");
      expect(criteria!.since).toBeUndefined();
    });
  });

  describe("criteria base fields", () => {
    it("always includes seen: false", async () => {
      const profile = baseProfile();
      const criteria = await fetchUnseenForTest(profile, 0);

      expect(criteria!.seen).toBe(false);
    });

    it("omits uid when afterUid is 0", async () => {
      const profile = baseProfile();
      const criteria = await fetchUnseenForTest(profile, 0);

      expect(criteria!.uid).toBeUndefined();
    });
  });
});