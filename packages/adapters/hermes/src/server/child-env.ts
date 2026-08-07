/**
 * Hermes child-process environment builder.
 *
 * Builds a minimal, auditable environment for spawned `hermes` processes.
 * This is used with runChildProcess's "replace" envMode — the child does
 * NOT inherit process.env.  Only explicitly allowlisted keys are included.
 *
 * In replace mode every key in the returned env dict is the full set of
 * keys that will reach child_process.spawn().  The lower-level merge of
 * sanitizeInheritedPaperclipEnv(process.env) is SKIPPED entirely by
 * runChildProcess.
 *
 * envMode: "replace" contract:
 *  - No inherited process.env keys (not even sanitized)
 *  - Only explicitly constructed env keys reach spawn()
 *  - Mandatory inheritable keys (PATH, LANG, LC_*) are copied explicitly
 *  - Isolation vars set from isolation contract, not inheritance
 *  - Blocked keys are OMITTED entirely, not set to "" (no shadowing needed)
 *  - Operator configEnv is additive but secret-shaped values are rejected
 *    unless they come through a governed secret-resolution path
 */

import { buildPaperclipEnv, redactEnvForLogs } from "@paperclipai/adapter-utils/server-utils";

// ───────────────────────────────────────────────────────────────────────
// Safe keys for explicit inheritance (minimal set)
// ───────────────────────────────────────────────────────────────────────
const SAFE_INHERITED_KEYS = new Set([
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "LC_NUMERIC",
  "LC_TIME",
  "TERM",
  // Safe PAPERCLIP_ vars that survive sanitizeInheritedPaperclipEnv()
  "PAPERCLIP_RUNTIME_API_URL",
  "PAPERCLIP_LISTEN_HOST",
  "PAPERCLIP_LISTEN_PORT",
]);

// ───────────────────────────────────────────────────────────────────────
// Patterns for secret-shaped variables that MUST NOT reach the child.
// These are blocked from parentEnv AND rejected from configEnv unless
// governed secret resolution metadata is provided.
// ───────────────────────────────────────────────────────────────────────
const BLOCKED_ENV_PATTERNS: RegExp[] = [
  /^DATABASE_URL$/i,
  /^(MYSQL|POSTGRES|PG|REDIS|MONGO|SQLITE)/i,
  /^(AWS_|AMAZON_)/i,
  /^(AZURE_|MSI_)/i,
  /^(GOOGLE_|GCP_|GCLOUD_|GOOGLE_CLOUD)/i,
  /^(SMTP_|IMAP_|MAIL_|EMAIL_)/i,
  /^(SENDGRID|MAILGUN|POSTMARK|RESEND)/i,
  /^(TWILIO|SEND_)/i,
  /^(STRIPE|PAYPAL|BILLING)/i,
  /^(SENTRY|DATADOG|NEW_RELIC|DD_)/i,
  /^(DOCKER_|KUBERNETES|K8S)/i,
  /^(GITHUB_TOKEN|GITHUB_ACTOR|GITHUB_REPOSITORY)/i,
  /^(NPM_TOKEN|NPM_AUTH|NODE_AUTH)/i,
  // Git variables — only author identity is allowed through explicit config
  /^GIT_(SSH|ASKPASS|TERMINAL|CONFIG|PROXY|SSL|EXEC|HOOK|TRACE|REDACT|EDITOR|SEQUENCE|PAGER|BROWSER|MERGE_|DIFF_|REBASE_|FETCH_|PUSH_|PULL_)/i,
  // Secret-shaped keys
  /^API_KEY$/i,
  /^API_TOKEN$/i,
  /[_]API_KEY$/i,
  /[_]API_TOKEN$/i,
  /[_]TOKEN$/i,
  /^ACCESS_KEY$/i,
  /^SECRET_KEY$/i,
  /^PRIVATE_KEY$/i,
  /^(PASSWORD|PASSWD)$/i,
  /^AUTH_TOKEN$/i,
  /^JWT_/i,
  /[_]SECRET_/i,
  /^SECRET_/i,
  /^SECRET_KEY$/i,
  /^(HELM_|TERRAFORM_)/i,
  /^(CIRCLE_|TRAVIS_|JENKINS_|BUILDKITE)/i,
  /^(PAPERCLIP_DATABASE|PAPERCLIP_ENCRYPTION|PAPERCLIP_JWT|PAPERCLIP_SESSION)/i,
  /^(DISCORD|TELEGRAM|SLACK|WEBHOOK)/i,
  /^(OPENAI|ANTHROPIC|COHERE|CLAUDE|GEMINI|MISTRAL|DEEPSEEK_)/i,
  /^(WEB3FORMS|FORMSPREE|FORMSUBMIT|FORMSPARK)/i,
  /^(CF_|CLOUDFLARE_|R2_|S3_)/i,
  /^(SERVICE_|SHARED_|VAULT_)/i,
  /^(CONNECTION_STRING|ENCRYPTION_KEY)/i,
  /^(LDAP_|KRB5_|KEYTAB)/i,
  /^(GPG_|GNUPG|SSH_KEY)/i,
  /^(SSH_AUTH_SOCK|NODE_OPTIONS)$/i,
  /^(HOME|USER|LOGNAME|SHELL)$/i,
];

