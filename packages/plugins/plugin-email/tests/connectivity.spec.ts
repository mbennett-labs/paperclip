import { describe, expect, it, vi } from "vitest";
import { probeMailboxConnectivity } from "../src/mail/connectivity.js";
import { summarizeOperationalError } from "../src/mail/operational-error.js";
import type { ConnectorProfile } from "../src/mail/imap.js";

const profile: ConnectorProfile = {
  key: "michael",
  username: "michael@thebinmap.com",
  imapHost: "imap.hostinger.com",
  imapPort: 993,
  imapSecure: true,
  smtpHost: "smtp.hostinger.com",
  smtpPort: 465,
  smtpSecure: true,
  pollFolder: "INBOX",
  archiveFolder: "",
  markSeen: false,
  maxMessagesPerPoll: 20,
};

describe("mailbox connectivity diagnostics", () => {
  it("returns explicit IMAP and SMTP success without sending a message", async () => {
    const validateImap = vi.fn(async () => undefined);
    const validateSmtp = vi.fn(async () => undefined);
    const result = await probeMailboxConnectivity(profile, "pw", { validateImap, validateSmtp });
    expect(result.ok).toBe(true);
    expect(result.imap.ok).toBe(true);
    expect(result.smtp.ok).toBe(true);
    expect(validateImap).toHaveBeenCalledOnce();
    expect(validateSmtp).toHaveBeenCalledOnce();
  });

  it("surfaces safe IMAP status and response while redacting the credential", () => {
    const err = new Error("Command failed") as Error & {
      responseStatus?: string;
      responseText?: string;
      executedCommand?: string;
    };
    err.responseStatus = "NO";
    err.responseText = "Authentication failed for secret-pass";
    err.executedCommand = "A1 LOGIN user@example.com secret-pass";
    const summary = summarizeOperationalError(err, ["secret-pass"]);
    expect(summary).toContain("status=NO");
    expect(summary).toContain("Authentication failed");
    expect(summary).not.toContain("secret-pass");
    expect(summary).not.toContain("LOGIN");
  });

  it("keeps IMAP and SMTP failures independently observable", async () => {
    const imapError = new Error("Command failed") as Error & { responseStatus?: string; responseText?: string };
    imapError.responseStatus = "BAD";
    imapError.responseText = "Invalid credentials";
    const validateImap = vi.fn(async () => { throw imapError; });
    const validateSmtp = vi.fn(async () => undefined);
    const result = await probeMailboxConnectivity(profile, "pw", { validateImap, validateSmtp });
    expect(result.ok).toBe(false);
    expect(result.imap.ok).toBe(false);
    expect(result.imap.error).toContain("status=BAD");
    expect(result.smtp.ok).toBe(true);
  });
});
