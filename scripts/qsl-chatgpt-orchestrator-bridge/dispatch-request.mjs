#!/usr/bin/env node
/**
 * QSL ChatGPT Orchestrator Bridge V1 — branch-native request dispatcher.
 *
 * Replaces the issue_comment transport with a commit-triggered request path:
 *
 *   1. A request is a JSON file committed at `.qsl/bridge-requests/<request_id>.json`.
 *   2. A push to `feat/qsl-chatgpt-orchestrator-bridge-v1` that touches that
 *      path triggers the dispatch workflow on the self-hosted staging runner.
 *   3. This script validates the request, enforces replay prevention, calls the
 *      staging Paperclip API, and posts a sanitized result to issue #34.
 *
 * Zero runtime dependencies (Node 20+ with global `fetch`). Pure helpers are
 * exported so the transport can be behavior-tested without network/git access.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REQUEST_DIR = ".qsl/bridge-requests";

// Mirrors ORCHESTRATOR_BRIDGE_OPERATIONS in
// packages/shared/src/types/qsl-orchestrator-bridge.ts. Keep in sync.
export const ALLOWLIST_OPERATIONS = [
  "status",
  "list-missions",
  "get-mission",
  "list-tasks",
  "get-task",
  "list-approvals",
  "list-mail-triage",
  "get-mail-thread-summary",
  "create-task",
  "update-task",
  "assign-task",
  "create-approval-request",
  "create-outbound-draft",
  "record-mission-evidence",
  "execute-approved-send",
  "publish-approved-asset",
  "accept-approved-commercial-commitment",
];

export const HUMAN_GATED_OPERATIONS = [
  "execute-approved-send",
  "publish-approved-asset",
  "accept-approved-commercial-commitment",
];

export const PROHIBITED_PATTERNS = [
  "shell",
  "exec",
  "sql",
  "credential",
  "secret",
  "deploy",
  "restart",
  "production",
  "destructive",
  "migrate",
  "drop",
];

const MAX_TARGET_IDS = 50;
const MAX_PAYLOAD_KEYS = 20;
const MAX_PAYLOAD_VALUE_LENGTH = 10_000;
const MAX_ID_LENGTH = 128;
const MAX_EVIDENCE_LENGTH = 50_000;

// ── Pure helpers (unit-tested) ───────────────────────────────────────────────

/**
 * Narrow request path filter. Accepts only
 * `.qsl/bridge-requests/<request_id>.json` with a safe `<request_id>`
 * (alphanumeric, dash, underscore). Accepts both relative and absolute paths,
 * but rejects traversal and any path whose final directory is not the request
 * directory.
 */
export function isRequestPath(relPath) {
  if (typeof relPath !== "string" || relPath.length === 0) return false;
  const normalized = relPath.replace(/\\/g, "/");
  const parts = normalized.split("/").filter((p) => p.length > 0);
  if (parts.length < 3) return false;
  if (parts.includes("..")) return false;
  const lastThree = parts.slice(-3);
  if (lastThree[0] !== ".qsl" || lastThree[1] !== "bridge-requests") return false;
  return /^[A-Za-z0-9_-]+\.json$/.test(lastThree[2]);
}

export function requestIdFromPath(relPath) {
  if (!isRequestPath(relPath)) return null;
  return path.basename(relPath).replace(/\.json$/, "");
}

export function isProhibitedOperation(operation) {
  if (typeof operation !== "string") return true;
  const lower = operation.toLowerCase();
  return PROHIBITED_PATTERNS.some((p) => lower.includes(p));
}

/**
 * Redact secret-like material from any text that may leave the private env.
 * Handles sk-* keys, bearer tokens, PEM blocks, base64 blobs, and key=value
 * secrets. Returns a bounded string.
 */
export function sanitizeText(text, maxLength = 500) {
  if (typeof text !== "string") return "";
  return text
    .replace(/-----BEGIN[\s\S]*?-----END[\s\S]*?-----/gi, "[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, "[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, "Bearer [REDACTED]")
    .replace(/\b(password|passwd|pwd|secret|token|api[_-]?key|credential)\s*[:=]\s*\S+/gi, "$1=[REDACTED]")
    .replace(/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, "[REDACTED]")
    .slice(0, maxLength);
}

/**
 * Parse request JSON. Returns { ok: true, request } or { ok: false, error }.
 * Rejects non-objects and empty documents.
 */
export function parseRequest(raw) {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { ok: false, error: "request file is empty" };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "request is not valid JSON" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "request must be a JSON object" };
  }
  return { ok: true, request: parsed };
}

