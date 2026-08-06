import type { AdapterConfigSchema } from "@paperclipai/adapter-utils";

import {
  DEFAULT_GRACE_SEC,
  DEFAULT_TIMEOUT_SEC,
  VALID_PROVIDERS,
} from "../shared/constants.js";

function providerLabel(provider: string): string {
  if (provider === "auto") return "Auto";
  if (provider === "openai-codex") return "OpenAI Codex";
  if (provider === "kimi-coding") return "Kimi Coding";
  if (provider === "minimax-cn") return "MiniMax China";
  return provider
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function getConfigSchema(): AdapterConfigSchema {
  return {
    fields: [
      {
        key: "provider",
        label: "Provider",
        type: "select",
        default: "auto",
        options: VALID_PROVIDERS.map((provider) => ({
          value: provider,
          label: providerLabel(provider),
        })),
        hint: "Usually auto. Set this only when Hermes cannot infer the provider from the model or ~/.hermes/config.yaml.",
      },
      {
        key: "timeoutSec",
        label: "Timeout seconds",
        type: "number",
        default: DEFAULT_TIMEOUT_SEC,
      },
      {
        key: "graceSec",
        label: "Grace seconds",
        type: "number",
        default: DEFAULT_GRACE_SEC,
        hint: "Seconds to wait after SIGTERM before killing the Hermes process.",
      },
      {
        key: "maxTurnsPerRun",
        label: "Max turns per run",
        type: "number",
        hint: "Optional Hermes --max-turns limit for tool-calling iterations.",
      },
      {
        key: "toolsets",
        label: "Toolsets",
        type: "text",
        hint: "Optional comma-separated Hermes toolsets, such as terminal,file,web.",
      },
      {
        key: "persistSession",
        label: "Persist session",
        type: "toggle",
        default: true,
        hint: "Resume Hermes sessions across Paperclip heartbeats.",
      },
      {
        key: "worktreeMode",
        label: "Hermes worktree mode",
        type: "toggle",
        default: false,
        hint: "Pass Hermes --worktree.",
      },
      {
        key: "checkpoints",
        label: "Checkpoints",
        type: "toggle",
        default: false,
        hint: "Pass Hermes --checkpoints.",
      },
      {
        key: "quiet",
        label: "Quiet output",
        type: "toggle",
        default: true,
        hint: "Pass Hermes --quiet for cleaner Paperclip run transcripts.",
      },
      {
        key: "verbose",
        label: "Verbose output",
        type: "toggle",
        default: false,
        hint: "Pass Hermes --verbose.",
      },
      {
        key: "paperclipApiUrl",
        label: "Paperclip API URL",
        type: "text",
        hint: "Optional API base override. Defaults to PAPERCLIP_API_URL.",
      },
      {
        key: "dangerouslySkipHermesApprovals",
        label: "Skip Hermes command approvals (--yolo)",
        type: "toggle",
        default: false,
        hint: "DANGEROUS: bypasses Hermes command-approval prompts. Without this, Hermes will reject commands requiring approval (non-interactive agents have no TTY to confirm).",
      },
      {
        key: "allowPaperclipApiAccess",
        label: "Expose Paperclip API key to Hermes",
        type: "toggle",
        default: false,
        hint: "DANGEROUS: Forward PAPERCLIP_API_KEY to the child process. Required only if Hermes must call back to Paperclip's REST API from within a run. The key grants bearer access scoped to this agent. Enabling this exposes the credential to the child environment — ensure the agent is properly contained.",
      },
      {
        key: "promptTemplate",
        label: "Prompt template",
        type: "textarea",
        hint: "Optional custom prompt template with {{variable}} placeholders.",
      },
    ],
  };
}
