import { useMemo, type CSSProperties } from "react";
import { usePluginData, type PluginPageProps } from "@paperclipai/plugin-sdk/ui";

type QueueItem = {
  status: string;
  priority: string;
  conversationState: string | null;
  conversationHumanGate: boolean | null;
  conversationRiskAuthorityClass: string | null;
  conversationCommercialSignal: boolean | null;
  shadowHumanAttentionRequired: boolean | null;
  continuityHumanAttentionRequired: boolean | null;
  continuityFollowUpStatus: string | null;
  draftCandidateKind: string | null;
  conversationOutputMode: string | null;
  latestVerdict: string | null;
};

type LiveShadowReport = {
  mode: string;
  generatedAt: string;
  metrics: {
    totalMessagesConsidered: number;
    classified: number;
    conversationRecordsCreated: number;
    humanAttentionRequired: number;
    noHumanAttentionRequired: number;
    draftsReady: number;
    commercialOpportunities: number;
    suppressed: number;
    waitingForReply: number;
    followUpDue: number;
    recommendationAgreement: number;
    recommendationDisagreement: number;
    recommendationOutcomeUnknown: number;
  };
};

type EmailPluginConfigView = {
  enabled?: boolean;
  scheduledPollingEnabled?: boolean;
  outboundEnabled?: boolean;
  markSeen?: boolean;
  maxMessagesPerPoll?: number;
  intakeSince?: string;
  mailboxProfiles?: Array<{ status?: "active" | "standby" | "reserved" }>;
};

const card: CSSProperties = {
  border: "1px solid rgba(127,127,127,0.22)",
  borderRadius: 12,
  padding: 14,
  background: "rgba(127,127,127,0.035)",
};

const metricGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(145px, 1fr))",
  gap: 8,
};

const laneGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
  gap: 12,
};

function Metric({ label, value, detail, live = false }: { label: string; value: string | number; detail: string; live?: boolean }) {
  return (
    <div style={card}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
        <span style={{ fontSize: 11, fontWeight: 700, opacity: 0.65, textTransform: "uppercase", letterSpacing: 0.4 }}>{label}</span>
        {live ? <span style={{ fontSize: 10, fontWeight: 800, color: "#1e8449" }}>LIVE</span> : null}
      </div>
      <div style={{ fontSize: 26, fontWeight: 800, marginTop: 6 }}>{value}</div>
      <div style={{ fontSize: 11, opacity: 0.65, marginTop: 2 }}>{detail}</div>
    </div>
  );
}

function StatusRow({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 16, padding: "5px 0", borderBottom: "1px solid rgba(127,127,127,0.10)" }}>
      <span style={{ opacity: 0.72 }}>{label}</span>
      <span style={{ fontWeight: strong ? 800 : 600, textAlign: "right" }}>{value}</span>
    </div>
  );
}

function Lane({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <section style={{ ...card, minHeight: 240 }}>
      <div style={{ fontSize: 17, fontWeight: 800 }}>{title}</div>
      <div style={{ fontSize: 11, opacity: 0.62, marginTop: 3, marginBottom: 10 }}>{subtitle}</div>
      {children}
    </section>
  );
}