/**
 * Validate a parsed request against the V1 contract. Mirrors
 * orchestratorBridgeRequestSchema plus staging/allowlist/authority gates.
 * Returns { ok: true } or { ok: false, error, resultClass }.
 */
export function validateRequest(request) {
  if (!request || typeof request !== "object") {
    return { ok: false, resultClass: "BLOCKED", error: "request must be an object" };
  }

  const requestId = request.request_id;
  if (typeof requestId !== "string" || requestId.length === 0 || requestId.length > MAX_ID_LENGTH) {
    return { ok: false, resultClass: "BLOCKED", error: "request_id must be a non-empty string (max 128)" };
  }

  const operation = request.operation;
  if (typeof operation !== "string") {
    return { ok: false, resultClass: "BLOCKED", error: "operation is required" };
  }
  if (isProhibitedOperation(operation)) {
    return { ok: false, resultClass: "BLOCKED", error: `operation matches a prohibited pattern: ${operation}` };
  }
  if (!ALLOWLIST_OPERATIONS.includes(operation)) {
    return { ok: false, resultClass: "BLOCKED", error: `operation is not allowlisted: ${operation}` };
  }

  const environment = request.environment;
  if (environment !== "staging") {
    return {
      ok: false,
      resultClass: "BLOCKED",
      error: `environment must be "staging", got ${JSON.stringify(environment)}`,
    };
  }

  if (request.target_ids !== undefined) {
    if (!Array.isArray(request.target_ids) || request.target_ids.length > MAX_TARGET_IDS) {
      return { ok: false, resultClass: "BLOCKED", error: `target_ids must be an array of at most ${MAX_TARGET_IDS}` };
    }
    if (!request.target_ids.every((t) => typeof t === "string")) {
      return { ok: false, resultClass: "BLOCKED", error: "target_ids entries must be strings" };
    }
  }

  if (request.payload !== undefined) {
    if (!request.payload || typeof request.payload !== "object" || Array.isArray(request.payload)) {
      return { ok: false, resultClass: "BLOCKED", error: "payload must be an object" };
    }
    const keys = Object.keys(request.payload);
    if (keys.length > MAX_PAYLOAD_KEYS) {
      return { ok: false, resultClass: "BLOCKED", error: `payload has too many keys (max ${MAX_PAYLOAD_KEYS})` };
    }
    for (const key of keys) {
      const value = request.payload[key];
      if (typeof value === "string" && value.length > MAX_PAYLOAD_VALUE_LENGTH) {
        return { ok: false, resultClass: "BLOCKED", error: `payload key "${key}" exceeds max value length` };
      }
    }
  }

  if (request.authority_approval_id !== undefined) {
    if (typeof request.authority_approval_id !== "string" || request.authority_approval_id.length > MAX_ID_LENGTH) {
      return { ok: false, resultClass: "BLOCKED", error: "authority_approval_id must be a string (max 128)" };
    }
  }

  if (request.expected_terminal_state !== undefined) {
    if (typeof request.expected_terminal_state !== "string" || request.expected_terminal_state.length > MAX_ID_LENGTH) {
      return { ok: false, resultClass: "BLOCKED", error: "expected_terminal_state must be a string (max 128)" };
    }
  }

  if (HUMAN_GATED_OPERATIONS.includes(operation) && !request.authority_approval_id) {
    return {
      ok: false,
      resultClass: "BLOCKED",
      error: `human-gated operation "${operation}" requires authority_approval_id`,
    };
  }

  return { ok: true };
}

/**
 * Replay prevention. The ledger is a JSON object mapping request_id -> record.
 * A request whose request_id already exists in the ledger is a replay.
 */
export function isReplay(requestId, ledger) {
  const map = ledger && typeof ledger === "object" && !Array.isArray(ledger) ? ledger : {};
  return Object.prototype.hasOwnProperty.call(map, requestId);
}

/**
 * Append a processed request record to the ledger (immutably). Record captures
 * request_id, operation, commit, result class, and timestamp for auditability.
 */
