import { useState } from "react";
import {
  usePluginAction,
  usePluginData,
  type PluginPageProps,
} from "@paperclipai/plugin-sdk/ui";

type MailboxProfile = {
  key?: string;
  username?: string;
  status?: "active" | "standby" | "reserved";
  imapHost?: string;
  imapPort?: number;
  smtpHost?: string;
  smtpPort?: number;
};

type ConfigView = {
  imapHost?: string;
  imapPort?: number;
  smtpHost?: string;
  smtpPort?: number;
  mailboxProfiles?: MailboxProfile[];
};

type ProbeResult = {
  ok: boolean;
  profileKey: string;
  username: string;
  imap: { ok: boolean; durationMs: number; error?: string };
  smtp: { ok: boolean; durationMs: number; error?: string };
};

const box: React.CSSProperties = { display: "grid", gap: 12, padding: 16, fontSize: 13 };
const card: React.CSSProperties = { border: "1px solid rgba(127,127,127,0.35)", borderRadius: 8, padding: 12, display: "grid", gap: 8 };
const row: React.CSSProperties = { display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" };
const label: React.CSSProperties = { fontWeight: 700, minWidth: 90 };
const btn: React.CSSProperties = { padding: "6px 12px", borderRadius: 6, border: "1px solid rgba(127,127,127,0.5)", cursor: "pointer", fontWeight: 700 };
const okStyle: React.CSSProperties = { color: "#1e8449" };
const errStyle: React.CSSProperties = { color: "#c0392b" };

export function MailboxConnectionsPage({ context }: PluginPageProps) {
  const companyId = context.companyId;
  const { data: config, loading, error } = usePluginData<ConfigView | null>("plugin-config", { companyId });
  const probeMailbox = usePluginAction("probe-mailbox");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, ProbeResult>>({});
  const [probeError, setProbeError] = useState<string | null>(null);

  async function runProbe(profileKey: string) {
    setBusyKey(profileKey);
    setProbeError(null);
    try {
      const result = await probeMailbox({ companyId, profileKey }) as ProbeResult;
      setResults((current) => ({ ...current, [profileKey]: result }));
    } catch (err) {
      setProbeError(err instanceof Error ? err.message : "Connectivity check failed");
    } finally {
      setBusyKey(null);
    }
  }

  if (loading) return <div style={box}>Loading mailbox configurationâ¦</div>;
  if (error) return <div style={box}><span style={errStyle}>Error: {error.message}</span></div>;

  const profiles = Array.isArray(config?.mailboxProfiles) ? config.mailboxProfiles : [];

  return (
    <div style={box}>
      <div>
        <div style={{ fontWeight: 800, fontSize: 16 }}>Mailbox connections</div>
        <div style={{ opacity: 0.7, marginTop: 4 }}>
          Read-only connectivity checks. IMAP opens the configured folder; SMTP verifies authentication. No message is sent, read, moved, or marked seen.
        </div>
      </div>
      {profiles.length === 0 ? (
        <div style={card}>No structured mailbox profiles are configured.</div>
      ) : profiles.map((profile) => {
        const key = profile.key?.trim() || "unnamed";
        const result = results[key];
        const imapHost = profile.imapHost || config?.imapHost || "default";
        const imapPort = profile.imapPort || config?.imapPort || 993;
        const smtpHost = profile.smtpHost || config?.smtpHost || "default";
        const smtpPort = profile.smtpPort || config?.smtpPort || 465;
        const active = profile.status === "active";
        return (
          <div key={key} style={card}>
            <div style={{ fontWeight: 800 }}>{key} <span style={{ opacity: 0.65, fontWeight: 500 }}>({profile.status ?? "standby"})</span></div>
            <div style={row}><span style={label}>Mailbox</span><span>{profile.username || "not set"}</span></div>
            <div style={row}><span style={label}>IMAP</span><span>{imapHost}:{imapPort}</span></div>
            <div style={row}><span style={label}>SMTP</span><span>{smtpHost}:{smtpPort}</span></div>
            <div>
              <button style={{ ...btn, opacity: active ? 1 : 0.55 }} disabled={!active || busyKey !== null} onClick={() => void runProbe(key)}>
                {busyKey === key ? "Checkingâ¦" : "Verify connectivity"}
              </button>
            </div>
            {result ? (
              <div style={{ display: "grid", gap: 4 }}>
                <div style={result.imap.ok ? okStyle : errStyle}>
                  IMAP: {result.imap.ok ? `OK (${result.imap.durationMs} ms)` : `FAILED â ${result.imap.error ?? "unknown error"}`}
                </div>
                <div style={result.smtp.ok ? okStyle : errStyle}>
                  SMTP: {result.smtp.ok ? `OK (${result.smtp.durationMs} ms)` : `FAILED â ${result.smtp.error ?? "unknown error"}`}
                </div>
              </div>
            ) : null}
          </div>
        );
      })}
      {probeError ? <div style={errStyle}>{probeError}</div> : null}
    </div>
  );
}
