import { useMemo, useState, type CSSProperties } from "react";
import {
  useHostNavigation,
  usePluginData,
  type PluginPageProps,
} from "@paperclipai/plugin-sdk/ui";

type QueueItem = {
  issueId: string;
  identifier: string | null;
  title: string;
  status: string;
  priority: string;
  createdAt: string;
  storeName: string | null;
  sourceForm: string | null;
  sourceType: string | null;
  latestVerdict: string | null;
  latestOutcome: string | null;
  duplicateCount: number;
  duplicateStrength: string | null;
  hasEvidence: boolean;
  intakeTransport: string;
  recordCompleteness: string;
  missingFields: string[];
  conflictingFields: Array<{
    field: string;
    values: Array<{ value: string; source: string; precedence: number }>;
  }>;
  sortCategory: string | null;
  sortLabel: string | null;
  replyActionStatus: string | null;
  draftCandidateKind: string | null;
  profileKey: string | null;
  mailboxUsername: string | null;
  fromAddress: string | null;
  to: string | null;
  messageSubject: string | null;
  messageDate: string | null;
  conversationState: string | null;
  conversationIntent: string | null;
  conversationNextAction: string | null;
  conversationHumanGate: boolean | null;
  conversationRiskAuthorityClass: string | null;
  conversationOutputMode: string | null;
  conversationCommercialSignal: boolean | null;
  conversationConfidence: number | null;
  conversationEntityName: string | null;
  conversationEntityType: string | null;
  shadowActionKind: string | null;
  shadowHumanAttentionRequired: boolean | null;
  shadowReason: string | null;
};

type EmailPluginConfigView = {
  enabled?: boolean;
  scheduledPollingEnabled?: boolean;
  outboundEnabled?: boolean;
  mailboxProfiles?: Array<{
    key?: string;
    username?: string;
    status?: "active" | "standby" | "reserved";
  }>;
  username?: string;
  extraProfilesJson?: string;
  markSeen?: boolean;
  maxMessagesPerPoll?: number;
  intakeSince?: string;
};

type WorkflowFilter =
  | "inbox"
  | "attention"
  | "drafts"
  | "needs_review"
  | "submissions"
  | "correspondence"
  | "notifications"
  | "data_quality"
  | "suppressed"
  | "reviewed";

type BrandFilter = "all" | "thebinmap" | "qsl" | "therapist_index" | "unknown";

const FILTERS: Array<{ key: WorkflowFilter; label: string }> = [
  { key: "inbox", label: "Inbox" },
  { key: "attention", label: "Needs Attention" },
  { key: "drafts", label: "Draft Work" },
  { key: "needs_review", label: "Needs Review" },
  { key: "submissions", label: "Submissions" },
  { key: "correspondence", label: "Correspondence" },
  { key: "notifications", label: "Notifications" },
  { key: "data_quality", label: "Data Quality" },
  { key: "suppressed", label: "Suppressed" },
  { key: "reviewed", label: "Reviewed" },
];

const BRAND_OPTIONS: Array<{ key: BrandFilter; label: string }> = [
  { key: "all", label: "All portfolio brands" },
  { key: "thebinmap", label: "TheBinMap" },
  { key: "qsl", label: "QSL" },
  { key: "therapist_index", label: "TherapistIndex" },
  { key: "unknown", label: "Unassigned" },
];

const BRAND_LABELS: Record<BrandFilter, string> = Object.fromEntries(
  BRAND_OPTIONS.map((option) => [option.key, option.label]),
) as Record<BrandFilter, string>;

const VERDICT_LABELS: Record<string, string> = {
  genuine_external: "Genuine",
  internal_test: "Internal",
  family_test: "Family test",
  spam: "Spam",
  duplicate: "Duplicate",
  unsure: "Unsure",
};

const TRANSPORT_LABELS: Record<string, string> = {
  provider_webhook: "Webhook",
  provider_api: "Provider API",
  wordpress_event: "WordPress",
  email_notification: "Email",
  inferred_email: "Inferred",
};

const COMPLETENESS_LABELS: Record<string, string> = {
  complete: "Complete",
  partial: "Partial",
  needs_source_verification: "Needs verification",
};