export function appendLedger(ledger, requestId, record) {
  const map = ledger && typeof ledger === "object" && !Array.isArray(ledger) ? { ...ledger } : {};
  map[requestId] = {
    operation: record.operation,
    commit: record.commit,
    result: record.resultClass,
    processed_at: record.processedAt,
  };
  return map;
}

/**
 * Map an HTTP status + response body to the bridge result shape.
 */
export function classifyResponse(httpStatus, body) {
  const b = body && typeof body === "object" ? body : {};
  if (httpStatus >= 400) {
    const resultClass = httpStatus === 403 ? "BLOCKED" : "FAIL";
    const error = sanitizeText(
      typeof b.sanitized_error === "string" || typeof b.error === "string"
        ? (b.sanitized_error ?? b.error)
        : "API error",
    );
    return { resultClass, affectedIds: [], evidence: "", error };
  }
  const resultClass = typeof b.result_class === "string" ? b.result_class : "UNKNOWN";
  const affectedIds = Array.isArray(b.affected_ids) ? b.affected_ids.map(String) : [];
  const evidence = typeof b.evidence_summary === "string" ? b.evidence_summary : "";
  const error = typeof b.sanitized_error === "string" ? b.sanitized_error : "";
  return { resultClass, affectedIds, evidence, error };
}

/**
 * Build the sanitized result comment body. Only ids, operation, result class,
 * evidence summary, and timestamps leave the private environment.
 */
export function buildResultComment({ requestId, operation, resultClass, affectedIds, evidence, error, commit, processedAt }) {
  const lines = [
    "### QSL ChatGPT Orchestrator Bridge V1",
    "",
    `- operation: \`${sanitizeText(operation, 128)}\``,
    `- request_id: \`${sanitizeText(requestId, 128)}\``,
    `- result: **${resultClass}**`,
    `- processed_at: \`${processedAt}\``,
  ];
  if (affectedIds && affectedIds.length > 0) {
    lines.push(`- affected_ids: \`${affectedIds.map((id) => sanitizeText(id, 128)).join(", ")}\``);
  }
  if (evidence) {
    lines.push(`- evidence: ${sanitizeText(evidence, 1000)}`);
  }
  if (error) {
    lines.push(`- error: ${sanitizeText(error, 1000)}`);
  }
  if (commit) {
    lines.push(`- commit: \`${sanitizeText(commit, 64)}\``);
  }
  return lines.join("\n");
}

// ── Effectful I/O (integration, mocked in tests) ─────────────────────────────

export async function callBridge(apiBase, companyId, request) {
  const base = apiBase.replace(/\/+$/, "");
  const url = `${base}/api/qsl-orchestrator-bridge/companies/${encodeURIComponent(companyId)}/bridge`;
  const body = {
    request_id: request.request_id,
    operation: request.operation,
    environment: request.environment,
  };
  if (request.target_ids !== undefined) body.target_ids = request.target_ids;
  if (request.payload !== undefined) body.payload = request.payload;
  if (request.authority_approval_id !== undefined) body.authority_approval_id = request.authority_approval_id;
  if (request.expected_terminal_state !== undefined) body.expected_terminal_state = request.expected_terminal_state;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let parsed;
  try {
    parsed = await res.json();
  } catch {
    parsed = {};
  }
  return { status: res.status, body: parsed };
}

/**
 * Parse the transport envelope from SSH stdout. The forced command outputs
 * exactly one JSON line: { transport_version, http_status, body }.
 *
 * Returns the same shape as callBridge: { status: number, body: object|null }
 * plus optional transportError for transport-level failures.
 */
export function parseTransportEnvelope(stdout, stderr = "") {
  if (!stdout) {
    return { status: 0, body: null, transportError: "transport_no_output" };
  }

  let envelope;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    return {
      status: 0,
      body: null,
      transportError: "transport_envelope_unparseable",
      rawOutput: sanitizeText(stdout, 200),
    };
  }

  if (
    !envelope ||
    typeof envelope !== "object" ||
    envelope.transport_version !== 1 ||
    typeof envelope.http_status !== "number"
  ) {
    return {
      status: 0,
      body: null,
      transportError: "transport_envelope_malformed",
      rawOutput: sanitizeText(JSON.stringify(envelope), 200),
    };
  }

  return {
    status: envelope.http_status,
    body: envelope.body && typeof envelope.body === "object" ? envelope.body : {},
  };
}

