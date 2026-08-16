import fs from "node:fs";

function replaceOnce(path, oldText, newText) {
  const source = fs.readFileSync(path, "utf8");
  const first = source.indexOf(oldText);
  if (first < 0) throw new Error(`Expected patch anchor not found in ${path}: ${oldText.slice(0, 140)}`);
  if (source.indexOf(oldText, first + oldText.length) >= 0) throw new Error(`Patch anchor is not unique in ${path}`);
  fs.writeFileSync(path, source.slice(0, first) + newText + source.slice(first + oldText.length));
}

const workerPath = "packages/plugins/plugin-email/src/worker.ts";

replaceOnce(workerPath,
`import {
  definePlugin,
  runWorker,
  type EnvSecretRefBinding,
  type PluginContext,
} from "@paperclipai/plugin-sdk";`,
`import {
  definePlugin,
  runWorker,
  type PluginContext,
} from "@paperclipai/plugin-sdk";`);

replaceOnce(workerPath,
`import {
  decideDraft,
  formatDraftDocument,
  type DraftCandidate,
} from "./mail/drafts.js";

type EmailPluginConfig = {
  enabled?: boolean;
  scheduledPollingEnabled?: boolean;
  outboundEnabled?: boolean;
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
  intakeSince?: string;
  storeExportPath?: string;
};`,
`import {
  decideDraft,
  formatDraftDocument,
  type DraftCandidate,
} from "./mail/drafts.js";
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
};`);

const worker = fs.readFileSync(workerPath, "utf8");
const profilesStart = worker.indexOf("function buildProfiles(config: EmailPluginConfig): ConnectorProfile[] {");
const profilesEnd = worker.indexOf("/**\n * Resolve the companies this connector operates for", profilesStart);
if (profilesStart < 0 || profilesEnd < 0) throw new Error("Could not locate legacy buildProfiles/resolvePassword block.");
const profileBlock = `function buildProfiles(config: EmailPluginConfig): ResolvedMailboxProfile[] {
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

`;
fs.writeFileSync(workerPath, worker.slice(0, profilesStart) + profileBlock + worker.slice(profilesEnd));

replaceOnce(workerPath,
`    if (!config || typeof config !== "object") continue;
    if (!config.username) continue;
    active.push({ companyId: company.id, config });`,
`    if (!config || typeof config !== "object") continue;
    if (!hasActiveMailboxConfig(config)) continue;
    active.push({ companyId: company.id, config });`);

replaceOnce(workerPath,
`  const profiles = buildProfiles(config);
  if (profiles.length === 0) {
    throw configError("No mailbox profiles configured. Set the primary username/credential or extraProfilesJson.");
  }
  const password = await resolvePassword(ctx, config, companyId);

  const results: ProfilePollResult[] = [];
  for (const profile of profiles) {
    const result: ProfilePollResult = { key: profile.key, ok: true, found: 0, created: 0, skippedDuplicates: 0 };
    const cursorKey = \`uid-cursor:\${profile.key}\`;
    try {
      const cursorRaw = await ctx.state.get({ scopeKind: "company", scopeId: companyId, namespace: STATE_NS, stateKey: cursorKey });`,
`  const profiles = activeMailboxProfiles(config);
  if (profiles.length === 0) {
    throw configError("No active mailbox profiles configured. Activate a mailbox profile or configure the legacy primary mailbox.");
  }

  const results: ProfilePollResult[] = [];
  for (const profile of profiles) {
    const result: ProfilePollResult = { key: profile.key, ok: true, found: 0, created: 0, skippedDuplicates: 0 };
    const cursorKey = \`uid-cursor:\${profile.key}\`;
    try {
      if (profile.intakeSince && !isValidIntakeDate(profile.intakeSince)) {
        throw configError(\`Mailbox profile "\${profile.key}" intakeSince is not a valid date (use YYYY-MM-DD): \${profile.intakeSince}\`);
      }
      const password = await resolvePassword(ctx, profile, companyId);
      const cursorRaw = await ctx.state.get({ scopeKind: "company", scopeId: companyId, namespace: STATE_NS, stateKey: cursorKey });`);

