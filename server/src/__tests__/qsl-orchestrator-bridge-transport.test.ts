import { describe, expect, it, vi, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  REQUEST_DIR,
  ALLOWLIST_OPERATIONS,
  isRequestPath,
  requestIdFromPath,
  isProhibitedOperation,
  sanitizeText,
  parseRequest,
  validateRequest,
  isReplay,
  appendLedger,
  classifyResponse,
  buildResultComment,
  commitLedgerToGit,
  dispatch,
  callBridgeViaSsh,
  parseTransportEnvelope,
} from "../../../scripts/qsl-chatgpt-orchestrator-bridge/dispatch-request.mjs";
import { ORCHESTRATOR_BRIDGE_OPERATIONS } from "@paperclipai/shared";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("QSL Orchestrator Bridge transport — request-file path filtering", () => {
  it("accepts a valid request file path", () => {
    expect(isRequestPath(".qsl/bridge-requests/status-001.json")).toBe(true);
    expect(isRequestPath(".qsl/bridge-requests/list_tasks_abc.json")).toBe(true);
  });

  it("rejects paths outside the narrow request directory", () => {
    expect(isRequestPath("bridge-requests/status.json")).toBe(false);
    expect(isRequestPath(".qsl/other/status.json")).toBe(false);
    expect(isRequestPath("status.json")).toBe(false);
    expect(isRequestPath(".qsl/bridge-requests/sub/status.json")).toBe(false);
  });

  it("rejects traversal and non-json files", () => {
    expect(isRequestPath(".qsl/bridge-requests/../../secret.json")).toBe(false);
    expect(isRequestPath(".qsl/bridge-requests/status.txt")).toBe(false);
    expect(isRequestPath(".qsl/bridge-requests/.json")).toBe(false);
    expect(isRequestPath(".qsl/bridge-requests/READ ME.json")).toBe(false);
  });

  it("derives a matching request_id from a valid path", () => {
    expect(requestIdFromPath(".qsl/bridge-requests/status-001.json")).toBe("status-001");
    expect(requestIdFromPath("elsewhere.json")).toBeNull();
  });
});

describe("QSL Orchestrator Bridge transport — allowlist parity with shared types", () => {
  it("dispatcher allowlist matches the shared operation constant", () => {
    expect(ALLOWLIST_OPERATIONS.slice().sort()).toEqual(
      [...ORCHESTRATOR_BRIDGE_OPERATIONS].slice().sort(),
    );
  });
});