// ───────────────────────────────────────────────────────────────────────
// Git author identity keys that may be explicitly configured
// ───────────────────────────────────────────────────────────────────────
const ALLOWED_GIT_AUTHOR_KEYS = new Set([
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
]);

// ───────────────────────────────────────────────────────────────────────
// Isolation variables set from the isolation contract, never inherited
// ───────────────────────────────────────────────────────────────────────
const PROTECTED_ISOLATION_KEYS = new Set([
  "HOME",
  "HERMES_HOME",
  "HERMES_WRITE_SAFE_ROOT",
  "HERMES_REDACT_SECRETS",
]);

// ───────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────

function isBlocked(key: string): boolean {
  if (ALLOWED_GIT_AUTHOR_KEYS.has(key)) return false;
  for (const pattern of BLOCKED_ENV_PATTERNS) {
    if (pattern.test(key)) return true;
  }
  return false;
}

function isSafeInherited(key: string): boolean {
  return SAFE_INHERITED_KEYS.has(key);
}

function parseSecretBindings(raw: unknown): Set<string> | null {
  if (Array.isArray(raw)) {
    return new Set(raw.filter((v): v is string => typeof v === "string" && v.length > 0));
  }
  return null;
}

// ───────────────────────────────────────────────────────────────────────
// Public API
// ───────────────────────────────────────────────────────────────────────

export interface HermesChildEnvInput {
  parentEnv: NodeJS.ProcessEnv;
  configEnv?: Record<string, string> | undefined;
  paperclipEnv: ReturnType<typeof buildPaperclipEnv>;
  taskEnv?: {
    runId?: string;
    taskId?: string;
    wakeReason?: string;
    commentId?: string;
    wakePayloadJson?: string;
  };
  authToken?: string;
  isolation?: Partial<Record<string, string>>;
  /** Set of env keys resolved through the governed secret pathway.
   *  Secret-shaped keys in configEnv are rejected unless present here. */
  resolvedSecretKeys?: string[] | null;
}

export interface HermesChildEnvResult {
  env: Record<string, string>;
  blockedKeys: string[];
  /** Secret-shaped configEnv keys that were rejected (not in resolvedSecretKeys). */
  rejectedConfigSecrets: string[];
  /** Keys resolved through governed secret path and allowed into the env. */
  resolvedSecretKeysUsed: string[];
}