replaceOnce(workerPath,
`        if (config?.enabled === false) throw configError("Connector is disabled for this company.");
        if (!config?.username) throw configError("Mailbox is not configured for this company.");
        const results = await runPollForCompany(ctx, companyId, config, false);`,
`        if (config?.enabled === false) throw configError("Connector is disabled for this company.");
        if (!hasActiveMailboxConfig(config)) throw configError("No active mailbox is configured for this company.");
        const results = await runPollForCompany(ctx, companyId, config, false);`);

replaceOnce(workerPath,
`      if (config?.enabled === false) throw configError("Connector is disabled for this company.");
      if (!config?.username) throw configError("Mailbox is not configured for this company.");
      if (config?.outboundEnabled === true) {`,
`      if (config?.enabled === false) throw configError("Connector is disabled for this company.");
      if (!hasActiveMailboxConfig(config)) throw configError("No active mailbox is configured for this company.");
      if (config?.outboundEnabled === true) {`);

replaceOnce(workerPath,
`      const profiles = buildProfiles(config);
      if (profiles.length === 0) throw configError("No mailbox profiles configured.");
      const password = await resolvePassword(ctx, config, companyId);
      const profile = profiles[0];

      const fetched = await searchBySubject(profile, password, {`,
`      const profiles = activeMailboxProfiles(config);
      if (profiles.length === 0) throw configError("No active mailbox profiles configured.");
      const requestedProfileKey = typeof params?.profileKey === "string" && params.profileKey.trim()
        ? params.profileKey.trim()
        : null;
      const profile = requestedProfileKey
        ? profiles.find((candidate) => candidate.key === requestedProfileKey)
        : profiles[0];
      if (!profile) throw configError(\`Active mailbox profile "\${requestedProfileKey}" was not found.\`);
      if (profile.intakeSince && !isValidIntakeDate(profile.intakeSince)) {
        throw configError(\`Mailbox profile "\${profile.key}" intakeSince is not a valid date (use YYYY-MM-DD): \${profile.intakeSince}\`);
      }
      const password = await resolvePassword(ctx, profile, companyId);

      const fetched = await searchBySubject(profile, password, {`);

replaceOnce(workerPath,
`      if (!config?.username) throw configError("Mailbox is not configured for this company.");
      const issueId = params?.issueId as string;`,
`      if (!hasActiveMailboxConfig(config)) throw configError("No active mailbox is configured for this company.");
      const issueId = params?.issueId as string;`);

replaceOnce(workerPath,
`      const profiles = buildProfiles(config);
      const profile = profiles.find((p) => p.key === thread.profileKey) ?? profiles[0];
      if (!profile) throw configError("No mailbox profile configured for sending.");
      const password = await resolvePassword(ctx, config, companyId);`,
`      const profiles = buildProfiles(config);
      const profile = profiles.find((candidate) => candidate.key === thread.profileKey);
      if (!profile) {
        throw configError(\`Mailbox profile "\${thread.profileKey}" linked to this message is no longer configured. Refusing to send through a different mailbox.\`);
      }
      if (profile.operationalStatus !== "active") {
        throw configError(\`Mailbox profile "\${thread.profileKey}" is \${profile.operationalStatus}; activate that exact mailbox before sending.\`);
      }
      const password = await resolvePassword(ctx, profile, companyId);`);

const current = fs.readFileSync(workerPath, "utf8");
const validateStart = current.indexOf("  async onValidateConfig(config) {");
const validateEnd = current.indexOf("\n\n  async onHealth()", validateStart);
if (validateStart < 0 || validateEnd < 0) throw new Error("Could not locate onValidateConfig block.");
const validateBlock = `  async onValidateConfig(config) {
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
          errors.push(\`Mailbox profile "\${profile.key}" intakeSince is not a valid date (use YYYY-MM-DD).\`);
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
          \`Configuration valid. \${profiles.length} mailbox profile(s): \${activeCount} active, \${standbyCount} standby, \${reservedCount} reserved. Live IMAP/SMTP verification runs only for active mailboxes.\`,
        ],
      };
    } catch (err) {
      return { ok: false, warnings, errors: [summarizeError(err)] };
    }
  },`;