/**
 * Call the bridge API through a bounded SSH forced command.
 *
 * The request JSON is piped to `bridge-dispatch-readonly` on the staging host.
 * The forced command validates, forwards, and returns a transport envelope:
 *   { transport_version: 1, http_status: <actual>, body: <parsed bridge JSON> }
 *
 * This preserves the actual HTTP status through the SSH boundary so
 * classifyResponse can distinguish BLOCKED (403) from FAIL (500) from PASS (200).
 */
export function callBridgeViaSsh(sshTarget, sshKey, request, spawnFn = spawnSync) {
  const args = [
    "-i", sshKey,
    "-o", "BatchMode=yes",
    "-o", "IdentitiesOnly=yes",
    "-o", "StrictHostKeyChecking=yes",
    "-o", "ConnectTimeout=10",
    sshTarget,
    "bridge-dispatch-readonly",
  ];

  let result;
  try {
    result = spawnFn("ssh", args, {
      input: requestJson,
      encoding: "utf8",
      timeout: 35_000,
      maxBuffer: 256 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    return {
      status: 0,
      body: null,
      transportError: `ssh_spawn_exception: ${err instanceof Error ? sanitizeText(err.message) : "unknown"}`,
    };
  }

  return parseTransportEnvelope(
    (result.stdout ?? "").trim(),
    (result.stderr ?? "").trim(),
  );
}

export async function postResultComment(repo, resultIssue, token, commentBody) {
  if (!token || !resultIssue) {
    // Dry-run / no GitHub context: emit locally, never post.
    return { posted: false, body: commentBody };
  }
  const res = await fetch(`https://api.github.com/repos/${repo}/issues/${resultIssue}/comments`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ body: commentBody }),
  });
  if (!res.ok) {
    throw new Error(`failed to post result comment: ${res.status}`);
  }
  return { posted: true, body: commentBody };
}

