import { useState } from "react";
import {
  usePluginAction,
  usePluginData,
  type PluginDetailTabProps,
  type PluginWidgetProps,
} from "@paperclipai/plugin-sdk/ui";

type ThreadRecord = {
  messageId: string;
  profileKey: string;
  from: string;
  fromAddress: string;
  to: string;
  subject: string;
  date: string;
  snippet: string;
  classHint: string;
  ventureHint: string;
  ingestedAt: string;
};

type SentRecord = {
  sentAt: string;
  sentMessageId: string;
  to: string;
  subject: string;
  profileKey: string;
};

type IssueEmailData = {
  thread: ThreadRecord | null;
  sent: SentRecord | null;
  draft: { to: string | null; subject: string | null; text: string } | null;
};

type MailboxStatus = {
  lastPollAt: string | null;
  lastDurationMs: number;
  totals: { polls: number; ingested: number; sent: number };
  profiles: Array<{ key: string; ok: boolean; found: number; created: number; skippedDuplicates: number; error?: string }>;
};

const box: React.CSSProperties = { display: "grid", gap: 10, padding: 12, fontSize: 13 };
const row: React.CSSProperties = { display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" };
const label: React.CSSProperties = { fontWeight: 600, minWidth: 90, opacity: 0.75 };
const mono: React.CSSProperties = { fontFamily: "monospace", fontSize: 12, opacity: 0.8, wordBreak: "break-all" };
const card: React.CSSProperties = { border: "1px solid rgba(127,127,127,0.35)", borderRadius: 8, padding: 10, display: "grid", gap: 6 };
const btn: React.CSSProperties = { padding: "6px 14px", borderRadius: 6, border: "1px solid rgba(127,127,127,0.5)", cursor: "pointer", fontWeight: 600 };
const errStyle: React.CSSProperties = { color: "#c0392b", fontSize: 12 };
const okStyle: React.CSSProperties = { color: "#1e8449", fontSize: 12 };

export function EmailIssueTab({ context }: PluginDetailTabProps) {
  const issueId = context.entityId;
  const companyId = context.companyId;
  const { data, loading, error, refresh } = usePluginData<IssueEmailData>("issue-email", { issueId, companyId });
  const { data: configData } = usePluginData<{ outboundEnabled?: boolean } | null>("plugin-config", { companyId });
  const sendReply = usePluginAction("send-reply");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const outboundEnabled = configData?.outboundEnabled === true;

  if (loading) return <div style={box}>Loading email record…</div>;
  if (error) return <div style={box}><span style={errStyle}>Error: {error.message}</span></div>;
  if (!data?.thread) {
    return <div style={box}><span style={{ opacity: 0.7 }}>No inbound email is linked to this issue. Email-sourced issues are created by the Email Connector in the Intake project.</span></div>;
  }

  const { thread, sent, draft } = data;

  async function handleSend() {
    setBusy(true);
    setSendError(null);
    try {
      const result = await sendReply({ issueId, companyId }) as { ok?: boolean; alreadySent?: boolean } | undefined;
      if (result && result.ok === false && !result.alreadySent) {
        setSendError("Send failed. Check the worker log.");
      }
      setConfirming(false);
      refresh();
    } catch (err) {
      setSendError(err instanceof Error ? err.message : "Send failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={box}>
      <div style={card}>
        <div style={{ fontWeight: 700 }}>Inbound email</div>
        <div style={row}><span style={label}>From</span><span>{thread.from}</span></div>
        <div style={row}><span style={label}>Subject</span><span>{thread.subject}</span></div>
        <div style={row}><span style={label}>Date</span><span>{new Date(thread.date).toLocaleString()}</span></div>
        <div style={row}><span style={label}>Class / venture</span><span><code>{thread.classHint}</code> / <code>{thread.ventureHint}</code> (hints)</span></div>
        <div style={row}><span style={label}>Message-ID</span><span style={mono}>{thread.messageId}</span></div>
        <div style={row}><span style={label}>Profile</span><span>{thread.profileKey}</span></div>
      </div>

      {sent ? (
        <div style={card}>
          <div style={{ fontWeight: 700 }}>Reply sent</div>
          <div style={row}><span style={label}>To</span><span>{sent.to}</span></div>
          <div style={row}><span style={label}>Sent at</span><span>{new Date(sent.sentAt).toLocaleString()}</span></div>
          <div style={row}><span style={label}>Message-ID</span><span style={mono}>{sent.sentMessageId}</span></div>
          <div style={okStyle}>Loop complete for this thread. The send record is also on the issue timeline.</div>
        </div>
      ) : (
        <div style={card}>
          <div style={{ fontWeight: 700 }}>Governed reply</div>
          {draft ? (
            <>
              <div style={row}><span style={label}>Draft To</span><span>{draft.to ?? thread.fromAddress}</span></div>
              <div style={row}><span style={label}>Draft Subject</span><span>{draft.subject ?? `Re: ${thread.subject}`}</span></div>
              <div style={{ whiteSpace: "pre-wrap", maxHeight: 220, overflow: "auto", border: "1px dashed rgba(127,127,127,0.4)", borderRadius: 6, padding: 8 }}>{draft.text}</div>
            </>
          ) : (
            <div style={{ opacity: 0.75 }}>No <code>reply-draft</code> document yet. The Communications Drafter attaches one; only then can the Board send.</div>
          )}
          {!outboundEnabled ? (
            <div style={errStyle}>Outbound email is disabled for this company. Enable outboundEnabled in plugin settings to send replies.</div>
          ) : !confirming ? (
            <div>
              <button style={{ ...btn, opacity: draft ? 1 : 0.5 }} disabled={!draft || busy} onClick={() => setConfirming(true)}>
                Send approved reply
              </button>
            </div>
          ) : (
            <div style={{ display: "grid", gap: 8 }}>
              <div style={{ fontWeight: 600 }}>Send this reply to {draft?.to ?? thread.fromAddress}?</div>
              <div style={{ opacity: 0.75, fontSize: 12 }}>This is an external effect. It is recorded permanently on the issue timeline with the sent Message-ID.</div>
              <div style={{ display: "flex", gap: 8 }}>
                <button style={btn} disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>
                <button style={{ ...btn, background: "#1e8449", color: "#fff", borderColor: "#1e8449" }} disabled={busy} onClick={() => void handleSend()}>
                  {busy ? "Sending..." : "Confirm send"}
                </button>
              </div>
            </div>
          )}
          {sendError ? <div style={errStyle}>{sendError}</div> : null}
          <div style={{ opacity: 0.6, fontSize: 12 }}>Board-only action. Agents have no send capability in this deployment.</div>
        </div>
      )}
    </div>
  );
}

export function EmailMetricsWidget({ context }: PluginWidgetProps) {
  const companyId = context.companyId;
  const { data, loading, error, refresh } = usePluginData<MailboxStatus>("mailbox-status", { companyId });
  const pollNow = usePluginAction("poll-now");
  const [busy, setBusy] = useState(false);
  const [pollError, setPollError] = useState<string | null>(null);

  async function handlePoll() {
    setBusy(true);
    setPollError(null);
    try {
      await pollNow({ companyId });
      refresh();
    } catch (err) {
      setPollError(err instanceof Error ? err.message : "Poll failed");
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <div style={box}>Loading email status…</div>;
  if (error) return <div style={box}><span style={errStyle}>Error: {error.message}</span></div>;

  const status = data ?? { lastPollAt: null, lastDurationMs: 0, totals: { polls: 0, ingested: 0, sent: 0 }, profiles: [] };

  return (
    <div style={box}>
      <div style={{ fontWeight: 700 }}>Email intake</div>
      <div style={row}><span style={label}>Last poll</span><span>{status.lastPollAt ? new Date(status.lastPollAt).toLocaleString() : "never"}</span></div>
      <div style={row}><span style={label}>Ingested</span><span>{status.totals.ingested} message(s)</span></div>
      <div style={row}><span style={label}>Replies sent</span><span>{status.totals.sent}</span></div>
      <div style={row}><span style={label}>Polls run</span><span>{status.totals.polls}</span></div>
      {status.profiles.map((p) => (
        <div key={p.key} style={row}>
          <span style={label}>{p.key}</span>
          {p.ok ? (
            <span style={okStyle}>ok — {p.created} new / {p.found} found{p.skippedDuplicates ? ` / ${p.skippedDuplicates} dup` : ""}</span>
          ) : (
            <span style={errStyle}>failed: {p.error}</span>
          )}
        </div>
      ))}
      <div>
        <button style={btn} disabled={busy} onClick={() => void handlePoll()}>{busy ? "Polling…" : "Poll now"}</button>
      </div>
      {pollError ? <div style={errStyle}>{pollError}</div> : null}
    </div>
  );
}
