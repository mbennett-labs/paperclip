import type { EnvSecretRefBinding } from "@paperclipai/plugin-sdk";
import { DEFAULTS } from "../constants.js";
import type { ConnectorProfile } from "./imap.js";

export type MailboxOperationalStatus = "active" | "standby" | "reserved";
export type MailboxCredentialMode = "profile" | "company_shared";

export type MailboxProfileConfig = {
  key?: string;
  username?: string;
  status?: MailboxOperationalStatus;
  credentialSecretRef?: string | EnvSecretRefBinding;
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
  intakeSince?: string;
};

export type MailboxProfileHostConfig = {
  enabled?: boolean;
  mailboxProfiles?: MailboxProfileConfig[];
  username?: string;
  credentialSecretRef?: string | EnvSecretRefBinding;
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
  intakeSince?: string;
};

export type ResolvedMailboxProfile = ConnectorProfile & {
  operationalStatus: MailboxOperationalStatus;
  credentialSecretRef?: string | EnvSecretRefBinding;
  credentialConfigPath: string;
  credentialMode: MailboxCredentialMode;
  source: "structured" | "legacy";
};

function configError(message: string): Error {
  return new Error(`[qsl.email] ${message}`);
}

function normalizeStatus(value: unknown): MailboxOperationalStatus {
  if (value == null || value === "") return "standby";
  if (value === "active" || value === "standby" || value === "reserved") return value;
  throw configError(`Mailbox status "${String(value)}" is invalid. Use active, standby, or reserved.`);
}

function baseTransport(config: MailboxProfileHostConfig): Omit<ConnectorProfile, "key" | "username"> {
  return {
    imapHost: config.imapHost || DEFAULTS.imapHost,
    imapPort: Number(config.imapPort ?? DEFAULTS.imapPort),
    imapSecure: config.imapSecure ?? DEFAULTS.imapSecure,
    smtpHost: config.smtpHost || DEFAULTS.smtpHost,
    smtpPort: Number(config.smtpPort ?? DEFAULTS.smtpPort),
    smtpSecure: config.smtpSecure ?? DEFAULTS.smtpSecure,
    pollFolder: config.pollFolder || DEFAULTS.pollFolder,
    archiveFolder: config.archiveFolder ?? DEFAULTS.archiveFolder,
    markSeen: config.markSeen ?? DEFAULTS.markSeen,
    maxMessagesPerPoll: Number(config.maxMessagesPerPoll ?? DEFAULTS.maxMessagesPerPoll),
    ...(config.intakeSince ? { intakeSince: config.intakeSince } : {}),
  };
}

function structuredProfiles(config: MailboxProfileHostConfig): ResolvedMailboxProfile[] {
  const raw = config.mailboxProfiles;
  if (!Array.isArray(raw) || raw.length === 0) return [];

  const base = baseTransport(config);
  const keys = new Set<string>();

  return raw.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw configError(`mailboxProfiles[${index}] must be an object.`);
    }

    const key = typeof entry.key === "string" ? entry.key.trim() : "";
    const username = typeof entry.username === "string" ? entry.username.trim() : "";
    if (!key) throw configError(`mailboxProfiles[${index}].key is required.`);
    if (!username) throw configError(`mailboxProfiles[${index}].username is required.`);
    if (keys.has(key)) {
      throw configError(`Duplicate mailbox profile key "${key}". Profile keys must be unique per company.`);
    }
    keys.add(key);

    const operationalStatus = normalizeStatus(entry.status);
    if (operationalStatus === "active" && !entry.credentialSecretRef) {
      throw configError(`Active mailbox profile "${key}" requires its own credentialSecretRef.`);
    }

    return {
      ...base,
      key,
      username,
      operationalStatus,
      credentialSecretRef: entry.credentialSecretRef,
      credentialConfigPath: `mailboxProfiles.${index}.credentialSecretRef`,
      credentialMode: "profile",
      source: "structured",
      imapHost: entry.imapHost || base.imapHost,
      imapPort: Number(entry.imapPort ?? base.imapPort),
      imapSecure: entry.imapSecure ?? base.imapSecure,
      smtpHost: entry.smtpHost || base.smtpHost,
      smtpPort: Number(entry.smtpPort ?? base.smtpPort),
      smtpSecure: entry.smtpSecure ?? base.smtpSecure,
      pollFolder: entry.pollFolder || base.pollFolder,
      archiveFolder: entry.archiveFolder ?? base.archiveFolder,
      markSeen: entry.markSeen ?? base.markSeen,
      maxMessagesPerPoll: Number(entry.maxMessagesPerPoll ?? base.maxMessagesPerPoll),
      ...(entry.intakeSince
        ? { intakeSince: entry.intakeSince }
        : base.intakeSince
          ? { intakeSince: base.intakeSince }
          : {}),
    };
  });
}