function readLedger(ledgerPath) {
  if (!ledgerPath || !existsSync(ledgerPath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(ledgerPath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeLedger(ledgerPath, ledger) {
  if (!ledgerPath) return;
  writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + "\n", "utf8");
}

export function commitLedgerToGit(ledgerPath, requestId, exec = execFileSync) {
  if (!ledgerPath) return;
  try {
    exec("git", ["add", ledgerPath], { stdio: "ignore" });
    exec("git", ["commit", "-m", `chore(qsl): record processed bridge request ${requestId}`], { stdio: "ignore" });
    exec("git", ["push", "origin", "HEAD"], { stdio: "ignore" });
  } catch (err) {
    // Best-effort: the result comment on the issue is the fallback audit trail.
    console.warn(`[bridge] ledger commit skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Full dispatch flow for a single request file. Fails closed on any validation
 * or replay violation and never leaves the private environment except through
 * the sanitized result comment.
 */
export async function dispatch({
  requestFilePath,
  ledgerPath,
  commit,
  apiBase,
  companyId,
  resultIssue,
  repo,
  token,
  commitLedger = false,
  commitLedgerFn = commitLedgerToGit,
  transport = "fetch",
  sshTarget,
  sshKey,
  sshSpawnFn = spawnSync,
}) {
  const relPath = requestFilePath.replace(/\\/g, "/");
  const requestId = requestIdFromPath(relPath);

  const fail = (resultClass, error) => {
    const commentBody = buildResultComment({
      requestId: requestId ?? "unknown",
      operation: "unknown",
      resultClass,
      affectedIds: [],
      evidence: "",
      error,
      commit,
      processedAt: new Date().toISOString(),
    });
    return { requestId, resultClass, commentBody, replay: false, error, status: 0 };
  };

  if (!isRequestPath(relPath)) {
    return fail("BLOCKED", `request file path is outside ${REQUEST_DIR}: ${relPath}`);
  }
  if (!existsSync(requestFilePath)) {
    return fail("BLOCKED", "request file not found");
  }

  const parsed = parseRequest(readFileSync(requestFilePath, "utf8"));
  if (!parsed.ok) {
    return fail("BLOCKED", parsed.error);
  }

  // Enforce request identity: the declared request_id must exactly equal the id
  // derived from `.qsl/bridge-requests/<request_id>.json`. Prevents a request
  // file whose contents claim a different identity than its filename.
  const declaredId =
    parsed.request && typeof parsed.request.request_id === "string" ? parsed.request.request_id : null;
  if (declaredId !== requestId) {
    return fail("BLOCKED", `request_id mismatch: file id is "${requestId}" but request declares "${declaredId}"`);
  }

  const validation = validateRequest(parsed.request);
  if (!validation.ok) {
    return fail(validation.resultClass, validation.error);
  }

  // Replay prevention: request_id must be unique and not already processed.
  const ledger = readLedger(ledgerPath);
  if (isReplay(requestId, ledger)) {
    return fail("BLOCKED", `duplicate/replayed request_id: ${requestId}`);
  }

  const operation = parsed.request.operation;
  let result;
  if (transport === "ssh") {
    result = callBridgeViaSsh(sshTarget, sshKey, parsed.request, sshSpawnFn);
  } else {
    result = await callBridge(apiBase, companyId, parsed.request);
  }
  const classified = classifyResponse(result.status, result.body);
  const processedAt = new Date().toISOString();

  const commentBody = buildResultComment({
    requestId,
    operation,
    resultClass: classified.resultClass,
    affectedIds: classified.affectedIds,
    evidence: classified.evidence,
    error: classified.error,
    commit,
    processedAt,
  });

  // Post sanitized result to the result issue. If no GitHub context, emit
  // locally only (dry-run).
  let posted = false;
  try {
    const postedResult = await postResultComment(repo, resultIssue, token, commentBody);
    posted = postedResult.posted;
  } catch (err) {
    console.warn(`[bridge] result comment failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Record processed request durably for replay prevention.
  const nextLedger = appendLedger(ledger, requestId, {
    operation,
    commit,
    resultClass: classified.resultClass,
    processedAt,
  });
  writeLedger(ledgerPath, nextLedger);
  if (commitLedger) {
    commitLedgerFn(ledgerPath, requestId);
  }

  return { requestId, resultClass: classified.resultClass, commentBody, replay: false, posted, status: 0 };
}

// ── CLI entry ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { commitLedger: false, transport: "fetch" };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const next = argv[i + 1];
    if (key === "--request-file") args.requestFile = next;
    else if (key === "--ledger") args.ledgerPath = next;
    else if (key === "--commit") args.commit = next;
    else if (key === "--api-base") args.apiBase = next;
    else if (key === "--company-id") args.companyId = next;
    else if (key === "--result-issue") args.resultIssue = next;
    else if (key === "--repo") args.repo = next;
    else if (key === "--commit-ledger") args.commitLedger = true;
    else if (key === "--transport") args.transport = next;
    else if (key === "--ssh-target") args.sshTarget = next;
    else if (key === "--ssh-key") args.sshKey = next;
    else if (key === "--help" || key === "-h") args.help = true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      "Usage: node dispatch-request.mjs --request-file <path> --api-base <url> --company-id <id> --result-issue <n> [--ledger <path>] [--commit <sha>] [--repo owner/name] [--commit-ledger] [--transport fetch|ssh] [--ssh-target user@host] [--ssh-key <path>]",
    );
    return;
  }
  if (!args.requestFile) throw new Error("--request-file is required");
  if (args.transport !== "ssh" && !args.apiBase) throw new Error("--api-base is required for fetch transport");
  if (args.transport === "ssh" && !args.sshTarget) throw new Error("--ssh-target is required for ssh transport");
  if (args.transport === "ssh" && !args.sshKey) throw new Error("--ssh-key is required for ssh transport");
  if (!args.companyId) throw new Error("--company-id is required");

  const result = await dispatch({
    requestFilePath: args.requestFile,
    ledgerPath: args.ledgerPath,
    commit: args.commit,
    apiBase: args.apiBase,
    companyId: args.companyId,
    resultIssue: args.resultIssue,
    repo: args.repo,
    token: process.env.GITHUB_TOKEN,
    commitLedger: args.commitLedger || process.env.BRIDGE_COMMIT_LEDGER === "true",
    transport: args.transport,
    sshTarget: args.sshTarget,
    sshKey: args.sshKey,
  });

  if (!result.posted && !args.resultIssue) {
    console.log(result.commentBody);
  }

  if (result.resultClass === "BLOCKED" || result.resultClass === "FAIL") {
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((err) => {
    console.error(`[bridge] ${sanitizeText(err instanceof Error ? err.message : String(err))}`);
    process.exitCode = 1;
  });
}