function brandOf(item: QueueItem): BrandFilter {
  const form = (item.sourceForm ?? "").toLowerCase();
  const type = (item.sourceType ?? "").toLowerCase();
  if (form.includes("thebinmap")) return "thebinmap";
  if (form.includes("qsl") || type.startsWith("qsl_")) return "qsl";
  if (form.includes("therapist")) return "therapist_index";
  if (["store_submission", "listing_claim", "alert_signup", "newsletter_signup"].includes(type)) {
    return "thebinmap";
  }
  return "unknown";
}

function isSuppressed(item: QueueItem): boolean {
  return item.conversationState === "suppressed" ||
    item.conversationState === "closed_not_interested" ||
    item.sortCategory === "spam_irrelevant" ||
    item.sortCategory === "duplicate";
}

function needsAttention(item: QueueItem): boolean {
  if (isSuppressed(item) || item.status !== "todo") return false;
  if (item.shadowHumanAttentionRequired === true || item.conversationHumanGate === true) return true;
  if (item.conversationRiskAuthorityClass === "uncertain") return true;
  if (item.sortCategory === "unknown" || item.sortCategory === "incomplete") return true;
  if (item.priority === "high" && !item.latestVerdict) return true;
  return item.replyActionStatus === "draft_needed";
}

function hasDraftWork(item: QueueItem): boolean {
  if (item.conversationOutputMode === "draft") return true;
  return Boolean(item.draftCandidateKind) ||
    item.replyActionStatus === "draft_needed" ||
    item.replyActionStatus === "draft_ready";
}

function hasDataQualityWork(item: QueueItem): boolean {
  if (item.sortCategory === "system_notification") return false;
  return item.recordCompleteness !== "complete" ||
    item.missingFields.length > 0 ||
    item.conflictingFields.length > 0;
}

function matchesWorkflow(item: QueueItem, filter: WorkflowFilter): boolean {
  switch (filter) {
    case "inbox":
      return !isSuppressed(item) && item.status === "todo";
    case "attention":
      return needsAttention(item);
    case "drafts":
      return !isSuppressed(item) && hasDraftWork(item);
    case "needs_review":
      return !isSuppressed(item) &&
        item.sortCategory !== "system_notification" &&
        !item.latestVerdict &&
        item.hasEvidence;
    case "submissions":
      return item.sortCategory === "store_submission" || item.sortCategory === "incomplete";
    case "correspondence":
      return item.sortCategory === "general_email" || item.sortCategory === "reply_continuation";
    case "notifications":
      return item.sortCategory === "system_notification";
    case "data_quality":
      return hasDataQualityWork(item);
    case "suppressed":
      return isSuppressed(item);
    case "reviewed":
      return Boolean(item.latestVerdict);
  }
}

function attentionScore(item: QueueItem): number {
  let score = 0;
  if (needsAttention(item)) score += 100;
  if (item.shadowHumanAttentionRequired === true) score += 20;
  if (item.conversationRiskAuthorityClass === "commercial_opportunity") score += 16;
  if (item.priority === "high") score += 25;
  if (item.sortCategory === "unknown") score += 20;
  if (item.sortCategory === "incomplete") score += 15;
  if (item.replyActionStatus === "draft_needed") score += 10;
  if (item.recordCompleteness === "needs_source_verification" && item.sortCategory !== "system_notification") score += 8;
  if (item.conflictingFields.length > 0) score += 5;
  if (item.latestVerdict) score -= 30;
  if (isSuppressed(item)) score -= 100;
  return score;
}

function nextAction(item: QueueItem): string {
  if (item.conversationNextAction) {
    return item.conversationNextAction.replace(/_/g, " ");
  }
  switch (item.sortCategory) {
    case "spam_irrelevant":
      return "No action — suppressed";
    case "duplicate":
      return "No action — duplicate";
    case "system_notification":
      return item.priority === "high" ? "Review operational event" : "Route / monitor";
    case "unknown":
      return "Human triage";
    case "incomplete":
      return item.draftCandidateKind ? "Review clarification draft" : "Request missing information";
    case "reply_continuation":
      return item.draftCandidateKind ? "Review reply draft" : "Prepare reply";
    case "general_email":
      return item.draftCandidateKind ? "Review reply draft" : "Review correspondence";
    case "store_submission":
      if (!item.latestVerdict) return "Review submission";
      return item.draftCandidateKind ? "Review acknowledgment" : "Reviewed";
    default:
      return item.latestVerdict ? "Reviewed" : "Review";
  }
}

function operatorStatus(item: QueueItem): string {
  if (item.shadowHumanAttentionRequired === true) return "Human gate";
  if (item.shadowHumanAttentionRequired === false) return "Automatic";
  if (item.conversationHumanGate === true) return "Human gate";
  return "Unscored";
}

