import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { DEFAULTS, EXPORT_NAMES, JOB_KEYS, PLUGIN_ID, PLUGIN_VERSION, SLOT_IDS } from "./constants.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Email Operations (QSL)",
  description:
    "Governed portfolio email intake and reply operations. IMAP intake creates reviewable work, deterministic sorting suppresses low-value traffic, and outbound effects remain human-authorized.",
  author: "QuantumShield Labs",
  categories: ["connector", "automation"],
  capabilities: [
    "companies.read",
    "projects.read",
    "issues.read",
    "issues.create",
    "issue.comments.read",
    "issue.comments.create",
    "issue.documents.read",
    "agents.read",
    "activity.log.write",
    "metrics.write",
    "plugin.state.read",
    "plugin.state.write",
    "jobs.schedule",
    "http.outbound",
    "secrets.read-ref",
    "ui.detailTab.register",
    "ui.dashboardWidget.register",
    "ui.page.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  instanceConfigSchema: {
    type: "object",
    description: "Company-scoped Email Operations settings. Configure independently for each portfolio company that operates email.",
    properties: {
      enabled: {
        type: "boolean",
        title: "Connector Enabled",
        default: DEFAULTS.enabled,
      },
      scheduledPollingEnabled: {
        type: "boolean",
        title: "Scheduled Polling",
        description: "Allow the recurring inbox polling job. Leave disabled for manual-only operation.",
        default: DEFAULTS.scheduledPollingEnabled,
      },
      outboundEnabled: {
        type: "boolean",
        title: "Outbound Sending",
        description: "Allow Board-invoked SMTP replies. Leave disabled for read-only intake.",
        default: DEFAULTS.outboundEnabled,
      },
      intakeProjectId: {
        type: "string",
        title: "Intake Project ID",
        description: "UUID of the project inbound email issues are created in.",
        default: DEFAULTS.intakeProjectId,
      },
      triageAgentId: {
        type: "string",
        title: "Triage Agent ID",
        description: "UUID of the Intake Triage agent new email issues are assigned to.",
        default: DEFAULTS.triageAgentId,
      },
      billingCode: {
        type: "string",
        title: "Mission Billing Code",
        description: "Billing code stamped on intake issues for per-mission cost attribution.",
        default: DEFAULTS.billingCode,
      },
      username: {
        type: "string",
        title: "Mailbox Username",
        description: "Primary IMAP/SMTP username (for Gmail: the full address).",
      },
      credentialSecretRef: {
        type: "object",
        title: "Mailbox Credential",
        description: "Secret binding holding the mailbox password (for Gmail: an app password). Resolved at execution time only.",
        format: "secret-ref",
        properties: {
          type: { type: "string", const: "secret_ref" },
          secretId: { type: "string" },
          version: { type: ["string", "number"] },
        },
        required: ["type", "secretId"],
      },
      imapHost: { type: "string", title: "IMAP Host", default: DEFAULTS.imapHost },
      imapPort: { type: "integer", title: "IMAP Port", default: DEFAULTS.imapPort },
      imapSecure: { type: "boolean", title: "IMAP TLS", default: DEFAULTS.imapSecure },
      smtpHost: { type: "string", title: "SMTP Host", default: DEFAULTS.smtpHost },
      smtpPort: { type: "integer", title: "SMTP Port", default: DEFAULTS.smtpPort },
      smtpSecure: { type: "boolean", title: "SMTP TLS", default: DEFAULTS.smtpSecure },
      pollFolder: {
        type: "string",
        title: "Poll Folder",
        default: DEFAULTS.pollFolder,
      },
      archiveFolder: {
        type: "string",
        title: "Archive Folder",
        description: "IMAP folder replies are moved to after the Board sends (e.g. [Gmail]/All Mail). Empty = flag answered only.",
        default: DEFAULTS.archiveFolder,
      },
      markSeen: {
        type: "boolean",
        title: "Mark Messages Seen After Intake",
        default: DEFAULTS.markSeen,
      },
      maxMessagesPerPoll: {
        type: "integer",
        title: "Max Messages Per Poll",
        default: DEFAULTS.maxMessagesPerPoll,
      },
      extraProfilesJson: {
        type: "string",
        title: "Additional Mailbox Profiles (JSON)",
        description:
          "Optional JSON array of additional mailbox profiles plus `key`. Current v1 profiles share the company-level credential, so use this only for aliases or mailboxes in the same credential group. Independent per-profile credentials are a future contract upgrade.",
        default: DEFAULTS.extraProfilesJson,
      },
      storeExportPath: {
        type: "string",
        title: "Store Export Path (JSON)",
        description:
          "Optional path to a JSON export of canonical stores for duplicate matching. Expected format: array of objects with id, name, address, city, state, phone, website, facebookUrl fields. File access is read-only.",
      },
      intakeSince: {
        type: "string",
        title: "Intake Since Date",
        description:
          "Optional. Messages with an IMAP internal date before this date (inclusive) are skipped during polling. Format: YYYY-MM-DD. Unset = process all unseen messages from cursor forward.",
        format: "date",
      },
    },
  },
  jobs: [
    {
      jobKey: JOB_KEYS.pollInbox,
      displayName: "Poll Inbox",
      description: "IMAP poll of configured mailbox profiles; creates governed intake issues for new messages.",
      schedule: "*/5 * * * *",
    },
  ],
  ui: {
    slots: [
      {
        type: "detailTab",
        id: SLOT_IDS.issueTab,
        displayName: "Email",
        exportName: EXPORT_NAMES.issueTab,
        entityTypes: ["issue"],
      },
      {
        type: "detailTab",
        id: SLOT_IDS.storeIntakeTab,
        displayName: "Store Intake",
        exportName: EXPORT_NAMES.storeIntakeTab,
        entityTypes: ["issue"],
      },
      {
        type: "page",
        id: SLOT_IDS.storeIntakePage,
        displayName: "Email Operations",
        exportName: EXPORT_NAMES.storeIntakePage,
      },
      {
        type: "dashboardWidget",
        id: SLOT_IDS.dashboardWidget,
        displayName: "Email Intake",
        exportName: EXPORT_NAMES.dashboardWidget,
      },
    ],
  },
};

export default manifest;
