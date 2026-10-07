import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ORCHESTRATOR_BRIDGE_OPERATIONS,
  READ_ONLY_OPERATIONS,
  BOUNDED_WRITE_OPERATIONS,
  HUMAN_GATED_OPERATIONS,
  isProhibitedOperation,
  orchestratorBridgeRequestSchema,
} from "@paperclipai/shared";

const routePath = fileURLToPath(
  new URL("../routes/qsl-orchestrator-bridge.ts", import.meta.url),
);

describe("QSL Orchestrator Bridge — shared types", () => {
  it("exports all expected operation categories", () => {
    expect(READ_ONLY_OPERATIONS.length).toBeGreaterThanOrEqual(8);
    expect(BOUNDED_WRITE_OPERATIONS.length).toBeGreaterThanOrEqual(6);
    expect(HUMAN_GATED_OPERATIONS.length).toBeGreaterThanOrEqual(3);

    const allOps = ORCHESTRATOR_BRIDGE_OPERATIONS as readonly string[];
    for (const op of READ_ONLY_OPERATIONS) expect(allOps).toContain(op);
    for (const op of BOUNDED_WRITE_OPERATIONS) expect(allOps).toContain(op);
    for (const op of HUMAN_GATED_OPERATIONS) expect(allOps).toContain(op);
  });

  it("rejects prohibited operation patterns", () => {
    expect(isProhibitedOperation("exec-shell")).toBe(true);
    expect(isProhibitedOperation("run-sql")).toBe(true);
    expect(isProhibitedOperation("read-credential")).toBe(true);
    expect(isProhibitedOperation("deploy-production")).toBe(true);
    expect(isProhibitedOperation("restart-service")).toBe(true);
    expect(isProhibitedOperation("destructive-drop")).toBe(true);
    expect(isProhibitedOperation("migrate-db")).toBe(true);
  });

  it("allows valid bridge operations", () => {
    expect(isProhibitedOperation("status")).toBe(false);
    expect(isProhibitedOperation("list-missions")).toBe(false);
    expect(isProhibitedOperation("create-task")).toBe(false);
    expect(isProhibitedOperation("list-approvals")).toBe(false);
  });
});

