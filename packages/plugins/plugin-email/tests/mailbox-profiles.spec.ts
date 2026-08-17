import { describe, expect, it } from "vitest";
import {
  activeMailboxProfiles,
  buildMailboxProfiles,
  hasActiveMailboxConfig,
  resolveProfileCredentialBinding,
  type MailboxProfileHostConfig,
} from "../src/mail/mailbox-profiles.js";

const secret = (secretId: string) => ({
  type: "secret_ref" as const,
  secretId,
  version: "latest" as const,
});

describe("first-class mailbox profiles", () => {
  it("models active, standby, and reserved mailboxes while only activating active profiles", () => {
    const config: MailboxProfileHostConfig = {
      mailboxProfiles: [
        {
          key: "michael",
          username: "michael@example.com",
          status: "active",
          credentialSecretRef: secret("11111111-1111-4111-8111-111111111111"),
        },
        { key: "info", username: "info@example.com", status: "standby" },
        { key: "legal", username: "legal@example.com", status: "reserved" },
      ],
    };

    const profiles = buildMailboxProfiles(config);
    expect(profiles.map((profile) => [profile.key, profile.operationalStatus])).toEqual([
      ["michael", "active"],
      ["info", "standby"],
      ["legal", "reserved"],
    ]);
    expect(activeMailboxProfiles(config).map((profile) => profile.key)).toEqual(["michael"]);
    expect(hasActiveMailboxConfig(config)).toBe(true);
  });

  it("binds each structured mailbox to its own exact nested secret path", () => {
    const config: MailboxProfileHostConfig = {
      mailboxProfiles: [
        {
          key: "michael",
          username: "michael@example.com",
          status: "active",
          credentialSecretRef: secret("11111111-1111-4111-8111-111111111111"),
        },
        {
          key: "info",
          username: "info@example.com",
          status: "active",
          credentialSecretRef: secret("22222222-2222-4222-8222-222222222222"),
        },
      ],
    };

    const [michael, info] = activeMailboxProfiles(config);
    expect(resolveProfileCredentialBinding(michael)).toEqual({
      secretRef: secret("11111111-1111-4111-8111-111111111111"),
      configPath: "mailboxProfiles.0.credentialSecretRef",
    });
    expect(resolveProfileCredentialBinding(info)).toEqual({
      secretRef: secret("22222222-2222-4222-8222-222222222222"),
      configPath: "mailboxProfiles.1.credentialSecretRef",
    });
    expect(michael.credentialMode).toBe("profile");
    expect(info.credentialMode).toBe("profile");
  });

  it("fails closed when an active structured mailbox has no credential binding", () => {
    const config: MailboxProfileHostConfig = {
      mailboxProfiles: [
        { key: "michael", username: "michael@example.com", status: "active" },
      ],
    };

    expect(() => buildMailboxProfiles(config)).toThrow(/requires its own credentialSecretRef/);
  });

  it("allows standby and reserved mailboxes to be modeled without credentials", () => {
    const config: MailboxProfileHostConfig = {
      mailboxProfiles: [
        { key: "info", username: "info@example.com", status: "standby" },
        { key: "legal", username: "legal@example.com", status: "reserved" },
      ],
    };

    expect(buildMailboxProfiles(config)).toHaveLength(2);
    expect(activeMailboxProfiles(config)).toEqual([]);
    expect(hasActiveMailboxConfig(config)).toBe(false);
  });

  it("rejects duplicate structured mailbox keys", () => {
    const config: MailboxProfileHostConfig = {
      mailboxProfiles: [
        { key: "main", username: "one@example.com", status: "standby" },
        { key: "main", username: "two@example.com", status: "reserved" },
      ],
    };

    expect(() => buildMailboxProfiles(config)).toThrow(/Duplicate mailbox profile key/);
  });

  it("preserves the legacy primary plus extraProfilesJson shared-credential path", () => {
    const config: MailboxProfileHostConfig = {
      username: "bootstrap@gmail.com",
      credentialSecretRef: secret("33333333-3333-4333-8333-333333333333"),
      extraProfilesJson: JSON.stringify([
        { key: "alias", username: "alias@gmail.com" },
      ]),
    };

    const profiles = buildMailboxProfiles(config);
    expect(profiles.map((profile) => profile.key)).toEqual(["primary", "alias"]);
    expect(profiles.every((profile) => profile.operationalStatus === "active")).toBe(true);
    expect(profiles.every((profile) => profile.credentialMode === "company_shared")).toBe(true);
    expect(profiles.map((profile) => resolveProfileCredentialBinding(profile).configPath)).toEqual([
      "credentialSecretRef",
      "credentialSecretRef",
    ]);
  });

  it("uses structured mailbox profiles instead of legacy fields when both exist", () => {
    const config: MailboxProfileHostConfig = {
      username: "legacy@gmail.com",
      credentialSecretRef: secret("33333333-3333-4333-8333-333333333333"),
      mailboxProfiles: [
        { key: "direct", username: "direct@example.com", status: "standby" },
      ],
    };

    expect(buildMailboxProfiles(config).map((profile) => profile.key)).toEqual(["direct"]);
    expect(hasActiveMailboxConfig(config)).toBe(false);
  });
});
