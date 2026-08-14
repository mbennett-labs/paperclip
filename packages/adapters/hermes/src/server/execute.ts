/**
 * Server-side execution logic for the Hermes Agent adapter.
 *
 * Spawns `hermes chat -q "..." -Q` as a child process, streams output,
 * and returns structured results to Paperclip.
 *
 * Verified CLI flags (hermes chat):
 *   -q/--query         single query (non-interactive)
 *   -Q/--quiet         quiet mode (no banner/spinner, only response + session_id)
 *   -m/--model         model name (e.g. anthropic/claude-sonnet-4)
 *   -t/--toolsets      comma-separated toolsets to enable
 *   --provider         inference provider (auto, openrouter, nous, etc.)
 *   -r/--resume        resume session by ID
 *   -w/--worktree      isolated git worktree
 *   -v/--verbose       verbose output
 *   --checkpoints      filesystem checkpoints
 *   --yolo             bypass dangerous-command approval prompts (agents have no TTY)
 *   --source           session source tag for filtering
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  UsageSummary,
} from "@paperclipai/adapter-utils";

import {
  runChildProcess,
  buildPaperclipEnv,
  renderTemplate,
  ensureAbsoluteDirectory,
  asString,
  parseObject,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  joinPromptSections,
  renderPaperclipWakePrompt,
  stringifyPaperclipWakePayload,
  isPaperclipRecoveryWakePayload,
  redactEnvForLogs,
} from "@paperclipai/adapter-utils/server-utils";

import type { LocalProcessSandboxOptions } from "@paperclipai/adapter-utils/local-process-sandbox";

import {
  HERMES_CLI,
  DEFAULT_TIMEOUT_SEC,
  DEFAULT_GRACE_SEC,
  DEFAULT_MODEL,
  VALID_PROVIDERS,
} from "../shared/constants.js";

import {
  detectModel,
  resolveProvider,
} from "./detect-model.js";

import { buildHermesChildEnv } from "./child-env.js";

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

function cfgString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function cfgNumber(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}
function cfgBoolean(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}
function cfgStringArray(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every((i) => typeof i === "string")
    ? (v as string[])
    : undefined;
}

export function resolveHermesCommand(config: Record<string, unknown>): string {
  return cfgString(config.hermesCommand) || cfgString(config.command) || HERMES_CLI;
}

export type HermesCommandDialect = "hermes" | "openclaw";

/**
 * Resolve the CLI dialect used to build the child argv.
 *
 * The adapter historically only spoke the Python `hermes` CLI (`chat -q ...`).
 * When `hermesCommand` points at an OpenClaw binary (which has no `chat`
 * subcommand), operators opt in via `commandDialect: "openclaw"` so the adapter
 * emits OpenClaw's embedded/headless `agent --local` invocation instead.
 *
 * This is explicit configuration, not a basename heuristic, so a Hermes-compatible
 * wrapper named `openclaw` (or vice-versa) never changes behavior implicitly.
 */
export function resolveHermesCommandDialect(
  config: Record<string, unknown>,
): HermesCommandDialect {
  return cfgString(config.commandDialect) === "openclaw" ? "openclaw" : "hermes";
}

export interface HermesCommandArgsInput {
  dialect: HermesCommandDialect;
  prompt: string;
  runId: string;
  model: string;
  resolvedProvider: string;
  timeoutSec: number;
  useQuiet: boolean;
  toolsets: string | undefined;
  maxTurns: number | undefined;
  worktreeMode: boolean;
  checkpoints: boolean;
  verbose: boolean;
  dangerousYolo: boolean;
  persistSession: boolean;
  prevSessionId: string | undefined;
  extraArgs: string[] | undefined;
}

/**
 * Build the child argv for the configured dialect.
 *
 * Hermes dialect (default) preserves the historical `chat -q` argv.
 * OpenClaw dialect emits OpenClaw 2026.2.17's embedded, non-interactive
 * `agent --local --session-id <runId> --message <prompt> --json --timeout <sec>`.
 * Model selection for OpenClaw is driven by writing a minimal `openclaw.json`
 * into the sandbox home (agents.defaults.model.primary). The `agent --local`
 * CLI does not accept --model; the sandbox config file is the selection method
 * supported by this installed version.
 */