describe("QSL Orchestrator Bridge transport — malformed requests", () => {
  it("rejects empty and non-JSON documents", () => {
    expect(parseRequest("").ok).toBe(false);
    expect(parseRequest("not json {").ok).toBe(false);
    expect(parseRequest("[]").ok).toBe(false);
  });

  it("rejects missing request_id and operation", () => {
    expect(validateRequest({ operation: "status", environment: "staging" }).ok).toBe(false);
    expect(validateRequest({ request_id: "r1", environment: "staging" }).ok).toBe(false);
  });

  it("rejects prohibited and non-allowlisted operations", () => {
    expect(validateRequest({ request_id: "r1", operation: "exec-shell", environment: "staging" }).ok).toBe(false);
    expect(validateRequest({ request_id: "r1", operation: "rm -rf /", environment: "staging" }).ok).toBe(false);
    expect(validateRequest({ request_id: "r1", operation: "delete-all", environment: "staging" }).ok).toBe(false);
  });

  it("rejects oversized payload values", () => {
    const result = validateRequest({
      request_id: "r1",
      operation: "create-task",
      environment: "staging",
      payload: { title: "x".repeat(10_001) },
    });
    expect(result.ok).toBe(false);
  });

  it("fails closed via dispatch on a malformed file", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bridge-malformed-"));
    const reqDir = path.join(dir, ".qsl", "bridge-requests");
    mkdirSync(reqDir, { recursive: true });
    const file = path.join(reqDir, "bad.json");
    writeFileSync(file, "{ not valid json", "utf8");
    const result = await dispatch({
      requestFilePath: file,
      apiBase: "http://localhost:3101",
      companyId: "company-1",
      resultIssue: "",
    });
    expect(result.resultClass).toBe("BLOCKED");
    expect(result.error).toContain("not valid JSON");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("QSL Orchestrator Bridge transport — staging-only enforcement", () => {
  it("rejects non-staging environment at validation", () => {
    expect(validateRequest({ request_id: "r1", operation: "status", environment: "production" }).ok).toBe(false);
    expect(validateRequest({ request_id: "r1", operation: "status", environment: "staging" }).ok).toBe(true);
  });

  it("rejects missing environment", () => {
    expect(validateRequest({ request_id: "r1", operation: "status" }).ok).toBe(false);
  });
});

describe("QSL Orchestrator Bridge transport — request identity enforcement", () => {
  it("blocks a request whose declared request_id does not match the file id", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bridge-identity-"));
    const reqDir = path.join(dir, ".qsl", "bridge-requests");
    mkdirSync(reqDir, { recursive: true });
    const requestFilePath = path.join(reqDir, "status-001.json");
    writeFileSync(
      requestFilePath,
      JSON.stringify({ request_id: "status-OTHER", operation: "status", environment: "staging" }),
      "utf8",
    );

    const result = await dispatch({
      requestFilePath,
      apiBase: "http://localhost:3101",
      companyId: "company-1",
      resultIssue: "",
    });

    expect(result.resultClass).toBe("BLOCKED");
    expect(result.error).toContain("request_id mismatch");
    expect(result.error).toContain("status-001");
    expect(result.error).toContain("status-OTHER");
    rmSync(dir, { recursive: true, force: true });
  });

  it("accepts a request whose declared request_id matches the file id", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bridge-identity-ok-"));
    const reqDir = path.join(dir, ".qsl", "bridge-requests");
    mkdirSync(reqDir, { recursive: true });
    const requestFilePath = path.join(reqDir, "status-001.json");
    writeFileSync(
      requestFilePath,
      JSON.stringify({ request_id: "status-001", operation: "status", environment: "staging" }),
      "utf8",
    );

    vi.stubGlobal("fetch", async () => ({
      ok: true,
      status: 200,
      json: async () => ({ result_class: "PASS", evidence_summary: "ok" }),
    }));

    const result = await dispatch({
      requestFilePath,
      ledgerPath: path.join(dir, "ledger.json"),
      apiBase: "http://localhost:3101",
      companyId: "company-1",
      resultIssue: "",
    });

    expect(result.resultClass).toBe("PASS");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("QSL Orchestrator Bridge transport — durable ledger commit path", () => {
  it("commitLedgerToGit stages, commits, and pushes the ledger", () => {
    const execCalls = [];
    const fakeExec = (cmd, args) => {
      execCalls.push({ cmd, args });
      return Buffer.from("");
    };
    commitLedgerToGit(".qsl/bridge-ledger.json", "status-001", fakeExec);

    expect(execCalls.map((c) => c.cmd)).toEqual(["git", "git", "git"]);
    expect(execCalls[0].args).toEqual(["add", ".qsl/bridge-ledger.json"]);
    expect(execCalls[1].args[0]).toBe("commit");
    expect(execCalls[1].args[2]).toContain("record processed bridge request status-001");
    expect(execCalls[2].args).toEqual(["push", "origin", "HEAD"]);
  });

  it("dispatch with commitLedger=true invokes the ledger commit function", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bridge-commitledger-"));
    const reqDir = path.join(dir, ".qsl", "bridge-requests");
    mkdirSync(reqDir, { recursive: true });
    const requestFilePath = path.join(reqDir, "status-001.json");
    writeFileSync(
      requestFilePath,
      JSON.stringify({ request_id: "status-001", operation: "status", environment: "staging" }),
      "utf8",
    );

    vi.stubGlobal("fetch", async () => ({
      ok: true,
      status: 200,
      json: async () => ({ result_class: "PASS", evidence_summary: "ok" }),
    }));

    let committedWith = null;
    const commitLedgerFn = (ledgerPath, requestId) => {
      committedWith = { ledgerPath, requestId };
    };

    const result = await dispatch({
      requestFilePath,
      ledgerPath: path.join(dir, "ledger.json"),
      apiBase: "http://localhost:3101",
      companyId: "company-1",
      resultIssue: "",
      commitLedger: true,
      commitLedgerFn,
    });

    expect(result.resultClass).toBe("PASS");
    expect(committedWith).not.toBeNull();
    expect(committedWith.requestId).toBe("status-001");
    expect(committedWith.ledgerPath).toContain("ledger.json");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("QSL Orchestrator Bridge transport — replay prevention", () => {
  it("detects a replayed request_id in the ledger", () => {
    const ledger = { "status-001": { operation: "status", result: "PASS" } };
    expect(isReplay("status-001", ledger)).toBe(true);
    expect(isReplay("status-002", ledger)).toBe(false);
  });

  it("treats empty/absent ledger as no replay", () => {
    expect(isReplay("status-001", {})).toBe(false);
    expect(isReplay("status-001", null)).toBe(false);
  });

  it("records a processed request durably", () => {
    const next = appendLedger({}, "status-001", {
      operation: "status",
      commit: "abc123",
      resultClass: "PASS",
      processedAt: "2026-08-23T00:00:00Z",
    });
    expect(next["status-001"]).toMatchObject({
      operation: "status",
      commit: "abc123",
      result: "PASS",
    });
  });

  it("blocks a duplicate request before calling the API", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bridge-replay-"));
    const reqDir = path.join(dir, ".qsl", "bridge-requests");
    mkdirSync(reqDir, { recursive: true });
    const ledgerPath = path.join(dir, "ledger.json");
    writeFileSync(ledgerPath, JSON.stringify({ "status-001": { operation: "status", result: "PASS" } }), "utf8");

    const requestFilePath = path.join(reqDir, "status-001.json");
    writeFileSync(
      requestFilePath,
      JSON.stringify({ request_id: "status-001", operation: "status", environment: "staging" }),
      "utf8",
    );

    let fetchCalled = false;
    vi.stubGlobal("fetch", () => {
      fetchCalled = true;
      throw new Error("fetch should not be called for replay");
    });

    const result = await dispatch({
      requestFilePath,
      ledgerPath,
      apiBase: "http://localhost:3101",
      companyId: "company-1",
      resultIssue: "",
    });

    expect(result.resultClass).toBe("BLOCKED");
    expect(result.error).toContain("duplicate/replayed");
    expect(fetchCalled).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("QSL Orchestrator Bridge transport — read-only status flow", () => {
  it("dispatches a valid status request and posts a sanitized PASS result", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bridge-status-"));
    const reqDir = path.join(dir, ".qsl", "bridge-requests");
    mkdirSync(reqDir, { recursive: true });
    const requestFilePath = path.join(reqDir, "status-001.json");
    writeFileSync(
      requestFilePath,
      JSON.stringify({ request_id: "status-001", operation: "status", environment: "staging" }),
      "utf8",
    );

    const fetchCalls = [];
    vi.stubGlobal("fetch", async (url, init) => {
      fetchCalls.push({ url: String(url), init });
      if (String(url).includes("/bridge")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            result_class: "PASS",
            evidence_summary: "Status resolved. Recent issues: 3.",
            affected_ids: ["issue-1", "issue-2"],
          }),
        };
      }
      return { ok: true, status: 201, json: async () => ({}) };
    });

    const result = await dispatch({
      requestFilePath,
      ledgerPath: path.join(dir, "ledger.json"),
      commit: "abc123def",
      apiBase: "http://localhost:3101",
      companyId: "company-1",
      resultIssue: "34",
      repo: "mbennett-labs/paperclip",
      token: "test-token",
    });

    expect(result.resultClass).toBe("PASS");
    expect(result.posted).toBe(true);
    expect(fetchCalls.some((c) => c.url.includes("/bridge"))).toBe(true);
    expect(fetchCalls.some((c) => c.url.includes("/issues/34/comments"))).toBe(true);

    // Ledger must be updated with the processed request.
    const ledger = JSON.parse(readFileSync(path.join(dir, "ledger.json"), "utf8"));
    expect(ledger["status-001"]).toMatchObject({ operation: "status", result: "PASS" });

    rmSync(dir, { recursive: true, force: true });
  });
});

describe("QSL Orchestrator Bridge transport — sanitized result egress", () => {
  it("redacts secrets, tokens, PEM blocks, and base64 blobs", () => {
    expect(sanitizeText("key sk-abcdefghijklmnop1234567890 here")).toBe("key [REDACTED] here");
    expect(sanitizeText("Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456")).toContain("[REDACTED]");
    expect(sanitizeText("-----BEGIN PRIVATE KEY-----\nabcdef\n-----END PRIVATE KEY-----")).toBe("[REDACTED]");
    expect(sanitizeText("password=hunter2secretvaluehere")).toContain("[REDACTED]");
    expect(sanitizeText("api_key=superlongsecretvaluehere123456789")).toContain("[REDACTED]");
  });

  it("builds a result comment without raw secret material", () => {
    const comment = buildResultComment({
      requestId: "status-001",
      operation: "status",
      resultClass: "PASS",
      affectedIds: ["issue-1"],
      evidence: "sk-abcdefghijklmnop1234567890 leaked?",
      error: "",
      commit: "abc123",
      processedAt: "2026-08-23T00:00:00Z",
    });
    expect(comment).not.toContain("sk-abcdefghijklmnop");
    expect(comment).toContain("[REDACTED]");
    expect(comment).toContain("status-001");
    expect(comment).toContain("PASS");
  });

  it("maps HTTP error statuses to BLOCKED/FAIL with sanitized errors", () => {
    expect(classifyResponse(403, { sanitized_error: "sk-leak" }).resultClass).toBe("BLOCKED");
    expect(classifyResponse(500, { error: "boom" }).resultClass).toBe("FAIL");
    const blocked = classifyResponse(403, { sanitized_error: "sk-leak-abcdefghijklmnop" });
    expect(blocked.error).not.toContain("sk-leak");
  });

  it("never emits raw request payload text in the result comment", () => {
    const comment = buildResultComment({
      requestId: "create-task-001",
      operation: "create-task",
      resultClass: "PASS",
      affectedIds: ["issue-9"],
      evidence: "Created task",
      error: "",
      commit: "abc",
      processedAt: "2026-08-23T00:00:00Z",
    });
    expect(comment).not.toContain("payload");
    expect(comment).not.toContain("{");
  });
});

describe("QSL Orchestrator Bridge transport — bounded SSH transport envelope", () => {
  it("parses a valid transport envelope into status + body", () => {
    const parsed = parseTransportEnvelope(
      JSON.stringify({ transport_version: 1, http_status: 200, body: { result_class: "PASS" } }),
    );
    expect(parsed).toEqual({ status: 200, body: { result_class: "PASS" } });
  });

  it("reports transport_no_output with sanitized stderr detail on empty stdout", () => {
    const parsed = parseTransportEnvelope("", "QSL_STAGING_OPS_ERROR: unsupported operation\r\n");
    expect(parsed.status).toBe(0);
    expect(parsed.body).toBeNull();
    expect(parsed.transportError).toBe("transport_no_output");
    expect(parsed.transportDetail).toContain("QSL_STAGING_OPS_ERROR: unsupported operation");
  });

  it("reports unparseable and malformed envelopes without crashing", () => {
    expect(parseTransportEnvelope("not json").transportError).toBe("transport_envelope_unparseable");
    expect(
      parseTransportEnvelope(JSON.stringify({ transport_version: 2, http_status: 200 })).transportError,
    ).toBe("transport_envelope_malformed");
  });
});

describe("QSL Orchestrator Bridge transport — bounded SSH dispatcher", () => {
  const baseRequest = { request_id: "status-001", operation: "status", environment: "staging" };

  it("pipes the serialized request to the bridge-dispatch-readonly forced command", () => {
    const calls = [];
    const fakeSpawn = (cmd, args, options) => {
      calls.push({ cmd, args, options });
      return {
        status: 0,
        stdout: JSON.stringify({ transport_version: 1, http_status: 200, body: { result_class: "PASS" } }),
        stderr: "",
      };
    };

    const result = callBridgeViaSsh("root@example", "/tmp/key", baseRequest, fakeSpawn);

    expect(result.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe("ssh");
    expect(calls[0].args).toContain("bridge-dispatch-readonly");
    expect(calls[0].args[calls[0].args.length - 1]).toBe("bridge-dispatch-readonly");
    expect(calls[0].args).toContain("BatchMode=yes");
    expect(calls[0].args).toContain("StrictHostKeyChecking=yes");
    expect(calls[0].options.input).toBe(JSON.stringify(baseRequest));
  });

  it("classifies an SSH transport failure as FAIL with the sanitized operator error", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bridge-ssh-fail-"));
    const reqDir = path.join(dir, ".qsl", "bridge-requests");
    mkdirSync(reqDir, { recursive: true });
    const requestFilePath = path.join(reqDir, "status-ssh-001.json");
    writeFileSync(
      requestFilePath,
      JSON.stringify({ request_id: "status-ssh-001", operation: "status", environment: "staging" }),
      "utf8",
    );

    const fakeSpawn = () => ({
      status: 1,
      stdout: "",
      stderr: "QSL_STAGING_OPS_ERROR: unsupported operation\n",
    });

    const result = await dispatch({
      requestFilePath,
      ledgerPath: path.join(dir, "ledger.json"),
      apiBase: "http://localhost:3101",
      companyId: "company-1",
      resultIssue: "",
      transport: "ssh",
      sshTarget: "root@example",
      sshKey: "/tmp/key",
      sshSpawnFn: fakeSpawn,
    });

    expect(result.resultClass).toBe("FAIL");
    expect(result.error).toContain("transport failure");
    expect(result.error).toContain("unsupported operation");

    const ledger = JSON.parse(readFileSync(path.join(dir, "ledger.json"), "utf8"));
    expect(ledger["status-ssh-001"].result).toBe("FAIL");
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not classify a healthy SSH envelope as a transport failure", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bridge-ssh-ok-"));
    const reqDir = path.join(dir, ".qsl", "bridge-requests");
    mkdirSync(reqDir, { recursive: true });
    const requestFilePath = path.join(reqDir, "status-ssh-002.json");
    writeFileSync(
      requestFilePath,
      JSON.stringify({ request_id: "status-ssh-002", operation: "status", environment: "staging" }),
      "utf8",
    );

    const fakeSpawn = () => ({
      status: 0,
      stdout: JSON.stringify({ transport_version: 1, http_status: 200, body: { result_class: "PASS" } }),
      stderr: "",
    });

    const result = await dispatch({
      requestFilePath,
      ledgerPath: path.join(dir, "ledger.json"),
      apiBase: "http://localhost:3101",
      companyId: "company-1",
      resultIssue: "",
      transport: "ssh",
      sshTarget: "root@example",
      sshKey: "/tmp/key",
      sshSpawnFn: fakeSpawn,
    });

    expect(result.resultClass).toBe("PASS");
    rmSync(dir, { recursive: true, force: true });
  });
});
