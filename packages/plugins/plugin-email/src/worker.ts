import { createHash } from "node:crypto";
import {
  definePlugin,
  runWorker,
  type PluginContext,
} from "@paperclipai/plugin-sdk";
import {
  DEFAULTS,
  JOB_KEYS,
  ORIGIN_KIND_INTAKE,
  STATE_NS,
  STATE_NS_INTAKE,
} from "./constants.js";
import {
  fetchUnseen,
  markReplied,
  markSeen,
  searchBySubject,
  type ConnectorProfile,
  type FetchedMessage,
} from "./mail/imap.js";
import { sendReply } from "./mail/smtp.js";
import {
  detectSource,
  extractStoreIntake,
  issueDescriptionFor,
  issueTitleFor,
  normalizeMessage,
  priorityFor,
  type NormalizedMessage,
} from "./mail/normalize.js";
import {
  DuplicateMatcher,
  FixtureStoreProvider,
  JsonStoreProvider,
  type DuplicateQuery,
  type StoreProvider,
} from "./mail/duplicates.js";
import {
  createReviewRecord,
  getLatestReview,
  getLatestOutcome,
  shouldSendIntakeNotification,
  isPendingNotification,
  type ReviewRecord,
  type ReviewVerdict,
  type OperationalOutcome,
  type IntakeNotificationRecord,
} from "./mail/review.js";
import {
  createAnalysisRecord,
  needsClassificationFallback,
  validateAnalysisOutput,
  type AnalysisRecord,
} from "./mail/analysis.js";
import {
  IntakeMetadata,
  type IntakeTransport,
  type RecordCompleteness,
} from "./mail/intake-metadata.js";
import {
  ReconciliationIndex,
  correlateIncomingEvidence,
  reconcileRecord,
  isProviderMarketing,
  type IntakeRecord,
  type CorrelationAttempt,
  type IntakeRecordEntry,
} from "./mail/reconciliation.js";
import {
  sortIntakeRecord,
  CATEGORY_LABELS,
  type IntakeSortResult,
} from "./mail/sorter.js";
import {
  decideDraft,
  formatDraftDocument,
  type DraftCandidate,
} from "./mail/drafts.js";
import {
  createConversationRecord,
  type StructuredConversationRecord,
} from "./mail/conversation.js";
import {
  createShadowEvaluation,
  type ShadowConversationEvaluation,
} from "./mail/conversation-evaluation.js";
import {
  activeMailboxProfiles,
  buildMailboxProfiles,
  hasActiveMailboxConfig,
  resolveProfileCredentialBinding,
  type MailboxProfileHostConfig,
  type ResolvedMailboxProfile,
} from "./mail/mailbox-profiles.js";