export function buildHermesChildEnv(input: HermesChildEnvInput): HermesChildEnvResult {
  const env: Record<string, string> = {};
  const blockedKeys: string[] = [];
  const rejectedConfigSecrets: string[] = [];
  const resolvedSecretKeysUsed: string[] = [];

  const governedKeys = parseSecretBindings(input.resolvedSecretKeys);

  // ── 1. Inherit only safe defaults ─────────────────────────────────
  for (const [key, value] of Object.entries(input.parentEnv)) {
    if (value === undefined) continue;
    if (isSafeInherited(key)) {
      env[key] = value;
    } else if (isBlocked(key)) {
      blockedKeys.push(key);
      // In replace mode we OMIT rather than setting to "".
    }
    // Everything else: omitted.  In replace mode, runChildProcess does
    // NOT merge process.env, so omission = exclusion.
  }

  // ── 2. Paperclip runtime identity ─────────────────────────────────
  if (input.paperclipEnv.PAPERCLIP_AGENT_ID) {
    env.PAPERCLIP_AGENT_ID = input.paperclipEnv.PAPERCLIP_AGENT_ID;
  }
  if (input.paperclipEnv.PAPERCLIP_COMPANY_ID) {
    env.PAPERCLIP_COMPANY_ID = input.paperclipEnv.PAPERCLIP_COMPANY_ID;
  }
  if (input.paperclipEnv.PAPERCLIP_API_URL) {
    env.PAPERCLIP_API_URL = input.paperclipEnv.PAPERCLIP_API_URL;
  }

  // ── 3. Run-scoped identity vars ───────────────────────────────────
  if (input.taskEnv?.runId) {
    env.PAPERCLIP_RUN_ID = input.taskEnv.runId;
  }
  if (input.taskEnv?.taskId) {
    env.PAPERCLIP_TASK_ID = input.taskEnv.taskId;
  }
  if (input.taskEnv?.wakeReason) {
    env.PAPERCLIP_WAKE_REASON = input.taskEnv.wakeReason;
  }
  if (input.taskEnv?.commentId) {
    env.PAPERCLIP_WAKE_COMMENT_ID = input.taskEnv.commentId;
  }
  if (input.taskEnv?.wakePayloadJson) {
    env.PAPERCLIP_WAKE_PAYLOAD_JSON = input.taskEnv.wakePayloadJson;
  }

  // ── 4. Operator-configured env ────────────────────────────────────
  if (input.configEnv) {
    for (const [key, value] of Object.entries(input.configEnv)) {
      // Protected isolation keys cannot be overridden by operator config.
      if (PROTECTED_ISOLATION_KEYS.has(key)) continue;

      // Reject secret-shaped values from plaintext config unless they
      // were resolved through the governed secret pathway.
      if (isBlocked(key) || isSecretShaped(key)) {
        if (governedKeys && governedKeys.has(key)) {
          env[key] = value;
          resolvedSecretKeysUsed.push(key);
        } else {
          rejectedConfigSecrets.push(key);
        }
        continue;
      }

      env[key] = value;
    }
  }

  // ── 5. Auth token — only with explicit operator opt-in ────────────
  if (input.authToken) {
    env.PAPERCLIP_API_KEY = input.authToken;
  }

  // ── 6. Protected isolation vars (last to prevent override) ────────
  if (input.isolation) {
    for (const [key, value] of Object.entries(input.isolation)) {
      if (PROTECTED_ISOLATION_KEYS.has(key) && value !== undefined) {
        env[key] = value;
      }
    }
  }

  // ── 7. Validate required isolation vars ───────────────────────────
  // In replace mode, HOME and TMPDIR must be present — they cannot be
  // inherited from process.env.
  if (!env.HOME) {
    env.HOME = input.isolation?.HOME ?? "/home/hermes-agent";
  }

  return { env, blockedKeys, rejectedConfigSecrets, resolvedSecretKeysUsed };
}

// ───────────────────────────────────────────────────────────────────────
// Additional secret-shaped heuristic for rejecting plaintext configEnv
// values that don't match the exact blocked patterns above but still
// look like secrets (e.g. AUTH0_CLIENT_SECRET, RAILWAY_TOKEN, etc.).
// ───────────────────────────────────────────────────────────────────────
function isSecretShaped(key: string): boolean {
  const upper = key.toUpperCase();
  return (
    /_SECRET$/i.test(upper) ||
    /_TOKEN$/i.test(upper) ||
    /_API_KEY$/i.test(upper) ||
    /^API_KEY$/i.test(upper) ||
    /^API_TOKEN$/i.test(upper) ||
    /_PASSWORD$/i.test(upper) ||
    /_PASS$/i.test(upper) ||
    /_AUTH$/i.test(upper) ||
    /_KEY$/i.test(upper)
  );
}

// ───────────────────────────────────────────────────────────────────────
// Log-safe environment helper
// ───────────────────────────────────────────────────────────────────────
export function redactedChildEnv(env: Record<string, string>): Record<string, string> {
  return redactEnvForLogs(env);
}