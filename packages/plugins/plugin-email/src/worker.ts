import { createHash } from "node:crypto";
import {
  definePlugin,
  runWorker,
  type EnvSecretRefBinding,
  type PluginContext,
} from "@paperclipai/plugin-sdk";
import {
  DEFAULTS,
  JOB_KEYS,
  ORIGIN_KIND_INTAKE,
  STATE_NS,
} from "./constants.js";
import {
  fetchUnseen,
  markReplied,
  markSeen,
  type ConnectorProfile,
} from "./mail/imap.js";
import { sendReply } from "./mail/smtp.js";
import {
  issueDescriptionFor,
  issueTitleFor,
  normalizeMessage,
  priorityFor,
  type NormalizedMessage,
} from "./mail/normalize.js";

type EmailPluginConfig = {
  enabled?: boolean;
  intakeProjectId?: string;
  triageAgentId?: string;
  billingCode?: string;
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
};

type ThreadRecord = {
  messageId: string;
  uid: number;
  folder: string;
  profileKey: string;
  from: string;
  fromAddress: string;
  to: string;
  subject: string;
  date: string;
  inReplyTo: string | null;
  references: string[];
  snippet: string;
  classHint: string;
  ventureHint: string;
  issueId: string;
  ingestedAt: string;
};

type SentRecord = {
  issueId: string;
  sentAt: string;
  sentMessageId: string;
  to: string;
  subject: string;
  profileKey: string;
};

type ProfilePollResult = {
  key: string;
  ok: boolean;
  found: number;
  created: number;
  skippedDuplicates: number;
  error?: string;
};

type MailboxStatus = {
  lastPollAt: string | null;
  lastDurationMs: number;
  totals: { polls: number; ingested: number; sent: number };
  profiles: ProfilePollResult[];
};

function summarizeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function seenKey(messageId: string): string {
  return `seen:${createHash("sha1").update(messageId).digest("hex")}`;
}

function configError(message: string): Error {
  return new Error(`[${"qsl.email"}] ${message}`);
}

function buildProfiles(config: EmailPluginConfig): ConnectorProfile[] {
  const base: ConnectorProfile = {
    key: "primary",
    imapHost: config.imapHost || DEFAULTS.imapHost,
    imapPort: Number(config.imapPort ?? DEFAULTS.imapPort),
    imapSecure: config.imapSecure ?? DEFAULTS.imapSecure,
    smtpHost: config.smtpHost || DEFAULTS.smtpHost,
    smtpPort: Number(config.smtpPort ?? DEFAULTS.smtpPort),
    smtpSecure: config.smtpSecure ?? DEFAULTS.smtpSecure,
    username: config.username || "",
    pollFolder: config.pollFolder || DEFAULTS.pollFolder,
    archiveFolder: config.archiveFolder ?? DEFAULTS.archiveFolder,
    markSeen: config.markSeen ?? DEFAULTS.markSeen,
    maxMessagesPerPoll: Number(config.maxMessagesPerPoll ?? DEFAULTS.maxMessagesPerPoll),
  };
  const profiles: ConnectorProfile[] = [];
  if (base.username) profiles.push(base);
  const extraRaw = (config.extraProfilesJson ?? "").trim();
  if (extraRaw) {
    try {
      const extra = JSON.parse(extraRaw) as Array<Partial<ConnectorProfile>>;
      for (let i = 0; i < extra.length; i += 1) {
        const p = extra[i];
        if (!p.username) continue;
        profiles.push({ ...base, ...p, key: p.key || `extra-${i + 1}` } as ConnectorProfile);
      }
    } catch {
      throw configError("extraProfilesJson is not valid JSON.");
    }
  }
  return profiles;
}

async function resolvePassword(ctx: PluginContext, config: EmailPluginConfig, companyId: string): Promise<string> {
  if (!config.credentialSecretRef) {
    throw configError("credentialSecretRef is not configured. Bind the mailbox credential secret in plugin settings.");
  }
  return ctx.secrets.resolve(config.credentialSecretRef, { companyId, configPath: "credentialSecretRef" });
}

/**
 * Resolve the companies this connector operates for: every company whose
 * scoped plugin config is enabled and has a mailbox username. This is what
 * makes the Email Company pattern reusable — a future company gets email
 * operations by writing its own scoped config, no worker changes.
 */
async function resolveActiveCompanies(ctx: PluginContext): Promise<Array<{ companyId: string; config: EmailPluginConfig }>> {
  const companies = await ctx.companies.list({ limit: 100 });
  const active: Array<{ companyId: string; config: EmailPluginConfig }> = [];
  for (const company of companies) {
    let config: EmailPluginConfig;
    try {
      config = (await ctx.config.get(company.id)) as EmailPluginConfig;
    } catch {
      continue;
    }
    if (!config || typeof config !== "object") continue;
    if (!config.username) continue;
    active.push({ companyId: company.id, config });
  }
  return active;
}