export function buildHermesCommandArgs(input: HermesCommandArgsInput): string[] {
  if (input.dialect === "openclaw") {
    const args: string[] = [
      "agent",
      "--local",
      "--session-id",
      input.runId,
      "--message",
      input.prompt,
      "--json",
      "--timeout",
      String(Math.max(1, Math.floor(input.timeoutSec))),
    ];
    return args;
  }

  const args: string[] = ["chat", "-q", input.prompt];
  if (input.useQuiet) args.push("-Q");
  if (input.model) args.push("-m", input.model);
  if (input.resolvedProvider !== "auto") args.push("--provider", input.resolvedProvider);
  if (input.toolsets) args.push("-t", input.toolsets);
  if (input.maxTurns && input.maxTurns > 0) args.push("--max-turns", String(input.maxTurns));
  if (input.worktreeMode) args.push("-w");
  if (input.checkpoints) args.push("--checkpoints");
  if (input.verbose) args.push("-v");
  args.push("--source", "tool");
  if (input.dangerousYolo) args.push("--yolo");
  if (input.persistSession && input.prevSessionId) args.push("--resume", input.prevSessionId);
  if (input.extraArgs?.length) args.push(...input.extraArgs);
  return args;
}

/**
 * Resolve the Hermes child working directory using the canonical Paperclip
 * workspace model (shared with the other local adapters).
 *
 * Precedence:
 *   1. The run workspace supplied by the execution context
 *      (`context.paperclipWorkspace.cwd`) — always an absolute path.
 *   2. An explicit `config.cwd` override (when the workspace source is
 *      `agent_home`, a configured cwd wins over the fallback agent home).
 *   3. The host process cwd (`process.cwd()`), which Node always returns as
 *      an absolute path.
 *
 * The result is guaranteed absolute; a relative "." is never produced because
 * the sandbox (local-process-sandbox) rejects non-absolute mount paths.
 */
export function resolveHermesWorkingDirectory(
  config: Record<string, unknown>,
  context: Record<string, unknown>,
): string {
  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const configuredCwd = cfgString(config.cwd);
  const useConfiguredInsteadOfAgentHome =
    workspaceSource === "agent_home" && Boolean(configuredCwd);
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  return effectiveWorkspaceCwd || configuredCwd || process.cwd();
}

/**
 * Resolve the contained sandbox workspace root.
 *
 * `containment.workspaceDir` is an optional persistent-config override; when it
 * is unset (the normal case) the workspace is derived per-run from the run ID,
 * so a new POC run never depends on a stale poc-001/poc-002 directory embedded
 * in the persistent agent configuration.
 */
export function resolveHermesSandboxWorkspaceDir(
  config: Record<string, unknown>,
  runId: string,
): string {
  return (
    cfgString(config["containment.workspaceDir"]) ||
    path.join(os.tmpdir(), `paperclip-hermes-sandbox-${runId}`)
  );
}

/**
 * Apply the contained execution identity to the child environment.
 *
 * The Hermes/OpenClaw CLI is an .mjs file with a `#!/usr/bin/env node` shebang,
 * so `node` must resolve from the child PATH.  On hosts where OpenClaw ships
 * its own Node >=22.12 runtime in the same bin directory (e.g.
 * /home/openclaw/.local/bin/node -> /usr/local/bin/node22), that directory
 * must precede the inherited system PATH or the shebang resolves the wrong
 * (too-old) node.  We prepend the command's own directory rather than the
 * inherited PATH.
 *
 * HOME is pointed at the contained (rw) sandbox home so the child writes
 * config/cache inside the workspace instead of a non-existent default.
 */
export function applyContainedExecutionIdentity(
  env: Record<string, string>,
  hermesCommand: string,
  sandboxHomeDir: string | null | undefined,
): Record<string, string> {
  const next: Record<string, string> = { ...env };

  if (path.isAbsolute(hermesCommand)) {
    const commandDir = path.dirname(hermesCommand);
    const inheritedPath = next.PATH ?? "";
    next.PATH = inheritedPath
      ? `${commandDir}${path.delimiter}${inheritedPath}`
      : commandDir;
  }

  if (sandboxHomeDir) {
    next.HOME = sandboxHomeDir;
  }

  return next;
}

// ---------------------------------------------------------------------------
// Wake-up prompt builder
// ---------------------------------------------------------------------------