type EmailPluginConfig = MailboxProfileHostConfig & {
  scheduledPollingEnabled?: boolean;
  outboundEnabled?: boolean;
  intakeProjectId?: string;
  triageAgentId?: string;
  billingCode?: string;
  storeExportPath?: string;
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

type IntakeEvidence = {
  messageId: string;
  profileKey: string;
  from: string;
  fromAddress: string;
  to: string;
  subject: string;
  date: string;
  classHint: string;
  ventureHint: string;
  evidenceId: string;
  sourceDetection: ReturnType<typeof detectSource>;
  storeIntake: ReturnType<typeof extractStoreIntake>;
  originalFields: Record<string, string>;
  normalizedFields: Record<string, string>;
  ingestedAt: string;
};

function summarizeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

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

function seenKey(messageId: string): string {
  return `seen:${createHash("sha1").update(messageId).digest("hex")}`;
}

export function resolveQueueStoreName(evidence: Record<string, unknown> | null): string | null {
  const si = evidence?.storeIntake as Record<string, unknown> | null | undefined;
  if (!si) return null;
  const normalized = si.normalizedValues as Record<string, string> | undefined;
  if (normalized?.storeName) return normalized.storeName;
  const original = si.originalValues as Record<string, string> | undefined;
  return original?.storeName ?? null;
}

export interface SortAndDraftResult {
  sortResult: IntakeSortResult;
  draftCandidate: {
    candidate: DraftCandidate;
    formatted: string;
    generatedAt: string;
    reason: string;
  } | null;
}

/**
 * Deterministic intake sorting and draft-candidate generation.
 *
 * Called by ingestMessage during the ingestion pipeline.
 * Exported so that integration tests can exercise the exact same
 * production path without a live PluginContext.
 *
 * This function:
 * - classifies every intake record into exactly one sort category
 * - decides whether a draft candidate is appropriate
 * - NEVER sends, NEVER contacts SMTP, NEVER enables outbound
 * - drafts are formatted documents only
 */
export function computeSortAndDraft(
  detection: ReturnType<typeof detectSource>,
  classHint: NormalizedMessage["classHint"],
  intakeMetadata: IntakeMetadata | null,
  inReplyTo: string | null,
  references: string[],
  fromAddress: string,
  fromDisplay: string,
  subject: string,
): SortAndDraftResult {
  const sortResult = sortIntakeRecord({
    sourceDetection: detection,
    classHint,
    intakeMetadata,
    duplicateMatchStrength: null,
    latestVerdict: null,
    hasReplyDraft: false,
    inReplyTo,
    hasReferences: references.length > 0,
  });

  const draftDecision = decideDraft(sortResult.category, {
    fromAddress,
    from: fromDisplay,
    subject,
  });

  const draftCandidate =
    draftDecision.shouldDraft && draftDecision.candidate
      ? {
          candidate: draftDecision.candidate,
          formatted: formatDraftDocument(draftDecision.candidate),
          generatedAt: new Date().toISOString(),
          reason: draftDecision.reason,
        }
      : null;

  return { sortResult, draftCandidate };
}

function configError(message: string): Error {
  return new Error(`[${"qsl.email"}] ${message}`);
}

function buildProfiles(config: EmailPluginConfig): ResolvedMailboxProfile[] {
  return buildMailboxProfiles(config);
}

async function resolvePassword(
  ctx: PluginContext,
  profile: ResolvedMailboxProfile,
  companyId: string,
): Promise<string> {
  const binding = resolveProfileCredentialBinding(profile);
  return ctx.secrets.resolve(binding.secretRef, { companyId, configPath: binding.configPath });
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
    if (!hasActiveMailboxConfig(config)) continue;
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

  // -- Governed intake: evidence (write-once) --
  const existingEvidence = await ctx.state.get({ scopeKind: "issue", scopeId: issue.id, namespace: STATE_NS_INTAKE, stateKey: "intake-evidence" });
  if (existingEvidence) {
    // Evidence already exists; verify fingerprint match if present
    const existing = existingEvidence as Record<string, unknown>;
    if (existing.evidenceId !== msg.evidenceId) {
      await ctx.activity.log({
        companyId,
        message: `Evidence integrity: conflicting re-ingestion attempt for issue ${issue.id} (existing=${existing.evidenceId}, incoming=${msg.evidenceId})`,
        entityType: "issue",
        entityId: issue.id,
        metadata: { action: "evidence_conflict", existingEvidenceId: existing.evidenceId, incomingEvidenceId: msg.evidenceId },
      });
    }
  } else {
    const detection = detectSource(msg.subject, msg.fromAddress, msg.bodyText);
    const storeIntake = extractStoreIntake(msg, detection, issue.id);
    const evidence: IntakeEvidence = {
      messageId: msg.messageId,
      profileKey: profile.key,
      from: msg.from,
      fromAddress: msg.fromAddress,
      to: msg.to,
      subject: msg.subject,
      date: msg.date,
      classHint: msg.classHint,
      ventureHint: msg.ventureHint,
      evidenceId: msg.evidenceId,
      sourceDetection: detection,
      storeIntake,
      originalFields: storeIntake?.originalValues ?? {},
      normalizedFields: storeIntake?.normalizedValues ?? {},
      ingestedAt: thread.ingestedAt,
    };
    await ctx.state.set({ scopeKind: "issue", scopeId: issue.id, namespace: STATE_NS_INTAKE, stateKey: "intake-evidence" }, evidence);

    // -- Governed intake: intake metadata with durable reconciliation --
    const existingMetadata = await ctx.state.get({ scopeKind: "issue", scopeId: issue.id, namespace: STATE_NS_INTAKE, stateKey: "intake-metadata" });
    if (!existingMetadata && storeIntake?.intakeMetadata) {
      await ctx.state.set({ scopeKind: "issue", scopeId: issue.id, namespace: STATE_NS_INTAKE, stateKey: "intake-metadata" }, storeIntake.intakeMetadata);

      const index = await rebuildReconciliationIndex(ctx, companyId);
      const correlation = correlateIncomingEvidence(
        {
          id: issue.id,
          metadata: storeIntake.intakeMetadata,
          fieldValues: storeIntake.normalizedValues,
        },
        index.listAll(),
      );

      if (correlation.unsafeCorrelation) {
        await ctx.activity.log({
          companyId,
          message: `Correlation safety gate: intake record ${issue.id} cannot be deterministically merged — requires human review`,
          entityType: "issue",
          entityId: issue.id,
          metadata: { action: "unsafe_correlation", reason: correlation.reason },
        });
      }
    } else if (existingMetadata && storeIntake?.intakeMetadata) {
      const existing = existingMetadata as IntakeMetadata;
      const incoming = storeIntake.intakeMetadata;

      const index = await rebuildReconciliationIndex(ctx, companyId);
      const existingRecord = index.get(issue.id);

      if (existingRecord) {
        const hasStrongerEvidence =
          (incoming.intakeTransport === "provider_webhook" ||
           incoming.intakeTransport === "provider_api" ||
           incoming.intakeTransport === "wordpress_event") &&
          existing.intakeTransport === "email_notification";

        if (hasStrongerEvidence) {
          const reconciled = reconcileRecord(existingRecord, {
            metadata: incoming,
            fieldValues: storeIntake.normalizedValues,
          });
          await ctx.state.set({ scopeKind: "issue", scopeId: issue.id, namespace: STATE_NS_INTAKE, stateKey: "intake-metadata" }, reconciled.metadata);
        }
      }
    }

    // -- Governed intake: duplicate matching (read-only, no write to TheBinMap) --
    if (storeIntake) {
      try {
        const dupQuery: DuplicateQuery = {
          storeName: storeIntake.originalValues.storeName || "",
          address: storeIntake.originalValues.address || "",
          city: storeIntake.originalValues.city || "",
          state: storeIntake.originalValues.state || "",
          phone: storeIntake.originalValues.phone || "",
          website: storeIntake.originalValues.website || "",
          facebookUrl: storeIntake.originalValues.facebookUrl || "",
          otherSocialUrl: storeIntake.originalValues.otherSocialUrl || "",
        };
        let storeProvider: StoreProvider;
        let providerStatus: string;
        if (config.storeExportPath) {
          const jsonProvider = new JsonStoreProvider(config.storeExportPath);
          if (jsonProvider.isAvailable()) {
            storeProvider = jsonProvider;
            providerStatus = "configured";
          } else {
            storeProvider = new FixtureStoreProvider();
            providerStatus = "unavailable: " + (jsonProvider.getError() ?? "unknown error");
          }
        } else {
          storeProvider = new FixtureStoreProvider();
          providerStatus = "not_configured";
        }
        const matcher = new DuplicateMatcher(storeProvider);
        const dupes = await matcher.findDuplicates(dupQuery);
        await ctx.state.set({ scopeKind: "issue", scopeId: issue.id, namespace: STATE_NS_INTAKE, stateKey: "intake-duplicates" }, dupes);
        await ctx.state.set({ scopeKind: "issue", scopeId: issue.id, namespace: STATE_NS_INTAKE, stateKey: "intake-provider-status" }, providerStatus);
      } catch {
        // Duplicate matching is advisory only; never blocks intake
      }
    }

    // -- Governed intake: deterministic analysis (proposal only, not a verdict) --
    const fallback = needsClassificationFallback();
    const analysisOutput = {
      ...fallback,
      category: msg.classHint,
      confidence: detection.confidence,
      priority: priorityFor(msg.classHint),
      priorityReason: "Deterministic source detection: " + detection.sourceType + " (" + detection.sourceForm + "), confidence " + detection.confidence,
      humanApprovalRequired: true,
      summary: detection.sourceType !== "unknown"
        ? "Store submission from " + detection.sourceForm + " via " + detection.sourcePage + "."
        : "General intake message classified as " + msg.classHint + ".",
    };
    const analysisRecord = createAnalysisRecord(
      "deterministic", "classifier-v1",
      analysisOutput,
      "ev-" + msg.evidenceId,
      "deterministic_only",
    );
    const analysisKey = "intake-analysis-" + Date.now() + "-" + msg.evidenceId.slice(0, 12);
    await ctx.state.set({ scopeKind: "issue", scopeId: issue.id, namespace: STATE_NS_INTAKE, stateKey: analysisKey }, analysisRecord);
    const existingAnalysisKeys = await ctx.state.get({ scopeKind: "issue", scopeId: issue.id, namespace: STATE_NS_INTAKE, stateKey: "intake-analysis-keys" });
    const analysisKeys: string[] = Array.isArray(existingAnalysisKeys) ? existingAnalysisKeys : [];
    analysisKeys.push(analysisKey);
    await ctx.state.set({ scopeKind: "issue", scopeId: issue.id, namespace: STATE_NS_INTAKE, stateKey: "intake-analysis-keys" }, analysisKeys);

    // -- Governed intake: deterministic sorter and draft candidate --
    const { sortResult, draftCandidate } = computeSortAndDraft(
      detection,
      msg.classHint,
      storeIntake?.intakeMetadata ?? null,
      msg.inReplyTo,
      msg.references,
      msg.fromAddress,
      msg.from,
      msg.subject,
    );
    await ctx.state.set({ scopeKind: "issue", scopeId: issue.id, namespace: STATE_NS_INTAKE, stateKey: "intake-sort-result" }, sortResult);

    const conversationRecord = createConversationRecord({
      msg,
      detection,
      sortResult,
      intakeMetadata: storeIntake?.intakeMetadata ?? null,
      storeIntake,
      draftCandidate: draftCandidate?.candidate ?? null,
    });
    const shadowEvaluation = createShadowEvaluation(conversationRecord);
    await ctx.state.set({
      scopeKind: "issue",
      scopeId: issue.id,
      namespace: STATE_NS_INTAKE,
      stateKey: "conversation-record",
    }, conversationRecord);
    await ctx.state.set({
      scopeKind: "issue",
      scopeId: issue.id,
      namespace: STATE_NS_INTAKE,
      stateKey: "conversation-shadow-evaluation",
    }, shadowEvaluation);
    await ctx.metrics.write("conversation_record_created", 1, {
      profile: profile.key,
      tenant: conversationRecord.tenant,
      state: conversationRecord.state,
      nextAction: conversationRecord.nextAction.kind,
    });
    await ctx.metrics.write(shadowEvaluation.humanAttentionRequired ? "conversation_human_review" : "conversation_no_human_action", 1, {
      profile: profile.key,
      tenant: conversationRecord.tenant,
      shadowAction: shadowEvaluation.shadowActionKind,
    });
    if (conversationRecord.output.mode === "draft" && conversationRecord.output.draft) {
      await ctx.metrics.write("conversation_draft_ready", 1, { profile: profile.key, tenant: conversationRecord.tenant });
    }
    if (conversationRecord.riskAuthorityClass === "commercial_opportunity") {
      await ctx.metrics.write("conversation_commercial_opportunity", 1, { profile: profile.key, tenant: conversationRecord.tenant });
    }
    if (conversationRecord.riskAuthorityClass === "uncertain") {
      await ctx.metrics.write("conversation_uncertain", 1, { profile: profile.key, tenant: conversationRecord.tenant });
    }

    if (draftCandidate) {
      await ctx.state.set({
        scopeKind: "issue",
        scopeId: issue.id,
        namespace: STATE_NS_INTAKE,
        stateKey: "intake-draft-candidate",
      }, draftCandidate);
    }

    // -- Governed intake: deduplicated notification (pending -> activity -> completed) --
    if (storeIntake && shouldSendIntakeNotification("high", "store_submission", null)) {
      const existingNotif = await ctx.state.get({ scopeKind: "issue", scopeId: issue.id, namespace: STATE_NS_INTAKE, stateKey: "intake-notification" }) as IntakeNotificationRecord | undefined;
      if (!existingNotif?.sent) {
        const pending: IntakeNotificationRecord = {
          sent: false,
          sentAt: null,
          issueId: issue.id,
          priority: "high",
          category: "store_submission",
          evidenceFingerprint: msg.evidenceId,
        };
        await ctx.state.set({ scopeKind: "issue", scopeId: issue.id, namespace: STATE_NS_INTAKE, stateKey: "intake-notification" }, pending);
        try {
          await ctx.activity.log({
            companyId,
            message: "NEW STORE SUBMISSION REQUIRES REVIEW: " + (storeIntake.originalValues.storeName || "unknown store"),
            entityType: "issue",
            entityId: issue.id,
            metadata: { priority: "high", category: "store_submission", evidenceFingerprint: msg.evidenceId },
          });
          // Activity succeeded: mark notification completed
          pending.sent = true;
          pending.sentAt = new Date().toISOString();
          await ctx.state.set({ scopeKind: "issue", scopeId: issue.id, namespace: STATE_NS_INTAKE, stateKey: "intake-notification" }, pending);
        } catch {
          // Activity log failed; notification stays pending.
          // On retry (re-ingestion blocked by seenKey), the pending state
          // will be detected and only the activity will be re-attempted.
        }
      } else if (isPendingNotification(existingNotif)) {
        // Retry: notification was pending from a previous partial ingestion.
        // Re-attempt the activity log.
        try {
          await ctx.activity.log({
            companyId,
            message: "NEW STORE SUBMISSION REQUIRES REVIEW (retry): " + (storeIntake?.originalValues.storeName || "unknown store"),
            entityType: "issue",
            entityId: issue.id,
            metadata: { priority: "high", category: "store_submission", evidenceFingerprint: existingNotif.evidenceFingerprint },
          });
          existingNotif.sent = true;
          existingNotif.sentAt = new Date().toISOString();
          await ctx.state.set({ scopeKind: "issue", scopeId: issue.id, namespace: STATE_NS_INTAKE, stateKey: "intake-notification" }, existingNotif);
        } catch {
          // Activity still failing; notification remains pending for next retry.
        }
      }
    }
  }

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
  scheduled: boolean,
): Promise<ProfilePollResult[]> {
  const status = await getStatus(ctx, companyId);

  if (config.enabled === false) {
    status.lastPollAt = new Date().toISOString();
    status.profiles = [{ key: "primary", ok: true, found: 0, created: 0, skippedDuplicates: 0, error: "connector disabled" }];
    await ctx.state.set({ scopeKind: "company", scopeId: companyId, namespace: STATE_NS, stateKey: "mailbox-status" }, status);
    return status.profiles;
  }

  if (scheduled && config.scheduledPollingEnabled !== true) {
    status.lastPollAt = new Date().toISOString();
    status.profiles = [{ key: "primary", ok: true, found: 0, created: 0, skippedDuplicates: 0, error: "scheduled polling disabled; set scheduledPollingEnabled to enable recurring polls" }];
    await ctx.state.set({ scopeKind: "company", scopeId: companyId, namespace: STATE_NS, stateKey: "mailbox-status" }, status);
    ctx.logger.info("poll skipped: scheduledPollingEnabled is false for this company", { companyId });
    return status.profiles;
  }

  if (config.intakeSince && !isValidIntakeDate(config.intakeSince)) {
    throw configError("intakeSince is not a valid date (use YYYY-MM-DD, e.g. 2026-07-01): " + config.intakeSince);
  }

  const profiles = activeMailboxProfiles(config);
  if (profiles.length === 0) {
    throw configError("No active mailbox profiles configured. Activate a mailbox profile or configure the legacy primary mailbox.");
  }

  const results: ProfilePollResult[] = [];
  for (const profile of profiles) {
    const result: ProfilePollResult = { key: profile.key, ok: true, found: 0, created: 0, skippedDuplicates: 0 };
    const cursorKey = `uid-cursor:${profile.key}`;
    try {
      if (profile.intakeSince && !isValidIntakeDate(profile.intakeSince)) {
        throw configError(`Mailbox profile "${profile.key}" intakeSince is not a valid date (use YYYY-MM-DD): ${profile.intakeSince}`);
      }
      const password = await resolvePassword(ctx, profile, companyId);
      const cursorRaw = await ctx.state.get({ scopeKind: "company", scopeId: companyId, namespace: STATE_NS, stateKey: cursorKey });
      const afterUid = typeof cursorRaw === "number" ? cursorRaw : 0;
      const fetched = await fetchUnseen(profile, password, afterUid);
      result.found = fetched.length;
      let maxUid = afterUid;
      for (const raw of fetched) {
        maxUid = Math.max(maxUid, raw.uid);
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
      if (maxUid > afterUid) {
        await ctx.state.set({ scopeKind: "company", scopeId: companyId, namespace: STATE_NS, stateKey: cursorKey }, maxUid);
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

function toIsoString(v: Date | string | undefined): string {
  if (typeof v === "string") return v;
  if (v instanceof Date) return v.toISOString();
  return new Date().toISOString();
}

function issueCreatedAt(issue: { createdAt?: Date | string | null }): string {
  return toIsoString(issue.createdAt ?? undefined);
}

async function rebuildReconciliationIndex(ctx: PluginContext, companyId: string): Promise<ReconciliationIndex> {
  const index = new ReconciliationIndex();
  try {
    const issues = await ctx.issues.list({
      companyId,
      originKindPrefix: ORIGIN_KIND_INTAKE,
      limit: 200,
    });
    for (const issue of issues) {
      try {
        const metadata = await ctx.state.get({
          scopeKind: "issue",
          scopeId: issue.id,
          namespace: STATE_NS_INTAKE,
          stateKey: "intake-metadata",
        });
        if (metadata && typeof metadata === "object") {
          const m = metadata as IntakeMetadata;
          const evidence = await ctx.state.get({
            scopeKind: "issue",
            scopeId: issue.id,
            namespace: STATE_NS_INTAKE,
            stateKey: "intake-evidence",
          });
          const fieldValues: Record<string, string> = {};
          if (evidence && typeof evidence === "object") {
            const ev = evidence as { normalizedFields?: Record<string, string>; storeIntake?: { normalizedValues?: Record<string, string> } };
            if (ev.normalizedFields && typeof ev.normalizedFields === "object") {
              Object.assign(fieldValues, ev.normalizedFields as Record<string, string>);
            } else if (ev.storeIntake?.normalizedValues) {
              Object.assign(fieldValues, ev.storeIntake.normalizedValues as Record<string, string>);
            }
          }
          index.add({
            id: issue.id,
            metadata: m,
            fieldValues,
            createdAt: issueCreatedAt(issue),
            updatedAt: m.lastEnrichedAt ?? issueCreatedAt(issue),
          });
        }
      } catch {
        // Skip individual issues that fail to load
      }
    }
  } catch {
    // Return empty index on failure
  }
  return index;
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
        await runPollForCompany(ctx, companyId, config, true).catch((err) => {
          ctx.logger.error("poll failed for company", { companyId, error: summarizeError(err) });
        });
      }
    });

    ctx.data.register("mailbox-status", async (params) => {
      const companyId = params?.companyId as string;
      if (!companyId) return { lastPollAt: null, totals: { polls: 0, ingested: 0, sent: 0 }, profiles: [] };
      return getStatus(ctx, companyId);
    });

    ctx.data.register("plugin-config", async (params) => {
      const companyId = params?.companyId as string;
      if (!companyId) return null;
      try {
        return await ctx.config.get(companyId) as EmailPluginConfig;
      } catch {
        return null;
      }
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
      const draftCandidate = await ctx.state.get({ scopeKind: "issue", scopeId: issueId, namespace: STATE_NS_INTAKE, stateKey: "intake-draft-candidate" });
      return { thread: thread ?? null, sent: sent ?? null, draft, draftCandidate: draftCandidate ?? null };
    });

    // -- Store intake data provider --
    ctx.data.register("store-intake", async (params) => {
      const issueId = params?.issueId as string;
      if (!issueId) return null;
      try {
        const evidence = await ctx.state.get({ scopeKind: "issue", scopeId: issueId, namespace: STATE_NS_INTAKE, stateKey: "intake-evidence" });
        const duplicates = await ctx.state.get({ scopeKind: "issue", scopeId: issueId, namespace: STATE_NS_INTAKE, stateKey: "intake-duplicates" });
        const notification = await ctx.state.get({ scopeKind: "issue", scopeId: issueId, namespace: STATE_NS_INTAKE, stateKey: "intake-notification" });
        const intakeMetadata = await ctx.state.get({ scopeKind: "issue", scopeId: issueId, namespace: STATE_NS_INTAKE, stateKey: "intake-metadata" });
        const conversationRecord = await ctx.state.get({ scopeKind: "issue", scopeId: issueId, namespace: STATE_NS_INTAKE, stateKey: "conversation-record" });
        const shadowEvaluation = await ctx.state.get({ scopeKind: "issue", scopeId: issueId, namespace: STATE_NS_INTAKE, stateKey: "conversation-shadow-evaluation" });

        // Gather analyses from unique keys (D3: safe per-record keys)
        const analyses: AnalysisRecord[] = [];
        // Fetch analyses by prefix-search: we rely on listing known keys via the analysis index
        const analysisIndex = await ctx.state.get({ scopeKind: "issue", scopeId: issueId, namespace: STATE_NS_INTAKE, stateKey: "intake-analysis-keys" });
        const analysisKeys: string[] = Array.isArray(analysisIndex) ? analysisIndex : [];
        for (const key of analysisKeys) {
          try {
            const record = await ctx.state.get({ scopeKind: "issue", scopeId: issueId, namespace: STATE_NS_INTAKE, stateKey: key });
            if (record) {
              // D7: Validate stored analysis before exposing to UI
              const validated = validateAnalysisOutput((record as AnalysisRecord).analysis);
              const safeRecord = { ...(record as AnalysisRecord) };
              if (!validated.ok) {
                safeRecord.analysis = needsClassificationFallback();
              }
              analyses.push(safeRecord);
            }
          } catch { /* skip corrupted record */ }
        }

        // Gather reviews from unique keys (D3: safe per-record keys)
        const reviews: ReviewRecord[] = [];
        const reviewIndex = await ctx.state.get({ scopeKind: "issue", scopeId: issueId, namespace: STATE_NS_INTAKE, stateKey: "intake-review-keys" });
        const reviewKeys: string[] = Array.isArray(reviewIndex) ? reviewIndex : [];
        for (const key of reviewKeys) {
          try {
            const record = await ctx.state.get({ scopeKind: "issue", scopeId: issueId, namespace: STATE_NS_INTAKE, stateKey: key });
            if (record) reviews.push(record as ReviewRecord);
          } catch { /* skip corrupted record */ }
        }

        const latestAnalysis = analyses.length > 0 ? analyses[analyses.length - 1].analysis : null;
        const latestReview = getLatestReview(reviews);
        const sortResult = await ctx.state.get({ scopeKind: "issue", scopeId: issueId, namespace: STATE_NS_INTAKE, stateKey: "intake-sort-result" });
        const draftCandidate = await ctx.state.get({ scopeKind: "issue", scopeId: issueId, namespace: STATE_NS_INTAKE, stateKey: "intake-draft-candidate" });
        return {
          evidence: evidence ?? null,
          duplicates: duplicates ?? [],
          analyses,
          reviews,
          latestAnalysis,
          latestReview,
          latestVerdict: latestReview?.verdict ?? null,
          latestOutcome: getLatestOutcome(reviews),
          notification,
          intakeMetadata: intakeMetadata ?? null,
          conversationRecord: conversationRecord ?? null,
          shadowEvaluation: shadowEvaluation ?? null,
          sortResult: sortResult ?? null,
          draftCandidate: draftCandidate ?? null,
        };
      } catch {
        return null;
      }
    });

    // -- Intake queue data provider (D1: review queue) --
    ctx.data.register("intake-queue", async (params) => {
      const companyId = params?.companyId as string;
      if (!companyId) return [];
      const requestedProfileKey = typeof params?.profileKey === "string" && params.profileKey.trim()
        ? params.profileKey.trim()
        : null;
      try {
        const config = (await ctx.config.get(companyId).catch(() => null)) as EmailPluginConfig | null;
        const mailboxUsernameByKey = new Map<string, string>();
        if (config) {
          try {
            for (const profile of buildProfiles(config)) {
              mailboxUsernameByKey.set(profile.key, profile.username);
            }
          } catch {
            // Keep historical queue evidence readable even if current mailbox config is incomplete.
          }
        }

        const issues = await ctx.issues.list({
          companyId,
          originKindPrefix: ORIGIN_KIND_INTAKE,
          limit: 200,
        });
        const items: Array<Record<string, unknown>> = [];
        for (const issue of issues) {
          try {
            const evidence = await ctx.state.get({ scopeKind: "issue", scopeId: issue.id, namespace: STATE_NS_INTAKE, stateKey: "intake-evidence" });
            const evidenceRecord = evidence && typeof evidence === "object"
              ? evidence as Record<string, unknown>
              : null;
            const profileKey = typeof evidenceRecord?.profileKey === "string" ? evidenceRecord.profileKey : null;
            if (requestedProfileKey && profileKey !== requestedProfileKey) continue;

            const reviewKeys = await ctx.state.get({ scopeKind: "issue", scopeId: issue.id, namespace: STATE_NS_INTAKE, stateKey: "intake-review-keys" });
            const reviewKeyList: string[] = Array.isArray(reviewKeys) ? reviewKeys : [];
            let latestVerdict: string | null = null;
            let latestOutcome: string | null = null;
            if (reviewKeyList.length > 0) {
              const lastKey = reviewKeyList[reviewKeyList.length - 1];
              const lastReview = await ctx.state.get({ scopeKind: "issue", scopeId: issue.id, namespace: STATE_NS_INTAKE, stateKey: lastKey });
              if (lastReview) {
                const r = lastReview as ReviewRecord;
                latestVerdict = r.verdict;
                latestOutcome = r.operationalOutcome ?? null;
              }
            }
            const duplicates = await ctx.state.get({ scopeKind: "issue", scopeId: issue.id, namespace: STATE_NS_INTAKE, stateKey: "intake-duplicates" });
            const dupList = Array.isArray(duplicates) ? duplicates : [];
            const intakeMetadata = await ctx.state.get({ scopeKind: "issue", scopeId: issue.id, namespace: STATE_NS_INTAKE, stateKey: "intake-metadata" });
            const sortData = await ctx.state.get({ scopeKind: "issue", scopeId: issue.id, namespace: STATE_NS_INTAKE, stateKey: "intake-sort-result" }) as IntakeSortResult | undefined;
            const draftData = await ctx.state.get({ scopeKind: "issue", scopeId: issue.id, namespace: STATE_NS_INTAKE, stateKey: "intake-draft-candidate" }) as Record<string, unknown> | undefined;
            const conversationData = await ctx.state.get({ scopeKind: "issue", scopeId: issue.id, namespace: STATE_NS_INTAKE, stateKey: "conversation-record" }) as StructuredConversationRecord | undefined;
            const shadowData = await ctx.state.get({ scopeKind: "issue", scopeId: issue.id, namespace: STATE_NS_INTAKE, stateKey: "conversation-shadow-evaluation" }) as ShadowConversationEvaluation | undefined;
            items.push({
              issueId: issue.id,
              identifier: issue.identifier,
              title: issue.title,
              status: issue.status,
              priority: issue.priority,
              createdAt: issue.createdAt,
              profileKey,
              mailboxUsername: profileKey ? mailboxUsernameByKey.get(profileKey) ?? null : null,
              fromAddress: typeof evidenceRecord?.fromAddress === "string" ? evidenceRecord.fromAddress : null,
              to: typeof evidenceRecord?.to === "string" ? evidenceRecord.to : null,
              messageSubject: typeof evidenceRecord?.subject === "string" ? evidenceRecord.subject : issue.title,
              messageDate: typeof evidenceRecord?.date === "string" ? evidenceRecord.date : issue.createdAt,
              storeName: resolveQueueStoreName(evidenceRecord),
              sourceForm: evidenceRecord?.sourceDetection
                ? (evidenceRecord.sourceDetection as Record<string, string>)?.sourceForm ?? null
                : null,
              sourceType: evidenceRecord?.sourceDetection
                ? (evidenceRecord.sourceDetection as Record<string, string>)?.sourceType ?? null
                : null,
              latestVerdict,
              latestOutcome,
              duplicateCount: dupList.length,
              duplicateStrength: dupList.length > 0 ? (dupList.some((d: Record<string, unknown>) => d.matchStrength === "strong") ? "strong" : "possible") : null,
              hasEvidence: evidence != null,
              intakeTransport: intakeMetadata ? (intakeMetadata as IntakeMetadata).intakeTransport : "inferred_email",
              recordCompleteness: intakeMetadata ? (intakeMetadata as IntakeMetadata).recordCompleteness : "needs_source_verification",
              missingFields: intakeMetadata ? (intakeMetadata as IntakeMetadata).missingFields : [],
              conflictingFields: intakeMetadata ? (intakeMetadata as IntakeMetadata).conflictingFields : [],
              sortCategory: sortData?.category ?? null,
              sortLabel: sortData ? CATEGORY_LABELS[sortData.category] : null,
              replyActionStatus: sortData?.replyActionStatus ?? null,
              draftCandidateKind: draftData?.candidate ? (draftData.candidate as DraftCandidate).kind : null,
              conversationState: conversationData?.state ?? null,
              conversationIntent: conversationData?.intent.category ?? null,
              conversationNextAction: conversationData?.nextAction.kind ?? null,
              conversationHumanGate: conversationData?.nextAction.humanApprovalRequired ?? null,
              conversationRiskAuthorityClass: conversationData?.riskAuthorityClass ?? null,
              conversationOutputMode: conversationData?.output.mode ?? null,
              conversationCommercialSignal: conversationData?.commercialSignal.present ?? null,
              conversationConfidence: conversationData?.intent.confidence ?? null,
              conversationEntityName: conversationData?.entityContext.entityName ?? null,
              conversationEntityType: conversationData?.entityContext.entityType ?? null,
              shadowActionKind: shadowData?.shadowActionKind ?? null,
              shadowHumanAttentionRequired: shadowData?.humanAttentionRequired ?? null,
              shadowReason: shadowData?.reason ?? null,
            });
          } catch { /* skip problematic issues */ }
        }
        return items;
      } catch {
        return [];
      }
    });

    // -- Perform human review action (D3: unique key per review; D4: trusted actor) --
    ctx.actions.register("perform-review", async (params, actionCtx) => {
      const issueId = params?.issueId as string;
      if (!issueId) throw configError("perform-review requires issueId.");
      const actorUserId = actionCtx?.actor?.userId;
      if (!actorUserId) throw configError("perform-review requires authenticated user context.");
      const verdict = params?.verdict as ReviewVerdict;
      if (!verdict) throw configError("perform-review requires a verdict.");
      const validVerdicts: ReviewVerdict[] = ["genuine_external", "internal_test", "family_test", "spam", "duplicate", "unsure"];
      if (!validVerdicts.includes(verdict)) throw configError("Invalid verdict: " + verdict + ". Must be one of: " + validVerdicts.join(", "));
      const notes = (params?.notes as string) || "";
      if (notes.length > 2000) throw configError("Review notes must be 2000 characters or fewer.");
      const operationalOutcome = params?.operationalOutcome as OperationalOutcome | undefined;
      const duplicateLink = params?.duplicateLink as ReviewRecord["duplicateLink"] | undefined;

      // Gather existing review keys
      const reviewKeyIndex = await ctx.state.get({ scopeKind: "issue", scopeId: issueId, namespace: STATE_NS_INTAKE, stateKey: "intake-review-keys" });
      const existingKeys: string[] = Array.isArray(reviewKeyIndex) ? reviewKeyIndex : [];
      const nextIndex = existingKeys.length;

      // D4: Reviewer identity comes from authenticated actor, NOT from client
      const reviewRecord = createReviewRecord(nextIndex, verdict, actorUserId, {
        notes,
        duplicateLink,
        operationalOutcome,
      });

      // D3: Unique key per review prevents silent overwrite
      const reviewKey = "intake-review-" + Date.now() + "-" + (reviewRecord.reviewIndex || 0);
      await ctx.state.set({ scopeKind: "issue", scopeId: issueId, namespace: STATE_NS_INTAKE, stateKey: reviewKey }, reviewRecord);

      // Update the key index
      existingKeys.push(reviewKey);
      await ctx.state.set({ scopeKind: "issue", scopeId: issueId, namespace: STATE_NS_INTAKE, stateKey: "intake-review-keys" }, existingKeys);

      await ctx.activity.log({
        companyId: params?.companyId as string || actionCtx?.actor?.companyId || "unknown",
        message: "Human review verdict: " + verdict + " for issue " + issueId + " (review #" + nextIndex + ")",
        entityType: "issue",
        entityId: issueId,
        metadata: { verdict, reviewer: actorUserId, reviewIndex: nextIndex, operationalOutcome: operationalOutcome ?? null },
      });

      return { ok: true, review: reviewRecord, totalReviews: existingKeys.length };
    });

    ctx.actions.register("poll-now", async (params) => {
      const companyId = params?.companyId as string;
      if (companyId) {
        const config = (await ctx.config.get(companyId)) as EmailPluginConfig;
        if (config?.enabled === false) throw configError("Connector is disabled for this company.");
        if (!hasActiveMailboxConfig(config)) throw configError("No active mailbox is configured for this company.");
        const results = await runPollForCompany(ctx, companyId, config, false);
        return { ok: true, results };
      }
      const active = await resolveActiveCompanies(ctx);
      for (const target of active) {
        await runPollForCompany(ctx, target.companyId, target.config, false).catch((err) => {
          ctx.logger.error("manual poll failed for company", { companyId: target.companyId, error: summarizeError(err) });
        });
      }
      return { ok: true, companies: active.length };
    });

    ctx.actions.register("poll-target", async (params) => {
      const companyId = params?.companyId as string;
      if (!companyId) throw configError("poll-target requires companyId.");
      const config = (await ctx.config.get(companyId)) as EmailPluginConfig;
      if (config?.enabled === false) throw configError("Connector is disabled for this company.");
      if (!hasActiveMailboxConfig(config)) throw configError("No active mailbox is configured for this company.");
      if (config?.outboundEnabled === true) {
        throw configError("poll-target is not available when outbound is enabled.");
      }

      const subject = typeof params?.subject === "string" && params.subject.trim() ? params.subject.trim() : "";
      if (!subject) throw configError("poll-target requires a subject to search for.");
      if (subject.length < 3) throw configError("poll-target subject search too short; must be at least 3 characters.");

      const fromDomain = typeof params?.fromDomain === "string" && params.fromDomain.trim() ? params.fromDomain.trim() : undefined;
      const dateSince = typeof params?.dateSince === "string" ? new Date(params.dateSince) : undefined;
      const dateBefore = typeof params?.dateBefore === "string" ? new Date(params.dateBefore) : undefined;
      const maxResults = Number(params?.maxResults ?? 1);
      if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 1) {
        throw configError("poll-target maxResults must be 1 during this pilot.");
      }

      const profiles = activeMailboxProfiles(config);
      if (profiles.length === 0) throw configError("No active mailbox profiles configured.");
      const requestedProfileKey = typeof params?.profileKey === "string" && params.profileKey.trim()
        ? params.profileKey.trim()
        : null;
      const profile = requestedProfileKey
        ? profiles.find((candidate) => candidate.key === requestedProfileKey)
        : profiles[0];
      if (!profile) throw configError(`Active mailbox profile "${requestedProfileKey}" was not found.`);
      if (profile.intakeSince && !isValidIntakeDate(profile.intakeSince)) {
        throw configError(`Mailbox profile "${profile.key}" intakeSince is not a valid date (use YYYY-MM-DD): ${profile.intakeSince}`);
      }
      const password = await resolvePassword(ctx, profile, companyId);

      const fetched = await searchBySubject(profile, password, {
        subject,
        unreadOnly: true,
        since: dateSince instanceof Date && !isNaN(dateSince.getTime()) ? dateSince : undefined,
        before: dateBefore instanceof Date && !isNaN(dateBefore.getTime()) ? dateBefore : undefined,
        maxResults,
      });

      if (fetched.length === 0) {
        await ctx.activity.log({
          companyId,
          message: `Targeted search returned no results: subject "${subject}"`,
          metadata: { action: "poll-target", subject, profileKey: profile.key },
        });
        return { ok: true, found: 0, created: 0, results: [] };
      }

      let created = 0;
      const results: ProfilePollResult[] = [];
      for (const raw of fetched) {
        const msg = normalizeMessage({
          uid: raw.uid,
          folder: profile.pollFolder,
          profileKey: profile.key,
          envelope: raw.envelope,
          bodyText: raw.bodyText,
        });
        const { created: isNew } = await ingestMessage(ctx, config, companyId, profile, msg);
        if (isNew) {
          created += 1;
          // Do NOT markSeen — targeted search preserves mailbox state
          results.push({ key: profile.key, ok: true, found: fetched.length, created: 1, skippedDuplicates: 0 });
        } else {
          results.push({ key: profile.key, ok: true, found: fetched.length, created: 0, skippedDuplicates: 1 });
        }
      }

      const status = await getStatus(ctx, companyId);
      status.lastPollAt = new Date().toISOString();
      status.totals.polls += 1;
      if (created > 0) status.totals.ingested += created;
      status.profiles = results;
      await ctx.state.set({ scopeKind: "company", scopeId: companyId, namespace: STATE_NS, stateKey: "mailbox-status" }, status);

      await ctx.activity.log({
        companyId,
        message: `Targeted search "${subject}": ${created} new issue(s) from ${fetched.length} message(s)`,
        metadata: { action: "poll-target", subject, found: fetched.length, created },
      });

      return { ok: true, found: fetched.length, created, results };
    });

    ctx.actions.register("reset-cursor", async (params) => {
      const companyId = params?.companyId as string;
      if (!companyId) throw configError("reset-cursor requires companyId.");
      const profileKey = typeof params?.profileKey === "string" && params.profileKey ? params.profileKey : "primary";
      const uid = Number(params?.uid);
      if (!Number.isInteger(uid) || uid < 0) throw configError("reset-cursor requires a non-negative integer uid.");
      const cursorKey = `uid-cursor:${profileKey}`;
      await ctx.state.set({ scopeKind: "company", scopeId: companyId, namespace: STATE_NS, stateKey: cursorKey }, uid);
      await ctx.activity.log({
        companyId,
        message: `Email intake cursor reset by operator: profile ${profileKey} -> UID ${uid}`,
        metadata: { profileKey, uid },
      });
      return { ok: true, profileKey, uid };
    });

    ctx.actions.register("send-reply", async (params) => {
      const companyId = params?.companyId as string;
      if (!companyId) throw configError("send-reply requires companyId.");
      const config = (await ctx.config.get(companyId)) as EmailPluginConfig;
      if (config?.outboundEnabled !== true) {
        throw configError("Outbound email is disabled for this company.");
      }
      if (!hasActiveMailboxConfig(config)) throw configError("No active mailbox is configured for this company.");
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
      const profile = profiles.find((candidate) => candidate.key === thread.profileKey);
      if (!profile) {
        throw configError(`Mailbox profile "${thread.profileKey}" linked to this message is no longer configured. Refusing to send through a different mailbox.`);
      }
      if (profile.operationalStatus !== "active") {
        throw configError(`Mailbox profile "${thread.profileKey}" is ${profile.operationalStatus}; activate that exact mailbox before sending.`);
      }
      const password = await resolvePassword(ctx, profile, companyId);

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

    const hasStructuredProfiles = Array.isArray(cfg.mailboxProfiles) && cfg.mailboxProfiles.length > 0;
    if (!hasStructuredProfiles) {
      if (!cfg.username) errors.push("Mailbox username is required when structured Mailbox Profiles are not configured.");
      if (!cfg.credentialSecretRef) errors.push("A legacy company mailbox credential secret binding is required when structured Mailbox Profiles are not configured.");
    }

    if (cfg.intakeSince) {
      if (!isValidIntakeDate(cfg.intakeSince)) {
        errors.push("intakeSince is not a valid date (use YYYY-MM-DD, e.g. 2026-07-01).");
      } else {
        warnings.push("intakeSince: " + cfg.intakeSince + " — company IMAP SINCE filter active; messages with internal date before this date are skipped unless a mailbox overrides it.");
      }
    }
    if (errors.length > 0) return { ok: false, warnings, errors };

    try {
      const profiles = buildProfiles(cfg);
      for (const profile of profiles) {
        if (profile.intakeSince && !isValidIntakeDate(profile.intakeSince)) {
          errors.push(`Mailbox profile "${profile.key}" intakeSince is not a valid date (use YYYY-MM-DD).`);
        }
      }
      if (errors.length > 0) return { ok: false, warnings, errors };

      const activeCount = profiles.filter((profile) => profile.operationalStatus === "active").length;
      const standbyCount = profiles.filter((profile) => profile.operationalStatus === "standby").length;
      const reservedCount = profiles.filter((profile) => profile.operationalStatus === "reserved").length;
      const sharedCredentialCount = profiles.filter((profile) => profile.credentialMode === "company_shared").length;

      if (activeCount === 0) {
        warnings.push("No active mailbox profiles. This company is modeled in Email Operations but inbox polling will remain idle.");
      }
      if (sharedCredentialCount > 1) {
        warnings.push("Legacy mailbox profiles share one company credential. Use structured Mailbox Profiles before operating unrelated inbox accounts.");
      }

      return {
        ok: true,
        warnings: [
          ...warnings,
          `Configuration valid. ${profiles.length} mailbox profile(s): ${activeCount} active, ${standbyCount} standby, ${reservedCount} reserved. Live IMAP/SMTP verification runs only for active mailboxes.`,
        ],
      };
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
