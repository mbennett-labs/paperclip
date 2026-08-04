export const PLUGIN_ID = "qsl.email";
export const PLUGIN_VERSION = "0.1.0";

export const JOB_KEYS = {
  pollInbox: "poll-inbox",
} as const;

export const SLOT_IDS = {
  issueTab: "email-issue-tab",
  storeIntakeTab: "store-intake-tab",
  storeIntakePage: "store-intake-page",
  dashboardWidget: "email-metrics-widget",
} as const;

export const EXPORT_NAMES = {
  issueTab: "EmailIssueTab",
  storeIntakeTab: "StoreIntakeTab",
  storeIntakePage: "StoreIntakePage",
  dashboardWidget: "EmailMetricsWidget",
} as const;

export const ORIGIN_KIND_INTAKE = `plugin:${PLUGIN_ID}:intake`;

export const STATE_NS = "email";
export const STATE_NS_INTAKE = "email-intake";

export const DEFAULTS = {
  enabled: true,
  scheduledPollingEnabled: false,
  outboundEnabled: false,
  imapHost: "imap.gmail.com",
  imapPort: 993,
  imapSecure: true,
  smtpHost: "smtp.gmail.com",
  smtpPort: 465,
  smtpSecure: true,
  username: "",
  pollFolder: "INBOX",
  archiveFolder: "",
  markSeen: false,
  maxMessagesPerPoll: 20,
  billingCode: "mission:email-ops",
  intakeProjectId: "",
  triageAgentId: "",
  extraProfilesJson: "",
} as const;