function parseMailboxProfiles(
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
        : `extra-${i + 1}`;
      profiles.push({ key, username, status: "active" });
    }
  } catch {
    // Worker-side validation owns config errors. Keep the console readable.
  }

  return profiles;
}

function categoryStyle(category: string | null): CSSProperties {
  if (category === "store_submission") return { color: "#2980b9", background: "rgba(41,128,185,0.12)" };
  if (category === "reply_continuation" || category === "general_email") return { color: "#7d3c98", background: "rgba(125,60,152,0.12)" };
  if (category === "system_notification") return { color: "#2874a6", background: "rgba(52,152,219,0.10)" };
  if (category === "incomplete" || category === "unknown") return { color: "#b45f06", background: "rgba(230,126,34,0.14)" };
  if (category === "spam_irrelevant" || category === "duplicate") return { color: "#666", background: "rgba(127,127,127,0.12)" };
  return { color: "#555", background: "rgba(127,127,127,0.08)" };
}

function operatorStyle(item: QueueItem): CSSProperties {
  if (item.shadowHumanAttentionRequired === true || item.conversationHumanGate === true) {
    return { color: "#b45f06", background: "rgba(230,126,34,0.14)" };
  }
  if (item.shadowHumanAttentionRequired === false) {
    return { color: "#1e8449", background: "rgba(39,174,96,0.12)" };
  }
  return { color: "#666", background: "rgba(127,127,127,0.12)" };
}

function completenessStyle(value: string): CSSProperties {
  if (value === "complete") return { color: "#1e8449", background: "rgba(39,174,96,0.12)" };
  if (value === "partial") return { color: "#b45f06", background: "rgba(230,126,34,0.12)" };
  return { color: "#b03a2e", background: "rgba(231,76,60,0.12)" };
}

