import { useState, useMemo } from "react";
import {
  usePluginData,
  usePluginAction,
  useHostNavigation,
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
};

type FilterName =
  | "all"
  | "action_required"
  | "forms_and_leads"
  | "listing_operations"
  | "needs_review"
  | "newsletters_promotions"
  | "system_notifications"
  | "likely_spam"
  | "recently_reviewed"
  | "partial_data"
  | "needs_source_check"
  | "thebinmap_brand"
  | "qsl_brand"
  | "therapist_index_brand";

const FILTERS: { key: FilterName; label: string }[] = [
  { key: "all", label: "All" },
  { key: "action_required", label: "Action Required" },
  { key: "forms_and_leads", label: "Forms & Leads" },
  { key: "listing_operations", label: "Listing Ops" },
  { key: "needs_review", label: "Needs Review" },
  { key: "newsletters_promotions", label: "Newsletters & Promos" },
  { key: "system_notifications", label: "System Notifications" },
  { key: "likely_spam", label: "Likely Spam" },
  { key: "recently_reviewed", label: "Recently Reviewed" },
  { key: "partial_data", label: "Partial Data" },
  { key: "needs_source_check", label: "Needs Source Check" },
  { key: "thebinmap_brand", label: "TheBinMap" },
  { key: "qsl_brand", label: "QSL" },
  { key: "therapist_index_brand", label: "TherapistIndex" },
];

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
  needs_source_verification: "Needs Verification",
};

function completenessColor(c: string): string {
  if (c === "complete") return "#27ae60";
  if (c === "partial") return "#e67e22";
  return "#e74c3c";
}

function completenessBg(c: string): string {
  if (c === "complete") return "rgba(39,174,96,0.12)";
  if (c === "partial") return "rgba(230,126,34,0.12)";
  return "rgba(231,76,60,0.12)";
}

function transportColor(t: string): string {
  if (t === "provider_webhook" || t === "provider_api") return "#2980b9";
  if (t === "wordpress_event") return "#8e44ad";
  if (t === "email_notification") return "#7f8c8d";
  return "#bdc3c7";
}

function extractBrand(item: QueueItem): string {
  const st = (item.sourceType ?? "").toLowerCase();
  const sf = (item.sourceForm ?? "").toLowerCase();
  if (sf.includes("thebinmap") || st.includes("store_submission") || st.includes("listing_claim") || st.includes("alert_signup")) return "thebinmap";
  if (sf.includes("qsl") || st.includes("qsl")) return "qsl";
  if (sf.includes("therapist")) return "therapist_index";
  return "unknown";
}

const BRAND_LABELS: Record<string, string> = {
  thebinmap: "TheBinMap",
  qsl: "QSL",
  therapist_index: "TherapistIndex",
  unknown: "—",
};

function filterItems(items: QueueItem[], filter: FilterName): QueueItem[] {
  switch (filter) {
    case "all":
      return items;
    case "action_required":
      return items.filter((i) =>
        i.priority === "high" && i.status === "todo" && !i.latestVerdict);
    case "forms_and_leads":
      return items.filter((i) =>
        (i.sourceType ?? "").match(/store_submission|listing_claim|qsl_risk_calc|qsl_security_review/));
    case "listing_operations":
      return items.filter((i) =>
        (i.sourceType ?? "").match(/listing_claim|correction|contact/) &&
        (i.sourceForm ?? "").includes("therapist_index"));
    case "needs_review":
      return items.filter((i) => !i.latestVerdict && i.hasEvidence);
    case "newsletters_promotions":
      return items.filter((i) =>
        (i.sourceType ?? "").match(/newsletter_signup|alert_signup|provider_marketing/));
    case "system_notifications":
      return items.filter((i) =>
        (i.sourceType ?? "").match(/provider_marketing/) ||
        (i.sourceForm ?? "").includes("therapist_index") && !(i.sourceType ?? "").match(/correction|removal/));
    case "likely_spam":
      return items.filter((i) =>
        i.latestVerdict === "spam" || (i.sourceType ?? "") === "provider_marketing");
    case "recently_reviewed":
      return items.filter((i) => i.latestVerdict).slice(-30);
    case "partial_data":
      return items.filter((i) => i.recordCompleteness === "partial");
    case "needs_source_check":
      return items.filter((i) => i.recordCompleteness === "needs_source_verification");
    case "thebinmap_brand":
      return items.filter((i) => extractBrand(i) === "thebinmap");
    case "qsl_brand":
      return items.filter((i) => extractBrand(i) === "qsl");
    case "therapist_index_brand":
      return items.filter((i) => extractBrand(i) === "therapist_index");
    default:
      return items;
  }
}