function legacyProfiles(config: MailboxProfileHostConfig): ResolvedMailboxProfile[] {
  const base = baseTransport(config);
  const profiles: ResolvedMailboxProfile[] = [];

  if (config.username) {
    profiles.push({
      ...base,
      key: "primary",
      username: config.username,
      operationalStatus: "active",
      credentialSecretRef: config.credentialSecretRef,
      credentialConfigPath: "credentialSecretRef",
      credentialMode: "company_shared",
      source: "legacy",
    });
  }

  const extraRaw = (config.extraProfilesJson ?? "").trim();
  if (!extraRaw) return profiles;

  let extra: Array<Partial<ConnectorProfile>>;
  try {
    extra = JSON.parse(extraRaw) as Array<Partial<ConnectorProfile>>;
  } catch {
    throw configError("extraProfilesJson is not valid JSON.");
  }
  if (!Array.isArray(extra)) throw configError("extraProfilesJson must be a JSON array.");

  for (let i = 0; i < extra.length; i += 1) {
    const entry = extra[i];
    if (!entry?.username) continue;
    profiles.push({
      ...base,
      ...entry,
      key: entry.key || `extra-${i + 1}`,
      username: entry.username,
      operationalStatus: "active",
      credentialSecretRef: config.credentialSecretRef,
      credentialConfigPath: "credentialSecretRef",
      credentialMode: "company_shared",
      source: "legacy",
    } as ResolvedMailboxProfile);
  }

  return profiles;
}

/**
 * Build every modeled mailbox for a company.
 *
 * Structured mailboxProfiles are authoritative when present. The legacy
 * username + extraProfilesJson path remains supported so existing staging
 * and production configurations do not change behavior during migration.
 */
export function buildMailboxProfiles(config: MailboxProfileHostConfig): ResolvedMailboxProfile[] {
  const structured = structuredProfiles(config);
  if (structured.length > 0) return structured;
  return legacyProfiles(config);
}

export function activeMailboxProfiles(config: MailboxProfileHostConfig): ResolvedMailboxProfile[] {
  return buildMailboxProfiles(config).filter((profile) => profile.operationalStatus === "active");
}

export function hasActiveMailboxConfig(config: MailboxProfileHostConfig): boolean {
  if (config.enabled === false) return false;
  const structured = config.mailboxProfiles;
  if (Array.isArray(structured) && structured.length > 0) {
    return structured.some((entry) =>
      entry?.status === "active" &&
      typeof entry.username === "string" &&
      entry.username.trim().length > 0
    );
  }
  return typeof config.username === "string" && config.username.trim().length > 0;
}

export function resolveProfileCredentialBinding(profile: ResolvedMailboxProfile): {
  secretRef: string | EnvSecretRefBinding;
  configPath: string;
} {
  if (!profile.credentialSecretRef) {
    const guidance = profile.source === "legacy"
      ? "Bind the company mailbox credential secret."
      : "Bind a credential secret to this active mailbox profile.";
    throw configError(`Mailbox profile "${profile.key}" has no credentialSecretRef. ${guidance}`);
  }
  return {
    secretRef: profile.credentialSecretRef,
    configPath: profile.credentialConfigPath,
  };
}