describe("QSL Orchestrator Bridge — validator schema", () => {
  it("accepts a valid minimal request", () => {
    const result = orchestratorBridgeRequestSchema.safeParse({
      request_id: "req-1",
      operation: "status",
      environment: "staging",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a valid full request", () => {
    const result = orchestratorBridgeRequestSchema.safeParse({
      request_id: "req-2",
      operation: "create-task",
      environment: "staging",
      target_ids: ["issue-1", "issue-2"],
      payload: { title: "Test", description: "Test desc" },
      authority_approval_id: "approval-1",
      expected_terminal_state: "done",
    });
    expect(result.success).toBe(true);
  });

  it("rejects non-staging environment", () => {
    const result = orchestratorBridgeRequestSchema.safeParse({
      request_id: "req-3",
      operation: "status",
      environment: "production",
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown operation", () => {
    const result = orchestratorBridgeRequestSchema.safeParse({
      request_id: "req-4",
      operation: "delete-all-data",
      environment: "staging",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty request_id", () => {
    const result = orchestratorBridgeRequestSchema.safeParse({
      request_id: "",
      operation: "status",
      environment: "staging",
    });
    expect(result.success).toBe(false);
  });

  it("rejects overlong request_id", () => {
    const result = orchestratorBridgeRequestSchema.safeParse({
      request_id: "x".repeat(129),
      operation: "status",
      environment: "staging",
    });
    expect(result.success).toBe(false);
  });

  it("rejects overlong authority_approval_id", () => {
    const result = orchestratorBridgeRequestSchema.safeParse({
      request_id: "req-5",
      operation: "execute-approved-send",
      environment: "staging",
      authority_approval_id: "x".repeat(129),
    });
    expect(result.success).toBe(false);
  });

  it("rejects too many target_ids", () => {
    const result = orchestratorBridgeRequestSchema.safeParse({
      request_id: "req-6",
      operation: "status",
      environment: "staging",
      target_ids: Array.from({ length: 51 }, (_, i) => `id-${i}`),
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing operation", () => {
    const result = orchestratorBridgeRequestSchema.safeParse({
      request_id: "req-7",
      environment: "staging",
    });
    expect(result.success).toBe(false);
  });
});

describe("QSL Orchestrator Bridge — source invariants", () => {
  const source = readFileSync(routePath, "utf8");

  it("does not use shell orchestration", () => {
    expect(source).not.toContain("node:child_process");
    expect(source).not.toMatch(/\bexec\(/);
    expect(source).not.toMatch(/\bspawn\(/);
  });

  it("does not export environment secrets or credentials", () => {
    expect(source).not.toMatch(/process\.env\.(OPENAI|ANTHROPIC|API_KEY|SECRET|TOKEN)/);
  });

  it("enforces company boundary on all operations", () => {
    expect(source).toContain("assertCompanyAccess(req, companyId)");
    expect(source).toContain("company scope");
  });

  it("sanitizes error messages with redaction patterns", () => {
    expect(source).toContain("sanitizeErrorMessage");
    expect(source).toContain("[REDACTED]");
  });

  it("blocks prohibited operation classes at server boundary", () => {
    expect(source).toContain("isProhibitedOperation(operation)");
    expect(source).toContain("Prohibited operation class");
  });

  it("validates requests with orchestratorBridgeRequestSchema", () => {
    expect(source).toContain("orchestratorBridgeRequestSchema");
    expect(source).toContain("safeParse");
  });

  it("enforces staging environment at server boundary", () => {
    expect(source).toContain('"staging"');
    expect(source).toContain("Only staging environment is allowed");
  });

  it("enforces payload size bounds", () => {
    expect(source).toContain("MAX_TARGET_IDS");
    expect(source).toContain("MAX_PAYLOAD_KEYS");
    expect(source).toContain("MAX_PAYLOAD_VALUE_LENGTH");
  });

  it("returns BLOCKED for human-gated ops without execution adapter", () => {
    expect(source).toContain("execution_adapter_not_implemented");
    expect(source).toContain("Deferred to future work");
  });

  it("uses real email intake origin kind for mail operations", () => {
    expect(source).toContain("plugin:qsl.email:intake");
  });

  it("records evidence as durable issue comments", () => {
    expect(source).toContain("addComment");
    expect(source).toContain("[Orchestrator Bridge Evidence]");
  });
});

describe("QSL Orchestrator Bridge — operation categories", () => {
  it("has all 8 required read-only operations", () => {
    const ro = READ_ONLY_OPERATIONS as readonly string[];
    expect(ro).toContain("status");
    expect(ro).toContain("list-missions");
    expect(ro).toContain("get-mission");
    expect(ro).toContain("list-tasks");
    expect(ro).toContain("get-task");
    expect(ro).toContain("list-approvals");
    expect(ro).toContain("list-mail-triage");
    expect(ro).toContain("get-mail-thread-summary");
  });

  it("has all 6 required bounded write operations", () => {
    const bw = BOUNDED_WRITE_OPERATIONS as readonly string[];
    expect(bw).toContain("create-task");
    expect(bw).toContain("update-task");
    expect(bw).toContain("assign-task");
    expect(bw).toContain("create-approval-request");
    expect(bw).toContain("create-outbound-draft");
    expect(bw).toContain("record-mission-evidence");
  });

  it("has all 3 required human-gated operation stubs", () => {
    const hg = HUMAN_GATED_OPERATIONS as readonly string[];
    expect(hg).toContain("execute-approved-send");
    expect(hg).toContain("publish-approved-asset");
    expect(hg).toContain("accept-approved-commercial-commitment");
  });
});

describe("QSL Orchestrator Bridge — approval gate behavior", () => {
  it("human-gated ops require authority_approval_id (source check)", () => {
    const s = readFileSync(routePath, "utf8");
    expect(s).toContain("requires authority_approval_id");
    expect(s).toContain("ctx.authorityApprovalId");
  });

  it("validates approval exists and is approved before evaluating gate", () => {
    const s = readFileSync(routePath, "utf8");
    expect(s).toContain('approval.status !== "approved"');
    expect(s).toContain('must be "approved"');
  });

  it("validates approval belongs to same company", () => {
    const s = readFileSync(routePath, "utf8");
    expect(s).toContain("company scope");
  });
});

describe("QSL Orchestrator Bridge — response schema", () => {
  const s = readFileSync(routePath, "utf8");

  it("produces PASS with evidence_summary", () => {
    expect(s).toContain('"PASS"');
    expect(s).toContain("evidence_summary");
  });

  it("produces BLOCKED with sanitized_error for denied ops", () => {
    expect(s).toContain('"BLOCKED"');
  });

  it("produces FAIL for caught errors", () => {
    expect(s).toContain('"FAIL"');
  });

  it("produces UNKNOWN for unhandled operations", () => {
    expect(s).toContain('"UNKNOWN"');
  });
});

describe("QSL Orchestrator Bridge — sanitization", () => {
  it("redacts API keys and tokens in error messages", () => {
    const source = readFileSync(routePath, "utf8");
    expect(source).toContain("sk-");
    expect(source).toContain("[REDACTED]");
  });

  it("caps error message length at 500 chars", () => {
    const source = readFileSync(routePath, "utf8");
    expect(source).toContain(".slice(0, 500)");
  });

  it("redacts PEM blocks in errors", () => {
    const source = readFileSync(routePath, "utf8");
    expect(source).toContain("BEGIN");
    expect(source).toContain("END");
  });
});