const HERMES_DEFAULT_PROMPT_TEMPLATE = [
  'You are "{{agent.name}}", an AI agent employee in a Paperclip-managed company.',
  "",
  "Paperclip runtime identity:",
  "- Agent ID: {{agent.id}}",
  "- Company ID: {{agent.companyId}}",
  "- Run ID: {{run.id}}",
  "- API base: {{paperclipApiUrl}}",
  "",
  "Paperclip API guidance:",
  "- Use `curl` from the terminal for Paperclip API calls; browser/web extraction tools may not reach localhost.",
  "- Use `$PAPERCLIP_API_URL`, `$PAPERCLIP_API_KEY`, and `$PAPERCLIP_RUN_ID`; do not hard-code local ports or copy secrets into comments.",
  "- Displayed command logs may redact secrets; rely on environment variables instead of printed token values.",
  "- Include `-H \"Authorization: Bearer $PAPERCLIP_API_KEY\"` on API requests.",
  "- Include `-H \"X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID\"` on mutating issue requests.",
  "- For multiline comments or status updates, preserve newlines with `jq --arg` or a heredoc-fed helper rather than hand-escaping JSON.",
  "",
  "Safe multiline update pattern:",
  "```bash",
  "api=\"${PAPERCLIP_API_URL%/}\"",
  "case \"$api\" in */api) ;; *) api=\"$api/api\" ;; esac",
  "",
  "body=$(cat <<'MD'",
  "Summary line",
  "",
  "- Detail one",
  "- Detail two",
  "MD",
  ")",
  "jq -n --arg status done --arg comment \"$body\" '{status:$status, comment:$comment}' | \\",
  "  curl -sS -X PATCH \"$api/issues/{{context.issueId}}\" \\",
  "    -H \"Authorization: Bearer $PAPERCLIP_API_KEY\" \\",
  "    -H \"X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID\" \\",
  "    -H \"Content-Type: application/json\" \\",
  "    --data-binary @-",
  "```",
  "",
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
].join("\n");