export function FounderMissionControlPage({ context }: PluginPageProps) {
  const companyId = context.companyId;
  const queue = usePluginData<QueueItem[]>("intake-queue", { companyId });
  const shadow = usePluginData<LiveShadowReport>("live-shadow-report", { companyId, limit: 200 });
  const config = usePluginData<EmailPluginConfigView | null>("plugin-config", { companyId });

  const items = queue.data ?? [];
  const metrics = shadow.data?.metrics;
  const cfg = config.data;

  const live = useMemo(() => {
    const humanDecisions = items.filter((item) =>
      item.status === "todo" &&
      (item.shadowHumanAttentionRequired === true ||
        item.conversationHumanGate === true ||
        item.continuityHumanAttentionRequired === true ||
        item.conversationRiskAuthorityClass === "uncertain" ||
        item.conversationState === "human_review")
    ).length;

    const commercial = items.filter((item) =>
      item.conversationCommercialSignal === true || item.conversationRiskAuthorityClass === "commercial_opportunity"
    ).length;

    const drafts = items.filter((item) => item.conversationOutputMode === "draft" || Boolean(item.draftCandidateKind)).length;
    const followUps = items.filter((item) => item.continuityFollowUpStatus === "follow_up_due").length;
    const activeMailboxes = (cfg?.mailboxProfiles ?? []).filter((profile) => profile.status === "active").length;

    return { humanDecisions, commercial, drafts, followUps, activeMailboxes };
  }, [items, cfg]);

  if (!companyId) {
    return <div style={{ padding: 16 }}>Select a company to view Founder Mission Control.</div>;
  }

  const loading = queue.loading || shadow.loading || config.loading;
  const error = queue.error ?? shadow.error ?? config.error;
  const safeLocks = [cfg?.scheduledPollingEnabled !== true, cfg?.outboundEnabled !== true, cfg?.markSeen !== true].filter(Boolean).length;

  return (
    <div style={{ padding: 16, display: "grid", gap: 14, fontSize: 13 }}>
      <header style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <h2 style={{ margin: 0, fontSize: 22, fontWeight: 850 }}>Founder Mission Control</h2>
            <span style={{ padding: "3px 7px", borderRadius: 999, fontSize: 10, fontWeight: 800, background: "rgba(39,174,96,0.12)", color: "#1e8449" }}>MVP · LIVE</span>
          </div>
          <div style={{ marginTop: 4, opacity: 0.66, maxWidth: 800 }}>
            Revenue speed, founder attention, and governed operations in one imperfect-but-useful cockpit. Live operational metrics are wired now; revenue adapters can replace manual checkpoints as we connect them.
          </div>
        </div>
        <button
          onClick={() => { queue.refresh(); shadow.refresh(); config.refresh(); }}
          style={{ padding: "7px 12px", borderRadius: 7, border: "1px solid rgba(127,127,127,0.4)", cursor: "pointer", fontWeight: 700 }}
        >
          Refresh live data
        </button>
      </header>

      {loading ? <div style={{ opacity: 0.65 }}>Refreshing Mission Control…</div> : null}
      {error ? <div style={{ color: "#c0392b" }}>Live data warning: {error.message}</div> : null}

      <div style={metricGrid}>
        <Metric label="Cash collected" value="—" detail="Gumroad / sales adapter next" />
        <Metric label="Pipeline $" value="—" detail="Manual until CRM adapter" />
        <Metric label="Commercial leads" value={live.commercial} detail="Detected in live intake" live />
        <Metric label="Human decisions" value={live.humanDecisions} detail="Waiting for founder/reviewer" live />
        <Metric label="Draft work" value={live.drafts} detail="Prepared or candidate drafts" live />
        <Metric label="Safety locks" value={`${safeLocks}/3`} detail="Polling · outbound · mark-seen locked" live />
      </div>

      <div style={laneGrid}>
        <Lane title="1 · Revenue NOW" subtitle="Shortest path to a paid customer">
          <StatusRow label="Primary offer" value="$299 B2B data product" strong />
          <StatusRow label="Qualified target pool" value="20 identified · manual checkpoint" />
          <StatusRow label="Live commercial signals" value={String(live.commercial)} />
          <StatusRow label="Follow-ups due" value={String(live.followUps)} />
          <StatusRow label="Cash / pipeline" value="Adapter not wired yet" />
          <div style={{ marginTop: 12, padding: 10, borderRadius: 8, background: "rgba(230,126,34,0.10)" }}>
            <strong>Next money action:</strong> activate the first qualified outreach batch and wire sent/reply/sale counts here.
          </div>
        </Lane>

        <Lane title="2 · Revenue Engine" subtitle="Audience, conversion, affiliates, measurement">
          <StatusRow label="Newsletter / list" value="Activation track" />
          <StatusRow label="Affiliate programs" value="Activation track" />
          <StatusRow label="Gumroad products" value="Existing + data product" />
          <StatusRow label="Measurement" value="GA4 / conversion wiring" />
          <StatusRow label="Draft work surfaced" value={String(live.drafts)} />
          <div style={{ marginTop: 12, fontSize: 11, opacity: 0.65 }}>
            MVP note: these are intentionally coarse checkpoints. We will replace them with live adapters as each revenue system comes online.
          </div>
        </Lane>

        <Lane title="3 · QSL / Conversation Operator" subtitle="Safety, staging, and human-attention buyback">
          <StatusRow label="Messages considered" value={String(metrics?.totalMessagesConsidered ?? 0)} />
          <StatusRow label="Conversation records" value={String(metrics?.conversationRecordsCreated ?? 0)} />
          <StatusRow label="Human attention" value={String(metrics?.humanAttentionRequired ?? live.humanDecisions)} />
          <StatusRow label="Suppressed" value={String(metrics?.suppressed ?? 0)} />
          <StatusRow label="Outcome unknown" value={String(metrics?.recommendationOutcomeUnknown ?? 0)} />
          <StatusRow label="Connector" value={cfg?.enabled === false ? "Disabled" : "Enabled"} />
          <StatusRow label="Polling" value={cfg?.scheduledPollingEnabled === true ? "Scheduled" : "Manual only"} />
          <StatusRow label="Outbound" value={cfg?.outboundEnabled === true ? "Enabled" : "Locked"} />
        </Lane>
      </div>

      <section style={card}>
        <div style={{ fontWeight: 800, marginBottom: 8 }}>What needs Mike right now?</div>
        {live.humanDecisions === 0 ? (
          <div style={{ color: "#1e8449", fontWeight: 700 }}>Nothing currently surfaced by Email Operations. Keep working the revenue lanes.</div>
        ) : (
          <div><strong>{live.humanDecisions}</strong> live item(s) currently require human review or authority.</div>
        )}
        <div style={{ marginTop: 8, fontSize: 11, opacity: 0.62 }}>
          Doctrine: surface live intelligence broadly; surface required human action narrowly.
          {shadow.data?.generatedAt ? ` · Live shadow generated ${new Date(shadow.data.generatedAt).toLocaleString()}.` : ""}
        </div>
      </section>
    </div>
  );
}