async function getStatus(ctx: PluginContext, companyId: string): Promise<MailboxStatus> {
  const existing = await ctx.state.get({ scopeKind: "company", scopeId: companyId, namespace: STATE_NS, stateKey: "mailbox-status" });
  if (existing && typeof existing === "object") return existing as MailboxStatus;
  return { lastPollAt: null, lastDurationMs: 0, totals: { polls: 0, ingested: 0, sent: 0 }, profiles: [] };
}

async function ingestMessage(
  ctx: PluginContext,
  config: EmailPluginConfig,
  companyId: string,
  profile: ConnectorProfile,
  msg: NormalizedMessage,
): Promise<{ issueId: string; created: boolean }> {
  const key = seenKey(`${profile.key}:${msg.messageId}`);
  const existing = await ctx.state.get({ scopeKind: "company", scopeId: companyId, namespace: STATE_NS, stateKey: key });
  if (existing && typeof existing === "object" && (existing as { issueId?: string }).issueId) {
    return { issueId: (existing as { issueId: string }).issueId, created: false };
  }

  const issue = await ctx.issues.create({
    companyId,
    projectId: config.intakeProjectId || undefined,
    title: issueTitleFor(msg),
    description: issueDescriptionFor(msg),
    status: "todo",
    priority: priorityFor(msg.classHint),
    assigneeAgentId: config.triageAgentId || undefined,
    billingCode: config.billingCode || DEFAULTS.billingCode,
    originKind: ORIGIN_KIND_INTAKE,
    originId: msg.messageId,
  });

  const thread: ThreadRecord = {
    messageId: msg.messageId,
    uid: msg.uid,
    folder: msg.folder,
    profileKey: profile.key,
    from: msg.from,
    fromAddress: msg.fromAddress,
    to: msg.to,
    subject: msg.subject,
    date: msg.date,
    inReplyTo: msg.inReplyTo,
    references: msg.references,
    snippet: msg.snippet,
    classHint: msg.classHint,
    ventureHint: msg.ventureHint,
    issueId: issue.id,
    ingestedAt: new Date().toISOString(),
  };
  await ctx.state.set({ scopeKind: "issue", scopeId: issue.id, namespace: STATE_NS, stateKey: "thread" }, thread);
  await ctx.state.set({ scopeKind: "company", scopeId: companyId, namespace: STATE_NS, stateKey: key }, { issueId: issue.id, at: thread.ingestedAt });

  await ctx.activity.log({
    companyId,
    message: `Email intake: "${msg.subject}" from ${msg.fromAddress || msg.from} -> ${issue.identifier ?? issue.id}`,
    entityType: "issue",
    entityId: issue.id,
    metadata: { profileKey: profile.key, messageId: msg.messageId, classHint: msg.classHint, ventureHint: msg.ventureHint },
  });
  await ctx.metrics.write("messages_ingested", 1, { profile: profile.key, class: msg.classHint, venture: msg.ventureHint });
  return { issueId: issue.id, created: true };
}

async function runPollForCompany(
  ctx: PluginContext,
  companyId: string,
  config: EmailPluginConfig,
): Promise<ProfilePollResult[]> {
  const status = await getStatus(ctx, companyId);

  if (config.enabled === false) {
    status.lastPollAt = new Date().toISOString();
    status.profiles = [{ key: "primary", ok: true, found: 0, created: 0, skippedDuplicates: 0, error: "connector disabled" }];
    await ctx.state.set({ scopeKind: "company", scopeId: companyId, namespace: STATE_NS, stateKey: "mailbox-status" }, status);
    return status.profiles;
  }

  const profiles = buildProfiles(config);
  if (profiles.length === 0) {
    throw configError("No mailbox profiles configured. Set the primary username/credential or extraProfilesJson.");
  }
  const password = await resolvePassword(ctx, config, companyId);

  const results: ProfilePollResult[] = [];
  for (const profile of profiles) {
    const result: ProfilePollResult = { key: profile.key, ok: true, found: 0, created: 0, skippedDuplicates: 0 };
    try {
      const fetched = await fetchUnseen(profile, password);
      result.found = fetched.length;
      for (const raw of fetched) {
        const msg = normalizeMessage({
          uid: raw.uid,
          folder: profile.pollFolder,
          profileKey: profile.key,
          envelope: raw.envelope,
          bodyText: raw.bodyText,
        });
        const { created } = await ingestMessage(ctx, config, companyId, profile, msg);
        if (created) {
          result.created += 1;
          status.totals.ingested += 1;
          await markSeen(profile, password, raw.uid, profile.pollFolder).catch((err) => {
            ctx.logger.warn("markSeen failed", { profile: profile.key, uid: raw.uid, error: summarizeError(err) });
          });
        } else {
          result.skippedDuplicates += 1;
        }
      }
    } catch (err) {
      result.ok = false;
      result.error = summarizeError(err);
      ctx.logger.error("poll failed for profile", { profile: profile.key, error: result.error });
    }
    results.push(result);
  }

  status.lastPollAt = new Date().toISOString();
  status.totals.polls += 1;
  status.profiles = results;
  await ctx.state.set({ scopeKind: "company", scopeId: companyId, namespace: STATE_NS, stateKey: "mailbox-status" }, status);

  const created = results.reduce((n, r) => n + r.created, 0);
  const failed = results.filter((r) => !r.ok);
  await ctx.activity.log({
    companyId,
    message: `Email poll: ${created} new issue(s) from ${results.reduce((n, r) => n + r.found, 0)} message(s) across ${profiles.length} profile(s)${failed.length ? `; ${failed.length} profile(s) failed` : ""}`,
    metadata: { results },
  });
  return results;
}