function renderConditionalSections(template: string, vars: Record<string, unknown>): string {
  const isTruthy = (key: string) => {
    if (key === "noTask") return !vars.taskId;
    const value = vars[key];
    if (Array.isArray(value)) return value.length > 0;
    return Boolean(value);
  };
  return template.replace(
    /\{\{#([a-zA-Z0-9_.-]+)\}\}([\s\S]*?)\{\{\/\1\}\}/g,
    (_match, key: string, body: string) => (isTruthy(key) ? body : ""),
  );
}

export function buildPrompt(
  ctx: AdapterExecutionContext,
  config: Record<string, unknown>,
  options: { resumedSession?: boolean } = {},
): string {
  const template = cfgString(config.promptTemplate) || HERMES_DEFAULT_PROMPT_TEMPLATE;

  const context = (ctx as any).context || {};
  const taskId = cfgString(context.taskId) || cfgString(context.issueId) || cfgString(ctx.config?.taskId);
  const taskTitle = cfgString(context.taskTitle) || cfgString(ctx.config?.taskTitle) || "";
  const taskBody = cfgString(context.taskBody) || cfgString(ctx.config?.taskBody) || "";
  const commentId = cfgString(context.commentId) || cfgString(context.wakeCommentId) || cfgString(ctx.config?.commentId) || "";
  const wakeReason = cfgString(context.wakeReason) || cfgString(ctx.config?.wakeReason) || "";
  const agentName = ctx.agent?.name || "Hermes Agent";
  const companyName = cfgString(context.companyName) || cfgString(ctx.config?.companyName) || "";
  const projectName = cfgString(context.projectName) || cfgString(ctx.config?.projectName) || "";

  // Build API URL — ensure it has the /api path
  let paperclipApiUrl =
    cfgString(config.paperclipApiUrl) ||
    process.env.PAPERCLIP_API_URL ||
    "http://127.0.0.1:3100/api";
  // Ensure /api suffix
  if (!paperclipApiUrl.endsWith("/api")) {
    paperclipApiUrl = paperclipApiUrl.replace(/\/+$/, "") + "/api";
  }

  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, {
    resumedSession: options.resumedSession === true,
  });
  const paperclipTaskMarkdown = cfgString(context.paperclipTaskMarkdown)?.trim() || "";
  const sessionHandoffMarkdown = cfgString(context.paperclipSessionHandoffMarkdown)?.trim() || "";
  const wakePayloadJson = stringifyPaperclipWakePayload(context.paperclipWake) || "";

  const vars: Record<string, unknown> = {
    agentId: ctx.agent?.id || "",
    agentName,
    companyId: ctx.agent?.companyId || "",
    companyName,
    runId: ctx.runId || "",
    agent: ctx.agent || {},
    company: { id: ctx.agent?.companyId || "", name: companyName },
    run: { id: ctx.runId || "", source: "on_demand" },
    context,
    taskId: taskId || "",
    taskTitle,
    taskBody,
    commentId,
    wakeReason,
    projectName,
    paperclipApiUrl,
    paperclipWakePrompt: wakePrompt,
    paperclipTaskMarkdown,
    taskContext: paperclipTaskMarkdown,
    paperclipWakeJson: wakePayloadJson,
    wakePayloadJson,
    paperclipApiKeyEnv: "PAPERCLIP_API_KEY",
    paperclipRunIdEnv: "PAPERCLIP_RUN_ID",
  };

  const rendered = isPaperclipRecoveryWakePayload(context.paperclipWake)
    ? ""
    : renderTemplate(renderConditionalSections(template, vars), vars);
  return joinPromptSections([
    wakePrompt,
    sessionHandoffMarkdown,
    paperclipTaskMarkdown,
    rendered,
  ]);
}

// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------

/** Regex to extract session ID from Hermes quiet-mode output: "session_id: <id>" */
const SESSION_ID_REGEX = /^session_id:\s*(\S+)/m;

/** Regex for legacy session output format */
const SESSION_ID_REGEX_LEGACY = /session[_ ](?:id|saved)[:\s]+([a-zA-Z0-9_-]+)/i;

/** Regex to extract token usage from Hermes output. */
const TOKEN_USAGE_REGEX =
  /tokens?[:\s]+(\d+)\s*(?:input|in)\b.*?(\d+)\s*(?:output|out)\b/i;

/** Regex to extract cost from Hermes output. */
const COST_REGEX = /(?:cost|spent)[:\s]*\$?([\d.]+)/i;

interface ParsedOutput {
  sessionId?: string;
  response?: string;
  usage?: UsageSummary;
  costUsd?: number;
  errorMessage?: string;
}

// ---------------------------------------------------------------------------
// Response cleaning
// ---------------------------------------------------------------------------

/** Strip noise lines from a Hermes response (tool output, system messages, etc.) */
function cleanResponse(raw: string): string {
  return raw
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      if (!t) return true; // keep blank lines for paragraph separation
      if (t.startsWith("[tool]") || t.startsWith("[hermes]") || t.startsWith("[paperclip]")) return false;
      if (t.startsWith("session_id:")) return false;
      if (/^\[\d{4}-\d{2}-\d{2}T/.test(t)) return false;
      if (/^\[done\]\s*┊/.test(t)) return false;
      if (/^┊\s*[\p{Emoji_Presentation}]/u.test(t) && !/^┊\s*💬/.test(t)) return false;
      if (/^\p{Emoji_Presentation}\s*(Completed|Running|Error)?\s*$/u.test(t)) return false;
      return true;
    })
    .map((line) => {
      let t = line.replace(/^[\s]*┊\s*💬\s*/, "").trim();
      t = t.replace(/^\[done\]\s*/, "").trim();
      return t;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------

function parseHermesOutput(stdout: string, stderr: string): ParsedOutput {
  const combined = stdout + "\n" + stderr;
  const result: ParsedOutput = {};

  // In quiet mode, Hermes outputs:
  //   <response text>
  //
  //   session_id: <id>
  const sessionMatch = stdout.match(SESSION_ID_REGEX);
  if (sessionMatch?.[1]) {
    result.sessionId = sessionMatch?.[1] ?? null;
    // The response is everything before the session_id line
    const sessionLineIdx = stdout.lastIndexOf("\nsession_id:");
    if (sessionLineIdx > 0) {
      result.response = cleanResponse(stdout.slice(0, sessionLineIdx));
    }
  } else {
    // Legacy format (non-quiet mode)
    const legacyMatch = combined.match(SESSION_ID_REGEX_LEGACY);
    if (legacyMatch?.[1]) {
      result.sessionId = legacyMatch?.[1] ?? null;
    }
    // In non-quiet mode, extract clean response from stdout by
    // filtering out tool lines, system messages, and noise
    const cleaned = cleanResponse(stdout);
    if (cleaned.length > 0) {
      result.response = cleaned;
    }
  }

  // Extract token usage
  const usageMatch = combined.match(TOKEN_USAGE_REGEX);
  if (usageMatch) {
    result.usage = {
      inputTokens: parseInt(usageMatch[1], 10) || 0,
      outputTokens: parseInt(usageMatch[2], 10) || 0,
    };
  }

  // Extract cost
  const costMatch = combined.match(COST_REGEX);
  if (costMatch?.[1]) {
    result.costUsd = parseFloat(costMatch[1]);
  }

  // Check for error patterns in stderr
  if (stderr.trim()) {
    const errorLines = stderr
      .split("\n")
      .filter((line) => /error|exception|traceback|failed/i.test(line))
      .filter((line) => !/INFO|DEBUG|warn/i.test(line)); // skip log-level noise
    if (errorLines.length > 0) {
      result.errorMessage = errorLines.slice(0, 5).join("\n");
    }
  }

  return result;
}

/**
 * Parse OpenClaw `agent --json` output.
 *
 * OpenClaw 2026.2.17 `agent --local --json` prints a JSON object of the shape
 * `{ payloads: [...], meta: { agentMeta: { sessionId, provider, model, ... } } }`
 * on stdout, possibly interleaved with ANSI banner/logger lines. We scan for the
 * last JSON object carrying a `meta` key and extract the assistant text from
 * `payloads[].text`. There is no `session_id:`/`tokens:`/`cost:` Hermes markup.
 */
function parseOpenClawOutput(stdout: string, stderr: string): ParsedOutput {
  const result: ParsedOutput = {};
  const combined = stdout + "\n" + stderr;

  let parsed: Record<string, unknown> | null = null;
  const candidates = stdout.match(/\{[\s\S]*\}/g) ?? [];
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const value = JSON.parse(candidates[i]);
      if (value && typeof value === "object" && "meta" in value) {
        parsed = value as Record<string, unknown>;
        break;
      }
    } catch {
      // skip non-JSON fragments
    }
  }

  if (parsed) {
    const meta = parseObject(parsed.meta);
    const agentMeta = parseObject(meta.agentMeta);
    result.sessionId = asString(agentMeta.sessionId, "") || undefined;

    const payloads = Array.isArray(parsed.payloads) ? parsed.payloads : [];
    const texts: string[] = [];
    for (const payload of payloads) {
      if (!payload || typeof payload !== "object") continue;
      const text = asString((payload as Record<string, unknown>).text, "");
      if (text.trim()) texts.push(text);
    }
    if (texts.length > 0) {
      result.response = texts.join("\n");
    }
  }

  const usageMatch = combined.match(TOKEN_USAGE_REGEX);
  if (usageMatch) {
    result.usage = {
      inputTokens: parseInt(usageMatch[1], 10) || 0,
      outputTokens: parseInt(usageMatch[2], 10) || 0,
    };
  }

  const costMatch = combined.match(COST_REGEX);
  if (costMatch?.[1]) {
    result.costUsd = parseFloat(costMatch[1]);
  }

  if (stderr.trim()) {
    const errorLines = stderr
      .split("\n")
      .filter((line) => /error|exception|traceback|failed/i.test(line))
      .filter((line) => !/INFO|DEBUG|warn/i.test(line));
    if (errorLines.length > 0) {
      result.errorMessage = errorLines.slice(0, 5).join("\n");
    }
  }

  return result;
}

/**
 * Parse adapter stdout/stderr into a structured result for the given dialect.
 */
export function parseCommandOutput(
  stdout: string,
  stderr: string,
  dialect: HermesCommandDialect,
): ParsedOutput {
  return dialect === "openclaw"
    ? parseOpenClawOutput(stdout, stderr)
    : parseHermesOutput(stdout, stderr);
}

// ---------------------------------------------------------------------------
// Main execute
// ---------------------------------------------------------------------------

export async function execute(
  ctx: AdapterExecutionContext,
): Promise<AdapterExecutionResult> {
  const config = (ctx.config ?? ctx.agent?.adapterConfig ?? {}) as Record<string, unknown>;

  // ── Resolve configuration ──────────────────────────────────────────────
  const hermesCmd = resolveHermesCommand(config);
  const model = cfgString(config.model) || DEFAULT_MODEL;
  const timeoutSec = cfgNumber(config.timeoutSec) || DEFAULT_TIMEOUT_SEC;
  const graceSec = cfgNumber(config.graceSec) || DEFAULT_GRACE_SEC;
  const maxTurns = cfgNumber(config.maxTurnsPerRun);
  const toolsets = cfgString(config.toolsets) || cfgStringArray(config.enabledToolsets)?.join(",");
  const extraArgs = cfgStringArray(config.extraArgs);
  const persistSession = cfgBoolean(config.persistSession) !== false;
  const worktreeMode = cfgBoolean(config.worktreeMode) === true;
  const checkpoints = cfgBoolean(config.checkpoints) === true;
  const prevSessionId = cfgString(
    (ctx.runtime?.sessionParams as Record<string, unknown> | null)?.sessionId,
  );

  // ── Resolve provider (defense in depth) ────────────────────────────────
  // Priority chain:
  //   1. Explicit provider in adapterConfig (user override)
  //   2. Provider from ~/.hermes/config.yaml (detected at runtime)
  //   3. Provider inferred from model name prefix
  //   4. "auto" (let Hermes decide)
  //
  // This ensures that even if the agent was created before provider tracking
  // was added, or if the model was changed without updating provider, the
  // correct provider is still used.
  let detectedConfig: Awaited<ReturnType<typeof detectModel>> | null = null;
  const explicitProvider = cfgString(config.provider);

  if (!explicitProvider) {
    try {
      detectedConfig = await detectModel();
    } catch {
      // Non-fatal — detection failure shouldn't block execution
    }
  }

  const { provider: resolvedProvider, resolvedFrom } = resolveProvider({
    explicitProvider,
    detectedProvider: detectedConfig?.provider,
    detectedModel: detectedConfig?.model,
    detectedBaseUrl: detectedConfig?.baseUrl,
    detectedHasApiKey: detectedConfig?.hasApiKey,
    detectedApiMode: detectedConfig?.apiMode,
    model,
  });

  // ── Load agent instructions file (Paperclip instruction bundles) ──────
  // Paperclip can materialize managed instructions into instructionsFilePath;
  // when present, inject that bundle into the Hermes prompt.
  const instructionsFilePath = cfgString(config.instructionsFilePath);
  let agentInstructions = "";
  if (instructionsFilePath) {
    try {
      agentInstructions = await fs.readFile(instructionsFilePath, "utf-8");
      const loadedInstructionsLength = agentInstructions.length;
      const instructionsFileDir = path.dirname(instructionsFilePath);
      agentInstructions += `\nThe above agent instructions were loaded from ${instructionsFilePath}. Resolve any relative file references from ${instructionsFileDir}/.`;
      await ctx.onLog(
        "stdout",
        `[hermes] Loaded agent instructions from ${instructionsFilePath} (${loadedInstructionsLength} chars)\n`,
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // Non-fatal: log to stdout with an explicit "Warning:" prefix so the
      // Paperclip UI doesn't render this as a red error (stderr output is
      // surfaced as an error signal even when execution continues).
      await ctx.onLog(
        "stdout",
        `[hermes] Warning: could not read agent instructions file "${instructionsFilePath}": ${reason}\n`,
      );
    }
  }

  // ── Build prompt ───────────────────────────────────────────────────────
  let prompt = buildPrompt(ctx, config, { resumedSession: Boolean(prevSessionId) });
  if (agentInstructions) {
    prompt = agentInstructions + "\n\n---\n\n" + prompt;
  }

  // ── Build command args ─────────────────────────────────────────────────
  // Use -Q (quiet) to get clean output: just response + session_id line
  const useQuiet = cfgBoolean(config.quiet) === true; // default false

  // --yolo is NOT passed by default.
  // Paperclip agents run as non-interactive subprocesses with no TTY;
  // Hermes's approval prompts will cause commands that require approval
  // to fail.  Operators who need the old behaviour must explicitly enable
  // dangerouslySkipHermesApprovals.
  const dangerousYolo = cfgBoolean(config.dangerouslySkipHermesApprovals) === true;

  const dialect = resolveHermesCommandDialect(config);
  const args = buildHermesCommandArgs({
    dialect,
    prompt,
    runId: ctx.runId,
    model,
    resolvedProvider,
    timeoutSec,
    useQuiet,
    toolsets,
    maxTurns,
    worktreeMode,
    checkpoints,
    verbose: cfgBoolean(config.verbose) === true,
    dangerousYolo,
    persistSession,
    prevSessionId,
    extraArgs,
  });

  // ── Build environment ──────────────────────────────────────────────────
  // envMode: "replace" — the child process does NOT inherit any parent
  // process.env keys.  Only the explicitly-constructed env dict reaches
  // child_process.spawn().
  const ctxContext = (ctx as any).context || {};
  const allowApiAccess = cfgBoolean(config.allowPaperclipApiAccess) === true;
  const { env, blockedKeys: _blockedKeys, rejectedConfigSecrets, resolvedSecretKeysUsed } = buildHermesChildEnv({
    parentEnv: process.env,
    configEnv: (config.env as Record<string, string> | undefined) ?? undefined,
    paperclipEnv: buildPaperclipEnv(ctx.agent),
    taskEnv: {
      runId: ctx.runId,
      taskId: cfgString(ctxContext.taskId) || cfgString(ctxContext.issueId) || cfgString(ctx.config?.taskId),
      wakeReason: cfgString(ctxContext.wakeReason) || cfgString(ctx.config?.wakeReason),
      commentId: cfgString(ctxContext.commentId) || cfgString(ctxContext.wakeCommentId) || cfgString(ctx.config?.commentId),
      wakePayloadJson: stringifyPaperclipWakePayload(ctxContext.paperclipWake) ?? undefined,
    },
    authToken: allowApiAccess ? ((ctx as any).authToken as string | undefined) : undefined,
    isolation: Object.fromEntries(
      Object.entries(config).filter(([k]) => k.startsWith("isolation.")).map(([k, v]) => [k.slice("isolation.".length), String(v ?? "")]),
    ),
    resolvedSecretKeys: (config.__resolvedEnvKeys as string[] | undefined) ?? null,
  });

  if (rejectedConfigSecrets.length > 0) {
    const blocked = rejectedConfigSecrets.map((k) => `${k}`).join(", ");
    await ctx.onLog("stderr", `[hermes] Rejected plaintext secret-shaped config.env keys: ${blocked}\n`);
  }

  // ── Resolve working directory ──────────────────────────────────────────
  // Canonical model: run workspace from execution context, then config.cwd
  // override, then process.cwd(). Never a relative "." — the sandbox requires
  // absolute paths and a relative cwd is unrelated to the contained workspace.
  const cwd = resolveHermesWorkingDirectory(config, ctxContext);
  try {
    await ensureAbsoluteDirectory(cwd);
  } catch {
    // Non-fatal
  }

  // ── Build OS containment options ──────────────────────────────────────
  const containmentEnabled = cfgBoolean(config.containment) === true;
  let sandboxOpts: LocalProcessSandboxOptions | null = null;
  if (containmentEnabled) {
    const sandboxWorkspaceDir = resolveHermesSandboxWorkspaceDir(config, ctx.runId);
    const sandboxHomeDir =
      cfgString(config["containment.homeDir"]) ||
      path.join(sandboxWorkspaceDir, "home");
    const sandboxExecUid = cfgNumber(config["containment.executionUid"]);
    const sandboxExecGid = cfgNumber(config["containment.executionGid"]);

    const providerPreset = cfgString(config["containment.providerPreset"]) || "none";
    if (providerPreset !== "none" && providerPreset !== "openrouter") {
      throw new Error(
        `Invalid containment.providerPreset "${providerPreset}". Must be "none" or "openrouter".`,
      );
    }
    let networkScope: LocalProcessSandboxOptions["networkScope"] = "deny";
    let networkAllowlist: string[] = [];
    if (providerPreset === "openrouter") {
      networkScope = "allowlist";
      networkAllowlist = ["openrouter.ai:443"];
    }

    await fs.mkdir(sandboxWorkspaceDir, { recursive: true });
    await fs.mkdir(sandboxHomeDir, { recursive: true });

    // ── OpenClaw dialect: seed model config so OpenClaw resolves the
    //    Paperclip-configured model instead of falling back to hardcoded
    //    defaults (anthropic/claude-opus-4-6).  The `agent --local` CLI
    //    does not accept --model; model selection is driven by the agent
    //    config file ($HOME/.openclaw/openclaw.json).
    if (dialect === "openclaw" && model) {
      const openclawConfigDir = path.join(sandboxHomeDir, ".openclaw");
      await fs.mkdir(openclawConfigDir, { recursive: true });
      const configPayload: Record<string, unknown> = {
        agents: {
          defaults: {
            model: { primary: model },
          },
        },
      };
      await fs.writeFile(
        path.join(openclawConfigDir, "openclaw.json"),
        JSON.stringify(configPayload),
        { mode: 0o600 },
      );
    }

    const extraPaths: { path: string; access: "ro" | "rw" }[] = [{ path: cwd, access: "ro" }];
    if (instructionsFilePath) {
      extraPaths.push({ path: path.dirname(instructionsFilePath), access: "ro" });
    }
    if (sandboxHomeDir) {
      extraPaths.push({ path: sandboxHomeDir, access: "rw" });
    }
// Mount OpenClaw installation directory when running the openclaw dialect.
// The openclaw CLI (whether invoked directly at /home/openclaw/.local/bin/openclaw
// or through a wrapper that delegates to it) needs its symlink target and
// node_modules readable inside the bubblewrap sandbox.
if (dialect === "openclaw") {
  extraPaths.push({ path: "/home/openclaw/.local", access: "ro" });
}

    sandboxOpts = {
      workspaceDir: sandboxWorkspaceDir,
      filesystemScope: "workspace",
      networkScope,
      homeDir: sandboxHomeDir ?? undefined,
      executionUid: sandboxExecUid ?? undefined,
      executionGid: sandboxExecGid ?? undefined,
      containmentRequired: true,
      extraPaths,
    };
    if (networkAllowlist.length > 0) {
      sandboxOpts.networkAllowlist = networkAllowlist;
    }

    // ── Contained execution identity: PATH + HOME ──────────────────────
    Object.assign(
      env,
      applyContainedExecutionIdentity(env, hermesCmd, sandboxOpts?.homeDir),
    );
  }

  // ── Log start ──────────────────────────────────────────────────────────
  const redactedEnv = redactEnvForLogs(env);
  await ctx.onLog(
    "stdout",
    `[hermes] Starting Hermes Agent (model=${model}, provider=${resolvedProvider} [${resolvedFrom}], timeout=${timeoutSec}s${maxTurns ? `, max_turns=${maxTurns}` : ""}, agent=${redactedEnv.PAPERCLIP_AGENT_ID ?? "?"}, company=${redactedEnv.PAPERCLIP_COMPANY_ID ?? "?"})\n`,
  );
  if (prevSessionId) {
    await ctx.onLog(
      "stdout",
      `[hermes] Resuming session: ${prevSessionId}\n`,
    );
  }

  // ── Execute ────────────────────────────────────────────────────────────
  // Hermes writes non-error noise to stderr (MCP init, INFO logs, etc).
  // Paperclip renders all stderr as red/error in the UI.
  // Wrap onLog to reclassify benign stderr lines as stdout.
  const wrappedOnLog = async (stream: "stdout" | "stderr", chunk: string) => {
    if (stream === "stderr") {
      const trimmed = chunk.trimEnd();
      // Benign patterns that should NOT appear as errors:
      // - Structured log lines: [timestamp] INFO/DEBUG/WARN: ...
      // - MCP server registration messages
      // - Python import/site noise
      const isBenign = /^\[?\d{4}[-/]\d{2}[-/]\d{2}T/.test(trimmed) || // structured timestamps
        /^[A-Z]+:\s+(INFO|DEBUG|WARN|WARNING)\b/.test(trimmed) || // log levels
        /Successfully registered all tools/.test(trimmed) ||
        /MCP [Ss]erver/.test(trimmed) ||
        /tool registered successfully/.test(trimmed) ||
        /Application initialized/.test(trimmed);
      if (isBenign) {
        return ctx.onLog("stdout", chunk);
      }
    }
    return ctx.onLog(stream, chunk);
  };

  const result = await runChildProcess(ctx.runId, hermesCmd, args, {
    cwd: containmentEnabled ? sandboxOpts!.workspaceDir : cwd,
    env,
    timeoutSec,
    graceSec,
    envMode: "replace",
    onLog: wrappedOnLog,
    onSpawn: ctx.onSpawn,
    localProcessSandbox: sandboxOpts,
  });

  // ── Parse output ───────────────────────────────────────────────────────
  const parsed = parseCommandOutput(result.stdout || "", result.stderr || "", dialect);

  await ctx.onLog(
    "stdout",
    `[hermes] Exit code: ${result.exitCode ?? "null"}, timed out: ${result.timedOut}\n`,
  );
  if (parsed.sessionId) {
    await ctx.onLog("stdout", `[hermes] Session: ${parsed.sessionId}\n`);
  }

  // ── Build result ───────────────────────────────────────────────────────
  const executionResult: AdapterExecutionResult = {
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    provider: resolvedProvider,
    model,
  };

  if (parsed.errorMessage) {
    executionResult.errorMessage = parsed.errorMessage;
  }

  if (parsed.usage) {
    executionResult.usage = parsed.usage;
  }

  if (parsed.costUsd !== undefined) {
    executionResult.costUsd = parsed.costUsd;
  }

  // Summary from agent response
  if (parsed.response) {
    executionResult.summary = parsed.response.slice(0, 2000);
  }

  // Set resultJson so Paperclip can persist run metadata (used for UI display + auto-comments)
  executionResult.resultJson = {
    result: parsed.response || "",
    session_id: parsed.sessionId || null,
    usage: parsed.usage || null,
    cost_usd: parsed.costUsd ?? null,
  };

  // Store session ID for next run
  if (persistSession && parsed.sessionId) {
    executionResult.sessionParams = { sessionId: parsed.sessionId };
    executionResult.sessionDisplayId = parsed.sessionId.slice(0, 16);
  }

  return executionResult;
}