export function StoreIntakePage({ context }: PluginPageProps) {
  const companyId = context.companyId;
  const { data, loading, error, refresh } = usePluginData<QueueItem[]>("intake-queue", { companyId });
  const { resolveHref } = useHostNavigation();
  const [activeFilter, setActiveFilter] = useState<FilterName>("all");

  const items: QueueItem[] = data ?? [];
  const filtered = useMemo(() => filterItems(items, activeFilter), [items, activeFilter]);
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const f of FILTERS) {
      c[f.key] = filterItems(items, f.key).length;
    }
    return c;
  }, [items]);

  if (!companyId) {
    return <div style={{ padding: 16, fontSize: 13, opacity: 0.7 }}>Select a company to view the intake queue.</div>;
  }

  return (
    <div style={{ padding: 16, fontSize: 13 }}>
      <h2 style={{ fontWeight: 700, fontSize: 18, margin: "0 0 12px 0" }}>Email Intake Review</h2>

      <div style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap" }}>
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setActiveFilter(f.key)}
            style={{
              padding: "4px 12px",
              borderRadius: 6,
              border: "1px solid rgba(127,127,127,0.35)",
              cursor: "pointer",
              fontWeight: activeFilter === f.key ? 700 : 400,
              background: activeFilter === f.key ? "rgba(41,128,185,0.12)" : "transparent",
              fontSize: 13,
            }}
          >
            {f.label} ({counts[f.key] ?? 0})
          </button>
        ))}
      </div>

      {loading && <div style={{ opacity: 0.7 }}>Loading intake queue...</div>}
      {error && <div style={{ color: "#c0392b", fontSize: 12 }}>Error: {error.message}</div>}

      {!loading && !error && filtered.length === 0 && (
        <div style={{ opacity: 0.7, padding: "20px 0" }}>No items match this filter.</div>
      )}

      {filtered.length > 0 && (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "1px solid rgba(127,127,127,0.25)" }}>
              <th style={thStyle}>ID</th>
              <th style={thStyle}>Brand</th>
              <th style={thStyle}>Intake Type</th>
              <th style={thStyle}>Subject / Store</th>
              <th style={thStyle}>Source Data</th>
              <th style={thStyle}>Transport</th>
              <th style={thStyle}>Priority</th>
              <th style={thStyle}>Review</th>
              <th style={thStyle}>Dup</th>
              <th style={thStyle}>Received</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((item) => {
              const issueHref = context.companyPrefix
                ? resolveHref(`/${context.companyPrefix}/issues/${item.issueId}`)
                : `#issues/${item.issueId}`;

              const brand = extractBrand(item);
              const displayTitle = item.storeName || item.title.replace(/^\[.*?\]\s*/, "");

              return (
                <tr
                  key={item.issueId}
                  style={{ borderBottom: "1px solid rgba(127,127,127,0.12)", cursor: "pointer" }}
                  onClick={() => {
                    window.location.href = issueHref;
                  }}
                >
                  <td style={tdStyle}>
                    <a href={issueHref} style={{ textDecoration: "none", fontWeight: 600 }}>
                      {item.identifier || item.issueId.slice(0, 8)}
                    </a>
                  </td>
                  <td style={tdStyle}>
                    <span style={{
                      fontSize: 11,
                      fontWeight: 500,
                      opacity: brand === "unknown" ? 0.5 : 1,
                    }}>
                      {BRAND_LABELS[brand] || brand}
                    </span>
                  </td>
                  <td style={tdStyle}>
                    <span style={{
                      padding: "1px 6px",
                      borderRadius: 3,
                      fontSize: 11,
                      fontWeight: 600,
                      background:
                        (item.sourceType ?? "").match(/store_submission|listing_claim/) ? "rgba(41,128,185,0.12)"
                        : (item.sourceType ?? "").match(/qsl_risk_calc|qsl_security_review/) ? "rgba(142,68,173,0.12)"
                        : (item.sourceType ?? "").match(/newsletter_signup|alert_signup|provider_marketing/) ? "rgba(127,127,127,0.12)"
                        : "rgba(127,127,127,0.08)",
                      color:
                        (item.sourceType ?? "").match(/store_submission|listing_claim/) ? "#2980b9"
                        : (item.sourceType ?? "").match(/qsl_risk_calc|qsl_security_review/) ? "#8e44ad"
                        : "#555",
                    }}>
                      {(item.sourceType || "—").replace(/_/g, " ")}
                    </span>
                  </td>
                  <td style={{ ...tdStyle, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {displayTitle || <span style={{ opacity: 0.5 }}>—</span>}
                  </td>
                  <td style={tdStyle}>
                    <span style={{
                      display: "inline-block",
                      padding: "2px 8px",
                      borderRadius: 4,
                      fontSize: 11,
                      fontWeight: 600,
                      color: completenessColor(item.recordCompleteness),
                      background: completenessBg(item.recordCompleteness),
                    }}>
                      {COMPLETENESS_LABELS[item.recordCompleteness] || item.recordCompleteness}
                    </span>
                    {item.missingFields.length > 0 && (
                      <span style={{ fontSize: 10, opacity: 0.6, marginLeft: 4 }}>
                        missing: {item.missingFields.slice(0, 2).join(", ")}
                        {item.missingFields.length > 2 ? ` +${item.missingFields.length - 2}` : ""}
                      </span>
                    )}
                    {item.conflictingFields.length > 0 && (
                      <span style={{ fontSize: 10, color: "#e74c3c", marginLeft: 4 }}>
                        !{item.conflictingFields.length}
                      </span>
                    )}
                  </td>
                  <td style={tdStyle}>
                    <span style={{
                      padding: "2px 8px",
                      borderRadius: 4,
                      fontSize: 11,
                      fontWeight: 600,
                      color: transportColor(item.intakeTransport),
                      background: transportColor(item.intakeTransport) + "1a",
                    }}>
                      {TRANSPORT_LABELS[item.intakeTransport] || item.intakeTransport}
                    </span>
                  </td>
                  <td style={tdStyle}>
                    {item.priority === "high" ? (
                      <span style={{
                        padding: "1px 6px",
                        borderRadius: 3,
                        fontSize: 11,
                        fontWeight: 600,
                        background: "rgba(230,126,34,0.15)",
                        color: "#c05610",
                      }}>{item.priority}</span>
                    ) : item.priority === "low" ? (
                      <span style={{ fontSize: 11, opacity: 0.5 }}>{item.priority}</span>
                    ) : (
                      <span style={{ fontSize: 11, opacity: 0.7 }}>{item.priority}</span>
                    )}
                  </td>
                  <td style={tdStyle}>
                    {item.latestVerdict
                      ? <span style={{
                          fontWeight: 500,
                          fontSize: 11,
                          color: item.latestVerdict === "genuine_external" ? "#27ae60"
                            : item.latestVerdict === "spam" ? "#e74c3c"
                            : item.latestVerdict === "duplicate" ? "#e67e22"
                            : "#555",
                        }}>{VERDICT_LABELS[item.latestVerdict] || item.latestVerdict}</span>
                      : <span style={{ opacity: 0.4, fontSize: 11 }}>—</span>}
                  </td>
                  <td style={tdStyle}>
                    {item.duplicateCount > 0
                      ? <span style={{ fontWeight: 600, fontSize: 11, color: item.duplicateStrength === "strong" ? "#c05610" : "#555" }}>{item.duplicateCount}</span>
                      : <span style={{ opacity: 0.4 }}>—</span>}
                  </td>
                  <td style={tdStyle}>
                    <span style={{ fontSize: 11, opacity: 0.7 }}>
                      {new Date(item.createdAt).toLocaleDateString()}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <div style={{ marginTop: 12, opacity: 0.6, fontSize: 11 }}>
        {items.length} intake record{items.length !== 1 ? "s" : ""} total ·
        {counts.action_required} action required ·
        {counts.needs_review} unreviewed ·
        {counts.partial_data} partial ·
        {counts.needs_source_check} needs source check
      </div>
    </div>
  );
}

const thStyle: React.CSSProperties = { padding: "6px 8px", fontWeight: 600, opacity: 0.75 };
const tdStyle: React.CSSProperties = { padding: "6px 8px" };