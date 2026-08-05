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
};

type FilterName =
  | "all"
  | "unreviewed"
  | "high_priority"
  | "possible_duplicates"
  | "needs_verification"
  | "internal_tests"
  | "spam"
  | "recently_reviewed";

const FILTERS: { key: FilterName; label: string }[] = [
  { key: "all", label: "All intake" },
  { key: "unreviewed", label: "Unreviewed" },
  { key: "high_priority", label: "High priority" },
  { key: "possible_duplicates", label: "Possible duplicates" },
  { key: "needs_verification", label: "Needs verification" },
  { key: "internal_tests", label: "Internal/family tests" },
  { key: "spam", label: "Spam" },
  { key: "recently_reviewed", label: "Recently reviewed" },
];

const VERDICT_LABELS: Record<string, string> = {
  genuine_external: "Genuine",
  internal_test: "Internal test",
  family_test: "Family test",
  spam: "Spam",
  duplicate: "Duplicate",
  unsure: "Unsure",
};

function filterItems(items: QueueItem[], filter: FilterName): QueueItem[] {
  switch (filter) {
    case "all":
      return items;
    case "unreviewed":
      return items.filter((i) => !i.latestVerdict);
    case "high_priority":
      return items.filter((i) => i.priority === "high");
    case "possible_duplicates":
      return items.filter((i) => i.duplicateCount > 0);
    case "needs_verification":
      return items.filter((i) => i.latestOutcome === "needs_verification");
    case "internal_tests":
      return items.filter((i) => i.latestVerdict === "internal_test" || i.latestVerdict === "family_test");
    case "spam":
      return items.filter((i) => i.latestVerdict === "spam");
    case "recently_reviewed":
      return items.filter((i) => i.latestVerdict).slice(-20);
    default:
      return items;
  }
}

export function StoreIntakePage({ context }: PluginPageProps) {
  const companyId = context.companyId;
  const { data, loading, error, refresh } = usePluginData<QueueItem[]>("intake-queue", { companyId });
  const { resolveHref } = useHostNavigation();
  const [activeFilter, setActiveFilter] = useState<FilterName>("unreviewed");

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
      <h2 style={{ fontWeight: 700, fontSize: 18, margin: "0 0 12px 0" }}>Store Intake Review</h2>

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
              <th style={thStyle}>Store</th>
              <th style={thStyle}>Source</th>
              <th style={thStyle}>Priority</th>
              <th style={thStyle}>Verdict</th>
              <th style={thStyle}>Outcome</th>
              <th style={thStyle}>Dup</th>
              <th style={thStyle}>Received</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((item) => {
              const issueHref = context.companyPrefix
                ? resolveHref(`/${context.companyPrefix}/issues/${item.issueId}`)
                : `#issues/${item.issueId}`;

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
                  <td style={tdStyle}>{item.storeName || <span style={{ opacity: 0.5 }}>—</span>}</td>
                  <td style={tdStyle}>
                    {item.sourceForm || item.sourceType || <span style={{ opacity: 0.5 }}>—</span>}
                  </td>
                  <td style={tdStyle}>
                    <span style={{
                      padding: "1px 6px",
                      borderRadius: 3,
                      fontSize: 11,
                      fontWeight: 600,
                      background: item.priority === "high" ? "rgba(230,126,34,0.15)" : "rgba(127,127,127,0.1)",
                      color: item.priority === "high" ? "#c05610" : "#555",
                    }}>
                      {item.priority}
                    </span>
                  </td>
                  <td style={tdStyle}>
                    {item.latestVerdict
                      ? <span style={{ fontWeight: 500 }}>{VERDICT_LABELS[item.latestVerdict] || item.latestVerdict}</span>
                      : <span style={{ opacity: 0.5 }}>—</span>}
                  </td>
                  <td style={tdStyle}>
                    {item.latestOutcome || <span style={{ opacity: 0.5 }}>—</span>}
                  </td>
                  <td style={tdStyle}>
                    {item.duplicateCount > 0
                      ? <span style={{ fontWeight: 600, color: item.duplicateStrength === "strong" ? "#c05610" : "#555" }}>{item.duplicateCount}</span>
                      : <span style={{ opacity: 0.5 }}>—</span>}
                  </td>
                  <td style={tdStyle}>
                    {new Date(item.createdAt).toLocaleDateString()}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <div style={{ marginTop: 12, opacity: 0.6, fontSize: 11 }}>
        {items.length} intake record{items.length !== 1 ? "s" : ""} total · {counts.unreviewed} unreviewed
      </div>
    </div>
  );
}

const thStyle: React.CSSProperties = { padding: "6px 8px", fontWeight: 600, opacity: 0.75 };
const tdStyle: React.CSSProperties = { padding: "6px 8px" };