fs.writeFileSync(workerPath, current.slice(0, validateStart) + validateBlock + current.slice(validateEnd));

const uiPath = "packages/plugins/plugin-email/src/ui/store-intake-page.tsx";
replaceOnce(uiPath,
`type EmailPluginConfigView = {
  enabled?: boolean;
  scheduledPollingEnabled?: boolean;
  outboundEnabled?: boolean;
  username?: string;`,
`type EmailPluginConfigView = {
  enabled?: boolean;
  scheduledPollingEnabled?: boolean;
  outboundEnabled?: boolean;
  mailboxProfiles?: Array<{
    key?: string;
    username?: string;
    status?: "active" | "standby" | "reserved";
  }>;
  username?: string;`);

const ui = fs.readFileSync(uiPath, "utf8");
const parseStart = ui.indexOf("function parseMailboxProfiles(");
const parseEnd = ui.indexOf("\n\nfunction categoryStyle", parseStart);
if (parseStart < 0 || parseEnd < 0) throw new Error("Could not locate parseMailboxProfiles block.");
const parseBlock = `function parseMailboxProfiles(
  config: EmailPluginConfigView | null | undefined,
): Array<{ key: string; username: string; status: "active" | "standby" | "reserved" }> {
  const structured = Array.isArray(config?.mailboxProfiles) ? config.mailboxProfiles : [];
  if (structured.length > 0) {
    return structured.flatMap((entry) => {
      const key = typeof entry?.key === "string" ? entry.key.trim() : "";
      const username = typeof entry?.username === "string" ? entry.username.trim() : "";
      if (!key || !username) return [];
      const status = entry.status === "active" || entry.status === "reserved" ? entry.status : "standby";
      return [{ key, username, status }];
    });
  }

  const profiles: Array<{ key: string; username: string; status: "active" | "standby" | "reserved" }> = [];
  if (config?.username) profiles.push({ key: "primary", username: config.username, status: "active" });

  const raw = (config?.extraProfilesJson ?? "").trim();
  if (!raw) return profiles;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return profiles;

    for (let i = 0; i < parsed.length; i += 1) {
      const entry: unknown = parsed[i];
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      const usernameValue = record.username;
      if (typeof usernameValue !== "string") continue;
      const username = usernameValue.trim();
      if (!username) continue;

      const keyValue = record.key;
      const key = typeof keyValue === "string" && keyValue.trim()
        ? keyValue.trim()
        : \`extra-\${i + 1}\`;
      profiles.push({ key, username, status: "active" });
    }
  } catch {
    // Worker-side validation owns config errors. Keep the console readable.
  }

  return profiles;
}`;
fs.writeFileSync(uiPath, ui.slice(0, parseStart) + parseBlock + ui.slice(parseEnd));

replaceOnce(uiPath,
`  const markSeen = configData?.markSeen === true;

  return (`,
`  const markSeen = configData?.markSeen === true;
  const activeMailboxCount = mailboxProfiles.filter((profile) => profile.status === "active").length;

  return (`);

replaceOnce(uiPath,
`        <span><strong>Mailboxes:</strong> {mailboxProfiles.length}</span>`,
`        <span><strong>Mailboxes:</strong> {mailboxProfiles.length} ({activeMailboxCount} active)</span>`);

replaceOnce(uiPath,
`              {profile.key}: {profile.username}
            </span>`,
`              {profile.key}: {profile.username} · {profile.status}
            </span>`);

replaceOnce(uiPath,
`            <option key={profile.key} value={profile.key}>{profile.username}</option>`,
`            <option key={profile.key} value={profile.key}>{profile.username} · {profile.status}</option>`);

console.log("Mailbox runtime/profile UI patch applied.");
