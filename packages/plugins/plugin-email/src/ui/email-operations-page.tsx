import { useState } from "react";
import type { PluginPageProps } from "@paperclipai/plugin-sdk/ui";
import { FounderMissionControlPage } from "./founder-mission-control-page.js";
import { StoreIntakePage } from "./store-intake-page.js";
import { MailboxConnectionsPage } from "./mailbox-connections-page.js";

type Surface = "mission" | "queue" | "connections";

export function EmailOperationsPage(props: PluginPageProps) {
  const [surface, setSurface] = useState<Surface>("mission");
  const buttonStyle = (active: boolean) => ({
    padding: "6px 10px",
    borderRadius: 7,
    border: "1px solid rgba(127,127,127,0.35)",
    cursor: "pointer",
    fontWeight: active ? 800 : 600,
    background: active ? "rgba(127,127,127,0.12)" : "transparent",
  });

  return (
    <div>
      <div style={{ display: "flex", gap: 6, padding: "12px 16px 0", flexWrap: "wrap" }}>
        <button onClick={() => setSurface("mission")} style={buttonStyle(surface === "mission")}>Founder Mission Control</button>
        <button onClick={() => setSurface("queue")} style={buttonStyle(surface === "queue")}>Email Operations Queue</button>
        <button onClick={() => setSurface("connections")} style={buttonStyle(surface === "connections")}>Mailbox Connections</button>
      </div>
      {surface === "mission" ? <FounderMissionControlPage {...props} /> : surface === "queue" ? <StoreIntakePage {...props} /> : <MailboxConnectionsPage {...props} />}
    </div>
  );
}
