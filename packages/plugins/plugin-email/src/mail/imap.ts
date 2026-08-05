import { ImapFlow } from "imapflow";

export type ConnectorProfile = {
  key: string;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  username: string;
  pollFolder: string;
  archiveFolder: string;
  markSeen: boolean;
  maxMessagesPerPoll: number;
  intakeSince?: string;
};

export type FetchedMessage = {
  uid: number;
  envelope: {
    messageId?: string;
    from?: unknown;
    to?: unknown;
    subject?: string;
    date?: Date | string;
    inReplyTo?: string;
    references?: string[] | string;
  };
  bodyText: string;
};

function imapClient(profile: ConnectorProfile, password: string): ImapFlow {
  return new ImapFlow({
    host: profile.imapHost,
    port: profile.imapPort,
    secure: profile.imapSecure,
    auth: { user: profile.username, pass: password },
    logger: false,
    socketTimeout: 60000,
    tls: { rejectUnauthorized: true, servername: profile.imapHost },
  } as ConstructorParameters<typeof ImapFlow>[0]);
}

/** Fetch up to `max` UNSEEN messages with UID > afterUid from the profile's poll folder. */
export async function fetchUnseen(
  profile: ConnectorProfile,
  password: string,
  afterUid: number,
): Promise<FetchedMessage[]> {
  const client = imapClient(profile, password);
  const out: FetchedMessage[] = [];
  await client.connect();
  try {
    const lock = await client.getMailboxLock(profile.pollFolder);
    try {
      const criteria: Record<string, unknown> = { seen: false };
      if (afterUid > 0) criteria.uid = `${afterUid + 1}:*`;
      if (profile.intakeSince) {
        criteria.since = new Date(profile.intakeSince);
      }
      const uids = await client.search(criteria, { uid: true });
      const selected = (Array.isArray(uids) ? uids : []).slice(0, profile.maxMessagesPerPoll);
      for (const uid of selected) {
        const msg = await client.fetchOne(
          String(uid),
          { envelope: true, bodyParts: ["text"] },
          { uid: true },
        );
        if (!msg) continue;
        const bodyPart = msg.bodyParts?.get("text");
        const bodyText = bodyPart ? bodyPart.toString("utf8") : "";
        out.push({ uid, envelope: msg.envelope ?? {}, bodyText });
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }
  return out;
}

export interface TargetedSearchParams {
  subject: string;
  unreadOnly?: boolean;
  since?: Date;
  before?: Date;
  fromPattern?: string;
  maxResults?: number;
}

export async function searchBySubject(
  profile: ConnectorProfile,
  password: string,
  params: TargetedSearchParams,
): Promise<FetchedMessage[]> {
  const client = imapClient(profile, password);
  await client.connect();
  try {
    const lock = await client.getMailboxLock(profile.pollFolder);
    try {
      const criteria: Record<string, unknown> = { subject: params.subject };
      if (params.unreadOnly !== false) criteria.seen = false;
      if (params.since) criteria.since = params.since;
      if (params.before) criteria.before = params.before;
      if (params.fromPattern) criteria.from = params.fromPattern;
      const uids = await client.search(criteria, { uid: true });
      const max = params.maxResults ?? 1;
      const selected = (Array.isArray(uids) ? uids : []).slice(0, max);
      const out: FetchedMessage[] = [];
      for (const uid of selected) {
        const msg = await client.fetchOne(
          String(uid),
          { envelope: true, bodyParts: ["text"] },
          { uid: true },
        );
        if (!msg) continue;
        const bodyPart = msg.bodyParts?.get("text");
        out.push({ uid, envelope: msg.envelope ?? {}, bodyText: bodyPart ? bodyPart.toString("utf8") : "" });
      }
      return out;
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }
}

/** Mark a message seen, flag answered, optionally move to the archive folder. */
export async function markReplied(
  profile: ConnectorProfile,
  password: string,
  uid: number,
  folder: string,
): Promise<void> {
  const client = imapClient(profile, password);
  await client.connect();
  try {
    const lock = await client.getMailboxLock(folder);
    try {
      await client.messageFlagsAdd(String(uid), ["\\Seen", "\\Answered"], { uid: true });
      if (profile.archiveFolder) {
        await client.messageMove(String(uid), profile.archiveFolder, { uid: true });
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }
}

/** Mark messages seen after successful intake (no archive move). */
export async function markSeen(
  profile: ConnectorProfile,
  password: string,
  uid: number,
  folder: string,
): Promise<void> {
  if (!profile.markSeen) return;
  const client = imapClient(profile, password);
  await client.connect();
  try {
    const lock = await client.getMailboxLock(folder);
    try {
      await client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }
}

/** Connectivity check used by onValidateConfig ("Test Connection"). */
export async function validateImap(profile: ConnectorProfile, password: string): Promise<void> {
  const client = imapClient(profile, password);
  await client.connect();
  try {
    await client.mailboxOpen(profile.pollFolder);
  } finally {
    await client.logout().catch(() => undefined);
  }
}
