import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { DEFAULTS, EXPORT_NAMES, JOB_KEYS, PLUGIN_ID, PLUGIN_VERSION, SLOT_IDS } from "./constants.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Email Connector (QSL)",
  description:
    "Governed email intake and reply for the QSL Email Company. IMAP poll creates triage issues from inbound mail; the Board sends approved drafts via a Board-invoked action. Agents have no send capability by construction.",
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
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  instanceConfigSchema: {
    type: "object",
    description: "Company-scoped connector settings. Configure once per company that operates email (set via plugin settings for the Email company).",
    properties: {
      enabled: {
        type: "boolean",
        title: "Connector Enabled",
        default: DEFAULTS.enabled,
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
        description: "IMAP/SMTP username (for Gmail: the full address).",
        default: DEFAULTS.username,
      },
      credentialSecretRef: {
        type: "string",
        title: "Mailbox Credential",
        description: "Secret binding holding the mailbox password (for Gmail: an app password). Resolved at execution time only.",
        format: "secret-ref",
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
        title: "Additional Connector Profiles (JSON)",
        description:
          "Optional JSON array of additional mailbox profiles (same fields as above plus `key`). Future multi-mailbox capability; the engine and loop are identical per profile.",
        default: DEFAULTS.extraProfilesJson,
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
        type: "dashboardWidget",
        id: SLOT_IDS.dashboardWidget,
        displayName: "Email Intake",
        exportName: EXPORT_NAMES.dashboardWidget,
      },
    ],
  },
};

export default manifest;