export function StoreIntakePage({ context }: PluginPageProps) {
  const companyId = context.companyId;
  const [activeFilter, setActiveFilter] = useState<WorkflowFilter>("attention");
  const [brandFilter, setBrandFilter] = useState<BrandFilter>("all");
  const [mailboxFilter, setMailboxFilter] = useState("all");
  const [search, setSearch] = useState("");
  const { data, loading, error, refresh } = usePluginData<QueueItem[]>("intake-queue", {
    companyId,
    ...(mailboxFilter !== "all" ? { profileKey: mailboxFilter } : {}),
  });
  const { data: configData } = usePluginData<EmailPluginConfigView | null>("plugin-config", { companyId });
  const { resolveHref } = useHostNavigation();

  const items = data ?? [];
  const mailboxProfiles = useMemo(() => parseMailboxProfiles(configData), [configData]);

  const counts = useMemo(() => {
    const result: Record<WorkflowFilter, number> = {
      inbox: 0,
      attention: 0,
      drafts: 0,
      needs_review: 0,
      submissions: 0,
      correspondence: 0,
      notifications: 0,
      data_quality: 0,
      suppressed: 0,
      reviewed: 0,
    };

    for (const item of items) {
      for (const filter of FILTERS) {
        if (matchesWorkflow(item, filter.key)) result[filter.key] += 1;
      }
    }
    return result;
  }, [items]);

  const operatorCounts = useMemo(() => ({
    human: items.filter((item) => item.shadowHumanAttentionRequired === true || item.conversationHumanGate === true).length,
    automatic: items.filter((item) => item.shadowHumanAttentionRequired === false && item.conversationHumanGate !== true).length,
    draft: items.filter((item) => item.conversationOutputMode === "draft" || Boolean(item.draftCandidateKind)).length,
    commercial: items.filter((item) => item.conversationCommercialSignal === true || item.conversationRiskAuthorityClass === "commercial_opportunity").length,
    uncertain: items.filter((item) => item.conversationRiskAuthorityClass === "uncertain" || item.conversationState === "human_review").length,
  }), [items]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return items
      .filter((item) => matchesWorkflow(item, activeFilter))
      .filter((item) => brandFilter === "all" || brandOf(item) === brandFilter)
      .filter((item) => {
        if (!needle) return true;
        const haystack = [
          item.identifier,
          item.title,
          item.storeName,
          item.sourceForm,
          item.sourceType,
          item.sortLabel,
          item.sortCategory,
          item.latestVerdict,
          item.profileKey,
          item.mailboxUsername,
          item.fromAddress,
          item.to,
          item.conversationIntent,
          item.conversationState,
          item.conversationNextAction,
          item.shadowActionKind,
          item.conversationEntityName,
        ]
          .filter((value): value is string => typeof value === "string")
          .join(" ")
          .toLowerCase();
        return haystack.includes(needle);
      })
      .sort((a, b) => {
        const scoreDifference = attentionScore(b) - attentionScore(a);
        if (scoreDifference !== 0) return scoreDifference;
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      });
  }, [items, activeFilter, brandFilter, search]);

  if (!companyId) {
    return <div style={{ padding: 16, fontSize: 13, opacity: 0.7 }}>Select a company to view Email Operations.</div>;
  }

  const connectorEnabled = configData?.enabled !== false;
  const scheduled = configData?.scheduledPollingEnabled === true;
  const outbound = configData?.outboundEnabled === true;
  const markSeen = configData?.markSeen === true;
  const activeMailboxCount = mailboxProfiles.filter((profile) => profile.status === "active").length;

  return (
    <div style={{ padding: 16, fontSize: 13, display: "grid", gap: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div>
          <h2 style={{ fontWeight: 700, fontSize: 20, margin: 0 }}>Email Operations</h2>
          <div style={{ marginTop: 4, opacity: 0.7, maxWidth: 760 }}>
            Governed intake for this company. Sort everything, suppress low-value traffic, and surface only the messages that need action, review, or human judgment.
          </div>
        </div>
        <button style={buttonStyle} onClick={() => refresh()}>Refresh queue</button>
      </div>

      <div style={systemBarStyle}>
        <span><strong>Connector:</strong> {connectorEnabled ? "enabled" : "disabled"}</span>
        <span><strong>Polling:</strong> {scheduled ? "scheduled" : "manual only"}</span>
        <span><strong>Mailbox state:</strong> {markSeen ? "may mark seen" : "read-only"}</span>
        <span><strong>Outbound:</strong> {outbound ? "Board send enabled" : "locked"}</span>
        <span><strong>Mailboxes:</strong> {mailboxProfiles.length} ({activeMailboxCount} active)</span>
        {configData?.intakeSince ? <span><strong>Boundary:</strong> {configData.intakeSince}</span> : null}
      </div>

      {mailboxProfiles.length > 0 ? (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          <span style={{ fontWeight: 600, opacity: 0.75 }}>Configured mailbox profiles</span>
          {mailboxProfiles.map((profile) => (
            <span key={`${profile.key}:${profile.username}`} style={mailboxPillStyle} title={profile.username}>
              {profile.key}: {profile.username} · {profile.status}
            </span>
          ))}
        </div>
      ) : null}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8 }}>
        <SummaryCard label="Human gated" value={operatorCounts.human} detail="Review before action" emphasis />
        <SummaryCard label="Automatic" value={operatorCounts.automatic} detail="No human action" />
        <SummaryCard label="Draft ready" value={operatorCounts.draft} detail="Evidence preserved" />
        <SummaryCard label="Commercial" value={operatorCounts.commercial} detail="Human-owned" />
        <SummaryCard label="Uncertain" value={operatorCounts.uncertain} detail="Escalate" />
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search subject, ID, source, store..."
          style={searchStyle}
        />
        <select value={brandFilter} onChange={(event) => setBrandFilter(event.target.value as BrandFilter)} style={selectStyle}>
          {BRAND_OPTIONS.map((option) => (
            <option key={option.key} value={option.key}>{option.label}</option>
          ))}
        </select>
        <select value={mailboxFilter} onChange={(event) => setMailboxFilter(event.target.value)} style={selectStyle}>
          <option value="all">All mailboxes</option>
          {mailboxProfiles.map((profile) => (
            <option key={profile.key} value={profile.key}>{profile.username} · {profile.status}</option>
          ))}
        </select>
      </div>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {FILTERS.map((filter) => (
          <button
            key={filter.key}
            onClick={() => setActiveFilter(filter.key)}
            style={{
              ...filterButtonStyle,
              fontWeight: activeFilter === filter.key ? 700 : 500,
              background: activeFilter === filter.key ? "rgba(41,128,185,0.12)" : "transparent",
            }}
          >
            {filter.label} ({counts[filter.key]})
          </button>
        ))}
      </div>

      {loading ? <div style={{ opacity: 0.7 }}>Loading Email Operations...</div> : null}
      {error ? <div style={{ color: "#c0392b", fontSize: 12 }}>Error: {error.message}</div> : null}

      {!loading && !error && filtered.length === 0 ? (
        <div style={{ opacity: 0.7, padding: "24px 0" }}>No messages match the current view.</div>
      ) : null}

      {filtered.length > 0 ? (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, minWidth: 1120 }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid rgba(127,127,127,0.25)" }}>
                <th style={thStyle}>ID</th>
                <th style={thStyle}>Portfolio</th>
                <th style={thStyle}>Mailbox</th>
                <th style={thStyle}>Sorted as</th>
                <th style={thStyle}>Conversation</th>
                <th style={thStyle}>Subject / entity</th>
                <th style={thStyle}>Next action</th>
                <th style={thStyle}>Evidence</th>
                <th style={thStyle}>Review</th>
                <th style={thStyle}>Received</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((item) => {
                const issueHref = context.companyPrefix
                  ? resolveHref(`/${context.companyPrefix}/issues/${item.issueId}`)
                  : `#issues/${item.issueId}`;
                const brand = brandOf(item);
                const displayTitle = item.storeName || item.title.replace(/^\[.*?\]\s*/, "");

                return (
                  <tr
                    key={item.issueId}
                    style={{ borderBottom: "1px solid rgba(127,127,127,0.12)", cursor: "pointer" }}
                    onClick={() => { window.location.href = issueHref; }}
                  >
                    <td style={tdStyle}>
                      <a href={issueHref} style={{ textDecoration: "none", fontWeight: 700 }} onClick={(event) => event.stopPropagation()}>
                        {item.identifier || item.issueId.slice(0, 8)}
                      </a>
                    </td>
                    <td style={tdStyle}>
                      <span style={{ fontSize: 11, fontWeight: 600, opacity: brand === "unknown" ? 0.5 : 1 }}>
                        {BRAND_LABELS[brand]}
                      </span>
                    </td>
                    <td style={tdStyle}>
                      <div style={{ fontSize: 11, fontWeight: 600 }} title={item.mailboxUsername || item.profileKey || undefined}>
                        {item.mailboxUsername || item.profileKey || "Unknown"}
                      </div>
                      {item.profileKey && item.mailboxUsername ? (
                        <div style={{ marginTop: 2, fontSize: 10, opacity: 0.5 }}>{item.profileKey}</div>
                      ) : null}
                    </td>
                    <td style={tdStyle}>
                      <span style={{ ...badgeStyle, ...categoryStyle(item.sortCategory) }}>
                        {item.sortLabel || item.sortCategory?.replace(/_/g, " ") || item.sourceType?.replace(/_/g, " ") || "Unsorted"}
                      </span>
                    </td>
                    <td style={tdStyle}>
                      <div style={{ display: "grid", gap: 3 }}>
                        <span style={{ ...badgeStyle, ...operatorStyle(item) }}>
                          {operatorStatus(item)}
                        </span>
                        <span style={{ fontSize: 10, opacity: 0.62 }}>
                          {(item.conversationIntent || "unknown").replace(/_/g, " ")}
                          {item.conversationState ? ` · ${item.conversationState.replace(/_/g, " ")}` : ""}
                        </span>
                      </div>
                    </td>
                    <td style={{ ...tdStyle, maxWidth: 280 }}>
                      <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={displayTitle}>
                        {item.conversationEntityName || displayTitle || "—"}
                      </div>
                      <div style={{ marginTop: 2, fontSize: 10, opacity: 0.55 }}>
                        {item.conversationEntityName && displayTitle !== item.conversationEntityName ? displayTitle + " · " : ""}
                        {item.fromAddress ? "from " + item.fromAddress : item.sourceForm || item.sourceType || "unknown source"}
                      </div>
                    </td>
                    <td style={tdStyle}>
                      <div style={{ fontWeight: needsAttention(item) ? 700 : 500 }}>{nextAction(item)}</div>
                      {item.shadowActionKind ? (
                        <div style={{ marginTop: 2, fontSize: 10, opacity: 0.6 }} title={item.shadowReason || undefined}>
                          shadow: {item.shadowActionKind.replace(/^would_/, "").replace(/_/g, " ")}
                        </div>
                      ) : item.draftCandidateKind ? (
                        <div style={{ marginTop: 2, fontSize: 10, opacity: 0.6 }}>draft: {item.draftCandidateKind.replace(/_/g, " ")}</div>
                      ) : null}
                    </td>
                    <td style={tdStyle}>
                      {item.sortCategory === "system_notification" ? (
                        <span style={{ ...badgeStyle, color: "#2874a6", background: "rgba(52,152,219,0.10)" }}>Operational event</span>
                      ) : (
                        <span style={{ ...badgeStyle, ...completenessStyle(item.recordCompleteness) }}>
                          {COMPLETENESS_LABELS[item.recordCompleteness] || item.recordCompleteness}
                        </span>
                      )}
                      <div style={{ marginTop: 3, fontSize: 10, opacity: 0.58 }}>
                        {TRANSPORT_LABELS[item.intakeTransport] || item.intakeTransport}
                        {item.sortCategory !== "system_notification" && item.missingFields.length ? ` · ${item.missingFields.length} missing` : ""}
                        {item.conflictingFields.length ? ` · ${item.conflictingFields.length} conflict` : ""}
                      </div>
                    </td>
                    <td style={tdStyle}>
                      {item.latestVerdict ? (
                        <span style={{ fontWeight: 600, fontSize: 11 }}>
                          {VERDICT_LABELS[item.latestVerdict] || item.latestVerdict}
                        </span>
                      ) : item.sortCategory === "system_notification" ? (
                        <span style={{ opacity: 0.55, fontSize: 11 }}>No verdict required</span>
                      ) : (
                        <span style={{ opacity: 0.45, fontSize: 11 }}>Not reviewed</span>
                      )}
                    </td>
                    <td style={tdStyle}>
                      <span style={{ fontSize: 11, opacity: 0.7 }} title={new Date(item.createdAt).toLocaleString()}>
                        {new Date(item.createdAt).toLocaleDateString()}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      <div style={{ opacity: 0.58, fontSize: 11 }}>
        Showing {filtered.length} of {items.length} intake records for the selected mailbox scope. Company isolation is enforced by the page context; mailbox identity and filtering are first-class queue fields.
      </div>
    </div>
  );
}

function SummaryCard({
  label,
  value,
  detail,
  emphasis = false,
}: {
  label: string;
  value: number;
  detail: string;
  emphasis?: boolean;
}) {
  return (
    <div style={{
      border: "1px solid rgba(127,127,127,0.28)",
      borderRadius: 8,
      padding: "10px 12px",
      background: emphasis && value > 0 ? "rgba(230,126,34,0.08)" : "transparent",
    }}>
      <div style={{ fontSize: 11, opacity: 0.65 }}>{label}</div>
      <div style={{ fontSize: 22, lineHeight: 1.2, fontWeight: 750, marginTop: 2 }}>{value}</div>
      <div style={{ fontSize: 10, opacity: 0.55, marginTop: 2 }}>{detail}</div>
    </div>
  );
}

const thStyle: CSSProperties = { padding: "7px 8px", fontWeight: 650, opacity: 0.72, whiteSpace: "nowrap" };
const tdStyle: CSSProperties = { padding: "8px" };
const badgeStyle: CSSProperties = { display: "inline-block", padding: "2px 7px", borderRadius: 4, fontSize: 11, fontWeight: 650 };
const buttonStyle: CSSProperties = { padding: "6px 12px", borderRadius: 6, border: "1px solid rgba(127,127,127,0.4)", cursor: "pointer", background: "transparent", fontWeight: 600 };
const filterButtonStyle: CSSProperties = { padding: "4px 10px", borderRadius: 6, border: "1px solid rgba(127,127,127,0.3)", cursor: "pointer", fontSize: 12 };
const searchStyle: CSSProperties = { minWidth: 280, flex: "1 1 320px", padding: "7px 9px", borderRadius: 6, border: "1px solid rgba(127,127,127,0.35)", background: "transparent", color: "inherit" };
const selectStyle: CSSProperties = { padding: "7px 9px", borderRadius: 6, border: "1px solid rgba(127,127,127,0.35)", background: "transparent", color: "inherit" };
const systemBarStyle: CSSProperties = { display: "flex", gap: "8px 16px", flexWrap: "wrap", padding: "8px 10px", borderRadius: 7, background: "rgba(127,127,127,0.07)", fontSize: 11 };
const mailboxPillStyle: CSSProperties = { padding: "2px 7px", borderRadius: 12, border: "1px solid rgba(127,127,127,0.3)", fontSize: 10, opacity: 0.8 };