function parseReplyDraft(body: string): { to: string | null; subject: string | null; text: string } {
  const lines = body.split("\n");
  let to: string | null = null;
  let subject: string | null = null;
  let i = 0;
  for (; i < lines.length; i += 1) {
    const line = lines[i];
    const toMatch = line.match(/^To:\s*(.+)$/i);
    const subjectMatch = line.match(/^Subject:\s*(.+)$/i);
    if (toMatch) { to = toMatch[1].trim(); continue; }
    if (subjectMatch) { subject = subjectMatch[1].trim(); continue; }
    if (line.trim() === "" && (to || subject)) { i += 1; break; }
    if (line.trim() === "") continue;
    break;
  }
  return { to, subject, text: lines.slice(i).join("\n").trim() };
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.jobs.register(JOB_KEYS.pollInbox, async () => {
      const active = await resolveActiveCompanies(ctx);
      if (active.length === 0) {
        ctx.logger.info("poll skipped: no companies with an enabled mailbox config");
        return;
      }
      for (const { companyId, config } of active) {
        await runPollForCompany(ctx, companyId, config).catch((err) => {
          ctx.logger.error("poll failed for company", { companyId, error: summarizeError(err) });
        });
      }
    });

    ctx.data.register("mailbox-status", async (params) => {
      const companyId = params?.companyId as string;
      if (!companyId) return { lastPollAt: null, totals: { polls: 0, ingested: 0, sent: 0 }, profiles: [] };
      return getStatus(ctx, companyId);
    });

    ctx.data.register("issue-email", async (params) => {
      const issueId = params?.issueId as string;
      const companyId = params?.companyId as string;
      if (!issueId || !companyId) return { thread: null, sent: null, draft: null };
      const [thread, sent, docs] = await Promise.all([
        ctx.state.get({ scopeKind: "issue", scopeId: issueId, namespace: STATE_NS, stateKey: "thread" }),
        ctx.state.get({ scopeKind: "issue", scopeId: issueId, namespace: STATE_NS, stateKey: "sent" }),
        ctx.issues.documents.list(issueId, companyId).catch(() => []),
      ]);
      let draft: { to: string | null; subject: string | null; text: string } | null = null;
      if (docs.some((d) => d.key === "reply-draft")) {
        const doc = await ctx.issues.documents.get(issueId, "reply-draft", companyId).catch(() => null);
        if (doc?.body) draft = parseReplyDraft(doc.body);
      }
      return { thread: thread ?? null, sent: sent ?? null, draft };
    });

    ctx.actions.register("poll-now", async (params) => {
      const companyId = params?.companyId as string;
      if (companyId) {
        const config = (await ctx.config.get(companyId)) as EmailPluginConfig;
        if (!config?.username) throw configError("Mailbox is not configured for this company.");
        const results = await runPollForCompany(ctx, companyId, config);
        return { ok: true, results };
      }
      const active = await resolveActiveCompanies(ctx);
      for (const target of active) {
        await runPollForCompany(ctx, target.companyId, target.config).catch((err) => {
          ctx.logger.error("manual poll failed for company", { companyId: target.companyId, error: summarizeError(err) });
        });
      }
      return { ok: true, companies: active.length };
    });

    ctx.actions.register("send-reply", async (params) => {
      const companyId = params?.companyId as string;
      if (!companyId) throw configError("send-reply requires companyId.");
      const config = (await ctx.config.get(companyId)) as EmailPluginConfig;
      if (!config?.username) throw configError("Mailbox is not configured for this company.");
      const issueId = params?.issueId as string;
      if (!issueId) throw configError("send-reply requires issueId.");

      const existing = await ctx.state.get({ scopeKind: "issue", scopeId: issueId, namespace: STATE_NS, stateKey: "sent" });
      if (existing) {
        return { ok: false, alreadySent: true, sent: existing };
      }

      const thread = (await ctx.state.get({ scopeKind: "issue", scopeId: issueId, namespace: STATE_NS, stateKey: "thread" })) as ThreadRecord | null;
      if (!thread) throw configError("No inbound email thread is linked to this issue.");

      const doc = await ctx.issues.documents.get(issueId, "reply-draft", companyId).catch(() => null);
      const overrideBody = typeof params?.body === "string" && params.body.trim() ? params.body.trim() : null;
      if (!doc?.body && !overrideBody) {
        throw configError("No reply-draft document on this issue. The Communications Drafter must attach a draft before the Board sends.");
      }
      const draft = doc?.body ? parseReplyDraft(doc.body) : { to: null, subject: null, text: overrideBody as string };
      const text = overrideBody ?? draft.text;
      if (!text) throw configError("The reply draft is empty.");

      const to = draft.to || thread.fromAddress || thread.from;
      const subject = draft.subject || thread.subject;
      const profiles = buildProfiles(config);
      const profile = profiles.find((p) => p.key === thread.profileKey) ?? profiles[0];
      if (!profile) throw configError("No mailbox profile configured for sending.");
      const password = await resolvePassword(ctx, config, companyId);

      const result = await sendReply(profile, password, {
        to,
        subject,
        text,
        inReplyTo: thread.messageId,
        references: thread.references,
      });

      const sent: SentRecord = {
        issueId,
        sentAt: new Date().toISOString(),
        sentMessageId: result.sentMessageId,
        to,
        subject,
        profileKey: profile.key,
      };
      await ctx.state.set({ scopeKind: "issue", scopeId: issueId, namespace: STATE_NS, stateKey: "sent" }, sent);

      await ctx.issues.createComment(
        issueId,
        [
          `## Reply sent by Board action`,
          "",
          `- **To:** ${to}`,
          `- **Subject:** ${/^re:/i.test(subject) ? subject : `Re: ${subject}`}`,
          `- **Sent at:** ${sent.sentAt}`,
          `- **Sent Message-ID:** \`${result.sentMessageId}\``,
          `- **Thread (in-reply-to):** \`${thread.messageId}\``,
          `- **Profile:** ${profile.key}`,
          "",
          "Sent via the governed Board send action. The original message was flagged answered and archived per connector config. This comment is the permanent send record.",
        ].join("\n"),
        companyId,
      );

      await markReplied(profile, password, thread.uid, thread.folder).catch((err) => {
        ctx.logger.warn("markReplied failed", { issueId, error: summarizeError(err) });
      });

      const status = await getStatus(ctx, companyId);
      status.totals.sent += 1;
      await ctx.state.set({ scopeKind: "company", scopeId: companyId, namespace: STATE_NS, stateKey: "mailbox-status" }, status);
      await ctx.metrics.write("replies_sent", 1, { profile: profile.key, venture: thread.ventureHint });
      await ctx.activity.log({
        companyId,
        message: `Board-approved reply sent for "${thread.subject}" to ${to}`,
        entityType: "issue",
        entityId: issueId,
        metadata: { sentMessageId: result.sentMessageId, threadMessageId: thread.messageId },
      });
      return { ok: true, sent };
    });
  },

  async onValidateConfig(config) {
    const cfg = config as EmailPluginConfig;
    const warnings: string[] = [];
    const errors: string[] = [];
    if (!cfg.intakeProjectId) warnings.push("intakeProjectId is empty; intake issues will be created without a project.");
    if (!cfg.triageAgentId) warnings.push("triageAgentId is empty; intake issues will be unassigned.");
    if (!cfg.username) errors.push("Mailbox username is required.");
    if (!cfg.credentialSecretRef) errors.push("A credential secret binding is required.");
    if (errors.length > 0) return { ok: false, warnings, errors };

    try {
      const profiles = buildProfiles(cfg);
      return { ok: true, warnings: [...warnings, `Configuration valid. ${profiles.length} profile(s) configured. Live IMAP/SMTP verification runs on the first poll.`] };
    } catch (err) {
      return { ok: false, warnings, errors: [summarizeError(err)] };
    }
  },

  async onHealth() {
    return { status: "ok", message: "email connector worker running" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
